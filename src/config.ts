/**
 * `neonConfig`-parity configuration (design §4.6).
 *
 * A mutable singleton with the same field names/semantics as
 * `@neondatabase/serverless`'s `neonConfig`, so an import-swap keeps working.
 * The one deliberate divergence is the default `fetchEndpoint`/`wsProxy`: they
 * build the URL from OUR host verbatim (`https://<host>/sql`, `<host>/v2`) with
 * NO `api.` rewrite — that rewrite is exactly what breaks against kisenon
 * (#2121). `pipelineConnect` is accepted but a no-op (we never pipeline
 * cleartext); `fetchConnectionCache` is accepted and always-on (also a no-op).
 */
export interface NeonConfig {
  /** HTTP `/sql` endpoint URL, or a builder. Default: host => `https://${host}/sql`. */
  fetchEndpoint: string | ((host: string, port: number) => string);
  /** WebSocket `/v2` proxy target, or a builder. Default: host => `${host}/v2`. */
  wsProxy: string | ((host: string, port: number) => string);
  /** Use `wss://` (secure) for the WebSocket. Default true. */
  useSecureWebSocket: boolean;
  /** Injected WebSocket constructor (Node <22 -> the `ws` package). */
  webSocketConstructor?: unknown;
  /** Route `Pool`/`Client` one-shot queries over HTTP `/sql`. Default true. */
  poolQueryViaFetch: boolean;
  /** Return rows as arrays instead of objects. Default false. */
  arrayMode: boolean;
  /** Return the full `{ rows, rowCount, fields, command }` result. Default false. */
  fullResults: boolean;
  /** Accepted for neon parity; always-on, no-op. */
  fetchConnectionCache: boolean;
  /** Accepted for neon parity; NO-OP (we never pipeline cleartext). */
  pipelineConnect: "password" | false;
}

export const neonConfig: NeonConfig = {
  fetchEndpoint: (host: string) => `https://${host}/sql`,
  wsProxy: (host: string) => `${host}/v2`,
  useSecureWebSocket: true,
  poolQueryViaFetch: true,
  arrayMode: false,
  fullResults: false,
  fetchConnectionCache: true,
  pipelineConnect: false,
};
