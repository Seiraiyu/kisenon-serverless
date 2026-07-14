// Integration-test provisioning helper (Phase 10, task 10.1).
//
// The integration suite runs against a LIVE kisenon endpoint reached over
// `DATABASE_URL` (host `<eid>.usc1.kisenon.com`). This module is the single
// gate the cross-runtime tests consult:
//
//   • `hasDatabaseUrl` — a synchronous boolean the tests feed to
//     `describe.skipIf(!hasDatabaseUrl)`, so the whole suite SKIPS cleanly when
//     no endpoint is configured (the state in CI until a URL is provided).
//   • `getDatabaseUrl()` — returns the URL, or throws a clear, actionable error
//     telling the operator exactly how to set it.
//
// It reads `process.env.DATABASE_URL` only. A gitignored `.env.integration`
// file is supported by launching the runner with `node --env-file=...` (see
// test/integration/README.md), which lands its keys in `process.env` before
// this module is evaluated — so both paths funnel through `process.env` and
// `hasDatabaseUrl` stays honest.
//
// NOTE (judgment call, plan 10.1): this deliberately does NOT provision a live
// project/endpoint via the cp `/v1` API + mothership `kisenon-verify-bot`
// token. That live provisioning is out of scope for this harness; the endpoint
// URL is supplied externally (CI secret / `.env.integration`). See the README
// for the provisioning recipe to run by hand.
//
// Access `process.env` through a `globalThis` cast rather than a node global:
// this package carries no `@types/node`, and the file must also load under the
// Workers / edge-runtime harnesses where `process` may be absent entirely.

/** Read `DATABASE_URL` from the ambient process env, if there is one. */
function readDatabaseUrl(): string | undefined {
  const g = globalThis as {
    process?: { env?: Record<string, string | undefined> };
  };
  const url = g.process?.env?.["DATABASE_URL"];
  return url && url.length > 0 ? url : undefined;
}

/**
 * `true` when a live `DATABASE_URL` is configured. The cross-runtime tests use
 * this with `describe.skipIf(!hasDatabaseUrl)` so the suite skips (never fails)
 * when there is no endpoint to hit.
 */
export const hasDatabaseUrl: boolean = readDatabaseUrl() !== undefined;

/**
 * Resolve the live endpoint `DATABASE_URL`. Returns the configured URL, or
 * throws with instructions if unset. Async to match the plan's signature
 * (`getDatabaseUrl(): Promise<string>`) and to leave room for a future live
 * cp-API provisioning path without changing call sites.
 */
export async function getDatabaseUrl(): Promise<string> {
  const url = readDatabaseUrl();
  if (url) return url;
  throw new Error(
    "DATABASE_URL is not set — the integration suite needs a live kisenon endpoint.\n" +
      "  DATABASE_URL=postgres://user:pw@<eid>.usc1.kisenon.com/db pnpm test:integration\n" +
      "or put it in a gitignored .env.integration file and run:\n" +
      "  node --env-file=.env.integration ./node_modules/.bin/vitest run test/integration\n" +
      "See test/integration/README.md for provisioning the endpoint.",
  );
}
