// Map an HTTP `/sql` failure to a pg-shaped `DatabaseError`. The server returns
// SQL/auth errors as HTTP 400 with `{ message, code, severity?, detail?, hint? }`
// (`code` = Postgres SQLSTATE), and non-SQL failures as 413/504/502 with a plain
// `{ message }` (CONTRACT.md §"Error shape"). `code` is preserved verbatim so an
// ORM's `err.code` SQLSTATE handling ports unchanged. The connection string is
// never echoed — any `postgres://…` in a message is redacted.

/**
 * pg-shaped error thrown by every transport path. Extends `Error` and carries
 * the optional Postgres error fields (`code` is the SQLSTATE).
 */
export class DatabaseError extends Error {
  code?: string;
  severity?: string;
  detail?: string;
  hint?: string;

  constructor(message: string) {
    super(message);
    this.name = "DatabaseError";
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Replace any `postgres://user:pw@host/…` credential URL with a redacted stub. */
function redact(message: string): string {
  return message.replace(/postgres(?:ql)?:\/\/\S+/gi, "postgres://***");
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/**
 * Build a `DatabaseError` from an HTTP status + parsed body.
 * - 400: structured pg envelope (`message`/`code`/`severity`/`detail`/`hint`).
 * - 413/504/502: fixed operational messages.
 * - anything else: `Server error (HTTP status N)`.
 */
export function mapHttpError(status: number, body: unknown): DatabaseError {
  const b = isObject(body) ? body : {};

  if (status === 400) {
    const message = str(b["message"]) ?? "database error";
    const err = new DatabaseError(redact(message));
    const code = str(b["code"]);
    if (code !== undefined) err.code = code;
    const severity = str(b["severity"]);
    if (severity !== undefined) err.severity = severity;
    const detail = str(b["detail"]);
    if (detail !== undefined) err.detail = redact(detail);
    const hint = str(b["hint"]);
    if (hint !== undefined) err.hint = redact(hint);
    return err;
  }

  if (status === 413) {
    return new DatabaseError("payload or result too large");
  }
  if (status === 504) {
    return new DatabaseError("query timeout exceeded");
  }
  if (status === 502) {
    return new DatabaseError("backend connection failed");
  }

  return new DatabaseError(`Server error (HTTP status ${status})`);
}
