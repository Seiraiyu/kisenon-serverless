// Per-runtime outbound-WebSocket adapter (design §4.7). The WS (`/v2`) transport
// needs one uniform duplex regardless of how the host runtime exposes outbound
// WebSockets — and they disagree sharply:
//
//   • Node <22 has no global `WebSocket`; you inject the `ws` package via
//     `neonConfig.webSocketConstructor` (branch 1).
//   • Cloudflare Workers has a global `WebSocket` type but CANNOT `new` one for
//     an OUTBOUND connection — you must `fetch(url,{Upgrade})` and read the
//     `webSocket` off the 101 response (branch 2). So Workers MUST be tried
//     before the generic global-`WebSocket` branch.
//   • Deno / Bun / Node ≥22 / browsers have a usable global `WebSocket` (branch 3).
//   • Vercel Edge has neither an injectable ctor nor outbound WS — branch 4
//     throws the one actionable error that points the caller at the HTTP path.
//
// Web-standard only (Uint8Array/ArrayBuffer/EventTarget) — no Node types — so it
// loads unmodified in Workers/Edge/Deno/Bun/Node ≥18.

import type { NeonConfig } from "../config.js";

/**
 * Uniform binary duplex the WS session (`src/ws/connection.ts`) speaks. Every
 * runtime branch below normalizes to this shape: `send` takes a binary frame,
 * `onMessage` yields inbound frames already coerced to `Uint8Array`.
 */
export interface WsSocket {
  /** Resolves once the socket is open (already-resolved for the Workers accept() path). */
  readonly ready: Promise<void>;
  /** Send one binary frame. */
  send(data: Uint8Array): void;
  /** Register the inbound-frame callback (bytes are always a `Uint8Array`). */
  onMessage(cb: (data: Uint8Array) => void): void;
  /** Register the close callback. */
  onClose(cb: (info: { code: number; reason: string }) => void): void;
  /** Close the socket. */
  close(code?: number, reason?: string): void;
}

/** The subset of the standard `WebSocket` interface we drive (also satisfied by the `ws` package). */
interface StandardWebSocket {
  binaryType: string;
  send(data: ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (ev: unknown) => void): void;
}

interface WebSocketCtor {
  new (url: string): StandardWebSocket;
}

/** The Cloudflare-Workers socket read off a fetch-upgrade 101 response. */
interface AcceptedWebSocket {
  accept(): void;
  send(data: ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (ev: unknown) => void): void;
}

const NO_WEBSOCKET_ERROR =
  "No WebSocket implementation: this runtime has no outbound WebSocket (e.g. Vercel Edge). " +
  "Use the HTTP path (neon()/pool.query) or set neonConfig.webSocketConstructor.";

/**
 * Resolve an outbound-WebSocket mechanism for `url` and normalize it to a
 * {@link WsSocket}. Resolution order (design §4.7): injected ctor → Cloudflare
 * Workers fetch-upgrade → global `WebSocket` → throw the actionable no-WS error.
 */
export async function openWebSocket(url: string, cfg: NeonConfig): Promise<WsSocket> {
  // 1. Injected constructor (Node <22 → the `ws` package).
  if (cfg.webSocketConstructor) {
    const Ctor = cfg.webSocketConstructor as WebSocketCtor;
    return adaptStandard(new Ctor(url));
  }

  const g = globalThis as unknown as {
    WebSocket?: WebSocketCtor;
    WebSocketPair?: unknown;
    navigator?: { userAgent?: string };
    fetch?: (input: string, init: { headers: Record<string, string> }) => Promise<unknown>;
  };

  // 2. Cloudflare Workers: has a global WebSocket *type* but cannot `new` one
  //    outbound — detect Workers and use the fetch-upgrade path instead.
  const isWorkers =
    typeof g.WebSocketPair !== "undefined" ||
    (typeof g.navigator !== "undefined" && g.navigator?.userAgent === "Cloudflare-Workers");
  if (isWorkers && typeof g.fetch === "function") {
    const resp = (await g.fetch(url, { headers: { Upgrade: "websocket" } })) as {
      webSocket?: AcceptedWebSocket;
    };
    const socket = resp.webSocket;
    if (!socket) {
      throw new Error("kisenon: Cloudflare Workers WebSocket upgrade failed (no webSocket on 101 response)");
    }
    socket.accept();
    return adaptAccepted(socket);
  }

  // 3. Global WebSocket (Deno / Bun / Node ≥22 / browser).
  if (typeof g.WebSocket === "function") {
    return adaptStandard(new g.WebSocket(url));
  }

  // 4. No outbound WebSocket in this runtime.
  throw new Error(NO_WEBSOCKET_ERROR);
}

/** Adapt a standard `WebSocket` (or `ws`-package instance) to {@link WsSocket}. */
function adaptStandard(ws: StandardWebSocket): WsSocket {
  ws.binaryType = "arraybuffer";
  const ready = new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("kisenon: WebSocket connection error")));
  });
  return {
    ready,
    send: (data) => ws.send(toArrayBuffer(data)),
    onMessage: (cb) => ws.addEventListener("message", (ev) => cb(toBytes((ev as { data: unknown }).data))),
    onClose: (cb) =>
      ws.addEventListener("close", (ev) => {
        const e = ev as { code?: number; reason?: string };
        cb({ code: e.code ?? 0, reason: e.reason ?? "" });
      }),
    close: (code, reason) => ws.close(code, reason),
  };
}

/** Adapt an already-accepted Cloudflare-Workers socket to {@link WsSocket}. */
function adaptAccepted(socket: AcceptedWebSocket): WsSocket {
  return {
    ready: Promise.resolve(),
    send: (data) => socket.send(toArrayBuffer(data)),
    onMessage: (cb) => socket.addEventListener("message", (ev) => cb(toBytes((ev as { data: unknown }).data))),
    onClose: (cb) =>
      socket.addEventListener("close", (ev) => {
        const e = ev as { code?: number; reason?: string };
        cb({ code: e.code ?? 0, reason: e.reason ?? "" });
      }),
    close: (code, reason) => socket.close(code, reason),
  };
}

const TEXT_ENCODER = new TextEncoder();

/**
 * Copy `u` into a fresh, exactly-sized `ArrayBuffer`. A plain `u.buffer` may be
 * over-allocated (pooled) or a `SharedArrayBuffer`, and TS 5.9's `BufferSource`
 * typing rejects `Uint8Array<ArrayBufferLike>` — a fresh copy sidesteps both.
 */
function toArrayBuffer(u: Uint8Array): ArrayBuffer {
  const ab = new ArrayBuffer(u.byteLength);
  new Uint8Array(ab).set(u);
  return ab;
}

/** Coerce an inbound frame (ArrayBuffer / typed-array view / string) to a `Uint8Array`. */
function toBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  if (typeof data === "string") return TEXT_ENCODER.encode(data);
  throw new Error("kisenon: unexpected WebSocket message data type");
}
