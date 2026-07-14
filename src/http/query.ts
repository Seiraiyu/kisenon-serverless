// `neon(connectionString)` — the tagged-template query surface and its `.query`
// / `.transaction` methods, all over the HTTP `/sql` transport. A template call
// (`` sql`SELECT ${id}` ``) or `sql.query(text, params)` returns a lazy
// `NeonQueryPromise`: awaiting it POSTs a single query; passing an array of them
// to `sql.transaction([...])` collects the unexecuted `{query,params}` into one
// batch `{queries:[…]}` POST with the isolation headers. Options resolve
// per-call over the `neon()` defaults over `neonConfig`.

import { neonConfig, type NeonConfig } from "../config.js";
import { normalizeConfig, type ConnectionConfig } from "../connection-string.js";
import { parseBatch, parseEnvelope } from "./envelope.js";
import { reshape } from "./reshape.js";
import { postSql, type SqlRequest } from "./transport.js";

/** Postgres isolation levels accepted by `transaction()` (neon enum spelling). */
export type IsolationLevel =
  | "Serializable"
  | "RepeatableRead"
  | "ReadCommitted"
  | "ReadUncommitted";

/** Per-call / per-instance query options (merged over `neonConfig`). */
export interface NeonOptions {
  arrayMode?: boolean;
  fullResults?: boolean;
  fetchOptions?: RequestInit;
  authToken?: string;
  fetchEndpoint?: NeonConfig["fetchEndpoint"];
  /** Injected `fetch` (tests / custom runtimes). */
  fetch?: typeof fetch;
  /** Batch-only: transaction isolation controls (ignored on single queries). */
  isolationLevel?: IsolationLevel;
  readOnly?: boolean;
  deferrable?: boolean;
}

/** The callable `neon()` result: a template tag with `.query`/`.transaction`. */
export interface NeonQueryFn {
  (strings: TemplateStringsArray, ...values: unknown[]): NeonQueryPromise;
  query(text: string, params?: unknown[], opts?: NeonOptions): NeonQueryPromise;
  transaction(
    queries: Array<NeonQueryPromise | SqlRequest>,
    opts?: NeonOptions,
  ): Promise<unknown[]>;
}

type Executor = (req: SqlRequest, opts: NeonOptions) => Promise<unknown>;

/**
 * A thenable that carries an unexecuted `{query,params}`. Awaiting it runs the
 * single-query HTTP path; `transaction()` reads `.request` instead of awaiting,
 * so members batch rather than fire individually.
 */
export class NeonQueryPromise implements PromiseLike<unknown> {
  constructor(
    private readonly execute: Executor,
    /** The unexecuted query — read by `transaction()`. */
    readonly request: SqlRequest,
    private readonly opts: NeonOptions,
  ) {}

  then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.execute(this.request, this.opts).then(onfulfilled, onrejected);
  }

  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ): Promise<unknown> {
    return this.then(undefined, onrejected);
  }

  finally(onfinally?: (() => void) | null): Promise<unknown> {
    return Promise.resolve(this as PromiseLike<unknown>).finally(onfinally);
  }
}

/** Build `{query,params}` from a template's static parts + interpolated holes. */
function buildTemplate(
  strings: TemplateStringsArray,
  values: unknown[],
): SqlRequest {
  let query = "";
  const params: unknown[] = [];
  for (let i = 0; i < strings.length; i++) {
    query += strings[i] ?? "";
    if (i < values.length) {
      params.push(values[i]);
      query += `$${params.length}`;
    }
  }
  return params.length > 0 ? { query, params } : { query };
}

function resolveResultOptions(
  connOpts: NeonOptions,
  callOpts: NeonOptions,
): { arrayMode: boolean; fullResults: boolean } {
  return {
    arrayMode: callOpts.arrayMode ?? connOpts.arrayMode ?? neonConfig.arrayMode,
    fullResults:
      callOpts.fullResults ?? connOpts.fullResults ?? neonConfig.fullResults,
  };
}

function isolationHeaders(opts: NeonOptions): Record<string, string> {
  const headers: Record<string, string> = {};
  if (opts.isolationLevel !== undefined) {
    headers["Neon-Batch-Isolation-Level"] = opts.isolationLevel;
  }
  if (opts.readOnly !== undefined) {
    headers["Neon-Batch-Read-Only"] = opts.readOnly ? "true" : "false";
  }
  if (opts.deferrable !== undefined) {
    headers["Neon-Batch-Deferrable"] = opts.deferrable ? "true" : "false";
  }
  return headers;
}

/**
 * Create a `neon()` query function bound to `connectionString`. `connOpts` set
 * instance defaults; each `.query`/template call may override them.
 */
export function neon(
  connectionString: string,
  connOpts: NeonOptions = {},
): NeonQueryFn {
  const cfg: ConnectionConfig = normalizeConfig(connectionString);

  const execute: Executor = async (req, callOpts) => {
    const fetchEndpoint =
      callOpts.fetchEndpoint ?? connOpts.fetchEndpoint ?? neonConfig.fetchEndpoint;
    const raw = await postSql(cfg, req, {
      authToken: callOpts.authToken ?? connOpts.authToken,
      fetchEndpoint,
      fetchOptions: callOpts.fetchOptions ?? connOpts.fetchOptions,
      fetch: callOpts.fetch ?? connOpts.fetch,
      connectionString,
    });
    return reshape(parseEnvelope(raw), resolveResultOptions(connOpts, callOpts));
  };

  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) =>
    new NeonQueryPromise(execute, buildTemplate(strings, values), {})) as NeonQueryFn;

  sql.query = (text, params, opts = {}) =>
    new NeonQueryPromise(
      execute,
      params !== undefined ? { query: text, params } : { query: text },
      opts,
    );

  sql.transaction = async (queries, opts = {}) => {
    const requests = queries.map((q) =>
      q instanceof NeonQueryPromise ? q.request : q,
    );
    const fetchEndpoint =
      opts.fetchEndpoint ?? connOpts.fetchEndpoint ?? neonConfig.fetchEndpoint;
    const raw = await postSql(
      cfg,
      { queries: requests },
      {
        authToken: opts.authToken ?? connOpts.authToken,
        fetchEndpoint,
        fetchOptions: opts.fetchOptions ?? connOpts.fetchOptions,
        fetch: opts.fetch ?? connOpts.fetch,
        connectionString,
        batchHeaders: isolationHeaders(opts),
      },
    );
    const resultOptions = resolveResultOptions(connOpts, opts);
    return parseBatch(raw).map((env) => reshape(env, resultOptions));
  };

  return sql;
}
