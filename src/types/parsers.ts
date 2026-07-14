/**
 * Type-parser registry: text -> JS value keyed by Postgres type OID.
 *
 * Ground-up (no `pg-types` dependency), pg-parity for the common OIDs. The wire
 * always delivers cells as text (`Neon-Raw-Text-Output: true`), so every parser
 * takes the raw text and returns the JS value. `setTypeParser` mirrors neon's
 * override hook. Unknown OIDs fall back to identity (the raw string).
 */

export type TypeParser = (text: string) => unknown;

const identity: TypeParser = (t) => t;

/**
 * numeric (1700): a Number when it round-trips exactly through an f64, else the
 * raw string — matching pg, which keeps arbitrary-precision numeric as a string
 * rather than silently losing precision.
 */
const parseNumeric: TypeParser = (t) => {
  const n = Number(t);
  return Number.isFinite(n) && String(n) === t ? n : t;
};

/** bytea (17): decode the `\x<hex>` output form to a Uint8Array. */
const parseBytea: TypeParser = (t) => {
  const hex = t.startsWith("\\x") ? t.slice(2) : t;
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
};

// Scalar OID -> parser. Array OIDs are handled separately (see ARRAY_ELEMENT).
const SCALAR: Record<number, TypeParser> = {
  16: (t) => t === "t", // bool
  17: parseBytea, // bytea
  20: (t) => BigInt(t), // int8
  21: (t) => Number(t), // int2
  23: (t) => Number(t), // int4
  25: identity, // text
  114: (t) => JSON.parse(t), // json
  700: (t) => Number(t), // float4
  701: (t) => Number(t), // float8
  1042: identity, // bpchar
  1043: identity, // varchar
  1082: (t) => new Date(t), // date
  1114: (t) => new Date(t), // timestamp
  1184: (t) => new Date(t), // timestamptz
  1700: parseNumeric, // numeric
  2950: identity, // uuid
  3802: (t) => JSON.parse(t), // jsonb
};

// Array OID -> element scalar OID (1-D arrays; elements parsed recursively).
const ARRAY_ELEMENT: Record<number, number> = {
  1000: 16, // bool[]
  1001: 17, // bytea[]
  199: 114, // json[]
  1005: 21, // int2[]
  1007: 23, // int4[]
  1016: 20, // int8[]
  1021: 700, // float4[]
  1022: 701, // float8[]
  1231: 1700, // numeric[]
  1009: 25, // text[]
  1014: 1042, // bpchar[]
  1015: 1043, // varchar[]
  1115: 1114, // timestamp[]
  1182: 1082, // date[]
  1185: 1184, // timestamptz[]
  2951: 2950, // uuid[]
  3807: 3802, // jsonb[]
};

// Runtime overrides installed via setTypeParser.
const overrides = new Map<number, TypeParser>();

/** Return the parser for an OID: override > array > scalar > identity. */
export function getTypeParser(oid: number): TypeParser {
  const override = overrides.get(oid);
  if (override) return override;
  const elementOid = ARRAY_ELEMENT[oid];
  if (elementOid !== undefined) {
    const elementParser = getTypeParser(elementOid);
    return (text) => parseArrayLiteral(text, elementParser);
  }
  return SCALAR[oid] ?? identity;
}

/** Install a parser override for an OID (neon-style `setTypeParser`). */
export function setTypeParser(oid: number, fn: TypeParser): void {
  overrides.set(oid, fn);
}

/**
 * Parse a Postgres array output literal (`{1,2,3}`, `{a,"b,c",NULL}`, nested
 * `{{1,2},{3,4}}`) into a JS array, applying `elementParser` to each unquoted,
 * non-NULL scalar. Quoted elements are always passed through the parser as
 * their unescaped text; bare `NULL` becomes JS `null`.
 */
function parseArrayLiteral(text: string, elementParser: TypeParser): unknown[] {
  let i = 0;

  function parseArray(): unknown[] {
    const result: unknown[] = [];
    i++; // consume '{'
    if (text[i] === "}") {
      i++;
      return result;
    }
    for (;;) {
      const ch = text[i];
      if (ch === "{") {
        result.push(parseArray());
      } else if (ch === '"') {
        result.push(elementParser(parseQuoted()));
      } else {
        const raw = parseBare();
        result.push(raw === "NULL" ? null : elementParser(raw));
      }
      const sep = text[i];
      if (sep === ",") {
        i++;
        continue;
      }
      // sep === '}' (or end): close this array.
      i++;
      return result;
    }
  }

  function parseQuoted(): string {
    i++; // consume opening quote
    let out = "";
    for (;;) {
      const ch = text[i];
      if (ch === undefined) break;
      if (ch === "\\") {
        out += text[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (ch === '"') {
        i++; // consume closing quote
        break;
      }
      out += ch;
      i++;
    }
    return out;
  }

  function parseBare(): string {
    let out = "";
    for (;;) {
      const ch = text[i];
      if (ch === undefined || ch === "," || ch === "}") break;
      out += ch;
      i++;
    }
    return out;
  }

  if (text[i] !== "{") {
    // Not an array literal — hand the raw text back as a single-element parse.
    return [elementParser(text)];
  }
  return parseArray();
}
