import { describe, expect, test, vi } from "vitest";
import { EventEmitter } from "../src/event-emitter.js";
import { Pool } from "../src/pool.js";

const CONN = "postgres://alice:s3cr3t@ep-x1.usc1.kisenon.com/appdb";
const nField = { name: "n", dataTypeID: 23, tableID: 0, columnID: 0, dataTypeSize: 4, dataTypeModifier: -1, format: "text" };

function stub(rows: unknown[], command = "SELECT") {
  return vi.fn(async (_u: string, _i: RequestInit) =>
    new Response(
      JSON.stringify({ command, rowCount: rows.length, fields: [nField], rows, rowAsArray: true }),
      { status: 200 },
    ),
  );
}

describe("Pool", () => {
  test("is an EventEmitter", () => {
    expect(new Pool(CONN)).toBeInstanceOf(EventEmitter);
  });

  test("query(text, params) → HTTP one-shot PgResult", async () => {
    const fetchStub = stub([["1"]]);
    const pool = new Pool({ connectionString: CONN, fetch: fetchStub as unknown as typeof fetch });
    const res = await pool.query("SELECT $1::int AS n", [1]);
    expect((res.rows[0] as { n: number }).n).toBe(1);
    expect(res.rowCount).toBe(1);
    expect(res.command).toBe("SELECT");
  });

  test("query({text, rowMode:'array'}) → array rows + {rows,rowCount,fields,command} parity", async () => {
    const fetchStub = stub([["1"]]);
    const pool = new Pool({ connectionString: CONN, fetch: fetchStub as unknown as typeof fetch });
    const res = await pool.query({ text: "SELECT 1 AS n", rowMode: "array" });
    expect(res.rows[0]).toEqual([1]);
    expect(res).toHaveProperty("rows");
    expect(res).toHaveProperty("rowCount");
    expect(res).toHaveProperty("fields");
    expect(res).toHaveProperty("command");
  });

  test("connect() with no outbound WebSocket rejects with the actionable no-WS error", async () => {
    // Happy-path connect() over a pinned WS session is covered in pool-ws.test.ts;
    // here assert the WS-absent runtime (e.g. Vercel Edge) surfaces the adapter's
    // actionable error rather than a stray placeholder.
    vi.stubGlobal("WebSocket", undefined);
    vi.stubGlobal("WebSocketPair", undefined);
    vi.stubGlobal("navigator", undefined);
    try {
      const pool = new Pool(CONN);
      await expect(pool.connect()).rejects.toThrow(
        "No WebSocket implementation: this runtime has no outbound WebSocket (e.g. Vercel Edge). " +
          "Use the HTTP path (neon()/pool.query) or set neonConfig.webSocketConstructor.",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("end() resolves and emits 'end'", async () => {
    const pool = new Pool(CONN);
    const seen = vi.fn();
    pool.on("end", seen);
    await expect(pool.end()).resolves.toBeUndefined();
    expect(seen).toHaveBeenCalledTimes(1);
  });
});
