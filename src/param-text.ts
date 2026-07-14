// Canonical JS-value → Postgres text-literal serialization, shared by the HTTP
// transport (the JSON body the server text-casts) and the WS Bind path (params
// sent as TEXT bytes). One source of truth so the two transports cannot drift:
// a param that works over neon()/pool.query MUST behave identically over
// pool.connect()/PoolClient.query.

const HEX = "0123456789abcdef";

/** Lowercase `\x…` hex encoding of a byte array (Postgres bytea input form). */
export function toHex(bytes: Uint8Array): string {
  let out = "\\x";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    out += HEX[b >> 4]! + HEX[b & 0x0f]!;
  }
  return out;
}

/**
 * Serialize one query param to its Postgres text form, or `null` for SQL NULL.
 * Matches the server's `paramsToText`: `Date`→ISO 8601, byte array→`\x…` hex,
 * `bigint`→decimal, object/array→JSON, and every other value→its string form
 * (numbers, booleans, strings). The result is a text literal the server casts to
 * the column/param type — the same rule whether it arrives in the HTTP JSON body
 * or as WS Bind text.
 */
export function paramToText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Uint8Array) return toHex(v);
  if (ArrayBuffer.isView(v)) {
    const view = v as ArrayBufferView;
    return toHex(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  }
  if (v instanceof ArrayBuffer) return toHex(new Uint8Array(v));
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
