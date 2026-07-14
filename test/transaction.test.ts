import { describe, expect, test, vi } from "vitest";
import { neon } from "../src/http/query.js";

const CONN = "postgres://alice:s3cr3t@ep-x1.usc1.kisenon.com/appdb";
const nField = { name: "n", dataTypeID: 23, tableID: 0, columnID: 0, dataTypeSize: 4, dataTypeModifier: -1, format: "text" };

function env(rows: unknown[]) {
  return { command: "SELECT", rowCount: rows.length, fields: [nField], rows, rowAsArray: true };
}

describe("neon().transaction", () => {
  test("wraps queries under `queries` and returns one reshaped result per query", async () => {
    const fetchStub = vi.fn(async (_u: string, _i: RequestInit) =>
      new Response(JSON.stringify({ results: [env([["1"]]), env([["2"]])] }), { status: 200 }),
    );
    const sql = neon(CONN, { fetch: fetchStub as unknown as typeof fetch });
    const out = await sql.transaction([
      sql.query("SELECT 1 AS n"),
      sql.query("SELECT $1::int AS n", [2]),
    ]);
    expect(out).toEqual([[{ n: 1 }], [{ n: 2 }]]);

    const body = JSON.parse(fetchStub.mock.calls[0]![1]!.body as string);
    expect(Array.isArray(body.queries)).toBe(true);
    expect(body.queries).toHaveLength(2);
    expect(body.queries[0]).toEqual({ query: "SELECT 1 AS n" });
    expect(body.queries[1]).toEqual({ query: "SELECT $1::int AS n", params: [2] });
    // no bare top-level array
    expect(Array.isArray(body)).toBe(false);
  });

  test("did NOT execute the member queries individually (single batch POST)", async () => {
    const fetchStub = vi.fn(async (_u: string, _i: RequestInit) =>
      new Response(JSON.stringify({ results: [env([["1"]])] }), { status: 200 }),
    );
    const sql = neon(CONN, { fetch: fetchStub as unknown as typeof fetch });
    await sql.transaction([sql.query("SELECT 1 AS n")]);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  test("maps isolation/readOnly/deferrable to Neon-Batch-* headers", async () => {
    const fetchStub = vi.fn(async (_u: string, _i: RequestInit) =>
      new Response(JSON.stringify({ results: [env([["1"]])] }), { status: 200 }),
    );
    const sql = neon(CONN, { fetch: fetchStub as unknown as typeof fetch });
    await sql.transaction([sql.query("SELECT 1 AS n")], {
      isolationLevel: "Serializable",
      readOnly: true,
      deferrable: true,
    });
    const headers = new Headers(fetchStub.mock.calls[0]![1]!.headers);
    expect(headers.get("Neon-Batch-Isolation-Level")).toBe("Serializable");
    expect(headers.get("Neon-Batch-Read-Only")).toBe("true");
    expect(headers.get("Neon-Batch-Deferrable")).toBe("true");
  });

  test("accepts plain {query,params} members too", async () => {
    const fetchStub = vi.fn(async (_u: string, _i: RequestInit) =>
      new Response(JSON.stringify({ results: [env([["1"]])] }), { status: 200 }),
    );
    const sql = neon(CONN, { fetch: fetchStub as unknown as typeof fetch });
    await sql.transaction([{ query: "SELECT 1 AS n", params: [] }]);
    const body = JSON.parse(fetchStub.mock.calls[0]![1]!.body as string);
    expect(body.queries[0].query).toBe("SELECT 1 AS n");
  });

  test("readOnly:false emits READ WRITE header value", async () => {
    const fetchStub = vi.fn(async (_u: string, _i: RequestInit) =>
      new Response(JSON.stringify({ results: [env([["1"]])] }), { status: 200 }),
    );
    const sql = neon(CONN, { fetch: fetchStub as unknown as typeof fetch });
    await sql.transaction([sql.query("SELECT 1 AS n")], { readOnly: false });
    const headers = new Headers(fetchStub.mock.calls[0]![1]!.headers);
    expect(headers.get("Neon-Batch-Read-Only")).toBe("false");
  });
});
