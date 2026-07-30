/**
 * Structured logging with redaction — a PURE module (no `server-only`, so the
 * redaction rules can be unit tested directly).
 *
 * Every log line is a single JSON object, which is what Vercel's log drain and
 * any downstream aggregator actually want. The important part is `redact()`:
 * it runs over every field before anything is emitted, so a token that reaches
 * a log call by accident is scrubbed rather than published.
 *
 * This is a safety net, not a licence. Do not pass secrets to the logger.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Record<string, unknown>;

/**
 * Field names whose values are replaced wholesale, whatever they contain.
 * Matched case-insensitively against the whole key.
 */
const SECRET_KEY_PATTERN =
  /^(.*_)?(access_token|accesstoken|token|input_token|page_access_token|encrypted_page_token|password|secret|api_key|apikey|authorization|cookie|service_role_key|anon_key)(_.*)?$/i;

/** Value shapes that look like credentials wherever they appear. */
const SECRET_VALUE_PATTERNS: { pattern: RegExp; replacement: string }[] = [
  // Meta user/page access tokens.
  { pattern: /\bEAA[A-Za-z0-9_-]{10,}/g, replacement: "[redacted-token]" },
  // Our own AES-GCM envelope.
  {
    pattern: /\bv\d+\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    replacement: "[redacted-ciphertext]",
  },
  // JWTs — Supabase anon/service keys and session tokens.
  {
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    replacement: "[redacted-jwt]",
  },
  // Anything carried in a query string.
  {
    pattern: /([?&](?:access_token|input_token|client_secret)=)[^&\s]+/gi,
    replacement: "$1[redacted]",
  },
];

const REDACTED = "[redacted]";
const MAX_DEPTH = 6;

function redactString(value: string): string {
  let output = value;
  for (const { pattern, replacement } of SECRET_VALUE_PATTERNS) {
    output = output.replace(pattern, replacement);
  }
  return output;
}

/**
 * Recursively scrub a value.
 *
 * Keys matching a secret name are replaced entirely; every string is also
 * scanned for credential-shaped substrings, because secrets travel inside URLs
 * and error messages as often as they do in their own field.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return "[truncated]";

  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") return value;

  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redact(entry, depth + 1));
  }

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    output[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : redact(entry, depth + 1);
  }
  return output;
}

export type LogRecord = {
  level: LogLevel;
  event: string;
  timestamp: string;
  [field: string]: unknown;
};

/** Build a redacted record without emitting it. Exposed for tests. */
export function buildLogRecord(level: LogLevel, event: string, fields: LogFields = {}): LogRecord {
  return {
    level,
    event,
    timestamp: new Date().toISOString(),
    ...(redact(fields) as LogFields),
  };
}

function emit(level: LogLevel, event: string, fields: LogFields): void {
  const record = buildLogRecord(level, event, fields);
  const line = JSON.stringify(record);

  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (event: string, fields: LogFields = {}) => emit("debug", event, fields),
  info: (event: string, fields: LogFields = {}) => emit("info", event, fields),
  warn: (event: string, fields: LogFields = {}) => emit("warn", event, fields),
  error: (event: string, fields: LogFields = {}) => emit("error", event, fields),
};

/** A logger that carries fixed fields — e.g. a sync run id — on every line. */
export function childLogger(context: LogFields) {
  return {
    debug: (event: string, fields: LogFields = {}) =>
      logger.debug(event, { ...context, ...fields }),
    info: (event: string, fields: LogFields = {}) => logger.info(event, { ...context, ...fields }),
    warn: (event: string, fields: LogFields = {}) => logger.warn(event, { ...context, ...fields }),
    error: (event: string, fields: LogFields = {}) =>
      logger.error(event, { ...context, ...fields }),
  };
}

export type Logger = ReturnType<typeof childLogger>;
