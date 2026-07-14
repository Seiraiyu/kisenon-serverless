// @vitest-environment edge-runtime
//
// Vercel Edge integration test (Phase 10, task 10.4). Runs under the
// `edge-runtime` environment (an outbound-WebSocket-less VM). Asserts the HTTP
// path works and that `pool.connect()` throws the EXACT actionable no-WS error
// from src/ws/adapter.ts (branch 4) — the error that points Edge callers at the
// HTTP transport. Skips cleanly when no DATABASE_URL is configured.
//
// This runs under `pnpm test:integration` (which uses the default runner, whose
// per-file `@vitest-environment` docblock above selects edge-runtime). It is
// excluded from the default `pnpm test` unit run.

import { describe, expect, it } from "vitest";
import { neon, Pool } from "../../src/index.js";
import { getDatabaseUrl, hasDatabaseUrl } from "./provision.js";

// Must match src/ws/adapter.ts NO_WEBSOCKET_ERROR verbatim.
const NO_WS_ERROR =
  "No WebSocket implementation: this runtime has no outbound WebSocket (e.g. Vercel Edge). " +
  "Use the HTTP path (neon()/pool.query) or set neonConfig.webSocketConstructor.";

describe.skipIf(!hasDatabaseUrl)("Edge integration (10.4)", () => {
  it("HTTP: neon() SELECT 1 AS n works on the edge runtime", async () => {
    const sql = neon(await getDatabaseUrl());
    const rows = (await sql`SELECT 1 AS n`) as Array<{ n: number }>;
    expect(rows).toEqual([{ n: 1 }]);
  });

  it("HTTP: Pool.query one-shot works on the edge runtime", async () => {
    const pool = new Pool({ connectionString: await getDatabaseUrl() });
    try {
      const res = await pool.query("SELECT 1 AS n");
      const row = res.rows[0] as { n: number } | undefined;
      expect(row?.n).toBe(1);
    } finally {
      await pool.end();
    }
  });

  it("WS: pool.connect() throws the exact no-WS error (no outbound WS)", async () => {
    const pool = new Pool({ connectionString: await getDatabaseUrl() });
    await expect(pool.connect()).rejects.toThrow(NO_WS_ERROR);
    await pool.end();
  });
});
