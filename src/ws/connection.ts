// WebSocket (`/v2`) session: a transparent Postgres byte-bridge. The proxy
// forwards bytes verbatim (ws_handler.go, CONTRACT.md §"SCRAM / channel binding
// over WS"), so THIS client speaks real Postgres wire — it sends the
// StartupMessage, runs its own md5/scram handshake, then simple/extended query.
//
// Layering: `WireConnection` (7.2) turns the socket's byte STREAM into a queue
// of whole PG messages (frames ≠ messages — see MessageReassembler). On top,
// `startSession` (7.3) boots auth and drains to the first ReadyForQuery, and
// `sessionQuery` (7.4) runs one query and assembles a `PgResult`.

import type { ConnectionConfig } from "../connection-string.js";
import type { Field, PgResult } from "../result.js";
import { md5AuthResponse } from "../auth/md5.js";
import { runScram, type ScramIO } from "../auth/scram.js";
import { getTypeParser } from "../types/parsers.js";
import {
  MessageReassembler,
  buildBind,
  buildDescribe,
  buildExecute,
  buildParse,
  buildQuery,
  buildStartup,
  buildSync,
  parseAuthTag,
  parseCommandComplete,
  parseDataRow,
  parseErrorResponse,
  parseRowDescription,
  type FieldDescription,
  type PgWireError,
  type RawMessage,
} from "../pg/protocol.js";
import type { WsSocket } from "./adapter.js";

// Backend message type bytes (ASCII).
const MSG_AUTH = 0x52; // 'R' Authentication*
const MSG_PARAMETER_STATUS = 0x53; // 'S'
const MSG_BACKEND_KEY_DATA = 0x4b; // 'K'
const MSG_NOTICE = 0x4e; // 'N' NoticeResponse
const MSG_ERROR = 0x45; // 'E' ErrorResponse
const MSG_READY = 0x5a; // 'Z' ReadyForQuery
const MSG_ROW_DESCRIPTION = 0x54; // 'T'
const MSG_DATA_ROW = 0x44; // 'D'
const MSG_COMMAND_COMPLETE = 0x43; // 'C'
const MSG_PARSE_COMPLETE = 0x31; // '1'
const MSG_BIND_COMPLETE = 0x32; // '2'
const MSG_EMPTY_QUERY = 0x49; // 'I' EmptyQueryResponse

const TEXT_DECODER = new TextDecoder();

/**
 * A Postgres ErrorResponse ('E') surfaced as a throwable, carrying the parsed
 * SQLSTATE and message fields (pg `DatabaseError`-shaped).
 */
export class DatabaseError extends Error {
  readonly severity: string;
  readonly code: string;
  readonly detail: string;
  readonly hint: string;
  constructor(e: PgWireError) {
    super(e.message || `postgres error ${e.code}`);
    this.name = "DatabaseError";
    this.severity = e.severity;
    this.code = e.code;
    this.detail = e.detail;
    this.hint = e.hint;
  }
}

/** Post-boot session facts captured while draining to the first ReadyForQuery. */
export interface SessionState {
  /** ParameterStatus values (server_version, client_encoding, …). */
  parameters: Record<string, string>;
  /** BackendKeyData process id, if the server sent one. */
  processId?: number;
  /** BackendKeyData secret key, if the server sent one. */
  secretKey?: number;
  /** Transaction status from the first ReadyForQuery: 'I' | 'T' | 'E'. */
  transactionStatus: number;
}

// --- Task 7.2 — bytes → reassembler → async message queue -----------------

interface Waiter {
  resolve: (m: RawMessage) => void;
  reject: (e: Error) => void;
}

/**
 * Turns a {@link WsSocket}'s inbound byte stream into an async queue of whole
 * Postgres messages. `nextMessage()` resolves the next complete message, awaiting
 * more frames when the buffer holds only a partial one.
 */
export class WireConnection {
  private readonly reassembler = new MessageReassembler();
  private readonly queue: RawMessage[] = [];
  private readonly waiters: Waiter[] = [];
  private failure: Error | null = null;

  constructor(private readonly socket: WsSocket) {
    socket.onMessage((data) => this.onBytes(data));
    socket.onClose((info) =>
      this.fail(
        new Error(`kisenon: WebSocket closed (code ${info.code}${info.reason ? ` ${info.reason}` : ""})`),
      ),
    );
  }

