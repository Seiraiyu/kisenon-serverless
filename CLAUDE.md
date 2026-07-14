# @kisenon/serverless — repo conventions

This is a ground-up, MIT-licensed, **zero-runtime-dependency** TypeScript client whose
`neon()`/`Pool`/`Client`/`neonConfig` surface is a one-token import-swap from
`@neondatabase/serverless`, talking to a live kisenon endpoint over HTTP `/sql` and
WebSocket `/v2` from Node and edge runtimes (Cloudflare Workers, Deno, Bun, Vercel Edge).

## Toolchain

- **pnpm** for install/build/test (Corepack-pinned via `packageManager` in `package.json`) —
  `corepack enable`, then `pnpm install`, `pnpm build`, `pnpm test`, `pnpm typecheck`.
- **tsup** builds dual ESM (`dist/index.js`) + CJS (`dist/index.cjs`) + types (`dist/index.d.ts`).
- **Vitest** for unit tests (`test/**/*.test.ts`, node env; `test/integration/**` runs against a
  live endpoint and is excluded from the default run).

## Rules

- **Zero runtime dependencies.** `package.json` has no `dependencies` key — only devDeps
  (tsup/typescript/vitest, plus test-only deps added in Phase 10). MD5 is bundled source;
  SCRAM uses Web Crypto (`crypto.subtle`). Nothing that pulls in a runtime dep.
- **Never import `@neondatabase/serverless`.** This is a from-scratch reimplementation, not a
  fork or a wrapper. It must not depend on, re-export, or copy that package.
- **Web-standard APIs only on the hot path.** `fetch`, `WebSocket`, `crypto.subtle`,
  `TextEncoder` — so the bundle loads unmodified in Workers/Edge/Deno/Bun/Node ≥18. Do not
  reach for `node:` built-ins on the hot path.
- **Conventional commits** (`feat:`, `fix:`, `chore:`, `docs:`, …) — release-please derives the
  version bump and changelog from commit messages.

## Layout

- `src/index.ts` — public surface (barrel export).
- `src/http/` — HTTP transport + `neon()`.
- `src/pg/` — Postgres wire protocol (WS).
- `src/auth/` — md5 + SCRAM.
- `src/ws/` — WebSocket transport + per-runtime adapter.
- `test/` — Vitest unit tests (co-located by module).
