// Postgres wire-protocol framing for the WebSocket (/v2) path. This is a
// byte-for-byte TypeScript port of the server's builders/parsers in
// src/proxy/internal/edgedriver/pgwire.go — the shapes MUST stay identical.
//
// The load-bearing fact (CONTRACT.md §"Framing"): /v2 frames are a raw byte
// STREAM, not message-aligned. `coalesceWrites` packs several PG messages into
// one WS frame and a large message spans frames, so all inbound bytes flow
// through MessageReassembler before any parser sees them.
//
// A typed message is: Int8 type + Int32 length (length includes its own 4
// bytes, excludes the type byte) + body. The StartupMessage is untyped: Int32
// length + Int32 196608 + key\0value\0…\0 + final \0.
//
// Web-standard only (Uint8Array, DataView, TextEncoder/TextDecoder) — no Node
// Buffer, no deps — so it loads unmodified in Workers/Edge/Deno/Bun/Node ≥18.

const PROTOCOL_VERSION_3 = 196608; // 3<<16 | 0 — Postgres 3.0 protocol version

// Length ceiling matching scram.ReadFrame's 16 MiB guard. Rejects a corrupt or
// hostile length prefix before we try to buffer for it.
const MAX_MESSAGE_LENGTH = 16 * 1024 * 1024;

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

const MALFORMED = "kisenon: malformed postgres message";

/** One complete Postgres message. `body` excludes the type byte and the 4-byte length prefix. */
export interface RawMessage {
  type: number;
  body: Uint8Array;
}

/** One column's metadata from a RowDescription ('T') message. */
export interface FieldDescription {
  name: string;
  tableOID: number;
  columnAttr: number;
  dataTypeOID: number;
  dataTypeSize: number;
  typeModifier: number;
  format: number; // 0 = text, 1 = binary; always 0 for us (we request text)
}

/** Structured Postgres ErrorResponse ('E') / NoticeResponse ('N'). `code` is the SQLSTATE. */
export interface PgWireError {
  severity: string;
  code: string;
  message: string;
  detail: string;
  hint: string;
}

// --- Byte-stream reassembler (Task 5.1) -----------------------------------

/**
 * Reassembles the /v2 byte stream into whole Postgres messages. Callers push
 * raw WS-frame bytes and pull complete messages; `next()` returns null while a
 * message is still incomplete (its declared length exceeds the buffered bytes).
 */
export class MessageReassembler {
  private buf = new Uint8Array(0);

  /** Append bytes from a WS frame. */
  push(chunk: Uint8Array): void {
    if (this.buf.length === 0) {
      this.buf = chunk.slice();
      return;
    }
    const next = new Uint8Array(this.buf.length + chunk.length);
    next.set(this.buf, 0);
    next.set(chunk, this.buf.length);
    this.buf = next;
  }

  /** One complete message, or null if the buffer does not yet hold a whole one. */
  next(): RawMessage | null {
    if (this.buf.length < 5) {
      return null; // need at least type(1) + length(4)
    }
    const length = readUint32BE(this.buf, 1);
    if (length > MAX_MESSAGE_LENGTH) {
      throw new Error(`kisenon: message length ${length} exceeds 16 MiB ceiling`);
    }
    const total = 1 + length; // type byte + length-covered region
    if (this.buf.length < total) {
      return null; // message spans more frames than we have buffered
    }
    const type = this.buf[0]!;
    const body = this.buf.slice(5, total);
    this.buf = this.buf.slice(total);
    return { type, body };
  }
}

// --- small encode helpers (Task 5.2) --------------------------------------

/** Wrap a typed message body in its 1-byte type + int32 length prefix. */
export function frame(type: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + body.length);
  out[0] = type;
  writeUint32BE(out, 1, 4 + body.length); // length includes its own 4 bytes
  out.set(body, 5);
  return out;
}

