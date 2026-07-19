import { describe, expect, it } from "vitest";
import { VERSION } from "../src/index.js";
import { packageVersion } from "../version.config.js";

describe("VERSION", () => {
  it("matches the package.json version", () => {
    expect(VERSION).toBe(packageVersion);
  });
});
