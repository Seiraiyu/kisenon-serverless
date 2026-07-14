import { afterEach, describe, expect, test, vi } from "vitest";
import { neonConfig, type NeonConfig } from "../src/config.js";
import { openWebSocket } from "../src/ws/adapter.js";

// A standard-WebSocket-shaped fake to inject via neonConfig.webSocketConstructor.
const built: FakeWs[] = [];
class FakeWs {
  binaryType = "";
  readonly sent: ArrayBuffer[] = [];
  private readonly listeners: Record<string, ((ev: unknown) => void)[]> = {};
  constructor(readonly url: string) {
    built.push(this);
  }
  addEventListener(type: string, cb: (ev: unknown) => void): void {
    (this.listeners[type] ??= []).push(cb);
  }
  send(data: ArrayBuffer): void {
    this.sent.push(data);
  }
  close(): void {}
  emit(type: string, ev: unknown): void {
    for (const cb of this.listeners[type] ?? []) cb(ev);
  }
}

afterEach(() => {
  built.length = 0;
  vi.unstubAllGlobals();
});

describe("openWebSocket — injected constructor (branch 1)", () => {
  test("uses the injected ctor and normalizes send/onMessage", async () => {
    const cfg: NeonConfig = { ...neonConfig, webSocketConstructor: FakeWs };
    const sock = await openWebSocket("wss://ep.usc1.kisenon.com/v2", cfg);

    const ws = built[0]!;
    expect(ws.url).toBe("wss://ep.usc1.kisenon.com/v2");
    expect(ws.binaryType).toBe("arraybuffer");

    // send normalizes Uint8Array -> ArrayBuffer frame.
    sock.send(new Uint8Array([1, 2, 3]));
    expect(new Uint8Array(ws.sent[0]!)).toEqual(new Uint8Array([1, 2, 3]));

    // onMessage normalizes an inbound ArrayBuffer -> Uint8Array.
    let got: Uint8Array | undefined;
    sock.onMessage((d) => (got = d));
    ws.emit("message", { data: new Uint8Array([9, 8, 7]).buffer });
    expect(got).toEqual(new Uint8Array([9, 8, 7]));

    // ready resolves on the 'open' event.
    let opened = false;
    void sock.ready.then(() => (opened = true));
    ws.emit("open", {});
    await sock.ready;
    expect(opened).toBe(true);
  });
});

describe("openWebSocket — Cloudflare Workers fetch-upgrade (branch 2)", () => {
  test("upgrades via fetch with an http(s):// URL, not ws(s)://", async () => {
    let fetchedUrl: string | undefined;
    const socket = {
      accept: vi.fn(),
      addEventListener: vi.fn(),
      send: vi.fn(),
      close: vi.fn(),
    };
    // A non-undefined WebSocketPair marks the runtime as Cloudflare Workers.
    vi.stubGlobal("WebSocketPair", function WebSocketPair() {});
    vi.stubGlobal("fetch", async (u: string) => {
      fetchedUrl = u;
      return { webSocket: socket };
    });

    const cfg: NeonConfig = { ...neonConfig };
    delete cfg.webSocketConstructor;

    await openWebSocket("wss://ep.usc1.kisenon.com/v2", cfg);

    // workerd rejects ws(s):// — the adapter must convert the scheme.
    expect(fetchedUrl).toBe("https://ep.usc1.kisenon.com/v2");
    expect(socket.accept).toHaveBeenCalled();
  });
});

describe("openWebSocket — no outbound WebSocket (branch 4)", () => {
  test("throws the exact actionable no-WS error", async () => {
    vi.stubGlobal("WebSocket", undefined);
    vi.stubGlobal("WebSocketPair", undefined);
    vi.stubGlobal("navigator", undefined);

    const cfg: NeonConfig = { ...neonConfig };
    delete cfg.webSocketConstructor;

    await expect(openWebSocket("wss://ep.usc1.kisenon.com/v2", cfg)).rejects.toThrow(
      "No WebSocket implementation: this runtime has no outbound WebSocket (e.g. Vercel Edge). " +
        "Use the HTTP path (neon()/pool.query) or set neonConfig.webSocketConstructor.",
    );
  });
});
