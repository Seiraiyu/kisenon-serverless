import { describe, test, expect } from "vitest";
import { paramToText } from "../src/param-text.js";

// Regression guard for the shared Postgres-text param serializer used by BOTH
// the HTTP body and the WS Bind path. A naive String(p) (the pre-fix WS bug)
// would fail every non-primitive case below.
describe("paramToText", () => {
  test("null / undefined -> SQL NULL", () => {
    expect(paramToText(null)).toBeNull();
    expect(paramToText(undefined)).toBeNull();
  });

  test("string -> itself", () => expect(paramToText("hi")).toBe("hi"));
  test("number -> decimal string", () => expect(paramToText(7)).toBe("7"));

  test("boolean -> true/false", () => {
    expect(paramToText(true)).toBe("true");
    expect(paramToText(false)).toBe("false");
  });

  test("bigint -> decimal string", () => expect(paramToText(123n)).toBe("123"));

  test("Date -> ISO 8601", () =>
    expect(paramToText(new Date("2026-07-14T00:00:00.000Z"))).toBe(
      "2026-07-14T00:00:00.000Z",
    ));

  test("Uint8Array (bytea) -> \\x hex, NOT comma-decimals", () => {
    expect(paramToText(new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]))).toBe(
      "\\x48656c6c6f",
    );
  });

  test("ArrayBufferView window -> \\x hex of the view", () => {
    // Int8Array exercises the ArrayBuffer.isView branch (not the Uint8Array one).
    expect(paramToText(new Int8Array([0x48, 0x65]))).toBe("\\x4865");
  });

  test("ArrayBuffer -> \\x hex", () => {
    expect(paramToText(new Uint8Array([0xde, 0xad]).buffer)).toBe("\\xdead");
  });

  test("object -> JSON", () => expect(paramToText({ a: 1 })).toBe('{"a":1}'));
  test("array -> JSON", () => expect(paramToText([1, 2, 3])).toBe("[1,2,3]"));
});
