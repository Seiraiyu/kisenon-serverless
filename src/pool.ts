// `Pool` — pg-shaped surface whose `query` is an HTTP one-shot over `POST /sql`
// (`poolQueryViaFetch`, the neon default). `connect()` (a connection-pinned
// `PoolClient` over a WebSocket session) is Phase 8; until then it throws a clear
// placeholder. Extends the zero-dep `EventEmitter` for pg's `on(...)` surface.

import { EventEmitter } from "./event-emitter.js";
import {
  queryOneShot,
  resolveConfig,
  type ClientConfig,
  type QueryConfig,
  type Resolved,
} from "./http/one-shot.js";
import type { PgResult } from "./result.js";

/** `Pool` accepts the same config shape as `Client`. */
export type PoolConfig = ClientConfig;

export class Pool extends EventEmitter {
  private readonly resolved: Resolved;

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

  /** Phase 8 (WebSocket-backed `PoolClient`) — not implemented yet. */
  async connect(): Promise<never> {
    throw new Error(
      "pool.connect() WebSocket sessions are implemented in Phase 8",
    );
  }

  async end(): Promise<void> {
    this.emit("end");
  }
}
