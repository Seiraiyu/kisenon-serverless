import { afterEach, describe, expect, test, vi } from "vitest";
import { neon } from "../src/http/query.js";

const CONN = "postgres://alice:s3cr3t@ep-x1.usc1.kisenon.com/appdb";

function envelope(fields: unknown[], rows: unknown[], command = "SELECT") {
  return { command, rowCount: rows.length, fields, rows, rowAsArray: true };
}

const nField = { name: "n", dataTypeID: 23, tableID: 0, columnID: 0, dataTypeSize: 4, dataTypeModifier: -1, format: "text" };

function stub(env: unknown) {
  return vi.fn(async (_u: string, _i: RequestInit) => new Response(JSON.stringify(env), { status: 200 }));
}

afterEach(() => vi.restoreAllMocks());

describe("neon() tagged template", () => {
  test("SELECT 1 AS n → [{ n: 1 }]", async () => {
    const fetchStub = stub(envelope([nField], [["1"]]));
    const sql = neon(CONN, { fetch: fetchStub as unknown as typeof fetch });
    const out = await sql`SELECT 1 AS n`;
    expect(out).toEqual([{ n: 1 }]);
    const body = JSON.parse(fetchStub.mock.calls[0]![1]!.body as string);
    expect(body.query).toBe("SELECT 1 AS n");
  });

  test("interpolated holes become $1,$2 placeholders + params", async () => {
    const fetchStub = stub(envelope([nField], [["7"]]));
    const sql = neon(CONN, { fetch: fetchStub as unknown as typeof fetch });
    const id = 7;
    const tag = "x";
    await sql`SELECT ${id} AS n WHERE t = ${tag}`;
    const body = JSON.parse(fetchStub.mock.calls[0]![1]!.body as string);
    expect(body.query).toBe("SELECT $1 AS n WHERE t = $2");
    expect(body.params).toEqual([7, "x"]);
  });

  test(".query(text, params) runs without templating", async () => {
    const fetchStub = stub(envelope([nField], [["1"]]));
    const sql = neon(CONN, { fetch: fetchStub as unknown as typeof fetch });
    const out = await sql.query("SELECT $1::int AS n", [1]);
    expect(out).toEqual([{ n: 1 }]);
    const body = JSON.parse(fetchStub.mock.calls[0]![1]!.body as string);
    expect(body).toEqual({ query: "SELECT $1::int AS n", params: [1] });
  });

  test("arrayMode option → array rows", async () => {
    const fetchStub = stub(envelope([nField], [["1"]]));
    const sql = neon(CONN, { fetch: fetchStub as unknown as typeof fetch, arrayMode: true });
    expect(await sql`SELECT 1 AS n`).toEqual([[1]]);
  });

  test("fullResults option → { rows, rowCount, fields, command }", async () => {
    const fetchStub = stub(envelope([nField], [["1"]]));
    const sql = neon(CONN, { fetch: fetchStub as unknown as typeof fetch, fullResults: true });
    const out = (await sql`SELECT 1 AS n`) as {
      rows: unknown[];
      rowCount: number;
      command: string;
    };
    expect(out.rows).toEqual([{ n: 1 }]);
    expect(out.rowCount).toBe(1);
    expect(out.command).toBe("SELECT");
  });

  test("per-call opts on .query override the neon() defaults", async () => {
    const fetchStub = stub(envelope([nField], [["1"]]));
    const sql = neon(CONN, { fetch: fetchStub as unknown as typeof fetch });
    const out = await sql.query("SELECT 1 AS n", [], { arrayMode: true });
    expect(out).toEqual([[1]]);
  });
});
