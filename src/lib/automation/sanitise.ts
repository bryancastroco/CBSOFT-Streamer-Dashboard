import type { NormalizedMetaError } from "@/lib/meta/errors";

/**
 * Shrinking errors on the way OUT — a PURE module.
 *
 * The specification says these endpoints must never return a full Meta error
 * payload containing secrets. Meta's error bodies are the risk: a Graph failure
 * can echo back the request that caused it, and a Graph request carries the
 * access token in its query string. Forwarding `error.error_user_msg` or a raw
 * `fbtrace` blob into an n8n execution log would put a live credential
 * somewhere it was never allowed to be.
 *
 * So an automation response carries only what a workflow can act on: a stable
 * category, Meta's numeric code, and a message with anything credential-shaped
 * scrubbed out. Everything else stays in the server log, where the redacting
 * logger already handles it.
 */

/** Patterns replaced wherever they appear in an outbound message. */
const SCRUB_PATTERNS: readonly RegExp[] = [
  // Meta user and Page access tokens.
  /\bEAA[A-Za-z0-9_-]{20,}/g,
  // This application's own crypto envelope.
  /\bv[0-9]+\.[A-Za-z0-9+/=_-]{16,}\.[A-Za-z0-9+/=_-]{16,}\.[A-Za-z0-9+/=_-]+/g,
  // JSON Web Tokens.
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g,
  // Any credential-bearing query parameter, whatever its value.
  /([?&](?:access_token|input_token|client_secret|appsecret_proof)=)[^&\s]*/gi,
];

export const REDACTION = "[redacted]";

/** Longest message we will send. A Graph error can be very long. */
const MAX_MESSAGE_LENGTH = 300;

/**
 * Scrub credential material out of a free-text message and cap its length.
 *
 * The truncation is not cosmetic: a long Meta message is long precisely because
 * it is echoing the request back, which is the case most likely to carry a
 * token that the patterns above did not anticipate.
 */
export function sanitiseMessage(message: string): string {
  let output = message;

  for (const pattern of SCRUB_PATTERNS) {
    output = output.replace(pattern, (_match, prefix?: string) =>
      prefix ? `${prefix}${REDACTION}` : REDACTION,
    );
  }

  output = output.replace(/\s+/g, " ").trim();

  return output.length > MAX_MESSAGE_LENGTH
    ? `${output.slice(0, MAX_MESSAGE_LENGTH)}… (truncated)`
    : output;
}

/** What an automation caller is told about a Meta failure. */
export type SafeMetaError = {
  category: string;
  code: number | null;
  subcode: number | null;
  message: string;
};

/**
 * Reduce a normalised Meta error to its safe fields.
 *
 * Deliberately a rebuild rather than a spread: a field added to
 * `NormalizedMetaError` later — a raw body, a request URL — is excluded by
 * default and has to be added here on purpose.
 */
export function sanitiseMetaError(error: NormalizedMetaError): SafeMetaError {
  return {
    category: error.category,
    code: error.code ?? null,
    subcode: error.subcode ?? null,
    message: sanitiseMessage(error.message),
  };
}

/**
 * Reduce an arbitrary thrown value to a safe message.
 *
 * Used where a route catches something it did not expect. The stack is never
 * returned — it names internal paths and, in a `postgres.js` error, can carry
 * the connection string.
 */
export function sanitiseThrown(cause: unknown, fallback = "Unexpected failure."): string {
  if (cause instanceof Error && cause.message) return sanitiseMessage(cause.message);
  if (typeof cause === "string" && cause.length > 0) return sanitiseMessage(cause);
  return fallback;
}
