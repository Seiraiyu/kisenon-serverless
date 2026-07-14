import { describe, expect, test } from "vitest";
import {
  buildSASLInitial,
  buildSASLResponse,
  clientFirst,
  makeNonce,
  runScram,
  scramOffered,
  scramProof,
  verifyServerFinal,
  type ScramIO,
} from "../src/auth/scram.js";

const utf8 = new TextEncoder();
const dec = new TextDecoder();

// RFC 7677 §3 published test vector.
const RFC7677 = {
  password: "pencil",
  clientFirstBare: "n=user,r=rOprNGfwEbeRWgbNEkqO",
  serverNonce: "rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0",
  saltB64: "W22ZaJ0SNY7soEsUEjb6gQ==",
  iterations: 4096,
  serverFirst:
    "r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096",
  clientProofB64: "dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=",
  serverSigB64: "6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=",
};

describe("clientFirst / makeNonce", () => {
  test("bare + gs2-prefixed message", () => {
    expect(clientFirst("abc")).toEqual({
      bare: "n=,r=abc",
      message: "n,,n=,r=abc",
    });
  });

  test("makeNonce is base64 of 18 random bytes (24 chars), non-repeating", () => {
    const a = makeNonce();
    const b = makeNonce();
    expect(a).toMatch(/^[A-Za-z0-9+/]{24}={0,2}$/);
    expect(atob(a).length).toBe(18);
    expect(a).not.toBe(b);
  });
});

describe("buildSASLInitial framing", () => {
  test("'p' + len + mechanism CString + int32 len + client-first", () => {
    const msg = buildSASLInitial("n,,n=,r=abc");
    expect(msg[0]).toBe(0x70); // 'p'
    const len = (msg[1]! << 24) | (msg[2]! << 16) | (msg[3]! << 8) | msg[4]!;
    expect(len).toBe(msg.length - 1); // length excludes the type byte

    const body = msg.subarray(5);
    // mechanism CString
    const nul = body.indexOf(0x00);
    expect(dec.decode(body.subarray(0, nul))).toBe("SCRAM-SHA-256");
    // int32 length of client-first
    const cf = "n,,n=,r=abc";
    const lo = nul + 1;
    const cfLen =
      (body[lo]! << 24) | (body[lo + 1]! << 16) | (body[lo + 2]! << 8) | body[lo + 3]!;
    expect(cfLen).toBe(cf.length);
    expect(dec.decode(body.subarray(lo + 4))).toBe(cf);
  });
});

describe("buildSASLResponse framing", () => {
  test("'p' + len + raw client-final (no mechanism prefix)", () => {
    const cf = "c=biws,r=xyz,p=AAAA";
    const msg = buildSASLResponse(cf);
    expect(msg[0]).toBe(0x70);
    const len = (msg[1]! << 24) | (msg[2]! << 16) | (msg[3]! << 8) | msg[4]!;
    expect(len).toBe(msg.length - 1);
    expect(dec.decode(msg.subarray(5))).toBe(cf);
  });
});

describe("scramOffered", () => {
  test("finds SCRAM-SHA-256 in a NUL-separated mechanism list", () => {
    expect(scramOffered(utf8.encode("SCRAM-SHA-256\x00"))).toBe(true);
    expect(scramOffered(utf8.encode("SCRAM-SHA-256-PLUS\x00SCRAM-SHA-256\x00"))).toBe(
      true,
    );
    expect(scramOffered(utf8.encode("SCRAM-SHA-256-PLUS\x00"))).toBe(false);
  });
});

describe("scramProof (RFC 7677 vector — math pinned independent of any server)", () => {
  test("clientFinal p= and expectedServerSig match the published vector", async () => {
    const { clientFinal, expectedServerSig } = await scramProof(
      RFC7677.password,
      RFC7677.clientFirstBare,
      RFC7677.serverFirst,
    );
    expect(clientFinal).toBe(
      "c=biws,r=" + RFC7677.serverNonce + ",p=" + RFC7677.clientProofB64,
    );
    // expectedServerSig == the server's v=
    const expectedB64 = btoa(String.fromCharCode(...expectedServerSig));
    expect(expectedB64).toBe(RFC7677.serverSigB64);
    expect(verifyServerFinal("v=" + RFC7677.serverSigB64, expectedServerSig)).toBe(
      true,
    );
  });

  test("rejects a server nonce that does not extend the client nonce", async () => {
    await expect(
      scramProof(RFC7677.password, "n=user,r=DIFFERENTNONCE", RFC7677.serverFirst),
    ).rejects.toThrow(/does not extend/);
  });
});

