import { describe, expect, test } from "vitest";
import type { Envelope } from "../src/http/envelope.js";
import { reshape } from "../src/http/reshape.js";
import type { PgResult } from "../src/result.js";

function env(partial: Partial<Envelope> & Pick<Envelope, "fields" | "rows">): Envelope {
  return {
    command: "SELECT",
    rowCount: partial.rows.length,
    rowAsArray: true,
    ...partial,
  };
}

const oneInt = env({
  fields: [
    {
      name: "n",
      dataTypeID: 23,
      tableID: 0,
      columnID: 0,
      dataTypeSize: 4,
      dataTypeModifier: -1,
      format: "text",
    },
  ],
  rows: [["1"]],
});

describe("reshape", () => {
  test("default: object rows, cells type-parsed", () => {
    expect(reshape(oneInt, { arrayMode: false, fullResults: false })).toEqual([
      { n: 1 },
    ]);
  });

  test("arrayMode: rows stay arrays, still type-parsed", () => {
    expect(reshape(oneInt, { arrayMode: true, fullResults: false })).toEqual([[1]]);
  });

  test("fullResults: pg RowList shape honoring arrayMode=false", () => {
    const out = reshape(oneInt, {
      arrayMode: false,
      fullResults: true,
    }) as PgResult;
    expect(out.rows).toEqual([{ n: 1 }]);
    expect(out.rowCount).toBe(1);
    expect(out.command).toBe("SELECT");
    expect(out.fields[0]!.name).toBe("n");
  });

  test("fullResults + arrayMode: rows as arrays", () => {
    const out = reshape(oneInt, {
      arrayMode: true,
      fullResults: true,
    }) as PgResult;
    expect(out.rows).toEqual([[1]]);
  });

  test("SQL null cell → JS null, never empty string", () => {
    const withNull = env({
      fields: [
        {
          name: "a",
          dataTypeID: 25,
          tableID: 0,
          columnID: 0,
          dataTypeSize: -1,
          dataTypeModifier: -1,
          format: "text",
        },
        {
          name: "b",
          dataTypeID: 25,
          tableID: 0,
          columnID: 0,
          dataTypeSize: -1,
          dataTypeModifier: -1,
          format: "text",
        },
      ],
      rows: [[null, ""]],
    });
    expect(reshape(withNull, { arrayMode: false, fullResults: false })).toEqual([
      { a: null, b: "" },
    ]);
  });

  test("parses multiple typed columns into an object", () => {
    const multi = env({
      command: "SELECT",
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
        {
          name: "flag",
          dataTypeID: 16,
          tableID: 0,
          columnID: 0,
          dataTypeSize: 1,
          dataTypeModifier: -1,
          format: "text",
        },
        {
          name: "doc",
          dataTypeID: 3802,
          tableID: 0,
          columnID: 0,
          dataTypeSize: -1,
          dataTypeModifier: -1,
          format: "text",
        },
      ],
      rows: [["7", "t", '{"k":1}']],
    });
    expect(reshape(multi, { arrayMode: false, fullResults: false })).toEqual([
      { id: 7, flag: true, doc: { k: 1 } },
    ]);
  });
});
