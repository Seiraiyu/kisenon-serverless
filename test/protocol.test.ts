import { describe, expect, test } from "vitest";
import {
  MessageReassembler,
  buildStartup,
  buildQuery,
  buildParse,
  buildBind,
  buildDescribe,
  buildExecute,
  buildSync,
  frame,
  appendCString,
  appendInt16,
  appendInt32,
  parseRowDescription,
  parseDataRow,
  parseCommandComplete,
  parseReadyForQuery,
  parseErrorResponse,
  parseNotification,
  parseAuthTag,
  type FieldDescription,
  type RawMessage,
} from "../src/pg/protocol.js";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);
const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
};
const dv = (b: Uint8Array): DataView =>
  new DataView(b.buffer, b.byteOffset, b.byteLength);
const cc = (s: string): number => s.charCodeAt(0);

// ---------------------------------------------------------------------------
// Task 5.1 — byte-stream reassembler (frames != messages)
// ---------------------------------------------------------------------------

describe("MessageReassembler", () => {
  test("reassembles one message split across two push()es (null mid-message)", () => {
    const msg = buildQuery("SELECT 1");
    const r = new MessageReassembler();
    r.push(msg.slice(0, 3)); // partial: type + 2 length bytes
    expect(r.next()).toBeNull(); // incomplete
    r.push(msg.slice(3)); // the rest
    const m = r.next() as RawMessage;
    expect(m).not.toBeNull();
    expect(m.type).toBe(cc("Q"));
    expect(dec(m.body)).toBe("SELECT 1\0");
    expect(r.next()).toBeNull(); // buffer drained
  });

  test("yields two messages packed into one push()", () => {
    const a = buildQuery("SELECT 1");
    const b = buildSync();
    const r = new MessageReassembler();
    r.push(concat(a, b));
    const m1 = r.next() as RawMessage;
    const m2 = r.next() as RawMessage;
    expect(m1.type).toBe(cc("Q"));
    expect(dec(m1.body)).toBe("SELECT 1\0");
    expect(m2.type).toBe(cc("S"));
    expect(m2.body.length).toBe(0);
    expect(r.next()).toBeNull();
  });

  test("returns null on an empty buffer", () => {
    expect(new MessageReassembler().next()).toBeNull();
  });

  test("rejects a message declaring a length over the 16 MiB ceiling", () => {
    const buf = new Uint8Array(5);
    buf[0] = cc("Q");
    new DataView(buf.buffer).setUint32(1, 17 * 1024 * 1024, false);
    const r = new MessageReassembler();
    r.push(buf);
    expect(() => r.next()).toThrow(/16 MiB|ceiling|exceeds/i);
  });
});

// ---------------------------------------------------------------------------
// Task 5.2 — frontend builders + helpers
// ---------------------------------------------------------------------------

describe("append helpers", () => {
  test("encode big-endian and NUL-terminate", () => {
    expect(Array.from(appendInt16(new Uint8Array(0), 0x0102))).toEqual([1, 2]);
    expect(Array.from(appendInt32(new Uint8Array(0), 0x01020304))).toEqual([1, 2, 3, 4]);
    expect(Array.from(appendInt32(new Uint8Array(0), -1))).toEqual([255, 255, 255, 255]);
    expect(Array.from(appendCString(new Uint8Array(0), "ab"))).toEqual([97, 98, 0]);
  });

  test("frame prefixes type + int32 length (length excludes the type byte)", () => {
    const f = frame(cc("Q"), enc("hi"));
    expect(f[0]).toBe(cc("Q"));
    expect([f[1], f[2], f[3], f[4]]).toEqual([0, 0, 0, 6]); // 4 + len("hi")
    expect(dec(f.slice(5))).toBe("hi");
  });
});

