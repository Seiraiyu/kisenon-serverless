import { describe, expect, test, vi } from "vitest";
import { Client } from "../src/client.js";
import { EventEmitter } from "../src/event-emitter.js";

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

describe("Client", () => {
  test("is an EventEmitter", () => {
    expect(new Client(CONN)).toBeInstanceOf(EventEmitter);
  });

  test("query(text, params) → PgResult with object rows", async () => {
    const fetchStub = stub([["1"]]);
    const client = new Client({ connectionString: CONN, fetch: fetchStub as unknown as typeof fetch });
    const res = await client.query("SELECT $1::int AS n", [1]);
    expect((res.rows[0] as { n: number }).n).toBe(1);
    expect(res.rowCount).toBe(1);
    expect(res.command).toBe("SELECT");
    expect(res.fields[0]!.name).toBe("n");
  });

  test("query({text, values}) config-object overload", async () => {
    const fetchStub = stub([["1"]]);
    const client = new Client({ connectionString: CONN, fetch: fetchStub as unknown as typeof fetch });
    const res = await client.query({ text: "SELECT 1 AS n" });
    expect((res.rows[0] as { n: number }).n).toBe(1);
    const body = JSON.parse(fetchStub.mock.calls[0]![1]!.body as string);
    expect(body.query).toBe("SELECT 1 AS n");
  });

  test("query({text, rowMode:'array'}) → array rows", async () => {
    const fetchStub = stub([["1"]]);
    const client = new Client({ connectionString: CONN, fetch: fetchStub as unknown as typeof fetch });
    const res = await client.query({ text: "SELECT 1 AS n", rowMode: "array" });
    expect(res.rows[0]).toEqual([1]);
  });

  test("connect() and end() resolve (HTTP one-shots need no session)", async () => {
    const client = new Client(CONN);
    await expect(client.connect()).resolves.toBeUndefined();
    await expect(client.end()).resolves.toBeUndefined();
  });

  test("end() emits 'end'", async () => {
    const client = new Client(CONN);
    const seen = vi.fn();
    client.on("end", seen);
    await client.end();
    expect(seen).toHaveBeenCalledTimes(1);
  });
});
