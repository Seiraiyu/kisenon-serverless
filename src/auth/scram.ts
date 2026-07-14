// SCRAM-SHA-256 client authentication on Web-standard crypto only.
//
// A faithful TS port of the proven Go client in
// seiraiyu-neon/src/proxy/internal/edgedriver/scram_client.go (RFC 5802 / 7677,
// gs2 header "n,," — no channel binding). The only substitution is the crypto
// primitive source: crypto.subtle (SHA-256 / HMAC / PBKDF2) instead of Go's
// crypto/* stdlib, so this loads unmodified in Workers/Deno/Bun/Node>=18 with no
// dependency and no Node `crypto`/`Buffer`. The password is derived-through
// only; nothing here logs it.

const MECHANISM = "SCRAM-SHA-256";
const GS2_HEADER = "n,,";
const GS2_HEADER_B64 = "biws"; // base64("n,,")

const utf8 = new TextEncoder();
const dec = new TextDecoder();

// --- base64 (no Buffer; btoa/atob operate on binary strings) --------------

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// --- crypto.subtle primitives ---------------------------------------------

// The DOM lib types crypto.subtle inputs as `BufferSource`, whose byte-view
// form is `ArrayBufferView<ArrayBuffer>`; a bare `Uint8Array` widens to
// `Uint8Array<ArrayBufferLike>` and no longer matches. Our arrays are always
// ArrayBuffer-backed, so cast at the boundary.
const bs = (u: Uint8Array): BufferSource => u as unknown as BufferSource;

async function hmacSHA256(key: Uint8Array, msg: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey(
    "raw",
    bs(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", k, bs(msg));
  return new Uint8Array(sig);
}

async function sha256(msg: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bs(msg)));
}

async function pbkdf2SHA256(
  password: Uint8Array,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", bs(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: bs(salt), iterations, hash: "SHA-256" },
    k,
    256, // 32 bytes
  );
  return new Uint8Array(bits);
}

// --- message framing ('p') -------------------------------------------------

// A frontend PasswordMessage: Int8 'p', Int32 length (includes the 4 length
// bytes, excludes the type byte), then body.
function frameP(body: Uint8Array): Uint8Array {
  const len = body.length + 4;
  const msg = new Uint8Array(1 + body.length + 4);
  msg[0] = 0x70; // 'p'
  msg[1] = (len >>> 24) & 0xff;
  msg[2] = (len >>> 16) & 0xff;
  msg[3] = (len >>> 8) & 0xff;
  msg[4] = len & 0xff;
  msg.set(body, 5);
  return msg;
}

// --- client-first ----------------------------------------------------------

/** base64 of 18 random bytes — the SCRAM client nonce. */
export function makeNonce(): string {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(18)));
}

/**
 * client-first-message. The username is empty (`n=`) — Postgres carries it in
 * the StartupMessage, matching scram_client.go and vanilla scram-sha-256.
 *   bare    = "n=,r=" + nonce
 *   message = "n,," + bare
 */
export function clientFirst(nonce: string): { bare: string; message: string } {
  const bare = "n=,r=" + nonce;
  return { bare, message: GS2_HEADER + bare };
}

/**
 * SASLInitialResponse ('p'): CString mechanism + Int32 length of the SCRAM
 * client-first + the client-first bytes. Returns the full framed message.
 */
export function buildSASLInitial(clientFirstMessage: string): Uint8Array {
  const mech = utf8.encode(MECHANISM);
  const cf = utf8.encode(clientFirstMessage);
  const body = new Uint8Array(mech.length + 1 + 4 + cf.length);
  body.set(mech, 0);
  body[mech.length] = 0x00; // CString NUL
  const off = mech.length + 1;
  body[off] = (cf.length >>> 24) & 0xff;
  body[off + 1] = (cf.length >>> 16) & 0xff;
  body[off + 2] = (cf.length >>> 8) & 0xff;
  body[off + 3] = cf.length & 0xff;
  body.set(cf, off + 4);
  return frameP(body);
}

// --- server-first parsing --------------------------------------------------

interface ServerFirst {
  nonce: string;
  salt: Uint8Array;
  iterations: number;
}

function parseServerFirst(s: string): ServerFirst {
  let nonce: string | undefined;
  let salt: Uint8Array | undefined;
  let iterations: number | undefined;
  for (const attr of s.split(",")) {
    if (attr.length < 2 || attr[1] !== "=") continue;
    const val = attr.slice(2);
    switch (attr[0]) {
      case "r":
        nonce = val;
        break;
      case "s":
        salt = base64ToBytes(val);
        break;
      case "i": {
        const n = Number.parseInt(val, 10);
        if (!Number.isFinite(n) || n <= 0) {
          throw new Error("scram: bad iteration count");
        }
        iterations = n;
        break;
      }
    }
  }
  if (nonce === undefined || salt === undefined || iterations === undefined) {
    throw new Error("scram: incomplete server-first message");
  }
  return { nonce, salt, iterations };
}

// --- proof (RFC 5802 §3) ---------------------------------------------------

/**
 * Compute the client-final-message and the ServerSignature we expect back.
 * `clientFirstBare` is the "n=...,r=<nonce>" the client sent; `serverFirst` is
 * the raw server-first-message string.
 */
