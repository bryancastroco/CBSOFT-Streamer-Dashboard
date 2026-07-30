/**
 * A correlation id for one request.
 *
 * ## Why the caller's id is honoured
 *
 * When n8n retries a sync and the run misbehaves, the question is "which of my
 * six attempts was that?". If the application mints its own id and ignores the
 * one the workflow already has, the two systems hold different names for the
 * same event and nobody can join them. So an inbound `x-request-id` wins, and
 * the response echoes whatever id was used either way.
 *
 * ## Why it is still validated
 *
 * The header is attacker-controlled and ends up in log lines and a response
 * header. An unbounded value is a log-injection and header-splitting vector, so
 * anything that is not a short run of safe characters is replaced rather than
 * trusted. Rejecting is not an option worth having — a bad correlation id is not
 * a reason to refuse a sync.
 *
 * Pure, and deliberately not `server-only`: it touches no secret and the proxy
 * uses it at the edge.
 */

export const REQUEST_ID_HEADER = "x-request-id";

/** Long enough to be unique, short enough to read in a log line. */
const MAX_LENGTH = 64;

/** Hex, base64url and UUID shapes. Anything else is not a correlation id. */
const SAFE = /^[A-Za-z0-9_.:-]{8,64}$/;

export function newRequestId(): string {
  // `crypto` is global in both the Node and edge runtimes this project uses.
  return crypto.randomUUID();
}

/**
 * The id to use for this request: the caller's if it is usable, else a new one.
 */
export function resolveRequestId(request: { headers: Headers }): string {
  const presented = request.headers.get(REQUEST_ID_HEADER);

  if (presented && SAFE.test(presented)) return presented;

  return newRequestId();
}

/** Trim and sanitise an id for logging, whatever its provenance. */
export function safeRequestId(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.slice(0, MAX_LENGTH);
  return SAFE.test(trimmed) ? trimmed : null;
}
