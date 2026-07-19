import { describe, expect, test } from "vitest";
import type { ConnectionConfig } from "../src/connection-string.js";
import { md5AuthResponse } from "../src/auth/md5.js";
import { scramProof } from "../src/auth/scram.js";
import { WireConnection, sessionQuery, startSession } from "../src/ws/connection.js";
import type { WsSocket } from "../src/ws/adapter.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

// --- backend-message builders (a scripted fake compute speaks these) --------

function concat(...arrs: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const a of arrs) n += a.length;
  const out = new Uint8Array(n);
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}
function i16(v: number): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setInt16(0, v, false);
  return b;
}
function i32(v: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, v, false);
  return b;
}
function cstr(s: string): Uint8Array {
  return concat(enc.encode(s), new Uint8Array([0]));
}
/** type byte + int32 length (incl. its 4 bytes) + body. */
function beMsg(type: number, body: Uint8Array): Uint8Array {
  return concat(new Uint8Array([type]), i32(body.length + 4), body);
}
const authMd5 = (salt: Uint8Array) => beMsg(0x52, concat(i32(5), salt));
const authOk = () => beMsg(0x52, i32(0));
const authSASL = () => beMsg(0x52, concat(i32(10), cstr("SCRAM-SHA-256"), new Uint8Array([0])));
const authSASLContinue = (s: string) => beMsg(0x52, concat(i32(11), enc.encode(s)));
const authSASLFinal = (s: string) => beMsg(0x52, concat(i32(12), enc.encode(s)));
const paramStatus = (k: string, v: string) => beMsg(0x53, concat(cstr(k), cstr(v)));
const readyForQuery = (st = "I") => beMsg(0x5a, new Uint8Array([st.charCodeAt(0)]));
const commandComplete = (tag: string) => beMsg(0x43, cstr(tag));
function rowDescription(cols: { name: string; oid: number }[]): Uint8Array {
  let body = i16(cols.length);
  for (const c of cols) {
    body = concat(body, cstr(c.name), i32(0), i16(0), i32(c.oid), i16(4), i32(-1), i16(0));
  }
  return beMsg(0x54, body);
}
function dataRow(vals: (string | null)[]): Uint8Array {
  let body = i16(vals.length);
  for (const v of vals) {
    if (v === null) body = concat(body, i32(-1));
    else body = concat(body, i32(enc.encode(v).length), enc.encode(v));
  }
  return beMsg(0x44, body);
}

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

// --- paired fake compute (a WsSocket the WireConnection drives) -------------

type Script = (data: Uint8Array, seq: number, emit: (bytes: Uint8Array) => void) => void;

class FakeCompute implements WsSocket {
  readonly ready = Promise.resolve();
  readonly clientSends: Uint8Array[] = [];
  closeCount = 0;
  closeInfo: { code?: number; reason?: string } | null = null;
  private msgCb: ((d: Uint8Array) => void) | null = null;
  private closeCb: ((i: { code: number; reason: string }) => void) | null = null;
  constructor(private readonly script: Script) {}
  send(data: Uint8Array): void {
    const seq = this.clientSends.length;
    this.clientSends.push(data);
    this.script(data, seq, (bytes) => this.msgCb?.(bytes));
  }
  onMessage(cb: (d: Uint8Array) => void): void {
    this.msgCb = cb;
  }
  onClose(cb: (i: { code: number; reason: string }) => void): void {
    this.closeCb = cb;
  }
  close(code?: number, reason?: string): void {
    this.closeCount += 1;
    this.closeInfo = { code, reason };
    this.closeCb?.({ code: code ?? 1000, reason: reason ?? "" });
  }
  emit(bytes: Uint8Array): void {
    this.msgCb?.(bytes);
  }
}

describe("WireConnection (7.2)", () => {
  test("closes the socket when a message exceeds the 16 MiB ceiling", async () => {
    const fake = new FakeCompute(() => {});
    const conn = new WireConnection(fake);
    const next = conn.nextMessage();
    const header = new Uint8Array(5);
    header[0] = 0x44; // 'D'
    new DataView(header.buffer).setUint32(1, 17 * 1024 * 1024, false);

    fake.emit(header);

    await expect(next).rejects.toThrow(/exceeds 16 MiB ceiling/i);
    expect(fake.closeCount).toBe(1);
    expect(fake.closeInfo).toEqual({ code: 1002, reason: "invalid postgres message" });
    await expect(conn.nextMessage()).rejects.toThrow(/exceeds 16 MiB ceiling/i);
  });
});

const cfg = (over: Partial<ConnectionConfig> = {}): ConnectionConfig => ({
  host: "ep.usc1.kisenon.com",
  port: 5432,
  user: "kisenon_user",
  password: "secret",
  database: "main",
  ssl: true,
  ...over,
});

describe("startSession — md5 auth (7.3)", () => {
  test("sends the md5 PasswordMessage and drains to ReadyForQuery", async () => {
    const salt = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
    const fake = new FakeCompute((data, seq, emit) => {
      if (seq === 0) {
        emit(authMd5(salt)); // response to StartupMessage
      } else if (data[0] === 0x70 /* 'p' */) {
        // one coalesced frame — exercises the reassembler splitting 3 messages.
        emit(concat(authOk(), paramStatus("server_version", "16.1"), readyForQuery("I")));
      }
    });
    const conn = new WireConnection(fake);
    const c = cfg();
    const state = await startSession(conn, c);

    expect(fake.clientSends).toHaveLength(2);
    expect(fake.clientSends[1]).toEqual(md5AuthResponse(c.user, c.password, salt));
    expect(state.parameters["server_version"]).toBe("16.1");
    expect(state.transactionStatus).toBe(0x49 /* 'I' */);
  });
});

