/**
 * Connection-string parsing and config normalization.
 *
 * Mirrors the server's `edgedriver.ParseConnString` (src/proxy/internal/
 * edgedriver/connstring.go): user/password are URL-decoded, `database` is the
 * path minus its leading `/`, `options` is the verbatim `?options=` value (may
 * carry `endpoint=<id>` for SNI-less routing), and host/port/sslmode are the
 * URL's own values. The host is kept VERBATIM — no `api.` rewrite — which is
 * what dodges #2121.
 */

/** Default backend Postgres port when the connection string omits one. */
const DEFAULT_PORT = 5432;

/**
 * The internal shape both `neon()` and `Pool`/`Client` normalize to. `options`
 * is the raw `?options=` passthrough (may carry `endpoint=<id>`).
 */
export interface ConnectionConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl: boolean;
  options?: string;
}

/** Discrete connection fields accepted by `normalizeConfig` (pg/neon-shaped). */
export interface DiscreteConfig {
  connectionString?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  ssl?: boolean;
}

/**
 * Parse a `postgres://` / `postgresql://` connection string into a
 * `ConnectionConfig`. Throws on an empty/blank string or a non-postgres scheme.
 */
export function parseConnectionString(s: string): ConnectionConfig {
  const trimmed = s.trim();
  if (trimmed === "") {
    throw new Error("kisenon: empty connection string");
  }

  let u: URL;
  try {
    u = new URL(trimmed);
  } catch (err) {
    throw new Error(
      `kisenon: malformed connection string: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") {
    throw new Error(
      `kisenon: connection string scheme must be postgres:// or postgresql://, got "${u.protocol.replace(
        /:$/,
        "",
      )}"`,
    );
  }

  const sslmode = u.searchParams.get("sslmode");
  const rawOptions = u.searchParams.get("options");

  const config: ConnectionConfig = {
    host: u.hostname,
    port: u.port === "" ? DEFAULT_PORT : Number(u.port),
    // URL keeps userinfo percent-encoded; decode to the wire value.
    user: safeDecode(u.username),
    password: safeDecode(u.password),
    // pathname keeps `%XX` escapes (WHATWG URL does not decode them); decode to
    // the wire database name, matching the Go server's net/url `.Path`.
    database: safeDecode(u.pathname.replace(/^\//, "")),
    // sslmode=disable -> plaintext; anything else (incl. absent) -> TLS.
    ssl: sslmode !== "disable",
  };
  // searchParams already URL-decoded the value.
  if (rawOptions !== null) {
    config.options = rawOptions;
  }
  return config;
}

/**
 * Normalize a bare connection string, a `{ connectionString }` object, or
 * discrete `{ host, port, user, ... }` fields to a single `ConnectionConfig`.
 * A connection string (bare or via `connectionString`) delegates to
 * `parseConnectionString`; discrete fields fill the same defaults (port 5432,
 * ssl true) so both inputs yield identical configs.
 */
export function normalizeConfig(input: string | DiscreteConfig): ConnectionConfig {
  if (typeof input === "string") {
    return parseConnectionString(input);
  }
  if (input.connectionString !== undefined) {
    return parseConnectionString(input.connectionString);
  }
  return {
    host: input.host ?? "",
    port: input.port ?? DEFAULT_PORT,
    user: input.user ?? "",
    password: input.password ?? "",
    database: input.database ?? "",
    ssl: input.ssl ?? true,
  };
}

/**
 * decodeURIComponent that falls back to the raw value on a malformed escape,
 * so a stray `%` in userinfo never crashes parsing.
 */
function safeDecode(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}
