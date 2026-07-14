// Reshape a parsed Neon `/sql` envelope (rows-as-arrays of text cells) into the
// caller-facing result: object rows by default, arrays when `arrayMode`, or the
// full `{ rows, rowCount, fields, command }` (pg RowList) shape when
// `fullResults`. Each non-null cell is type-parsed via the OID registry
// (src/types/parsers.ts); a SQL NULL cell becomes JS `null` (never "").

import type { Envelope } from "./envelope.js";
import type { Field, PgResult } from "../result.js";
import { getTypeParser } from "../types/parsers.js";

/** Which of the three result shapes to produce. */
export interface ResultOptions {
  arrayMode: boolean;
  fullResults: boolean;
}

/**
 * Type-parse one envelope row (an array of text cells / JSON null) into an array
 * of JS values in column order. A `null` cell stays `null`; every other cell is
 * a string run through the field's OID parser.
 */
function parseRow(cells: unknown, fields: Field[]): unknown[] {
  const arr = Array.isArray(cells) ? cells : [];
  const out: unknown[] = new Array(fields.length);
  for (let i = 0; i < fields.length; i++) {
    const cell = arr[i];
    if (cell === null || cell === undefined) {
      out[i] = null;
      continue;
    }
    const field = fields[i]!;
    out[i] = getTypeParser(field.dataTypeID)(String(cell));
  }
  return out;
}

/** Key a parsed row array by field name in column order. */
function toObject(parsed: unknown[], fields: Field[]): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  for (let i = 0; i < fields.length; i++) {
    obj[fields[i]!.name] = parsed[i];
  }
  return obj;
}

/**
 * Reshape the envelope. `fullResults` wins on the outer shape (returns a
 * `PgResult`); `arrayMode` picks array-vs-object rows in both the bare and
 * `fullResults` forms.
 */
export function reshape(env: Envelope, opts: ResultOptions): unknown {
  const rows = env.rows.map((row) => {
    const parsed = parseRow(row, env.fields);
    return opts.arrayMode ? parsed : toObject(parsed, env.fields);
  });

  if (!opts.fullResults) {
    return rows;
  }

  const result: PgResult = {
    rows,
    rowCount: env.rowCount,
    fields: env.fields,
    command: env.command,
  };
  return result;
}
