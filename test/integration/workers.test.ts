/// <reference types="@cloudflare/vitest-pool-workers" />
// Cloudflare Workers integration test (Phase 10, task 10.3). Runs inside
// workerd via `@cloudflare/vitest-pool-workers` (Miniflare). This is the
// load-bearing WS runtime: Workers cannot `new WebSocket()` outbound, so the
// adapter takes the `fetch(url, { headers: { Upgrade } }) -> resp.webSocket
// .accept()` branch (src/ws/adapter.ts, branch 2). Run: `pnpm test:workers`.
//
// The endpoint URL arrives as a Worker binding (`env.DATABASE_URL`), wired in
// vitest.workers.config.ts from the host process env. Local runs may skip when
// it is absent; automation can require it through REQUIRE_INTEGRATION=1.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { neon, Pool } from "../../src/index.js";

// The binding is optional (absent until a live endpoint is configured).
declare module "cloudflare:test" {
  interface ProvidedEnv {
    DATABASE_URL?: string;
  }
}

const url = env.DATABASE_URL;

describe.skipIf(!url)("Workers integration (10.3)", () => {
  it("HTTP: neon() SELECT 1 AS n -> [{ n: 1 }]", async () => {
    const sql = neon(url!);
    const rows = (await sql`SELECT 1 AS n`) as Array<{ n: number }>;
    expect(rows).toEqual([{ n: 1 }]);
  });

  it("WS: pool.connect() pinned txn over the fetch-upgrade adapter branch", async () => {
    const pool = new Pool({ connectionString: url! });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("CREATE TEMP TABLE kisenon_it_w (id int)");
      await client.query("INSERT INTO kisenon_it_w (id) VALUES ($1)", [9]);
      const sel = await client.query("SELECT id FROM kisenon_it_w");
      expect(sel.rows).toEqual([{ id: 9 }]);
      await client.query("COMMIT");
    } finally {
      client.release();
      await pool.end();
    }
  });
});
