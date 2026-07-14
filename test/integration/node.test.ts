// Node integration test (Phase 10, task 10.2) — exercises the full surface
// against a LIVE endpoint from the Node runtime. Skips cleanly when no
// DATABASE_URL is configured (see ./provision.ts).
//
// HTTP path: `neon()` tagged template, `Pool.query` one-shot, parameterized
// query, and `sql.transaction([...])` batch. WS path: a connection-pinned
// transaction over `pool.connect()` (BEGIN / temp-table INSERT / SELECT /
// COMMIT) and out-of-band LISTEN/NOTIFY on the pinned session.
//
// WS note: `pool.connect()` needs an outbound WebSocket. Node >= 22 has a
// global `WebSocket`, so no injection is required; on Node < 22 the runner must
// set `neonConfig.webSocketConstructor = ws` first (documented in the README).

import { describe, expect, it } from "vitest";
import { neon, Pool } from "../../src/index.js";
import { getDatabaseUrl, hasDatabaseUrl } from "./provision.js";

describe.skipIf(!hasDatabaseUrl)("Node integration (10.2)", () => {
  it("HTTP: neon() tagged template SELECT 1 AS n -> [{ n: 1 }]", async () => {
    const sql = neon(await getDatabaseUrl());
    const rows = (await sql`SELECT 1 AS n`) as Array<{ n: number }>;
    expect(rows).toEqual([{ n: 1 }]);
  });

  it("HTTP: Pool.query one-shot SELECT 1 AS n -> rows[0].n === 1", async () => {
    const pool = new Pool({ connectionString: await getDatabaseUrl() });
    try {
      const res = await pool.query("SELECT 1 AS n");
      const row = res.rows[0] as { n: number } | undefined;
      expect(row?.n).toBe(1);
    } finally {
      await pool.end();
    }
  });

  it("HTTP: parameterized query binds $1", async () => {
    const sql = neon(await getDatabaseUrl());
    const rows = (await sql.query("SELECT $1::int AS v", [42])) as Array<{
      v: number;
    }>;
    expect(rows[0]?.v).toBe(42);
  });

  it("HTTP: sql.transaction([...]) batches multiple statements", async () => {
    const sql = neon(await getDatabaseUrl());
    const results = (await sql.transaction([
      sql`SELECT 1 AS a`,
      sql`SELECT 2 AS b`,
    ])) as [Array<{ a: number }>, Array<{ b: number }>];
    expect(results[0]).toEqual([{ a: 1 }]);
    expect(results[1]).toEqual([{ b: 2 }]);
  });

  it("WS: pinned BEGIN/INSERT/SELECT/COMMIT over one session", async () => {
    const pool = new Pool({ connectionString: await getDatabaseUrl() });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Temp table is session-scoped and auto-drops when the pinned session
      // closes (pool.end below), so there is nothing to clean up in the DB.
      await client.query("CREATE TEMP TABLE kisenon_it (id int)");
      const ins = await client.query(
        "INSERT INTO kisenon_it (id) VALUES ($1)",
        [7],
      );
      expect(ins.command).toBe("INSERT");
      expect(ins.rowCount).toBe(1);
      const sel = await client.query("SELECT id FROM kisenon_it");
      expect(sel.rows).toEqual([{ id: 7 }]);
      await client.query("COMMIT");
    } finally {
      client.release();
      await pool.end();
    }
  });

  it(
    "WS: LISTEN + pg_notify fires the 'notification' event",
    async () => {
      const pool = new Pool({ connectionString: await getDatabaseUrl() });
      const client = await pool.connect();
      try {
        const got = new Promise<{ channel: string; payload: string }>(
          (resolve) => {
            client.on("notification", (n) =>
              resolve(n as { channel: string; payload: string }),
            );
          },
        );
        await client.query("LISTEN kisenon_chan");
        await client.query("SELECT pg_notify('kisenon_chan', 'hi')");
        // A follow-up round trip guarantees the async 'A' has been drained even
        // if the server did not piggyback it on the pg_notify response.
        await client.query("SELECT 1");
        const n = await got;
        expect(n.channel).toBe("kisenon_chan");
        expect(n.payload).toBe("hi");
      } finally {
        client.release();
        await pool.end();
      }
    },
    15_000,
  );
});