  private onBytes(data: Uint8Array): void {
    this.reassembler.push(data);
    for (;;) {
      let msg: RawMessage | null;
      try {
        msg = this.reassembler.next();
      } catch (e) {
        this.fail(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      if (!msg) break;
      const waiter = this.waiters.shift();
      if (waiter) {
        waiter.resolve(msg);
      } else {
        this.queue.push(msg);
      }
    }
  }

  private fail(err: Error): void {
    if (this.failure) return;
    this.failure = err;
    while (this.waiters.length > 0) {
      this.waiters.shift()!.reject(err);
    }
  }

  /** Resolve the next complete Postgres message (awaiting more frames as needed). */
  nextMessage(): Promise<RawMessage> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise<RawMessage>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  /** Send one frontend message frame. */
  send(msg: Uint8Array): void {
    this.socket.send(msg);
  }

  /** Close the underlying socket. */
  close(): void {
    this.socket.close();
  }
}

// --- Task 7.3 — session boot (Startup → auth → ReadyForQuery) --------------

/**
 * Boot a session: send the StartupMessage, run the server-selected auth method
 * (md5 or SCRAM — the client does the crypto; the proxy just forwards bytes),
 * then drain ParameterStatus/BackendKeyData/NoticeResponse to the first
 * ReadyForQuery. Throws {@link DatabaseError} on an ErrorResponse.
 */
export async function startSession(
  conn: WireConnection,
  cfg: ConnectionConfig,
): Promise<SessionState> {
  conn.send(buildStartup(cfg.user, cfg.database, cfg.options));

  // Phase 1: authentication.
  let authDone = false;
  while (!authDone) {
    const msg = await conn.nextMessage();
    if (msg.type === MSG_ERROR) {
      throw new DatabaseError(parseErrorResponse(msg.body));
    }
    if (msg.type !== MSG_AUTH) {
      throw new Error(`kisenon: unexpected message 0x${msg.type.toString(16)} during authentication`);
    }
    const authType = parseAuthTag(msg.body);
    switch (authType) {
      case 0: // AuthenticationOk
        authDone = true;
        break;
      case 5: {
        // AuthenticationMD5Password: 4-byte salt follows the auth-type code.
        const salt = msg.body.slice(4, 8);
        conn.send(md5AuthResponse(cfg.user, cfg.password, salt));
        break;
      }
      case 10:
      case 11:
      case 12: {
        // SASL/SCRAM: hand this message (and subsequent 'R' messages) to the driver.
        await runScram(cfg.user, cfg.password, scramIO(conn, msg));
        authDone = true;
        break;
      }
      default:
        throw new Error(`kisenon: unsupported authentication method ${authType}`);
    }
  }

  // Phase 2: drain to the first ReadyForQuery.
  const state: SessionState = { parameters: {}, transactionStatus: 0x49 /* 'I' */ };
  for (;;) {
    const msg = await conn.nextMessage();
    switch (msg.type) {
      case MSG_PARAMETER_STATUS: {
        const [name, value] = readParameterStatus(msg.body);
        state.parameters[name] = value;
        break;
      }
      case MSG_BACKEND_KEY_DATA: {
        if (msg.body.length >= 8) {
          const view = new DataView(msg.body.buffer, msg.body.byteOffset, msg.body.byteLength);
          state.processId = view.getUint32(0, false);
          state.secretKey = view.getUint32(4, false);
        }
        break;
      }
      case MSG_NOTICE:
        break; // ignorable
      case MSG_READY:
        state.transactionStatus = msg.body.length > 0 ? msg.body[0]! : 0x49;
        return state;
      case MSG_ERROR:
        throw new DatabaseError(parseErrorResponse(msg.body));
      default:
        break; // tolerate anything else pre-ReadyForQuery
    }
  }
}

/**
 * A {@link ScramIO} bound to a {@link WireConnection}. `recvAuth` yields the
 * already-consumed first Authentication message once (pushback), then reads
 * subsequent 'R' messages off the wire — so `startSession` can detect SASL and
 * still let `runScram` see the code-10 message.
 */
function scramIO(conn: WireConnection, first: RawMessage): ScramIO {
  let pending: RawMessage | null = first;
  return {
    send: (m) => conn.send(m),
    recvAuth: async () => {
      const msg = pending ?? (await conn.nextMessage());
      pending = null;
      if (msg.type === MSG_ERROR) {
        throw new DatabaseError(parseErrorResponse(msg.body));
      }
      if (msg.type !== MSG_AUTH) {
        throw new Error(`kisenon: expected Authentication message, got 0x${msg.type.toString(16)}`);
      }
      return { authType: parseAuthTag(msg.body), body: msg.body.slice(4) };
    },
  };
}

/** Parse a ParameterStatus ('S') body: two NUL-terminated strings (name, value). */
function readParameterStatus(body: Uint8Array): [string, string] {
  const nul = body.indexOf(0);
  if (nul < 0) return [TEXT_DECODER.decode(body), ""];
  const name = TEXT_DECODER.decode(body.subarray(0, nul));
  const rest = body.subarray(nul + 1);
  const end = rest.indexOf(0);
  const value = TEXT_DECODER.decode(end < 0 ? rest : rest.subarray(0, end));
  return [name, value];
}

// --- Task 7.4 — query over the session ------------------------------------

/**
 * Run one query on a booted session and assemble a {@link PgResult}. No params →
 * simple protocol (Query; collect T,D*,C,Z). With params → extended protocol
 * (Parse/Bind/Describe/Execute/Sync; collect 1,2,T,D*,C,Z). Row values are
 * type-parsed from wire TEXT via `getTypeParser(field.dataTypeID)`. Throws
 * {@link DatabaseError} on an ErrorResponse.
 */
export async function sessionQuery(
  conn: WireConnection,
  text: string,
  params?: unknown[],
): Promise<PgResult> {
  if (params && params.length > 0) {
    conn.send(buildParse("", text, []));
    conn.send(buildBind("", "", params.map(encodeParam)));
    conn.send(buildDescribe("P", ""));
    conn.send(buildExecute("", 0));
    conn.send(buildSync());
  } else {
    conn.send(buildQuery(text));
  }

  let fields: FieldDescription[] = [];
  const rawRows: (Uint8Array | null)[][] = [];
  let command = "";
  let commandRowCount = 0;
  let sawCommandComplete = false;

  for (;;) {
    const msg = await conn.nextMessage();
    switch (msg.type) {
      case MSG_PARSE_COMPLETE: // '1'
      case MSG_BIND_COMPLETE: // '2'
        break;
      case MSG_ROW_DESCRIPTION:
        fields = parseRowDescription(msg.body);
        break;
      case MSG_DATA_ROW:
        rawRows.push(parseDataRow(msg.body));
        break;
      case MSG_COMMAND_COMPLETE: {
        const cc = parseCommandComplete(msg.body);
        command = cc.command;
        commandRowCount = cc.rowCount;
        sawCommandComplete = true;
        break;
      }
      case MSG_EMPTY_QUERY: // 'I'
        sawCommandComplete = true;
        break;
      case MSG_NOTICE:
        break; // ignorable
      case MSG_ERROR:
        throw new DatabaseError(parseErrorResponse(msg.body));
      case MSG_READY:
        return assembleResult(fields, rawRows, command, commandRowCount, sawCommandComplete);
      default:
        break; // tolerate ParameterStatus / anything else mid-stream
    }
  }
}

/** Map a wire RowDescription field onto the caller-facing {@link Field} shape. */
function toField(f: FieldDescription): Field {
  return {
    name: f.name,
    dataTypeID: f.dataTypeOID,
    tableID: f.tableOID,
    columnID: f.columnAttr,
    dataTypeSize: f.dataTypeSize,
    dataTypeModifier: f.typeModifier,
    format: "text",
  };
}

/** Assemble the collected wire messages into a {@link PgResult} with type-parsed row objects. */
function assembleResult(
  fields: FieldDescription[],
  rawRows: (Uint8Array | null)[][],
  command: string,
  commandRowCount: number,
  sawCommandComplete: boolean,
): PgResult {
  const parsers = fields.map((f) => getTypeParser(f.dataTypeOID));
  const rows: Record<string, unknown>[] = rawRows.map((cols) => {
    const row: Record<string, unknown> = {};
    for (let i = 0; i < fields.length; i++) {
      const cell = cols[i];
      row[fields[i]!.name] = cell == null ? null : parsers[i]!(TEXT_DECODER.decode(cell));
    }
    return row;
  });
  // rowCount mirrors pg: the CommandComplete count for DML; row count for a SELECT.
  const rowCount = sawCommandComplete ? (command === "SELECT" ? rows.length : commandRowCount) : null;
  return {
    rows,
    rowCount,
    fields: fields.map(toField),
    command,
  };
}

/** Encode one bind parameter as wire TEXT bytes (null → SQL NULL). */
function encodeParam(p: unknown): Uint8Array | null {
  if (p === null || p === undefined) return null;
  const s = typeof p === "string" ? p : String(p);
  return new TextEncoder().encode(s);
}