describe("verifyServerFinal (constant-time)", () => {
  const expected = new Uint8Array([1, 2, 3, 4]);
  const b64 = btoa(String.fromCharCode(...expected));

  test("accepts an exact match", () => {
    expect(verifyServerFinal("v=" + b64, expected)).toBe(true);
  });
  test("rejects a mismatch", () => {
    const wrong = btoa(String.fromCharCode(9, 9, 9, 9));
    expect(verifyServerFinal("v=" + wrong, expected)).toBe(false);
  });
  test("rejects a length mismatch", () => {
    const shorter = btoa(String.fromCharCode(1, 2, 3));
    expect(verifyServerFinal("v=" + shorter, expected)).toBe(false);
  });
  test("rejects a server error (e=)", () => {
    expect(verifyServerFinal("e=other-error", expected)).toBe(false);
  });
});

// --- runScram driver against a scripted in-memory server ------------------

// A minimal SCRAM *server* stub, parameterised by the RFC 7677 vector's salt +
// iterations. It echoes the client's real (random) nonce, appends a fixed
// server-nonce suffix, and derives the ServerSignature the same way any correct
// server would (via scramProof, whose expectedServerSig == the server's v=).
function makeServerIO(
  password: string,
  opts: { badSig?: boolean; noScram?: boolean } = {},
): { io: ScramIO; sent: Uint8Array[] } {
  const sent: Uint8Array[] = [];
  const salt = RFC7677.saltB64;
  const iters = RFC7677.iterations;
  const suffix = "%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0";

  let step = 0;
  let clientFirstBare = "";
  let serverFirst = "";

  const clientFirstFrom = (msg: Uint8Array): string => {
    // 'p'(1) + len(4) + mechanism CString + int32(4) + client-first bytes.
    const body = msg.subarray(5);
    const nul = body.indexOf(0x00);
    return dec.decode(body.subarray(nul + 1 + 4));
  };

  const recvAuth = async (): Promise<{ authType: number; body: Uint8Array }> => {
    step++;
    if (step === 1) {
      // AuthenticationSASL — advertise mechanism(s).
      const list = opts.noScram ? "SCRAM-SHA-256-PLUS\x00" : "SCRAM-SHA-256\x00";
      return { authType: 10, body: utf8.encode(list) };
    }
    if (step === 2) {
      // We have received SASLInitial; derive server-first echoing client nonce.
      const clientFirstMsg = clientFirstFrom(sent[0]!); // "n,,n=,r=<nonce>"
      clientFirstBare = clientFirstMsg.slice(3); // strip "n,,"
      const clientNonce = clientFirstBare.split(",").find((a) => a.startsWith("r="))!.slice(2);
      serverFirst = "r=" + clientNonce + suffix + ",s=" + salt + ",i=" + iters;
      return { authType: 11, body: utf8.encode(serverFirst) };
    }
    if (step === 3) {
      // We have received SASLResponse; produce the correct (or corrupted) v=.
      const { expectedServerSig } = await scramProof(
        password,
        clientFirstBare,
        serverFirst,
      );
      const sig = new Uint8Array(expectedServerSig);
      if (opts.badSig) sig[0] = (sig[0] ?? 0) ^ 0xff;
      const v = btoa(String.fromCharCode(...sig));
      return { authType: 12, body: utf8.encode("v=" + v) };
    }
    // AuthenticationOk.
    return { authType: 0, body: new Uint8Array(0) };
  };

  return { io: { send: (m) => sent.push(m), recvAuth }, sent };
}

describe("runScram handshake driver", () => {
  test("completes against a faithful scripted server (SASLInitial → SASLResponse → v=)", async () => {
    const { io, sent } = makeServerIO(RFC7677.password);
    await expect(runScram("user", RFC7677.password, io)).resolves.toBeUndefined();
    // Sent exactly two client messages: SASLInitial then SASLResponse, both 'p'.
    expect(sent.length).toBe(2);
    expect(sent[0]![0]).toBe(0x70);
    expect(sent[1]![0]).toBe(0x70);
    // SASLResponse body is a client-final message.
    expect(dec.decode(sent[1]!.subarray(5))).toMatch(/^c=biws,r=.*,p=.+$/);
  });

  test("throws on a server signature mismatch (does not resolve to Ok)", async () => {
    const { io } = makeServerIO(RFC7677.password, { badSig: true });
    await expect(runScram("user", RFC7677.password, io)).rejects.toThrow(
      /signature mismatch/,
    );
  });

  test("throws when the server does not offer SCRAM-SHA-256", async () => {
    const { io } = makeServerIO(RFC7677.password, { noScram: true });
    await expect(runScram("user", RFC7677.password, io)).rejects.toThrow(
      /did not offer/,
    );
  });
});
