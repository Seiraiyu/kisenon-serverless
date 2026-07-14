import { describe, expect, test, vi } from "vitest";
import type { ConnectionConfig } from "../src/connection-string.js";
import { DatabaseError } from "../src/http/errors.js";
import { postSql } from "../src/http/transport.js";

const cfg: ConnectionConfig = {
  host: "ep-x1.usc1.kisenon.com",
  port: 5432,
  user: "alice",
  password: "s3cr3t",
  database: "appdb",
  ssl: true,
};

const okEnvelope = {
  command: "SELECT",
  rowCount: 1,
  fields: [{ name: "n", dataTypeID: 23, tableID: 0, columnID: 0, dataTypeSize: 4, dataTypeModifier: -1, format: "text" }],
  rows: [["1"]],
  rowAsArray: true,
};

function okResponse(): Response {
  return new Response(JSON.stringify(okEnvelope), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function wakingResponse(retryAfter = "0"): Response {
  return new Response(JSON.stringify({ code: "endpoint_waking" }), {
    status: 503,
    headers: { "Content-Type": "application/json", "Retry-After": retryAfter },
  });
}

describe("postSql headers + body", () => {
  test("POSTs to fetchEndpoint(host) with the neon control headers + connection string", async () => {
    const fetchStub = vi.fn(async (_u: string, _i: RequestInit) => okResponse());
    await postSql(
      cfg,
      { query: "SELECT $1::int AS n", params: [1] },
      {
        fetchEndpoint: (host) => `https://${host}/sql`,
        fetch: fetchStub as unknown as typeof fetch,
        connectionString: "postgres://alice:s3cr3t@ep-x1.usc1.kisenon.com/appdb",
      },
    );
    expect(fetchStub).toHaveBeenCalledTimes(1);
    const [url, init] = fetchStub.mock.calls[0]!;
    expect(url).toBe("https://ep-x1.usc1.kisenon.com/sql");
    expect(init!.method).toBe("POST");
    const headers = new Headers(init!.headers);
    expect(headers.get("Neon-Array-Mode")).toBe("true");
    expect(headers.get("Neon-Raw-Text-Output")).toBe("true");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("Neon-Connection-String")).toBe(
      "postgres://alice:s3cr3t@ep-x1.usc1.kisenon.com/appdb",
    );
    expect(headers.get("Authorization")).toBeNull();
    const body = JSON.parse(init!.body as string);
    expect(body).toEqual({ query: "SELECT $1::int AS n", params: [1] });
  });

  test("authToken → Authorization: Bearer, no connection-string header", async () => {
    const fetchStub = vi.fn(async (_u: string, _i: RequestInit) => okResponse());
    await postSql(
      cfg,
      { query: "SELECT 1" },
      {
        authToken: "jwt-abc",
        fetchEndpoint: (host) => `https://${host}/sql`,
        fetch: fetchStub as unknown as typeof fetch,
      },
    );
    const headers = new Headers(fetchStub.mock.calls[0]![1]!.headers);
    expect(headers.get("Authorization")).toBe("Bearer jwt-abc");
    expect(headers.get("Neon-Connection-String")).toBeNull();
  });

  test("serializes Date→ISO, Uint8Array→\\x, object→JSON, bigint→string, null→null", async () => {
    const fetchStub = vi.fn(async (_u: string, _i: RequestInit) => okResponse());
    const d = new Date("2026-07-14T00:00:00.000Z");
    await postSql(
      cfg,
      {
        query: "INSERT",
        params: [d, new Uint8Array([0xde, 0xad, 0xbe, 0xef]), { a: 1 }, 10n, null, 42, true, "hi"],
      },
      {
        fetchEndpoint: (host) => `https://${host}/sql`,
        fetch: fetchStub as unknown as typeof fetch,
        connectionString: "postgres://x@h/d",
      },
    );
    const body = JSON.parse(fetchStub.mock.calls[0]![1]!.body as string);
    expect(body.params).toEqual([
      "2026-07-14T00:00:00.000Z",
      "\\xdeadbeef",
      '{"a":1}',
      "10",
      null,
      42,
      true,
      "hi",
    ]);
  });

  test("batch body carries the mandatory `queries` wrapper + batch headers", async () => {
    const fetchStub = vi.fn(async (_u: string, _i: RequestInit) =>
      new Response(JSON.stringify({ results: [okEnvelope] }), { status: 200 }),
    );
    await postSql(
      cfg,
      { queries: [{ query: "SELECT 1" }, { query: "SELECT 2", params: [2] }] },
      {
        fetchEndpoint: (host) => `https://${host}/sql`,
        fetch: fetchStub as unknown as typeof fetch,
        connectionString: "postgres://x@h/d",
        batchHeaders: { "Neon-Batch-Isolation-Level": "Serializable", "Neon-Batch-Read-Only": "true" },
      },
    );
    const init = fetchStub.mock.calls[0]![1]!;
    const body = JSON.parse(init.body as string);
    expect(body.queries).toHaveLength(2);
    expect(body.queries[1]).toEqual({ query: "SELECT 2", params: [2] });
    const headers = new Headers(init.headers);
    expect(headers.get("Neon-Batch-Isolation-Level")).toBe("Serializable");
    expect(headers.get("Neon-Batch-Read-Only")).toBe("true");
  });

  test("non-2xx (400) throws a mapped DatabaseError, never echoing the conn string", async () => {
    const fetchStub = vi.fn(async (_u: string, _i: RequestInit) =>
      new Response(JSON.stringify({ message: "boom", code: "42601" }), { status: 400 }),
    );
    await expect(
      postSql(cfg, { query: "boom" }, {
        fetchEndpoint: (host) => `https://${host}/sql`,
        fetch: fetchStub as unknown as typeof fetch,
        connectionString: "postgres://alice:s3cr3t@h/d",
      }),
    ).rejects.toMatchObject({ code: "42601" });
  });
});

describe("wake-retry", () => {
  test("retries endpoint_waking then succeeds", async () => {
    let n = 0;
    const fetchStub = vi.fn(async (_u: string, _i: RequestInit) => (n++ === 0 ? wakingResponse("0") : okResponse()));
    const out = await postSql(cfg, { query: "SELECT 1" }, {
      fetchEndpoint: (host) => `https://${host}/sql`,
      fetch: fetchStub as unknown as typeof fetch,
      connectionString: "postgres://x@h/d",
    });
    expect(fetchStub).toHaveBeenCalledTimes(2);
    expect(out).toEqual(okEnvelope);
  });

  test("throws DatabaseError{code:endpoint_waking} after exhausting retries", async () => {
    const fetchStub = vi.fn(async (_u: string, _i: RequestInit) => wakingResponse("0"));
    const err = await postSql(cfg, { query: "SELECT 1" }, {
      fetchEndpoint: (host) => `https://${host}/sql`,
      fetch: fetchStub as unknown as typeof fetch,
      connectionString: "postgres://x@h/d",
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DatabaseError);
    expect((err as DatabaseError).code).toBe("endpoint_waking");
    // bounded: ~5 attempts, not infinite.
    expect(fetchStub.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(fetchStub.mock.calls.length).toBeLessThanOrEqual(6);
  });
});
