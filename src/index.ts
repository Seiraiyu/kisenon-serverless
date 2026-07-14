// Public entrypoint for `@kisenon/serverless`. The surface is a one-token
// import-swap from `@neondatabase/serverless`: `neon()` (aliased `kisenon()`),
// `neonConfig`, `setTypeParser`, `DatabaseError`, `Pool`, and `Client`.

export const VERSION = "0.0.0";

export { neon } from "./http/query.js";
import { neon } from "./http/query.js";
/** Identical brand alias for `neon()` (design §4.1). */
export const kisenon = neon;

export { neonConfig } from "./config.js";
export type { NeonConfig } from "./config.js";
export { setTypeParser } from "./types/parsers.js";
export { DatabaseError } from "./http/errors.js";

export { Pool } from "./pool.js";
export { Client } from "./client.js";
export type { PoolConfig } from "./pool.js";
export type { ClientConfig } from "./client.js";

export type { NeonQueryFn, NeonOptions, IsolationLevel } from "./http/query.js";
export type { Field, PgResult } from "./result.js";