export async function scramProof(
  password: string,
  clientFirstBare: string,
  serverFirst: string,
): Promise<{ clientFinal: string; expectedServerSig: Uint8Array }> {
  const sf = parseServerFirst(serverFirst);

  // The server nonce must extend the client nonce (anti-replay).
  const clientNonce = clientNonceOf(clientFirstBare);
  if (!sf.nonce.startsWith(clientNonce)) {
    throw new Error("scram: server nonce does not extend client nonce");
  }

  const saltedPassword = await pbkdf2SHA256(
    utf8.encode(password),
    sf.salt,
    sf.iterations,
  );
  const clientKey = await hmacSHA256(saltedPassword, utf8.encode("Client Key"));
  const storedKey = await sha256(clientKey);
  const clientFinalNoProof = "c=" + GS2_HEADER_B64 + ",r=" + sf.nonce;
  const authMessage = clientFirstBare + "," + serverFirst + "," + clientFinalNoProof;
  const authBytes = utf8.encode(authMessage);
  const clientSignature = await hmacSHA256(storedKey, authBytes);

  const clientProof = new Uint8Array(clientKey.length);
  for (let i = 0; i < clientKey.length; i++) {
    clientProof[i] = clientKey[i]! ^ clientSignature[i]!;
  }

  const serverKey = await hmacSHA256(saltedPassword, utf8.encode("Server Key"));
  const expectedServerSig = await hmacSHA256(serverKey, authBytes);

  const clientFinal = clientFinalNoProof + ",p=" + bytesToBase64(clientProof);
  return { clientFinal, expectedServerSig };
}

function clientNonceOf(clientFirstBare: string): string {
  for (const attr of clientFirstBare.split(",")) {
    if (attr.startsWith("r=")) return attr.slice(2);
  }
  return "";
}

/**
 * Verify the server-final-message "v=<b64 ServerSignature>" against `expected`
 * in constant time (XOR-accumulate, never `===` on the decoded bytes).
 */
export function verifyServerFinal(
  serverFinal: string,
  expected: Uint8Array,
): boolean {
  let sig: Uint8Array | undefined;
  for (const attr of serverFinal.split(",")) {
    if (attr.startsWith("v=")) {
      sig = base64ToBytes(attr.slice(2));
      break;
    }
    if (attr.startsWith("e=")) return false; // server-reported error
  }
  if (sig === undefined || sig.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= sig[i]! ^ expected[i]!;
  return diff === 0;
}

// --- SASLResponse / handshake driver --------------------------------------

/** SASLResponse ('p'): the client-final bytes with no mechanism prefix. */
export function buildSASLResponse(clientFinal: string): Uint8Array {
  return frameP(utf8.encode(clientFinal));
}

/**
 * Does the AuthenticationSASL mechanism list (NUL-separated names) advertise
 * SCRAM-SHA-256?
 */
export function scramOffered(mechList: Uint8Array): boolean {
  for (const name of dec.decode(mechList).split("\x00")) {
    if (name === MECHANISM) return true;
  }
  return false;
}

/** Parsed Authentication ('R') message, as produced by the protocol layer. */
export interface AuthMessage {
  authType: number;
  body: Uint8Array; // bytes after the 4-byte auth-type code
}

export interface ScramIO {
  send(msg: Uint8Array): void;
  recvAuth(): Promise<AuthMessage>;
}

/**
 * Drive the full SCRAM-SHA-256 handshake. The caller has already sent the
 * StartupMessage; `io.recvAuth()` yields already-parsed Authentication
 * messages. Sequencing (mirrors scram_client.go):
 *   10 SASL          → send SASLInitial
 *   11 SASLContinue  → serverFirst → send SASLResponse(clientFinal)
 *   12 SASLFinal     → verify v=
 *    0 Ok            → resolve
 */
export async function runScram(
  user: string,
  password: string,
  io: ScramIO,
): Promise<void> {
  void user; // username travels in the StartupMessage, not the SCRAM exchange.
  const nonce = makeNonce();
  const cf = clientFirst(nonce);
  let expectedServerSig: Uint8Array = new Uint8Array(0);
  let sawFinal = false;

  for (;;) {
    const { authType, body } = await io.recvAuth();
    switch (authType) {
      case 10: // AuthenticationSASL
        if (!scramOffered(body)) {
          throw new Error("scram: server did not offer SCRAM-SHA-256");
        }
        io.send(buildSASLInitial(cf.message));
        break;
      case 11: {
        // AuthenticationSASLContinue: body is the server-first-message.
        const serverFirst = dec.decode(body);
        const proof = await scramProof(password, cf.bare, serverFirst);
        expectedServerSig = proof.expectedServerSig;
        io.send(buildSASLResponse(proof.clientFinal));
        break;
      }
      case 12: {
        // AuthenticationSASLFinal: body is "v=<b64 ServerSignature>".
        const serverFinal = dec.decode(body);
        if (!verifyServerFinal(serverFinal, expectedServerSig)) {
          throw new Error("scram: server signature mismatch");
        }
        sawFinal = true;
        break;
      }
      case 0: // AuthenticationOk
        if (!sawFinal) {
          throw new Error("scram: AuthenticationOk before server-final");
        }
        return;
      default:
        throw new Error("scram: unexpected auth type " + authType);
    }
  }
}
