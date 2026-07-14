import { describe, expect, test } from "vitest";
import { DatabaseError, mapHttpError } from "../src/http/errors.js";

describe("DatabaseError", () => {
  test("is an Error carrying pg-shaped fields", () => {
    const e = new DatabaseError("boom");
    e.code = "42601";
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("DatabaseError");
    expect(e.message).toBe("boom");
    expect(e.code).toBe("42601");
  });
});

describe("mapHttpError", () => {
  test("400 → DatabaseError from the pg error envelope", () => {
    const e = mapHttpError(400, {
      message: "syntax error at or near \"selec\"",
      code: "42601",
      severity: "ERROR",
      detail: "some detail",
      hint: "did you mean SELECT?",
    });
    expect(e).toBeInstanceOf(DatabaseError);
    expect(e.message).toBe('syntax error at or near "selec"');
    expect(e.code).toBe("42601");
    expect(e.severity).toBe("ERROR");
    expect(e.detail).toBe("some detail");
    expect(e.hint).toBe("did you mean SELECT?");
  });

  test("413 → payload/result too large", () => {
    const e = mapHttpError(413, { message: "whatever" });
    expect(e).toBeInstanceOf(DatabaseError);
    expect(e.message).toMatch(/too large/i);
  });

  test("504 → query timeout exceeded", () => {
    expect(mapHttpError(504, {}).message).toMatch(/timeout/i);
  });

  test("502 → backend connection failed", () => {
    expect(mapHttpError(502, {}).message).toMatch(/backend/i);
  });

  test("unknown status → generic Server error (HTTP status N)", () => {
    expect(mapHttpError(418, {}).message).toBe("Server error (HTTP status 418)");
  });

  test("redacts a connection string leaked into the message", () => {
    const e = mapHttpError(400, {
      message:
        "failed to connect postgres://alice:s3cr3t@ep-x1.usc1.kisenon.com/appdb",
      code: "08006",
    });
    expect(e.message).not.toContain("s3cr3t");
    expect(e.message).toContain("postgres://***");
  });

  test("400 with a non-string message falls back to a generic message", () => {
    const e = mapHttpError(400, {});
    expect(e).toBeInstanceOf(DatabaseError);
    expect(typeof e.message).toBe("string");
    expect(e.message.length).toBeGreaterThan(0);
  });
});
