// Parse + validate the Neon `/sql` JSON response envelope (CONTRACT.md
// §"HTTP transport", server `result.go`). The wire shape is:
//
//   { "command": "SELECT", "rowCount": 1,
//     "fields": [ { "name": "id", "dataTypeID": 23, "tableID": 0, "columnID": 0,
//                   "dataTypeSize": 4, "dataTypeModifier": -1, "format": "text" } ],
//     "rows": [ ["1"] ], "rowAsArray": true }
//
// Every cell is a text string or JSON `null`. A batch response wraps an array of
// these under a mandatory `results` key: `{ "results": [ envelope, … ] }`.

import type { Field } from "../result.js";

/** The parsed, shape-validated single-query response envelope. */
export interface Envelope {
  command: string;
  rowCount: number;
  fields: Field[];
  rows: unknown[];
  rowAsArray: boolean;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Normalize one wire field (which may omit sub-keys) to the full `Field` shape. */
function toField(raw: unknown, index: number): Field {
  if (!isObject(raw)) {
    throw new Error(`kisenon: envelope fields[${index}] is not an object`);
  }
  const name = raw["name"];
  if (typeof name !== "string") {
    throw new Error(`kisenon: envelope fields[${index}].name is missing`);
  }
  const dataTypeID = raw["dataTypeID"];
  if (typeof dataTypeID !== "number") {
    throw new Error(`kisenon: envelope fields[${index}].dataTypeID is missing`);
  }
  return {
    name,
    dataTypeID,
    tableID: typeof raw["tableID"] === "number" ? (raw["tableID"] as number) : 0,
    columnID: typeof raw["columnID"] === "number" ? (raw["columnID"] as number) : 0,
    dataTypeSize:
      typeof raw["dataTypeSize"] === "number" ? (raw["dataTypeSize"] as number) : 0,
    dataTypeModifier:
      typeof raw["dataTypeModifier"] === "number"
        ? (raw["dataTypeModifier"] as number)
        : -1,
    format: typeof raw["format"] === "string" ? (raw["format"] as string) : "text",
  };
}

/**
 * Validate and normalize a single-query response envelope. Requires `fields` and
 * `rows` arrays and a `command` string; fills `rowCount` (defaults to
 * `rows.length`) and `rowAsArray` (defaults to true). Throws on a missing or
 * mistyped required key.
 */
export function parseEnvelope(json: unknown): Envelope {
  if (!isObject(json)) {
    throw new Error("kisenon: response is not a JSON object");
  }
  if (typeof json["command"] !== "string") {
    throw new Error("kisenon: envelope is missing a string `command`");
  }
  const rawFields = json["fields"];
  if (!Array.isArray(rawFields)) {
    throw new Error("kisenon: envelope is missing a `fields` array");
  }
  const rows = json["rows"];
  if (!Array.isArray(rows)) {
    throw new Error("kisenon: envelope is missing a `rows` array");
  }
  const rowCount =
    typeof json["rowCount"] === "number" ? (json["rowCount"] as number) : rows.length;
  const rowAsArray =
    typeof json["rowAsArray"] === "boolean" ? (json["rowAsArray"] as boolean) : true;
  return {
    command: json["command"] as string,
    rowCount,
    fields: rawFields.map(toField),
    rows,
    rowAsArray,
  };
}

/**
 * Parse a batch response `{ "results": [ envelope, … ] }` into an array of
 * envelopes. The `results` wrapper is mandatory (CONTRACT.md #2108); throws if
 * it is absent or not an array.
 */
export function parseBatch(json: unknown): Envelope[] {
  if (!isObject(json)) {
    throw new Error("kisenon: batch response is not a JSON object");
  }
  const results = json["results"];
  if (!Array.isArray(results)) {
    throw new Error("kisenon: batch response is missing a `results` array");
  }
  return results.map(parseEnvelope);
}
