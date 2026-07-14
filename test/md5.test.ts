import { describe, expect, test } from "vitest";
import { md5, md5hex, md5AuthResponse } from "../src/auth/md5.js";

const enc = (s: string) => new TextEncoder().encode(s);

describe("md5 (RFC 1321 vectors)", () => {
  test.each([
    ["", "d41d8cd98f00b204e9800998ecf8427e"],
    ["a", "0cc175b9c0f1b6a831c399e269772661"],
    ["abc", "900150983cd24fb0d6963f7d28e17f72"],
    ["message digest", "f96b697d7cb7938d525a2f31aaf161d0"],
    ["abcdefghijklmnopqrstuvwxyz", "c3fcd3d76192e4007dfb496cca67e13b"],
    [
      "The quick brown fox jumps over the lazy dog",
      "9e107d9d372bb6826bd81d3542a419d6",
    ],
    [
      // 80-byte input: exercises the two-block padding path.
      "12345678901234567890123456789012345678901234567890123456789012345678901234567890",
      "57edf4a22be3c955ac49da2e2107b67a",
    ],
  ])("md5(%j)", (s, hex) => {
    expect(md5hex(enc(s))).toBe(hex);
  });

  test("md5 returns 16 raw bytes", () => {
    const d = md5(enc("abc"));
    expect(d).toBeInstanceOf(Uint8Array);
    expect(d.length).toBe(16);
    expect(d[0]).toBe(0x90);
    expect(d[15]).toBe(0x72);
  });
});

describe("md5AuthResponse (PasswordMessage)", () => {
  // Hand-computed with a reference MD5 (node:crypto), independent of src/auth/md5.ts:
  //   user="alice", password="s3cr3t", salt=deadbeef
  //   inner = md5(password+user) = 8505fe3f3de8521be02f7b633dae545d
  //   outer = md5(inner+salt)    = f4ae1027427ba7f70c4ff1f49b2de6b2
  const user = "alice";
  const password = "s3cr3t";
  const salt = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
  const outer = "f4ae1027427ba7f70c4ff1f49b2de6b2";

  test("emits the full framed 'p' message with md5<hex> body", () => {
    const msg = md5AuthResponse(user, password, salt);
    // 'p' + Int32 length + "md5"+outer+"\0"
    expect(msg[0]).toBe(0x70); // 'p'
    const len = (msg[1]! << 24) | (msg[2]! << 16) | (msg[3]! << 8) | msg[4]!;
    const body = new TextDecoder().decode(msg.subarray(5));
    expect(len).toBe(msg.length - 1); // length excludes the type byte
    expect(body).toBe("md5" + outer + "\0");
  });

  test("matches the byte-exact reference frame", () => {
    const msg = md5AuthResponse(user, password, salt);
    const hex = Array.from(msg)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    expect(hex).toBe(
      "70000000286d6435663461653130323734323762613766373063346666316634396232646536623200",
    );
  });
});
