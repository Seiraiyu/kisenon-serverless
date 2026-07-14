// Pure-JS MD5 (RFC 1321) + Postgres md5 password-auth response.
//
// SubtleCrypto has no MD5, so this bundled implementation is what lets the
// package run unmodified in Workers/Deno/Bun/Node>=18 without a Node `crypto`
// import or any dependency. Postgres `md5` auth is legacy but still the default
// for roles created before scram-sha-256, so the WS transport must speak it.
//
// The password is derived-through only; nothing here logs it.

// Per-round left-rotate amounts (RFC 1321 §3.4).
const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

// K[i] = floor(abs(sin(i+1)) * 2^32). Precomputed once (avoids a 64-entry
// literal and the transcription errors that come with it).
const K = (() => {
  const k = new Uint32Array(64);
  for (let i = 0; i < 64; i++) {
    k[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
  }
  return k;
})();

function rotl(x: number, c: number): number {
  return ((x << c) | (x >>> (32 - c))) >>> 0;
}

/** MD5 digest of `input`, as a 16-byte Uint8Array. */
export function md5(input: Uint8Array): Uint8Array {
  const msgLen = input.length;
  // Padding: 0x80, then zeros to 56 mod 64, then 64-bit LE bit-length.
  const withOne = msgLen + 1;
  const padded = new Uint8Array((withOne + 8 + 63 & ~63) as number);
  padded.set(input, 0);
  padded[msgLen] = 0x80;
  // Bit length (LE). >>>0 keeps the low 32 bits; high word from /2^32.
  const bitLen = msgLen * 8;
  const lo = bitLen >>> 0;
  const hi = Math.floor(bitLen / 4294967296) >>> 0;
  const lenOff = padded.length - 8;
  padded[lenOff] = lo & 0xff;
  padded[lenOff + 1] = (lo >>> 8) & 0xff;
  padded[lenOff + 2] = (lo >>> 16) & 0xff;
  padded[lenOff + 3] = (lo >>> 24) & 0xff;
  padded[lenOff + 4] = hi & 0xff;
  padded[lenOff + 5] = (hi >>> 8) & 0xff;
  padded[lenOff + 6] = (hi >>> 16) & 0xff;
  padded[lenOff + 7] = (hi >>> 24) & 0xff;

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const M = new Uint32Array(16);
  for (let off = 0; off < padded.length; off += 64) {
    for (let j = 0; j < 16; j++) {
      const p = off + j * 4;
      M[j] =
        (padded[p]! |
          (padded[p + 1]! << 8) |
          (padded[p + 2]! << 16) |
          (padded[p + 3]! << 24)) >>>
        0;
    }

    let A = a0;
    let B = b0;
    let C = c0;
    let D = d0;

    for (let i = 0; i < 64; i++) {
      let F: number;
      let g: number;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      F = (F + A + K[i]! + M[g]!) >>> 0;
      A = D;
      D = C;
      C = B;
      B = (B + rotl(F, S[i]!)) >>> 0;
    }

    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }

  const out = new Uint8Array(16);
  const words = [a0, b0, c0, d0];
  for (let w = 0; w < 4; w++) {
    const v = words[w]!;
    out[w * 4] = v & 0xff;
    out[w * 4 + 1] = (v >>> 8) & 0xff;
    out[w * 4 + 2] = (v >>> 16) & 0xff;
    out[w * 4 + 3] = (v >>> 24) & 0xff;
  }
  return out;
}

const HEX = "0123456789abcdef";

/** MD5 digest of `input`, as a lowercase 32-char hex string. */
export function md5hex(input: Uint8Array): string {
  const d = md5(input);
  let s = "";
  for (let i = 0; i < d.length; i++) {
    const b = d[i]!;
    s += HEX[b >>> 4]! + HEX[b & 0x0f]!;
  }
  return s;
}

const utf8 = new TextEncoder();

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * Build the full PasswordMessage ('p') response to AuthenticationMD5Password.
 *
 *   inner = md5hex(utf8(password) ++ utf8(user))
 *   outer = md5hex(utf8(inner)    ++ salt)          // salt = raw 4 bytes
 *   body  = "md5" ++ outer ++ "\0"
 *
 * Returns the framed message: Int8 'p', Int32 length, body.
 */
export function md5AuthResponse(
  user: string,
  password: string,
  salt: Uint8Array,
): Uint8Array {
  const inner = md5hex(concat(utf8.encode(password), utf8.encode(user)));
  const outer = md5hex(concat(utf8.encode(inner), salt));
  const body = utf8.encode("md5" + outer + "\0");
  const len = body.length + 4; // length includes the 4 length bytes, not the type byte
  const msg = new Uint8Array(1 + body.length + 4);
  msg[0] = 0x70; // 'p'
  msg[1] = (len >>> 24) & 0xff;
  msg[2] = (len >>> 16) & 0xff;
  msg[3] = (len >>> 8) & 0xff;
  msg[4] = len & 0xff;
  msg.set(body, 5);
  return msg;
}
