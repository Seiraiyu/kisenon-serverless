import { readFileSync } from "node:fs";

const packageJson = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version?: unknown };

if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
  throw new Error("package.json must contain a non-empty version string");
}

export const packageVersion = packageJson.version;
export const versionDefine = {
  __KISENON_PACKAGE_VERSION__: JSON.stringify(packageVersion),
};
