import { afterEach, describe, expect, test, vi } from "vitest";
import { neonConfig } from "../src/config.js";
import { Pool } from "../src/pool.js";

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
function beMsg(type: number, body: Uint8Array): Uint8Array {
  return concat(new Uint8Array([type]), i32(body.length + 4), body);
}
const authOk = () => beMsg(0x52, i32(0));
const readyForQuery = (st = "I") => beMsg(0x5a, new Uint8Array([st.charCodeAt(0)]));
const commandComplete = (tag: string) => beMsg(0x43, cstr(tag));
const notification = (pid: number, chan: string, payload: string) =>
  beMsg(0x41, concat(i32(pid), cstr(chan), cstr(payload)));
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

/** A StartupMessage is untyped: int32 len + int32 196608 (00 03 00 00). */
function isStartup(u: Uint8Array): boolean {
  return u.length >= 8 && u[4] === 0 && u[5] === 3 && u[6] === 0 && u[7] === 0;
}
/** SQL text of a simple Query ('Q') message: header(5) + cstring. */
function queryText(u: Uint8Array): string {
  const body = u.subarray(5);
  const nul = body.indexOf(0);
  return dec.decode(nul < 0 ? body : body.subarray(0, nul));
}

// --- scripted fake WebSocket constructor (branch 1: injected ctor) ----------

type Script = (data: Uint8Array, seq: number, emit: (bytes: Uint8Array) => void) => void;

interface FakeWs {
  url: string;
  sends: Uint8Array[];
}

function fakeWsCtor(script: Script): {
  ctor: new (url: string) => unknown;
  instances: FakeWs[];
} {
  const instances: FakeWs[] = [];
  class FakeWS {
    binaryType = "";
    readonly url: string;
    readonly sends: Uint8Array[] = [];
    private readonly listeners: Record<string, ((ev: unknown) => void)[]> = {};
    constructor(url: string) {
      this.url = url;
      instances.push(this);
      queueMicrotask(() => this.fire("open", {}));
    }
    addEventListener(type: string, cb: (ev: unknown) => void): void {
      (this.listeners[type] ??= []).push(cb);
    }
    send(data: ArrayBuffer): void {
      const u = new Uint8Array(data);
      this.sends.push(u);
      script(u, this.sends.length - 1, (bytes) => this.fire("message", { data: bytes }));
    }
    close(): void {
      this.fire("close", { code: 1000, reason: "" });
    }
    private fire(type: string, ev: unknown): void {
      for (const cb of this.listeners[type] ?? []) cb(ev);
    }
  }
  return { ctor: FakeWS as unknown as new (url: string) => unknown, instances };
}

const CONN = "postgres://kisenon_user:secret@ep.usc1.kisenon.com/main";
const NO_WS_ERROR =
  "No WebSocket implementation: this runtime has no outbound WebSocket (e.g. Vercel Edge). " +
  "Use the HTTP path (neon()/pool.query) or set neonConfig.webSocketConstructor.";

afterEach(() => {
  delete neonConfig.webSocketConstructor;
  vi.unstubAllGlobals();
});

// --- 8.2 — pinned transaction on ONE session --------------------------------

describe("pool.connect() — pinned session (8.2)", () => {
  test("BEGIN/INSERT/SELECT/COMMIT run on the same session; release() returns it", async () => {
    const { ctor, instances } = fakeWsCtor((data, seq, emit) => {
      if (seq === 0 && isStartup(data)) {
        emit(concat(authOk(), readyForQuery("I"))); // trust auth
        return;
      }
      if (data[0] === 0x51 /* 'Q' */) {
        const sql = queryText(data);
        if (sql.startsWith("BEGIN")) emit(concat(commandComplete("BEGIN"), readyForQuery("T")));
        else if (sql.startsWith("INSERT"))
          emit(concat(commandComplete("INSERT 0 1"), readyForQuery("T")));
        else if (sql.startsWith("SELECT"))
          emit(
            concat(
              rowDescription([{ name: "id", oid: 23 }]),
              dataRow(["42"]),
              commandComplete("SELECT 1"),
              readyForQuery("T"),
            ),
          );
        else if (sql.startsWith("COMMIT")) emit(concat(commandComplete("COMMIT"), readyForQuery("I")));
      }
    });
    neonConfig.webSocketConstructor = ctor;

    const pool = new Pool(CONN);
    const c = await pool.connect();
    const begin = await c.query("BEGIN");
    const ins = await c.query("INSERT INTO t VALUES (42)");
    const sel = await c.query("SELECT id FROM t");
    const commit = await c.query("COMMIT");

    expect(begin.command).toBe("BEGIN");
    expect(ins.command).toBe("INSERT");
    expect(ins.rowCount).toBe(1);
    expect(sel.rows).toEqual([{ id: 42 }]);
    expect(commit.command).toBe("COMMIT");

    // One socket ⇒ one Startup ⇒ one auth: all four queries shared the session.
    expect(instances).toHaveLength(1);
    const startups = instances[0]!.sends.filter(isStartup);
    expect(startups).toHaveLength(1);

    // release() returns the session; a second connect() reuses it (no new socket).
    c.release();
    const c2 = await pool.connect();
    expect(instances).toHaveLength(1);
    expect(c2).toBe(c);

    await pool.end();
  });
});

// --- 8.3 — LISTEN/NOTIFY routed to the "notification" event -----------------

describe("pool.connect() — LISTEN/NOTIFY (8.3)", () => {
  test("out-of-band 'A' during draining fires on('notification'), not query output", async () => {
    const { ctor } = fakeWsCtor((data, seq, emit) => {
      if (seq === 0 && isStartup(data)) {
        emit(concat(authOk(), readyForQuery("I")));
        return;
      }
      if (data[0] === 0x51 /* 'Q' */ && queryText(data).startsWith("LISTEN")) {
        // A NOTIFY that arrived mid-drain: CommandComplete, then 'A', then Z.
        emit(
          concat(
            commandComplete("LISTEN"),
            notification(4242, "chan", "hi"),
            readyForQuery("I"),
          ),
        );
      }
    });
    neonConfig.webSocketConstructor = ctor;

    const pool = new Pool(CONN);
    const c = await pool.connect();

    const events: { channel: string; payload: string }[] = [];
    c.on("notification", (n) => events.push(n as { channel: string; payload: string }));

    const res = await c.query("LISTEN chan");
    expect(res.command).toBe("LISTEN");
    expect(res.rows).toEqual([]); // 'A' was NOT mistaken for a data row
    expect(events).toEqual([{ processId: 4242, channel: "chan", payload: "hi" }]);

    await pool.end();
  });
});

// --- 8.4 — WS-absent fallback: connect() throws, query() works over HTTP -----

describe("pool — no outbound WebSocket (8.4)", () => {
  test("connect() rejects with the exact no-WS error; query() still works over HTTP", async () => {
    vi.stubGlobal("WebSocket", undefined);
    vi.stubGlobal("WebSocketPair", undefined);
    vi.stubGlobal("navigator", undefined);
    delete neonConfig.webSocketConstructor;

    const stubFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            command: "SELECT",
            rowCount: 1,
            fields: [{ name: "n", dataTypeID: 23 }],
            rows: [["1"]],
            rowAsArray: true,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );

    const pool = new Pool({ connectionString: CONN, fetch: stubFetch as unknown as typeof fetch });

    await expect(pool.connect()).rejects.toThrow(NO_WS_ERROR);

    const res = await pool.query("SELECT 1");
    expect(res.rows).toEqual([{ n: 1 }]);
    expect(stubFetch).toHaveBeenCalledTimes(1);

    await pool.end();
  });
});
