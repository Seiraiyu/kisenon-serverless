// ORM parity fixture (Phase 10, task 10.5). Proves `pg`-surface parity by
// running a real ORM — Drizzle's `neon-serverless` adapter — over
// `@kisenon/serverless`'s `Pool`, with ONLY the driver import swapped
// (`@kisenon/serverless` in place of `@neondatabase/serverless`). Drizzle drives
// the pool through the same `pg`-shaped surface, so a `SELECT` returns typed
// rows unchanged. Local runs skip when no DATABASE_URL is configured.

import { sql as dsql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-serverless";
import { describe, expect, it } from "vitest";
import { Pool } from "../../src/index.js";
import { getDatabaseUrl, hasDatabaseUrl } from "./provision.js";

describe.skipIf(!hasDatabaseUrl)("Drizzle over @kisenon/serverless (10.5)", () => {
  it("runs a SELECT and returns typed rows (only the driver import swapped)", async () => {
    const pool = new Pool({ connectionString: await getDatabaseUrl() });
    try {
      // Drizzle's neon-serverless driver expects a neon `Pool`; ours is the
      // pg-shaped drop-in. The cast bridges the nominal type only — at runtime
      // Drizzle drives our real pool through the identical surface.
      const db = drizzle(pool as never);
      const result = (await db.execute(dsql`SELECT 1 AS n`)) as {
        rows: Array<{ n: number }>;
      };
      expect(result.rows[0]?.n).toBe(1);
    } finally {
      await pool.end();
    }
  });
});
