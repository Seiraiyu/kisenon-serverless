import { describe, expect, test } from "vitest";
import { parseBatch, parseEnvelope } from "../src/http/envelope.js";

// The literal single-envelope example from CONTRACT.md §"HTTP transport".
const single = {
  command: "SELECT",
  rowCount: 1,
  fields: [
    {
      name: "id",
      dataTypeID: 23,
      tableID: 0,
      columnID: 0,
      dataTypeSize: 4,
      dataTypeModifier: -1,
      format: "text",
    },
  ],
  rows: [["1"]],
  rowAsArray: true,
};

describe("parseEnvelope", () => {
  test("parses the CONTRACT.md single envelope", () => {
    const env = parseEnvelope(single);
    expect(env.command).toBe("SELECT");
    expect(env.rowCount).toBe(1);
    expect(env.rowAsArray).toBe(true);
    expect(env.rows).toEqual([["1"]]);
    expect(env.fields[0]).toEqual({
      name: "id",
      dataTypeID: 23,
      tableID: 0,
      columnID: 0,
      dataTypeSize: 4,
      dataTypeModifier: -1,
      format: "text",
    });
  });

  test("normalizes a partial field to the full Field shape", () => {
    const env = parseEnvelope({
      command: "SELECT",
      rowCount: 1,
      fields: [{ name: "n", dataTypeID: 23 }],
      rows: [["1"]],
      rowAsArray: true,
    });
    expect(env.fields[0]).toEqual({
      name: "n",
      dataTypeID: 23,
      tableID: 0,
      columnID: 0,
      dataTypeSize: 0,
      dataTypeModifier: -1,
      format: "text",
    });
  });

  test("defaults rowCount/rowAsArray when absent", () => {
    const env = parseEnvelope({
      command: "SELECT",
      fields: [{ name: "n", dataTypeID: 23 }],
      rows: [["1"], ["2"]],
    });
    expect(env.rowCount).toBe(2);
    expect(env.rowAsArray).toBe(true);
  });

  test("throws on a non-object", () => {
    expect(() => parseEnvelope(null)).toThrow();
    expect(() => parseEnvelope("nope")).toThrow();
  });

  test("throws when fields or rows are missing/not arrays", () => {
    expect(() => parseEnvelope({ command: "SELECT", rows: [] })).toThrow();
    expect(() => parseEnvelope({ command: "SELECT", fields: [] })).toThrow();
    expect(() =>
      parseEnvelope({ command: "SELECT", fields: {}, rows: [] }),
    ).toThrow();
  });
});

describe("parseBatch", () => {
  test("reads {results:[…]} into an array of envelopes", () => {
    const batch = parseBatch({ results: [single, single] });
    expect(batch).toHaveLength(2);
    expect(batch[0]!.command).toBe("SELECT");
    expect(batch[1]!.rows).toEqual([["1"]]);
  });

  test("throws when results is missing or not an array", () => {
    expect(() => parseBatch({})).toThrow();
    expect(() => parseBatch({ results: {} })).toThrow();
    expect(() => parseBatch(null)).toThrow();
  });
});
