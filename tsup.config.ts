import { defineConfig } from "tsup";
import { versionDefine } from "./version.config.js";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],   // → dist/index.js (ESM) + dist/index.cjs (CJS)
  outExtension: ({ format }) => ({ js: format === "cjs" ? ".cjs" : ".js" }),
  dts: true,                // → dist/index.d.ts
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: "es2022",
  define: versionDefine,
});
