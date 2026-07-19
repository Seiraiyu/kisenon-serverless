// Workers integration-test config (Phase 10, task 10.3). Runs the Workers
// integration cells inside workerd via `@cloudflare/vitest-pool-workers`
// (Miniflare). Invoked by `pnpm test:workers`.
//
// `DATABASE_URL` is read from the host process env at config time and forwarded
// into the Worker as a binding, so the in-worker test reads `env.DATABASE_URL`.

import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";
import { requireDatabaseUrl } from "./test/integration/require-database-url.js";
import { versionDefine } from "./version.config.js";

requireDatabaseUrl(process.env);

export default defineWorkersConfig({
  define: versionDefine,
  test: {
    include: ["test/integration/workers.test.ts"],
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          // Forward the host endpoint URL into the Worker as a binding.
          bindings: {
            DATABASE_URL: process.env.DATABASE_URL ?? "",
          },
        },
      },
    },
  },
});