/** Append `s` as UTF-8 followed by a terminating NUL. */
export function appendCString(b: Uint8Array, s: string): Uint8Array {
  const enc = TEXT_ENCODER.encode(s);
  const out = new Uint8Array(b.length + enc.length + 1);
  out.set(b, 0);
  out.set(enc, b.length);
  out[out.length - 1] = 0;
  return out;
}

/** Append a big-endian int16. */
export function appendInt16(b: Uint8Array, v: number): Uint8Array {
  const out = new Uint8Array(b.length + 2);
  out.set(b, 0);
  out[b.length] = (v >>> 8) & 0xff;
  out[b.length + 1] = v & 0xff;
  return out;
}

/** Append a big-endian int32 (v === -1 encodes as FF FF FF FF, the SQL-NULL sentinel). */
export function appendInt32(b: Uint8Array, v: number): Uint8Array {
  const out = new Uint8Array(b.length + 4);
  out.set(b, 0);
  writeUint32BE(out, b.length, v);
  return out;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function writeUint32BE(b: Uint8Array, offset: number, v: number): void {
  b[offset] = (v >>> 24) & 0xff;
  b[offset + 1] = (v >>> 16) & 0xff;
  b[offset + 2] = (v >>> 8) & 0xff;
  b[offset + 3] = v & 0xff;
}

function readUint32BE(b: Uint8Array, offset: number): number {
  return (
    (b[offset]! * 0x1000000) +
    ((b[offset + 1]! << 16) | (b[offset + 2]! << 8) | b[offset + 3]!)
  );
}

// --- Frontend message builders (Task 5.2) ---------------------------------

/**
 * Build an untyped StartupMessage (protocol 3.0) with `user`/`database` and,
 * when set, a verbatim `options` parameter (may carry the SNI-less
 * `endpoint=<id>` routing hint).
 */
export function buildStartup(user: string, database: string, options?: string): Uint8Array {
  let body = appendInt32(new Uint8Array(0), PROTOCOL_VERSION_3);
  body = appendCString(body, "user");
  body = appendCString(body, user);
  body = appendCString(body, "database");
  body = appendCString(body, database);
  if (options) {
    body = appendCString(body, "options");
    body = appendCString(body, options);
  }
  body = concat(body, new Uint8Array([0])); // terminating NUL

  const out = new Uint8Array(4 + body.length);
  writeUint32BE(out, 0, 4 + body.length); // untyped: int32 length only
  out.set(body, 4);
  return out;
}

/** Simple-protocol Query ('Q'). */
export function buildQuery(sql: string): Uint8Array {
  return frame(0x51 /* 'Q' */, appendCString(new Uint8Array(0), sql));
}

/**
 * Extended-protocol Parse ('P'). `name` is "" for the unnamed statement; `oids`
 * may be empty to let the server infer parameter types (we send params as text).
 */
export function buildParse(name: string, sql: string, oids: number[]): Uint8Array {
  let body = appendCString(new Uint8Array(0), name);
  body = appendCString(body, sql);
  body = appendInt16(body, oids.length);
  for (const oid of oids) {
    body = appendInt32(body, oid);
  }
  return frame(0x50 /* 'P' */, body);
}

/**
 * Extended-protocol Bind ('B'). Params are sent in TEXT format (0 param-format
 * codes → all text); a null element is a SQL NULL (length -1). A single result
 * format code 0 requests all result columns in TEXT — Neon-Raw-Text-Output is
 * always-on, so the driver parses client-side.
 */
export function buildBind(portal: string, stmt: string, params: (Uint8Array | null)[]): Uint8Array {
  let body = appendCString(new Uint8Array(0), portal);
  body = appendCString(body, stmt);
  body = appendInt16(body, 0); // 0 parameter format codes => all TEXT
  body = appendInt16(body, params.length);
  for (const p of params) {
    if (p === null) {
      body = appendInt32(body, -1); // SQL NULL
      continue;
    }
    body = appendInt32(body, p.length);
    body = concat(body, p);
  }
  body = appendInt16(body, 1); // one result format code, applied to all columns
  body = appendInt16(body, 0); // TEXT
  return frame(0x42 /* 'B' */, body);
}

/** Extended-protocol Describe ('D') for a statement ("S") or portal ("P"); name "" = unnamed. */
export function buildDescribe(kind: "S" | "P", name: string): Uint8Array {
  let body: Uint8Array = new Uint8Array([kind.charCodeAt(0)]);
  body = appendCString(body, name);
  return frame(0x44 /* 'D' */, body);
}

/** Extended-protocol Execute ('E'); maxRows === 0 means all rows. */
export function buildExecute(portal: string, maxRows: number): Uint8Array {
  let body = appendCString(new Uint8Array(0), portal);
  body = appendInt32(body, maxRows);
  return frame(0x45 /* 'E' */, body);
}

/** Extended-protocol Sync ('S'). */
export function buildSync(): Uint8Array {
  return frame(0x53 /* 'S' */, new Uint8Array(0));
}

// --- small decode helper --------------------------------------------------

// Cursor over a message body with bounds-checked readers that return null on
// underflow rather than throwing (callers translate null → MALFORMED).
class Reader {
  private pos = 0;
  private view: DataView;

  constructor(private buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  byte(): number | null {
    if (this.pos + 1 > this.buf.length) return null;
    return this.buf[this.pos++]!;
  }

  int16(): number | null {
    if (this.pos + 2 > this.buf.length) return null;
    const v = this.view.getInt16(this.pos, false);
    this.pos += 2;
    return v;
  }

  int32(): number | null {
    if (this.pos + 4 > this.buf.length) return null;
    const v = this.view.getInt32(this.pos, false);
    this.pos += 4;
    return v;
  }

  uint32(): number | null {
    if (this.pos + 4 > this.buf.length) return null;
    const v = this.view.getUint32(this.pos, false);
    this.pos += 4;
    return v;
  }

  bytes(n: number): Uint8Array | null {
    if (n < 0 || this.pos + n > this.buf.length) return null;
    const b = this.buf.slice(this.pos, this.pos + n); // copy, so callers can retain it
    this.pos += n;
    return b;
  }

  cstring(): string | null {
    for (let i = this.pos; i < this.buf.length; i++) {
      if (this.buf[i] === 0) {
        const s = TEXT_DECODER.decode(this.buf.slice(this.pos, i));
        this.pos = i + 1;
        return s;
      }
    }
    return null;
  }
}

// --- Backend message parsers (Tasks 5.3–5.5) ------------------------------

/** Parse a RowDescription ('T') body into per-column field metadata. */
export function parseRowDescription(body: Uint8Array): FieldDescription[] {
  const r = new Reader(body);
  const n = r.int16();
  if (n === null || n < 0) throw new Error(MALFORMED);
  const fields: FieldDescription[] = [];
  for (let i = 0; i < n; i++) {
    const name = r.cstring();
    if (name === null) throw new Error(MALFORMED);
    const tableOID = r.uint32();
    const columnAttr = r.int16();
    const dataTypeOID = r.uint32();
    const dataTypeSize = r.int16();
    const typeModifier = r.int32();
    const format = r.int16();
    if (
      tableOID === null ||
      columnAttr === null ||
      dataTypeOID === null ||
      dataTypeSize === null ||
      typeModifier === null ||
      format === null
    ) {
      throw new Error(MALFORMED);
    }
    fields.push({ name, tableOID, columnAttr, dataTypeOID, dataTypeSize, typeModifier, format });
  }
  return fields;
}

/**
 * Parse a DataRow ('D') body into column values. A SQL NULL (wire length -1) is
 * null; an empty (but non-NULL) column is a non-null zero-length Uint8Array —
 * callers MUST preserve this distinction (NULL→null vs ""→"").
 */
export function parseDataRow(body: Uint8Array): (Uint8Array | null)[] {
  const r = new Reader(body);
  const n = r.int16();
  if (n === null || n < 0) throw new Error(MALFORMED);
  const cols: (Uint8Array | null)[] = [];
  for (let i = 0; i < n; i++) {
    const l = r.int32();
    if (l === null) throw new Error(MALFORMED);
    if (l === -1) {
      cols.push(null); // SQL NULL
      continue;
    }
    if (l < 0) throw new Error(MALFORMED);
    const b = r.bytes(l); // empty column => non-null zero-length slice
    if (b === null) throw new Error(MALFORMED);
    cols.push(b);
  }
  return cols;
}

/**
 * Parse a CommandComplete ('C') body into the command tag's leading verb and its
 * trailing affected-row count (e.g. "SELECT 1" → {command:"SELECT",rowCount:1};
 * "INSERT 0 5" → {command:"INSERT",rowCount:5}; tags without a count → 0).
 */
export function parseCommandComplete(body: Uint8Array): { command: string; rowCount: number } {
  const r = new Reader(body);
  const tag = r.cstring();
  if (tag === null) throw new Error(MALFORMED);
  const parts = tag.split(/\s+/).filter((p) => p.length > 0);
  if (parts.length === 0) throw new Error(MALFORMED);
  const command = parts[0]!;
  let rowCount = 0;
  if (parts.length > 1) {
    const v = Number.parseInt(parts[parts.length - 1]!, 10);
    if (!Number.isNaN(v)) rowCount = v;
  }
  return { command, rowCount };
}

/** Transaction-status byte from a ReadyForQuery ('Z') body: 'I' | 'T' | 'E'. */
export function parseReadyForQuery(body: Uint8Array): number {
  if (body.length < 1) throw new Error(MALFORMED);
  return body[0]!;
}

/**
 * Parse an ErrorResponse ('E') / NoticeResponse ('N') body — a sequence of
 * (1-byte field-type + cstring) entries ending in a zero field-type byte — into
 * a PgWireError. Fields: S/V→severity, C→code (SQLSTATE), M→message, D→detail,
 * H→hint. Never throws; unknown field types are skipped.
 */
export function parseErrorResponse(body: Uint8Array): PgWireError {
  const e: PgWireError = { severity: "", code: "", message: "", detail: "", hint: "" };
  const r = new Reader(body);
  for (;;) {
    const ft = r.byte();
    if (ft === null || ft === 0) break;
    const val = r.cstring();
    if (val === null) break;
    switch (String.fromCharCode(ft)) {
      case "S":
      case "V": // Severity: localized 'S' / non-localized 'V' (prefer 'V')
        if (e.severity === "" || ft === 0x56 /* 'V' */) e.severity = val;
        break;
      case "C":
        e.code = val;
        break;
      case "M":
        e.message = val;
        break;
      case "D":
        e.detail = val;
        break;
      case "H":
        e.hint = val;
        break;
    }
  }
  return e;
}

/** Parse a NotificationResponse ('A') body: int32 pid, cstring channel, cstring payload. */
export function parseNotification(body: Uint8Array): {
  processId: number;
  channel: string;
  payload: string;
} {
  const r = new Reader(body);
  const processId = r.uint32();
  if (processId === null) throw new Error(MALFORMED);
  const channel = r.cstring();
  if (channel === null) throw new Error(MALFORMED);
  const payload = r.cstring();
  if (payload === null) throw new Error(MALFORMED);
  return { processId, channel, payload };
}

/**
 * Parse the leading int32 auth code from an Authentication ('R') body (0 ok, 3
 * cleartext, 5 md5, 10 SASL, 11 SASLContinue, 12 SASLFinal). Trailing bytes —
 * the 4-byte md5 salt or the SASL mechanism NUL-list — are consumed in Phase 6.
 */
export function parseAuthTag(body: Uint8Array): number {
  const r = new Reader(body);
  const t = r.int32();
  if (t === null) throw new Error(MALFORMED);
  return t;
}
