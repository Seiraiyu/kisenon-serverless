# Integration tests (`@kisenon/serverless`)

Cross-runtime tests that exercise the client against a **live** kisenon
endpoint over `DATABASE_URL`. They are **excluded from the default unit run**
(`pnpm test`) — the `vitest.config.ts` `exclude` drops `test/integration/**` —
and they skip locally when `DATABASE_URL` is unset. Set `REQUIRE_INTEGRATION=1`
to make a missing URL fail before test discovery in automation.

## Running

```sh
# Node cells (10.2 node, 10.4 edge, 10.5 acceptance + drizzle)
DATABASE_URL=postgres://user:pw@<eid>.usc1.kisenon.com/db pnpm test:integration

# Cloudflare Workers cells (10.3 + the Workers half of the 10.5 gate)
DATABASE_URL=postgres://user:pw@<eid>.usc1.kisenon.com/db pnpm test:workers
```

For automation that must never pass without executing the live assertions:

```sh
REQUIRE_INTEGRATION=1 DATABASE_URL=postgres://user:pw@<eid>.usc1.kisenon.com/db pnpm test:integration
REQUIRE_INTEGRATION=1 DATABASE_URL=postgres://user:pw@<eid>.usc1.kisenon.com/db pnpm test:workers
```

Or put the URL in a **gitignored** `.env.integration` file and launch the
runner with Node's `--env-file` so the key lands in `process.env` before the
tests read it:

```sh
# .env.integration
DATABASE_URL=postgres://user:pw@<eid>.usc1.kisenon.com/db
```

```sh
node --env-file=.env.integration ./node_modules/.bin/vitest run test/integration
node --env-file=.env.integration ./node_modules/.bin/vitest run --config vitest.workers.config.ts
```

`test/integration/provision.ts` reads `DATABASE_URL` from `process.env` and
exposes `hasDatabaseUrl` (the `describe.skipIf` gate) and
`getDatabaseUrl()` (throws an actionable error if unset). Both Vitest configs
also reject a missing URL when `REQUIRE_INTEGRATION=1`.

## What each file covers

| File | Runtime | Cells |
|---|---|---|
| `node.test.ts` (10.2) | Node | HTTP `neon()` template, `Pool.query`, parameterized query, `sql.transaction([...])`; WS pinned `BEGIN/INSERT/SELECT/COMMIT`; `LISTEN` + `pg_notify` |
| `workers.test.ts` (10.3) | workerd (Miniflare) | HTTP `neon()`; WS `pool.connect()` txn over the **fetch-upgrade** adapter branch |
| `edge.test.ts` (10.4) | `edge-runtime` | HTTP `neon()` / `Pool.query`; `pool.connect()` throws the exact no-WS error |
| `acceptance.test.ts` (10.5) | Node | **Gate:** `SELECT 1 → 1` over HTTP **and** WS (Node cells; Workers cells are in `workers.test.ts`) |
| `orm-drizzle.test.ts` (10.5) | Node | Drizzle `neon-serverless` over our `Pool` — only the driver import swapped |

## Runtime notes

- **Node WebSocket:** the WS cells (`pool.connect()`) need an outbound
  WebSocket. **Node ≥ 22** has a global `WebSocket` and needs nothing. On
  **Node < 22**, set `neonConfig.webSocketConstructor = ws` (the `ws` package)
  before the tests run.
- **Both auth paths:** provision the endpoint role with **`scram-sha-256`** so
  the SCRAM handshake is exercised (the WS session path); an `md5` role
  exercises the other. The HTTP `/sql` path authenticates server-side, the WS
  `/v2` path runs the client-side SCRAM/md5 handshake — a SCRAM-provisioned role
  covers both.
- **No DB cleanup needed:** the WS tests create **`TEMP` tables** on the pinned
  session; they are session-scoped and auto-drop when the session closes
  (`pool.end()`).
- **Notification timing:** the `LISTEN`/`pg_notify` cell issues a trailing
  `SELECT 1` round trip so the async `NotificationResponse` is drained even when
  the server does not piggyback it on the `pg_notify` response.

## Provisioning the `kisenon-verify` endpoint (by hand)

This harness does **not** provision an endpoint automatically (out of scope,
plan 10.1). To obtain a live `DATABASE_URL` on the `kisenon-verify` tenant:

1. Create a project/branch/endpoint on the `kisenon-verify` tenant via the cp
   `/v1` API (or `keon projects create`), authenticated with the **mothership**
   `kisenon-verify-bot` service-account token (the parity bearer is minted on
   the mothership — not homelab, not `keon-login`). Host is
   `<eid>.usc1.kisenon.com`.
2. Create a role with `scram-sha-256` (see above).
3. Export
   `DATABASE_URL=postgres://<user>:<pw>@<eid>.usc1.kisenon.com/<db>` into the CI
   secret store or `.env.integration`.

> Cross-repo Tier-3 wiring — running this published-package smoke from
> seiraiyu-neon's `scripts/verify behavior` — is intentionally **not** wired
> here. See the `TODO(#2134)` in `acceptance.test.ts`.
