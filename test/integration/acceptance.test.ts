// ACCEPTANCE GATE (Phase 10, task 10.5). The phase's pass/fail bar: `SELECT 1`
// returns `1` over BOTH transports (HTTP `/sql` and WebSocket `/v2`), proving
// the client is wire-correct end-to-end against a live kisenon endpoint.
//
// This file covers the Node cells (HTTP + WS). The Workers cells of the gate
// (HTTP + WS from workerd) live in workers.test.ts and run via
// `pnpm test:workers` — the two runners together satisfy the design's
// four-cell proof (HTTP+WS × Node+Workers). Skips cleanly with no DATABASE_URL.
//
// TODO(#2134): wire into seiraiyu-neon scripts/verify behavior post-publish
// (cross-repo Tier-3: the published @kisenon/serverless package run against the
// live endpoint). Out of scope here — do not touch seiraiyu-neon.

import { describe, expect, it } from "vitest";
import { neon, Pool } from "../../src/index.js";
import { getDatabaseUrl, hasDatabaseUrl } from "./provision.js";

describe.skipIf(!hasDatabaseUrl)("Acceptance gate — SELECT 1 (10.5)", () => {
  it("HTTP: SELECT 1 -> 1 (neon over /sql)", async () => {
    const sql = neon(await getDatabaseUrl());
    const rows = (await sql`SELECT 1 AS one`) as Array<{ one: number }>;
    expect(rows[0]?.one).toBe(1);
  });

  it("HTTP: SELECT 1 -> 1 (Pool.query over /sql)", async () => {
    const pool = new Pool({ connectionString: await getDatabaseUrl() });
    try {
      const res = await pool.query("SELECT 1 AS one");
      const row = res.rows[0] as { one: number } | undefined;
      expect(row?.one).toBe(1);
    } finally {
      await pool.end();
    }
  });

  it("WS: SELECT 1 -> 1 (pinned session over /v2)", async () => {
    const pool = new Pool({ connectionString: await getDatabaseUrl() });
    const client = await pool.connect();
    try {
      const res = await client.query("SELECT 1 AS one");
      const row = res.rows[0] as { one: number } | undefined;
      expect(row?.one).toBe(1);
    } finally {
      client.release();
      await pool.end();
    }
  });
});
