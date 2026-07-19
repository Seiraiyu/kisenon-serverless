import { defineConfig } from "vitest/config";
import { versionDefine } from "./version.config.js";

export default defineConfig({
  define: versionDefine,
  test: { include: ["test/**/*.test.ts"], exclude: ["test/integration/**"], environment: "node" },
});
