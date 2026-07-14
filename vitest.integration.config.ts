// Integration-test config (Phase 10). Runs the Node + edge-runtime integration
// cells via `pnpm test:integration`. The Workers cells run separately under
// vitest.workers.config.ts (workerd), so `workers.test.ts` is excluded here —
// it imports the `cloudflare:test` module, which only resolves in the Workers
// pool. `edge.test.ts` selects the edge-runtime environment per-file via its
// `// @vitest-environment edge-runtime` docblock.
//
// This is a separate config (not the default `vitest.config.ts`) precisely
// because the default one EXCLUDES `test/integration/**` to keep `pnpm test`
// fast and endpoint-free; here we opt those files back in.

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/integration/**/*.test.ts"],
    exclude: ["test/integration/workers.test.ts"],
    environment: "node",
  },
});
