import "server-only";

import { publicEnv } from "@/config/public-env";

/**
 * Which origin is this deployment reachable at?
 *
 * Needed wherever an absolute URL has to be produced on the server: a password
 * reset link, an OAuth callback, anything Supabase Auth must be told to
 * redirect back to. A relative path is preferable everywhere else and is what
 * the sign-in bounce already uses.
 *
 * ## Why this is not just `NEXT_PUBLIC_APP_URL`
 *
 * Because a preview deployment does not have one. Vercel mints a fresh
 * hostname per commit, so the canonical URL is only meaningful in production.
 * The resolution order below picks the most specific true answer available:
 *
 *   1. `NEXT_PUBLIC_APP_URL` — the canonical production origin, when set.
 *   2. `VERCEL_PROJECT_PRODUCTION_URL` — Vercel's own idea of production.
 *   3. `VERCEL_URL` — this deployment, which on a preview is the only truth.
 *   4. `http://localhost:3000` — development.
 *
 * ## Why the request Host header is not in that list
 *
 * `Host` is attacker-controlled. Building a password-reset link from it is the
 * classic host-header poisoning bug: the victim receives a real token pointed
 * at the attacker's domain. Every source above is set by the platform or by an
 * operator, never by a caller. `originFromRequest` exists for the narrow case
 * where a request origin genuinely is the right answer, and it validates
 * against this resolution rather than trusting the header.
 */

const LOCAL_ORIGIN = "http://localhost:3000";

function normalise(value: string | undefined, protocol = "https"): string | null {
  if (!value) return null;

  const withScheme = /^https?:\/\//i.test(value) ? value : `${protocol}://${value}`;

  try {
    const url = new URL(withScheme);
    // `origin` drops any path, query or trailing slash, so callers can always
    // concatenate a path without wondering whether to add a separator.
    return url.origin;
  } catch {
    return null;
  }
}

export function resolveAppOrigin(): string {
  return (
    normalise(publicEnv.appUrl || undefined) ??
    normalise(process.env["VERCEL_PROJECT_PRODUCTION_URL"]) ??
    normalise(process.env["VERCEL_URL"]) ??
    LOCAL_ORIGIN
  );
}

/** Absolute URL for an internal path. Leading slash optional. */
export function absoluteUrl(path: string): string {
  const origin = resolveAppOrigin();
  return `${origin}${path.startsWith("/") ? "" : "/"}${path}`;
}

/**
 * Every origin this deployment legitimately answers on.
 *
 * The allow-list a redirect target is checked against. Deliberately small:
 * canonical, Vercel's production URL, this deployment, and localhost in
 * development only — localhost in a production allow-list would let a phishing
 * page in a victim's own browser be a valid redirect target.
 */
export function allowedOrigins(): readonly string[] {
  const origins = new Set<string>();

  for (const candidate of [
    publicEnv.appUrl || undefined,
    process.env["VERCEL_PROJECT_PRODUCTION_URL"],
    process.env["VERCEL_URL"],
  ]) {
    const origin = normalise(candidate);
    if (origin) origins.add(origin);
  }

  if (process.env.NODE_ENV !== "production") origins.add(LOCAL_ORIGIN);
  if (origins.size === 0) origins.add(LOCAL_ORIGIN);

  return [...origins];
}

/**
 * The request's origin, but only if we actually serve it.
 *
 * Returns `null` for anything unrecognised rather than echoing it back, so a
 * forged `Host` or `Origin` header cannot become a redirect target or find its
 * way into an email. Callers should treat `null` as "use `resolveAppOrigin()`".
 */
/**
 * The scheme to assume for a bare `Host`, which carries none.
 *
 * `x-forwarded-proto` when the proxy set it — Vercel always does. Otherwise
 * https, except for loopback: guessing http would mean a legitimate preview
 * host never matches the https origins in the allow-list, and the check would
 * reject its own deployment.
 */
function schemeForHost(host: string, headers: Headers): string {
  const forwarded = headers.get("x-forwarded-proto");
  if (forwarded) {
    // Can be a comma-separated chain; the left-most is the original client.
    const first = forwarded.split(",")[0]?.trim();
    if (first === "http" || first === "https") return first;
  }

  return /^(localhost|127\.0\.0\.1|\[::1\])(:|$)/i.test(host) ? "http" : "https";
}

export function originFromRequest(headers: Headers): string | null {
  const host = headers.get("x-forwarded-host") ?? headers.get("host") ?? undefined;

  const candidate =
    normalise(headers.get("origin") ?? undefined) ??
    (host ? normalise(host, schemeForHost(host, headers)) : null);

  if (!candidate) return null;

  /*
   * Exact origin match against the allow-list. Not `includes`, not a suffix
   * test: `cbsoft.example.com.evil.test` contains the real host as a substring
   * and must not pass.
   */
  return allowedOrigins().includes(candidate) ? candidate : null;
}
