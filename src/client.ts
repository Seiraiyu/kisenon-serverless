// `Client` — pg-shaped surface backed by HTTP one-shots. `connect()` is a no-op
// for the HTTP path (the WebSocket session lands in Phase 8); `query` routes
// every call through `POST /sql` (`poolQueryViaFetch`). Extends the zero-dep
// `EventEmitter` so `on('end'|'error'|'notice'|'notification')` port from pg.

import { EventEmitter } from "./event-emitter.js";
import {
  queryOneShot,
  resolveConfig,
  type ClientConfig,
  type QueryConfig,
  type Resolved,
} from "./http/one-shot.js";
import type { PgResult } from "./result.js";

export type { ClientConfig } from "./http/one-shot.js";

export class Client extends EventEmitter {
  private readonly resolved: Resolved;

  constructor(config: string | ClientConfig) {
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

  /** No-op for HTTP one-shots; Phase 8 opens the WebSocket session here. */
  async connect(): Promise<void> {
    return;
  }

  async end(): Promise<void> {
    this.emit("end");
  }
}
