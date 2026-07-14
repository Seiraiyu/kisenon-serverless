import { describe, test, expect, afterEach } from "vitest";
import { getTypeParser, setTypeParser } from "../src/types/parsers.js";

describe("getTypeParser — text -> JS by OID (task 2.4)", () => {
  test.each([
    [23, "42", 42], // int4
    [21, "7", 7], // int2
    [16, "t", true], // bool true
    [16, "f", false], // bool false
    [700, "3.5", 3.5], // float4
    [701, "3.5", 3.5], // float8
    [114, '{"a":1}', { a: 1 }], // json
    [3802, '{"b":2}', { b: 2 }], // jsonb
    [1184, "2026-07-14 00:00:00+00", new Date("2026-07-14T00:00:00Z")], // timestamptz
    [1007, "{1,2,3}", [1, 2, 3]], // int4 array
  ])("oid %i parses %s", (oid, text, want) => {
    expect(getTypeParser(oid as number)(text as string)).toEqual(want);
  });

  test("int8 (20) parses to BigInt", () => {
    expect(getTypeParser(20)("9007199254740993")).toBe(9007199254740993n);
  });

  test("numeric (1700) stays a Number when it fits, a string when it overflows f64", () => {
    expect(getTypeParser(1700)("3.5")).toBe(3.5);
    // 30 nines overflows f64 precision — pg parity keeps it as a string.
    expect(getTypeParser(1700)("999999999999999999999999999999")).toBe(
      "999999999999999999999999999999",
    );
  });

  test("text (25) and varchar (1043) are identity", () => {
    expect(getTypeParser(25)("hello")).toBe("hello");
    expect(getTypeParser(1043)("world")).toBe("world");
  });

  test("uuid (2950) is identity", () => {
    const u = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
    expect(getTypeParser(2950)(u)).toBe(u);
  });

  test("date (1082) parses to a Date", () => {
    expect(getTypeParser(1082)("2026-07-14")).toEqual(new Date("2026-07-14"));
  });

  test("timestamp (1114) parses to a Date", () => {
    expect(getTypeParser(1114)("2026-07-14 12:00:00")).toBeInstanceOf(Date);
  });

  test("bytea (17) decodes the \\x hex form to a Uint8Array", () => {
    expect(getTypeParser(17)("\\xdeadbeef")).toEqual(
      new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
    );
  });

  test("text array (1009) parses recursively", () => {
    expect(getTypeParser(1009)("{a,b,c}")).toEqual(["a", "b", "c"]);
  });

  test("unknown OID falls back to identity (string)", () => {
    expect(getTypeParser(999999)("raw-text")).toBe("raw-text");
  });
});

describe("setTypeParser override (task 2.4)", () => {
  afterEach(() => {
    // restore int4 to its default numeric parse
    setTypeParser(23, (t) => Number(t));
  });

  test("overrides the parser for an OID", () => {
    setTypeParser(23, (t) => `int:${t}`);
    expect(getTypeParser(23)("42")).toBe("int:42");
  });
});
