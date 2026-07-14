// `Pool` — pg-shaped surface whose `query` is an HTTP one-shot over `POST /sql`
// (`poolQueryViaFetch`, the neon default), and whose `connect()` pins a real
// WebSocket session: `wsProxy(host)` → `wss://` (when `useSecureWebSocket`) →
// `openWebSocket` (the runtime adapter) → `WireConnection` → `startSession`,
// returning a `PoolClient` whose `query()` runs over that one pinned session.
// A small idle set (keyed by config) lets `release()` hand the session back for
// reuse instead of re-authenticating. Extends the zero-dep `EventEmitter`.

import { neonConfig } from "./config.js";
import { EventEmitter } from "./event-emitter.js";
import {
  queryOneShot,
  resolveConfig,
  type ClientConfig,
  type QueryConfig,
  type Resolved,
} from "./http/one-shot.js";
import type { ConnectionConfig } from "./connection-string.js";
import type { PgResult } from "./result.js";
import { openWebSocket } from "./ws/adapter.js";
import { WireConnection, sessionQuery, startSession, type Notification } from "./ws/connection.js";

/** `Pool` accepts the same config shape as `Client`. */
export type PoolConfig = ClientConfig;

/** Bound on idle sessions retained per config key; excess sessions are closed on release. */
const MAX_IDLE_PER_KEY = 10;

/** Config identity for the idle set — one keyed bucket per endpoint+role+database. */
function idleKey(cfg: ConnectionConfig): string {
  return `${cfg.host}|${cfg.port}|${cfg.user}|${cfg.database}`;
}

/**
 * A connection-pinned client over a single WebSocket session (pg's
 * `PoolClient`). Every `query()` runs on the SAME session (one Startup, one
 * auth) — the basis for a pinned transaction — and out-of-band LISTEN/NOTIFY
 * arrives via the "notification" event. `release()` returns it to the pool.
 */
export class PoolClient extends EventEmitter {
  constructor(
    private readonly conn: WireConnection,
    private readonly pool: Pool,
    private readonly key: string,
  ) {
    super();
  }

  /** Run one query over the pinned session (simple, or extended when `params` are given). */
  query(text: string, params?: unknown[]): Promise<PgResult> {
    return sessionQuery(this.conn, text, params, (n: Notification) =>
      this.emit("notification", n),
    );
  }

  /** Return this session to the pool (or close it if the idle set is full). */
  release(): void {
    this.pool.returnClient(this.key, this);
  }

  /** @internal Close the underlying WebSocket session. */
  closeSession(): void {
    this.conn.close();
  }
}

export class Pool extends EventEmitter {
  private readonly resolved: Resolved;
  private readonly idle = new Map<string, PoolClient[]>();

  constructor(config: string | PoolConfig) {
    super();
    this.resolved = resolveConfig(config);
  }

  query(text: string, params?: unknown[]): Promise<PgResult>;
  query(config: QueryConfig): Promise<PgResult>;
  query(
    textOrConfig: string | QueryConfig,
    params?: unknown[],
  ): Promise<PgResult> {
    return queryOneShot(this.resolved, textOrConfig, params);
  }

  /**
   * Pin a WebSocket session and return a `PoolClient`. Reuses an idle session
   * for the same config when available; otherwise dials `wsProxy(host)`, opens
   * the runtime WebSocket, and boots the session. Rejects with the adapter's
   * actionable no-WS error on a runtime with no outbound WebSocket.
   */
  async connect(): Promise<PoolClient> {
    const cfg = this.resolved.cfg;
    const key = idleKey(cfg);

    const bucket = this.idle.get(key);
    if (bucket && bucket.length > 0) {
      return bucket.pop()!;
    }

    const proxy =
      typeof neonConfig.wsProxy === "function"
        ? neonConfig.wsProxy(cfg.host, cfg.port)
        : neonConfig.wsProxy;
    const scheme = neonConfig.useSecureWebSocket ? "wss" : "ws";
    const url = `${scheme}://${proxy}`;

    const socket = await openWebSocket(url, neonConfig);
    const conn = new WireConnection(socket);
    await socket.ready;
    await startSession(conn, cfg);
    return new PoolClient(conn, this, key);
  }

  /** @internal Return a released `PoolClient` to its idle bucket, or close it if full. */
  returnClient(key: string, client: PoolClient): void {
    client.removeAllListeners(); // drop this checkout's listeners before reuse
    const bucket = this.idle.get(key) ?? [];
    if (bucket.length >= MAX_IDLE_PER_KEY) {
      client.closeSession();
      return;
    }
    bucket.push(client);
    this.idle.set(key, bucket);
  }

  async end(): Promise<void> {
    for (const bucket of this.idle.values()) {
      for (const client of bucket) client.closeSession();
    }
    this.idle.clear();
    this.emit("end");
  }
}
