# @kisenon/serverless

Serverless/edge Postgres client for [kisenon](https://kisenon.com) — a one-token import swap for `@neondatabase/serverless`, over HTTP and WebSocket, from Node, Cloudflare Workers, Deno, Bun, and Vercel Edge (HTTP only).

Zero runtime dependencies. Web-standard crypto only (Web Crypto SCRAM + a bundled MD5), so it loads unmodified on every edge runtime. MIT licensed.

```sh
npm i @kisenon/serverless
```

## Quickstart

Point `DATABASE_URL` at your endpoint host — `<eid>.<region>.kisenon.com` (currently `usc1`, e.g. `ep-x1.usc1.kisenon.com`) — and query:

```ts
import { neon } from "@kisenon/serverless";

const sql = neon(process.env.DATABASE_URL!);
const [row] = await sql`SELECT 1 AS n`;
console.log(row.n); // 1
```

## Two transports

- **HTTP `/sql`** — `neon()` and `Pool.query` / `Client.query` send a single `POST /sql` per call. Works in every runtime, including Vercel Edge. Best for one-shot queries and serverless functions.
- **WebSocket `/v2`** — `pool.connect()` pins a real Postgres session (one Startup, one auth) for connection-scoped work: multi-statement transactions and `LISTEN`/`NOTIFY`. Needs outbound WebSocket support (everything but Vercel Edge).

### HTTP — `neon()` tagged template

Interpolated holes become bound `$1, $2, …` parameters — never string-concatenated:

```ts
const sql = neon(process.env.DATABASE_URL!);

const users = await sql`SELECT id, email FROM users WHERE active = ${true}`;
// -> [{ id: 1, email: "a@example.com" }, ...]  (rows are objects, cells type-parsed)
```

Or call `.query(text, params)` directly, and batch several statements into one round-trip as a transaction:

```ts
const rows = await sql.query("SELECT * FROM users WHERE id = $1", [42]);

await sql.transaction(
  [
    sql`INSERT INTO audit (msg) VALUES (${"login"})`,
    sql`UPDATE users SET seen_at = now() WHERE id = ${42}`,
  ],
  { isolationLevel: "Serializable", readOnly: false },
);
```

### HTTP — `Pool.query` one-shot

`Pool` and `Client` speak the `pg`-shaped surface. By default (`poolQueryViaFetch`) `query` is an HTTP one-shot returning the full `{ rows, rowCount, fields, command }` result:

```ts
import { Pool } from "@kisenon/serverless";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const { rows, rowCount } = await pool.query("SELECT id FROM users WHERE id = $1", [42]);
console.log(rowCount, rows[0]);
await pool.end();
```

Pass `{ text, values, rowMode: "array" }` to get array rows instead of objects:

```ts
const { rows } = await pool.query({ text: "SELECT id, email FROM users", rowMode: "array" });
// rows -> [[1, "a@example.com"], ...]
```

### WebSocket — pinned transaction via `pool.connect()`

`pool.connect()` returns a `PoolClient` bound to one WebSocket session. Every `query()` runs on that same session, so `BEGIN … COMMIT` is a real transaction. Always `release()` it (returns the session to the pool for reuse):

```ts
import { Pool } from "@kisenon/serverless";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query("INSERT INTO todos (title) VALUES ($1)", ["ship it"]);
  const { rows } = await client.query("SELECT count(*)::int AS n FROM todos");
  await client.query("COMMIT");
  console.log(rows[0]);
} catch (err) {
  await client.query("ROLLBACK");
  throw err;
} finally {
  client.release();
}
await pool.end();
```

### WebSocket — `LISTEN` / `NOTIFY`

Out-of-band notifications on a pinned session arrive via the `"notification"` event:

```ts
const client = await pool.connect();
client.on("notification", (msg) => {
  // msg -> { processId, channel, payload }
  console.log(msg.channel, msg.payload);
});
await client.query("LISTEN jobs");
// … elsewhere: SELECT pg_notify('jobs', 'hello')
```

## Runtime matrix

| Runtime | HTTP (`neon()`, `Pool.query`) | WebSocket (`pool.connect()`) |
|---|---|---|
| Node ≥ 18 | ✅ | ✅ — Node ≥ 22 has a global `WebSocket`; on Node < 22 set `neonConfig.webSocketConstructor` (see below) |
| Cloudflare Workers | ✅ | ✅ (fetch-upgrade) |
| Deno | ✅ | ✅ |
| Bun | ✅ | ✅ |
| Vercel Edge | ✅ | ❌ — no outbound WebSocket |

On **Vercel Edge** the runtime has no outbound WebSocket, so `pool.connect()` throws — use the HTTP path (`neon()` / `pool.query`) there. The exact error:

> `No WebSocket implementation: this runtime has no outbound WebSocket (e.g. Vercel Edge). Use the HTTP path (neon()/pool.query) or set neonConfig.webSocketConstructor.`

**Node < 22** has no global `WebSocket`. Inject the [`ws`](https://www.npmjs.com/package/ws) package once at startup to enable the WS path:

```ts
import { neonConfig } from "@kisenon/serverless";
import ws from "ws";

neonConfig.webSocketConstructor = ws;
```

Node ≥ 22, Deno, Bun, and Cloudflare Workers need no injection.

## Migrating from `@neondatabase/serverless`

The surface is 1:1 — swap the import specifier and your call-sites are unchanged:

| From `@neondatabase/serverless` | To `@kisenon/serverless` |
|---|---|
| `import { neon, Pool, Client, neonConfig } from "@neondatabase/serverless"` | `import { neon, Pool, Client, neonConfig } from "@kisenon/serverless"` |
| every call-site | unchanged (surface is 1:1) |
| `DATABASE_URL` host | your endpoint's host verbatim — `<eid>.<region>.kisenon.com` (currently `usc1`; no `api.` host) |

Notes:

- **Use `@kisenon/serverless`, not the stock driver.** The unmodified `@neondatabase/serverless` does **not** work against a kisenon endpoint — it rewrites the host to an `api.<region>` form for its HTTP path and pipelines cleartext auth over WS, neither of which kisenon serves. `@kisenon/serverless` keeps your host **verbatim** (`<eid>.<region>.kisenon.com`, no `api.` rewrite) — so it is region-agnostic by construction and works for any region your endpoint lives in — and does its own md5 / SCRAM handshake. It is the supported client.
- **`kisenon()` is an identical brand alias for `neon()`** — `import { kisenon } from "@kisenon/serverless"` and use it exactly like `neon()` if you prefer the branded name.
- **`neonConfig.pipelineConnect` is accepted but a no-op** (we never pipeline cleartext auth). `fetchConnectionCache` is likewise accepted and always-on.
- **Auth:** both `md5` and `scram-sha-256` are supported, computed client-side against RFC vectors (server-independent).

## `neonConfig` reference

A mutable singleton with the same field names and semantics as neon's, so a config-swap keeps working:

| Field | Default | Meaning |
|---|---|---|
| `fetchEndpoint` | `` host => `https://${host}/sql` `` | HTTP `/sql` URL, or a `(host, port) => string` builder. Built from **your** host — no `api.` rewrite. |
| `wsProxy` | `` host => `${host}/v2` `` | WebSocket `/v2` target, or a `(host, port) => string` builder. |
| `useSecureWebSocket` | `true` | Use `wss://` (vs `ws://`) for the WebSocket. |
| `webSocketConstructor` | `undefined` | Injected WebSocket constructor. Set to `ws` on Node < 22. |
| `poolQueryViaFetch` | `true` | Route `Pool` / `Client` one-shot `query()` over HTTP `/sql`. |
| `arrayMode` | `false` | Return rows as arrays instead of objects. |
| `fullResults` | `false` | Return the full `{ rows, rowCount, fields, command }` result (vs just rows). |
| `fetchConnectionCache` | `true` | Accepted for parity; always-on, no-op. |
| `pipelineConnect` | `false` | Accepted for parity; **no-op** (we never pipeline cleartext). |

## Exports

`neon`, `kisenon` (identical alias for `neon`), `Pool`, `Client`, `neonConfig`, `setTypeParser`, `DatabaseError`, `VERSION`, plus the TypeScript types `NeonConfig`, `PoolConfig`, `ClientConfig`, `NeonQueryFn`, `NeonOptions`, `IsolationLevel`, `Field`, and `PgResult`.

Register a custom text→JS parser for a Postgres type OID:

```ts
import { setTypeParser } from "@kisenon/serverless";
setTypeParser(1700, (text) => text); // keep numeric as a string
```

Query errors throw a `pg`-shaped `DatabaseError` whose `code` is the Postgres SQLSTATE, so existing ORM `err.code` handling ports unchanged:

```ts
import { DatabaseError } from "@kisenon/serverless";
try {
  await sql`SELECT * FROM missing_table`;
} catch (err) {
  if (err instanceof DatabaseError) console.log(err.code); // e.g. "42P01"
}
```

## License

MIT © 2026 Seiraiyu / David Stonely
