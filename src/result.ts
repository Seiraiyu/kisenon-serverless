// Shared result/row-description types used by both the HTTP envelope path
// (src/http/*) and the WebSocket session path (src/ws/*). Kept in its own module
// so the two transports agree on one `PgResult`/`Field` shape without importing
// each other.

/**
 * Column descriptor as surfaced to callers (pg `FieldDef`-shaped). This mirrors
 * the HTTP envelope's `fields[]` entries; the WS path maps its wire
 * RowDescription (`FieldDescription` in src/pg/protocol.ts) onto this shape.
 * `format` is the pg text/binary marker as a string ("text"), matching the
 * Neon HTTP envelope; the WS path passes "text" (all results requested as TEXT).
 */
export interface Field {
  name: string;
  dataTypeID: number;
  tableID: number;
  columnID: number;
  dataTypeSize: number;
  dataTypeModifier: number;
  format: string;
}

/**
 * pg-shaped result returned by `Client.query`, `Pool.query`, `PoolClient.query`
 * and the `fullResults` HTTP shape. `rows` are row objects by default, or arrays
 * when `rowMode: "array"`. `rowCount` is null for statements that report none.
 */
export interface PgResult {
  rows: unknown[];
  rowCount: number | null;
  fields: Field[];
  command: string;
  oid?: number;
}
