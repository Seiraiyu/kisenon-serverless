// HTTP `/sql` transport: build the request (URL from `fetchEndpoint(host,port)`,
// neon control headers, JSON body), POST it via the global `fetch` (edge-safe,
// injectable for tests), and translate the response. On a `503 {code:
// "endpoint_waking"}` wake the request is retried with a bounded backoff
// (Retry-After honored; ~5 tries / ~10s cap) before surfacing a
// `DatabaseError{code:"endpoint_waking"}`. Any other non-2xx maps via
// `mapHttpError`. The connection string is sent only in the `Neon-Connection-
// String` header and never logged.

import type { ConnectionConfig } from "../connection-string.js";
import type { NeonConfig } from "../config.js";
import { DatabaseError, mapHttpError } from "./errors.js";
import { paramToText } from "../param-text.js";

/** A single query for the `{query,params,types?}` body. */
export interface SqlRequest {
  query: string;
  params?: unknown[];
  types?: number[];
}

/** The two accepted body shapes: a single query or a `{queries:[…]}` batch. */
export type SqlBody = SqlRequest | { queries: SqlRequest[] };

/** Per-call transport options (auth, endpoint, injected fetch, batch headers). */
export interface PostSqlOptions {
  authToken?: string;
  fetchEndpoint: NeonConfig["fetchEndpoint"];
  fetchOptions?: RequestInit;
  batchHeaders?: Record<string, string>;
  /** Injected `fetch` (defaults to the global). */
  fetch?: typeof fetch;
  /** Original connection string to send verbatim; reconstructed if omitted. */
  connectionString?: string;
}

const MAX_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 200;
const BACKOFF_CAP_MS = 3000;

/**
 * Serialize one query param for the HTTP JSON body. Primitives stay native
 * (preserving the wire shape); everything else routes through the shared
 * Postgres-text serializer (`Date`→ISO, byte array→`\x…`, `bigint`→decimal,
 * object/array→JSON) so the HTTP and WS paths cannot diverge. `null`/`undefined`
 * → `null`.
 */
function serializeParam(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "string") {
    return v;
  }
  return paramToText(v);
}

function serializeRequest(req: SqlRequest): SqlRequest {
  const out: SqlRequest = { query: req.query };
  if (req.params !== undefined) out.params = req.params.map(serializeParam);
  if (req.types !== undefined) out.types = req.types;
  return out;
}

/** URL-encode userinfo and rebuild `postgres://…` when no original string given. */
function reconstructConnString(cfg: ConnectionConfig): string {
  const auth = `${encodeURIComponent(cfg.user)}:${encodeURIComponent(cfg.password)}`;
  let url = `postgres://${auth}@${cfg.host}:${cfg.port}/${cfg.database}`;
  const params: string[] = [];
  if (!cfg.ssl) params.push("sslmode=disable");
  if (cfg.options) params.push(`options=${encodeURIComponent(cfg.options)}`);
  if (params.length > 0) url += `?${params.join("&")}`;
  return url;
}

function resolveEndpoint(
  fetchEndpoint: NeonConfig["fetchEndpoint"],
  cfg: ConnectionConfig,
): string {
  return typeof fetchEndpoint === "function"
    ? fetchEndpoint(cfg.host, cfg.port)
    : fetchEndpoint;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isWaking(body: unknown): boolean {
  return isObject(body) && body["code"] === "endpoint_waking";
}

/** Retry delay: `Retry-After` seconds if valid, else capped exponential backoff. */
function retryDelayMs(retryAfter: string | null, attempt: number): number {
  if (retryAfter !== null) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, BACKOFF_CAP_MS);
  }
  return Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_CAP_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * POST a single or batch SQL body to `/sql` and return the parsed JSON envelope
 * (single) or `{results:[…]}` (batch). Retries endpoint-waking 503s; throws a
 * `DatabaseError` on any other failure.
 */
export async function postSql(
  cfg: ConnectionConfig,
  body: SqlBody,
  opts: PostSqlOptions,
): Promise<unknown> {
  const doFetch = opts.fetch ?? fetch;
  const url = resolveEndpoint(opts.fetchEndpoint, cfg);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Neon-Array-Mode": "true",
    "Neon-Raw-Text-Output": "true",
  };
  if (opts.authToken !== undefined) {
    headers["Authorization"] = `Bearer ${opts.authToken}`;
  } else {
    headers["Neon-Connection-String"] =
      opts.connectionString ?? reconstructConnString(cfg);
  }
  if (opts.batchHeaders) Object.assign(headers, opts.batchHeaders);

  const payload: SqlBody =
    "queries" in body
      ? { queries: body.queries.map(serializeRequest) }
      : serializeRequest(body);
  const serializedBody = JSON.stringify(payload);

  const init: RequestInit = {
    ...opts.fetchOptions,
    method: "POST",
    headers: { ...headers, ...(opts.fetchOptions?.headers as Record<string, string>) },
    body: serializedBody,
  };

  for (let attempt = 0; ; attempt++) {
    const res = await doFetch(url, init);
    if (res.ok) {
      return (await res.json()) as unknown;
    }

    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }

    if (res.status === 503 && isWaking(parsed)) {
      if (attempt + 1 >= MAX_ATTEMPTS) {
        const err = new DatabaseError("endpoint is waking, please retry shortly");
        err.code = "endpoint_waking";
        throw err;
      }
      await sleep(retryDelayMs(res.headers.get("Retry-After"), attempt));
      continue;
    }

    throw mapHttpError(res.status, parsed);
  }
}
