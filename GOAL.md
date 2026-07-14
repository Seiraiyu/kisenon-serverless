# Goal & Definition of Done — `@kisenon/serverless`

**Goal:** Ship `@kisenon/serverless` — a ground-up, MIT-licensed, **zero-runtime-dependency**
TypeScript client that is a one-token import swap for `@neondatabase/serverless`
(`neon()`/`kisenon()`, `Pool`, `Client`, `neonConfig`), talking to a live kisenon
endpoint over HTTP `/sql` and WebSocket `/v2` from **Node and Cloudflare Workers**,
published to **npm with provenance**.

Tracking: Seiraiyu/seiraiyu-neon#2134 (follow-on of #1579). Plan:
`docs/plans/2026-07-14-kisenon-serverless-client-plan.md` in seiraiyu-neon.

## Success criteria

### Correctness / surface (local, verifiable now)
1. `neon()` + `kisenon` alias, `Pool`, `Client`, `neonConfig`, `setTypeParser`,
   `DatabaseError` export from the root; `kisenon === neon`. — **DONE**
2. Zero runtime `dependencies`; Web-standard crypto only (Web Crypto SCRAM + bundled MD5). — **DONE**
3. `pnpm build` emits dual ESM + CJS + `.d.ts`; `pnpm typecheck` (strict,
   `noUncheckedIndexedAccess`) exits 0; full unit suite green. — **DONE** (148/148)
4. HTTP: envelope→type-parsed object rows, `arrayMode`/`fullResults` parity,
   wake-`503` retry, `.transaction` batch, `err.code` = SQLSTATE. — **DONE**
5. WS: byte-stream reassembly, Startup→md5|scram→ReadyForQuery, simple+extended
   query, pinned txn, LISTEN/NOTIFY. — **DONE**
6. Auth pinned to RFC 1321 (MD5) + RFC 7677 (SCRAM) vectors — server-independent. — **DONE**
7. Host verbatim (no `api.` rewrite); Vercel Edge → HTTP works, WS throws one exact
   actionable error. — **DONE**

### Acceptance gate (plan §10.5 — pass/fail bar; needs live endpoint)
8. Real `SELECT 1 → 1` over **both HTTP and WS** from **both Node and Cloudflare
   Workers (Miniflare)** against a live `kisenon-verify` endpoint. — **PENDING**
9. A Drizzle (or Kysely) fixture runs `SELECT` returning typed rows with **only the
   driver import swapped**. — **PENDING**

### Release (Phase 12 — outward gate)
10. `npm view @kisenon/serverless dist-tags.latest === 0.1.0` **with a provenance
    attestation**; fresh `npm i` + Node smoke passes against the live endpoint. — **PENDING**

## Out of scope (v1)
Stock-driver hedge (#2121/#2122), fleet-wide compute SCRAM migration, `-pooler`/
multi-region routing, streaming, bespoke ORM adapters. Server md5 (#2124 / plan
Phase 9) is **deferred** — not on the v1 acceptance path (the verify role is
provisioned SCRAM, which the HTTP client already speaks).
