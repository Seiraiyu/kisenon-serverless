import { describe, expect, it } from "vitest";
import { requireDatabaseUrl } from "./integration/require-database-url.js";

describe("live integration configuration", () => {
  it("fails when live coverage is required without a database URL", () => {
    expect(() => requireDatabaseUrl({ REQUIRE_INTEGRATION: "1" })).toThrow(
      /REQUIRE_INTEGRATION=1 but DATABASE_URL is not set/,
    );
  });

  it("allows an explicit local skip when live coverage is not required", () => {
    expect(() => requireDatabaseUrl({})).not.toThrow();
  });

  it("allows a required live run when a database URL is configured", () => {
    expect(() =>
      requireDatabaseUrl({
        REQUIRE_INTEGRATION: "1",
        DATABASE_URL: "postgres://user:pass@example.com/database",
      }),
    ).not.toThrow();
  });
});