describe("frontend builders", () => {
  test("buildStartup: version 196608 + NUL-delimited user/database/options", () => {
    const m = buildStartup("alice", "appdb", "endpoint=ep-x1");
    // length prefix equals total buffer length
    expect(dv(m).getUint32(0, false)).toBe(m.length);
    // version bytes 00 03 00 00
    expect([m[4], m[5], m[6], m[7]]).toEqual([0x00, 0x03, 0x00, 0x00]);
    const rest = dec(m.slice(8));
    expect(rest).toContain("user\0alice\0");
    expect(rest).toContain("database\0appdb\0");
    expect(rest).toContain("options\0endpoint=ep-x1\0");
    expect(m[m.length - 1]).toBe(0); // final terminating NUL
  });

  test("buildStartup: omits the options key when absent", () => {
    const m = buildStartup("bob", "db2");
    expect(dec(m.slice(8))).not.toContain("options\0");
  });

  test("buildQuery: 'Q' + int32 len + cstring", () => {
    const m = buildQuery("SELECT 1");
    expect(m[0]).toBe(cc("Q"));
    expect([m[1], m[2], m[3], m[4]]).toEqual([0x00, 0x00, 0x00, 0x0d]);
    expect(dec(m.slice(5))).toBe("SELECT 1\0");
  });

  test("buildParse: 'P' + name + sql + oid list", () => {
    const m = buildParse("", "SELECT $1", [23]);
    expect(m[0]).toBe(cc("P"));
    const body = m.slice(5);
    let p = 0;
    expect(body[p]).toBe(0); // name ""
    p += 1;
    const sqlEnd = body.indexOf(0, p);
    expect(dec(body.slice(p, sqlEnd))).toBe("SELECT $1");
    p = sqlEnd + 1;
    expect(dv(body).getInt16(p, false)).toBe(1); // oid count
    p += 2;
    expect(dv(body).getUint32(p, false)).toBe(23);
  });

  test("buildBind: text params, NULL as -1, empty as 0, one text result code", () => {
    // mirrors the Go BuildBind test: params "42", NULL, "" (empty non-null)
    const m = buildBind("", "", [enc("42"), null, new Uint8Array(0)]);
    expect(m[0]).toBe(cc("B"));
    const body = m.slice(5);
    const d = dv(body);
    let p = 0;
    expect(body[p]).toBe(0); // portal ""
    p += 1;
    expect(body[p]).toBe(0); // stmt ""
    p += 1;
    expect(d.getInt16(p, false)).toBe(0); // 0 param format codes => all text
    p += 2;
    expect(d.getInt16(p, false)).toBe(3); // num params
    p += 2;
    expect(d.getInt32(p, false)).toBe(2); // param0 len
    p += 4;
    expect(dec(body.slice(p, p + 2))).toBe("42");
    p += 2;
    expect(d.getInt32(p, false)).toBe(-1); // param1 NULL
    p += 4;
    expect(d.getInt32(p, false)).toBe(0); // param2 empty
    p += 4;
    expect(d.getInt16(p, false)).toBe(1); // one result format code
    p += 2;
    expect(d.getInt16(p, false)).toBe(0); // text
  });

  test("buildDescribe: 'D' + kind + name", () => {
    const m = buildDescribe("S", "stmt1");
    expect(m[0]).toBe(cc("D"));
    const body = m.slice(5);
    expect(body[0]).toBe(cc("S"));
    const nameEnd = body.indexOf(0, 1);
    expect(dec(body.slice(1, nameEnd))).toBe("stmt1");
  });

  test("buildExecute: 'E' + portal + int32 maxRows", () => {
    const m = buildExecute("", 0);
    expect(m[0]).toBe(cc("E"));
    const body = m.slice(5);
    expect(body[0]).toBe(0); // portal ""
    expect(dv(body).getInt32(1, false)).toBe(0); // all rows
  });

  test("buildSync: 'S' with empty body (length 4)", () => {
    const m = buildSync();
    expect(m[0]).toBe(cc("S"));
    expect([m[1], m[2], m[3], m[4]]).toEqual([0, 0, 0, 4]);
    expect(m.length).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Task 5.3 — parse RowDescription + DataRow
// ---------------------------------------------------------------------------

function encodeRowDescription(fields: FieldDescription[]): Uint8Array {
  let b = appendInt16(new Uint8Array(0), fields.length);
  for (const f of fields) {
    b = appendCString(b, f.name);
    b = appendInt32(b, f.tableOID);
    b = appendInt16(b, f.columnAttr);
    b = appendInt32(b, f.dataTypeOID);
    b = appendInt16(b, f.dataTypeSize);
    b = appendInt32(b, f.typeModifier);
    b = appendInt16(b, f.format);
  }
  return b;
}

function encodeDataRow(cols: (Uint8Array | null)[]): Uint8Array {
  let b = appendInt16(new Uint8Array(0), cols.length);
  for (const c of cols) {
    if (c === null) {
      b = appendInt32(b, -1);
      continue;
    }
    b = appendInt32(b, c.length);
    b = concat(b, c);
  }
  return b;
}

describe("parseRowDescription", () => {
  test("round-trips field metadata", () => {
    const want: FieldDescription[] = [
      { name: "n", tableOID: 0, columnAttr: 0, dataTypeOID: 23, dataTypeSize: 4, typeModifier: -1, format: 0 },
      { name: "label", tableOID: 16384, columnAttr: 2, dataTypeOID: 25, dataTypeSize: -1, typeModifier: -1, format: 0 },
    ];
    expect(parseRowDescription(encodeRowDescription(want))).toEqual(want);
  });
});

describe("parseDataRow", () => {
  test("preserves NULL(-1) vs empty-string(0) — the load-bearing distinction", () => {
    const cols = parseDataRow(encodeDataRow([enc("42"), null, new Uint8Array(0)]));
    expect(cols.length).toBe(3);
    expect(dec(cols[0] as Uint8Array)).toBe("42");
    expect(cols[1]).toBeNull(); // SQL NULL
    expect(cols[2]).not.toBeNull(); // empty string, distinct from NULL
    expect((cols[2] as Uint8Array).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Task 5.4 — CommandComplete / ReadyForQuery / ErrorResponse
// ---------------------------------------------------------------------------

describe("parseCommandComplete", () => {
  test.each([
    ["SELECT 1\0", "SELECT", 1],
    ["INSERT 0 5\0", "INSERT", 5],
    ["UPDATE 3\0", "UPDATE", 3],
    ["DELETE 0\0", "DELETE", 0],
    ["CREATE TABLE\0", "CREATE", 0],
    ["BEGIN\0", "BEGIN", 0],
  ])("%j -> command+rowCount", (tag, command, rowCount) => {
    expect(parseCommandComplete(enc(tag as string))).toEqual({ command, rowCount });
  });
});

describe("parseReadyForQuery", () => {
  test("returns the transaction-status byte", () => {
    expect(parseReadyForQuery(enc("T"))).toBe(cc("T"));
    expect(parseReadyForQuery(enc("I"))).toBe(cc("I"));
    expect(parseReadyForQuery(enc("E"))).toBe(cc("E"));
  });
  test("throws on an empty payload", () => {
    expect(() => parseReadyForQuery(new Uint8Array(0))).toThrow();
  });
});

describe("parseErrorResponse", () => {
  test("keys S/C/M into severity/code/message", () => {
    let b: Uint8Array = new Uint8Array(0);
    b = concat(b, enc("S"));
    b = appendCString(b, "ERROR");
    b = concat(b, enc("C"));
    b = appendCString(b, "42P01");
    b = concat(b, enc("M"));
    b = appendCString(b, 'relation "nope" does not exist');
    b = concat(b, new Uint8Array([0])); // terminator
    const e = parseErrorResponse(b);
    expect(e.severity).toBe("ERROR");
    expect(e.code).toBe("42P01");
    expect(e.message).toBe('relation "nope" does not exist');
  });

  test("captures detail (D) and hint (H)", () => {
    let b: Uint8Array = new Uint8Array(0);
    b = concat(b, enc("M"));
    b = appendCString(b, "boom");
    b = concat(b, enc("D"));
    b = appendCString(b, "some detail");
    b = concat(b, enc("H"));
    b = appendCString(b, "try this");
    b = concat(b, new Uint8Array([0]));
    const e = parseErrorResponse(b);
    expect(e.message).toBe("boom");
    expect(e.detail).toBe("some detail");
    expect(e.hint).toBe("try this");
  });
});

// ---------------------------------------------------------------------------
// Task 5.5 — NotificationResponse + Authentication tag
// ---------------------------------------------------------------------------

describe("parseNotification", () => {
  test("parses pid, channel, payload", () => {
    let b = appendInt32(new Uint8Array(0), 42);
    b = appendCString(b, "chan");
    b = appendCString(b, "hi");
    expect(parseNotification(b)).toEqual({ processId: 42, channel: "chan", payload: "hi" });
  });
});

describe("parseAuthTag", () => {
  test("returns the 4-byte auth type, leaving trailing bytes (md5 salt) for later", () => {
    let md5 = appendInt32(new Uint8Array(0), 5);
    md5 = concat(md5, new Uint8Array([1, 2, 3, 4])); // salt, consumed in Phase 6
    expect(parseAuthTag(md5)).toBe(5);
    expect(parseAuthTag(appendInt32(new Uint8Array(0), 0))).toBe(0); // AuthenticationOk
    expect(parseAuthTag(appendInt32(new Uint8Array(0), 10))).toBe(10); // SASL
  });
});
