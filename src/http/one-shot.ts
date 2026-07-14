// Shared HTTP one-shot `query` used by both `Client` and `Pool` for the
// `poolQueryViaFetch` path: normalize the pg overloads (`query(text, params)`
// and `query({ text, values, rowMode })`), POST a single `/sql` request, and
// return the full `PgResult` (`rowMode:'array'` selects array rows).

import { neonConfig, type NeonConfig } from "../config.js";
import { normalizeConfig, type ConnectionConfig, type DiscreteConfig } from "../connection-string.js";
import type { PgResult } from "../result.js";
import { parseEnvelope } from "./envelope.js";
import { reshape } from "./reshape.js";
import { postSql } from "./transport.js";

/** Transport extras a `Client`/`Pool` config object may carry beyond pg fields. */
export interface TransportConfig {
  fetch?: typeof fetch;
  fetchEndpoint?: NeonConfig["fetchEndpoint"];
  authToken?: string;
}

/** `Client`/`Pool` constructor config: a connection string or discrete fields. */
export type ClientConfig = DiscreteConfig & TransportConfig;

/** The `query({ text, values, rowMode })` config-object overload shape. */
export interface QueryConfig {
  text: string;
  values?: unknown[];
  rowMode?: "array";
}

/** Resolved per-instance transport state shared by the two surfaces. */
export interface Resolved {
  cfg: ConnectionConfig;
  connectionString?: string;
  fetch?: typeof fetch;
  fetchEndpoint?: NeonConfig["fetchEndpoint"];
  authToken?: string;
}

/** Resolve a string|config into the `ConnectionConfig` + transport state. */
export function resolveConfig(config: string | ClientConfig): Resolved {
  const cfg = normalizeConfig(config);
  if (typeof config === "string") {
    return { cfg, connectionString: config };
  }
  const resolved: Resolved = { cfg };
  if (config.connectionString !== undefined) {
    resolved.connectionString = config.connectionString;
  }
  if (config.fetch !== undefined) resolved.fetch = config.fetch;
  if (config.fetchEndpoint !== undefined) resolved.fetchEndpoint = config.fetchEndpoint;
  if (config.authToken !== undefined) resolved.authToken = config.authToken;
  return resolved;
}

/** Run one HTTP `/sql` query and return the full pg `PgResult`. */
export async function queryOneShot(
  r: Resolved,
  textOrConfig: string | QueryConfig,
  params?: unknown[],
): Promise<PgResult> {
  let query: string;
  let values: unknown[] | undefined;
  let arrayMode = false;
  if (typeof textOrConfig === "string") {
    query = textOrConfig;
    values = params;
  } else {
    query = textOrConfig.text;
    values = textOrConfig.values;
    arrayMode = textOrConfig.rowMode === "array";
  }

  const raw = await postSql(
    r.cfg,
    values !== undefined ? { query, params: values } : { query },
    {
      authToken: r.authToken,
      fetchEndpoint: r.fetchEndpoint ?? neonConfig.fetchEndpoint,
      fetch: r.fetch,
      connectionString: r.connectionString,
    },
  );
  return reshape(parseEnvelope(raw), { arrayMode, fullResults: true }) as PgResult;
}