describe("startSession — SCRAM auth (7.3)", () => {
  test("drives the SASL handshake and completes on AuthenticationOk", async () => {
    let clientBare = "";
    let serverFirst = "";
    let pCount = 0;
    const password = "pencil";
    const fake = new FakeCompute((data, seq, emit) => {
      if (seq === 0) {
        emit(authSASL());
        return;
      }
      if (data[0] !== 0x70 /* 'p' */) return;
      pCount += 1;
      if (pCount === 1) {
        // SASLInitialResponse — recover the client nonce from the client-first.
        const text = dec.decode(data);
        const m = /n,,n=,r=([A-Za-z0-9+/=]+)/.exec(text);
        const clientNonce = m ? m[1]! : "";
        clientBare = "n=,r=" + clientNonce;
        const serverNonce = clientNonce + "3rfcNHYJY1ZVvWVs7j";
        serverFirst = `r=${serverNonce},s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096`;
        emit(authSASLContinue(serverFirst));
      } else {
        // SASLResponse — reuse the deterministic proof math for the ServerSignature.
        void scramProof(password, clientBare, serverFirst).then((proof) => {
          emit(
            concat(
              authSASLFinal("v=" + b64(proof.expectedServerSig)),
              authOk(),
              readyForQuery("I"),
            ),
          );
        });
      }
    });
    const conn = new WireConnection(fake);
    await expect(startSession(conn, cfg({ password }))).resolves.toBeDefined();
    // Startup + SASLInitial + SASLResponse.
    expect(fake.clientSends).toHaveLength(3);
    expect(fake.clientSends[1]![0]).toBe(0x70);
    expect(fake.clientSends[2]![0]).toBe(0x70);
  });
});

describe("sessionQuery (7.4)", () => {
  async function boot(script: Script): Promise<WireConnection> {
    const conn = new WireConnection(new FakeCompute(script));
    await startSession(conn, cfg({ password: "" }));
    return conn;
  }

  test("simple protocol: SELECT 1 AS n -> rows[0].n === 1", async () => {
    const conn = await boot((data, seq, emit) => {
      if (seq === 0) {
        emit(concat(authOk(), readyForQuery("I")));
      } else if (data[0] === 0x51 /* 'Q' */) {
        emit(
          concat(
            rowDescription([{ name: "n", oid: 23 }]),
            dataRow(["1"]),
            commandComplete("SELECT 1"),
            readyForQuery("I"),
          ),
        );
      }
    });
    const res = await sessionQuery(conn, "SELECT 1 AS n");
    expect(res.rows).toEqual([{ n: 1 }]);
    expect(res.command).toBe("SELECT");
    expect(res.rowCount).toBe(1);
    expect(res.fields[0]).toMatchObject({ name: "n", dataTypeID: 23, format: "text" });
  });

  test("extended protocol: one param -> rows[0].n === 7", async () => {
    const conn = await boot((data, seq, emit) => {
      if (seq === 0) {
        emit(concat(authOk(), readyForQuery("I")));
      } else if (data[0] === 0x53 /* 'S' Sync */) {
        emit(
          concat(
            beMsg(0x31, new Uint8Array(0)), // ParseComplete '1'
            beMsg(0x32, new Uint8Array(0)), // BindComplete '2'
            rowDescription([{ name: "n", oid: 23 }]),
            dataRow(["7"]),
            commandComplete("SELECT 1"),
            readyForQuery("I"),
          ),
        );
      }
    });
    const res = await sessionQuery(conn, "SELECT $1::int AS n", [7]);
    expect(res.rows).toEqual([{ n: 7 }]);
    expect(res.command).toBe("SELECT");
  });

  test("extended protocol: bytea param binds as \\x hex, not String()", async () => {
    // Regression for the WS param-encoding bug: a Uint8Array param must go on the
    // wire as the Postgres text literal \x48656c6c6f, not "72,101,108,108,111".
    const sends: Uint8Array[] = [];
    const conn = await boot((data, seq, emit) => {
      sends.push(data);
      if (seq === 0) {
        emit(concat(authOk(), readyForQuery("I")));
      } else if (data[0] === 0x53 /* 'S' Sync */) {
        emit(
          concat(
            beMsg(0x31, new Uint8Array(0)), // ParseComplete
            beMsg(0x32, new Uint8Array(0)), // BindComplete
            rowDescription([{ name: "b", oid: 17 }]),
            dataRow(["\\x48656c6c6f"]),
            commandComplete("SELECT 1"),
            readyForQuery("I"),
          ),
        );
      }
    });
    await sessionQuery(conn, "SELECT $1 AS b", [
      new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]),
    ]);
    const wire = sends.map((d) => String.fromCharCode(...d)).join("");
    expect(wire).toContain("\\x48656c6c6f");
    expect(wire).not.toContain("72,101,108,108,111");
  });

  test("ErrorResponse throws DatabaseError", async () => {
    const conn = await boot((data, seq, emit) => {
      if (seq === 0) {
        emit(concat(authOk(), readyForQuery("I")));
      } else if (data[0] === 0x51 /* 'Q' */) {
        const body = concat(
          new Uint8Array([0x43]),
          cstr("42601"), // C: SQLSTATE
          new Uint8Array([0x4d]),
          cstr("syntax error"), // M: message
          new Uint8Array([0]),
        );
        emit(beMsg(0x45, body)); // 'E' ErrorResponse
      }
    });
    await expect(sessionQuery(conn, "SELCT 1")).rejects.toThrow("syntax error");
  });
});
