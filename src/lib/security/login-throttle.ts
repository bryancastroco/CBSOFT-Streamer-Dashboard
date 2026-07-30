import "server-only";

import { createHash } from "node:crypto";

import { RateLimiter, type RateLimitRule } from "@/lib/security/rate-limit";

/**
 * Throttling for the sign-in form.
 *
 * Supabase Auth applies its own limits, but they are project-wide and generous.
 * This closes the application-level gap recorded as R14 in `SECURITY.md`:
 * password spraying against a known address, and credential stuffing against a
 * list of them.
 *
 * ## Two budgets, not one
 *
 * Keying only on the email address lets one attacker with a list of ten
 * thousand addresses make ten thousand attempts — each address gets its own
 * fresh budget. Keying only on the client address punishes an office behind one
 * NAT, where a genuine typo from a colleague eats everyone's allowance.
 *
 * So both are counted and either can refuse. The per-address budget is tighter
 * because it protects a single account; the per-client budget is looser but
 * catches the spray.
 *
 * ## What it cannot do
 *
 * Counters are per process, so on a serverless platform the effective ceiling
 * is `limit × instances`. It raises the cost of a brute-force attempt by orders
 * of magnitude; it is not a substitute for MFA, and `SECURITY.md` still records
 * that gap.
 */

/** Per email address. Tight: a real person does not miss six times in a row. */
const PER_IDENTIFIER: RateLimitRule = { limit: 6, windowMs: 15 * 60_000 };

/** Per client address. Looser, because one address may be a whole office. */
const PER_CLIENT: RateLimitRule = { limit: 30, windowMs: 15 * 60_000 };

const limiter = new RateLimiter();

let sinceLastPrune = 0;
function maybePrune(): void {
  sinceLastPrune += 1;
  if (sinceLastPrune >= 100) {
    sinceLastPrune = 0;
    limiter.prune();
  }
}

/**
 * Hash the key material before it becomes a map key.
 *
 * An email address and a client IP are both personal data, and a limiter's map
 * is the kind of thing that ends up in a heap dump. A hash is all the limiter
 * needs — it only ever compares keys for equality.
 */
function keyOf(kind: string, value: string): string {
  return `${kind}:${createHash("sha256").update(value.toLowerCase().trim()).digest("hex").slice(0, 32)}`;
}

export type LoginThrottleDecision =
  { allowed: true } | { allowed: false; retryAfterSeconds: number };

/**
 * Count one sign-in attempt.
 *
 * Called **before** credentials are checked, so a refused attempt never reaches
 * Supabase — which is the point: the expensive thing is the password
 * verification, and an attacker should not be able to make us do it.
 */
export function checkLoginAttempt(params: {
  email: string;
  clientAddress: string | null;
}): LoginThrottleDecision {
  maybePrune();

  const byIdentifier = limiter.check(keyOf("email", params.email), PER_IDENTIFIER);

  const byClient = params.clientAddress
    ? limiter.check(keyOf("client", params.clientAddress), PER_CLIENT)
    : { allowed: true as const, retryAfterSeconds: 0 };

  if (byIdentifier.allowed && byClient.allowed) return { allowed: true };

  return {
    allowed: false,
    retryAfterSeconds: Math.max(
      byIdentifier.allowed ? 0 : byIdentifier.retryAfterSeconds,
      byClient.allowed ? 0 : byClient.retryAfterSeconds,
    ),
  };
}

/**
 * Forget an address's failures after a successful sign-in.
 *
 * Without this, somebody who mistypes their password five times and then gets
 * it right stays throttled for the rest of the window — punished for
 * succeeding. The client budget is deliberately *not* cleared: one valid login
 * from a shared address should not reset the allowance for everyone behind it.
 */
export function clearLoginAttempts(email: string): void {
  limiter.forget(keyOf("email", email));
}

/**
 * The client address, as far as it can be trusted.
 *
 * `x-forwarded-for` is attacker-supplied unless a proxy you control overwrites
 * it. On Vercel it does, and the left-most entry is the real client. Off
 * Vercel this could be spoofed to spread an attack across fake addresses — the
 * per-email budget is the one that still holds in that case, which is why the
 * limiter does not rely on this alone.
 */
export function clientAddressFrom(headers: Headers): string | null {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }

  return headers.get("x-real-ip");
}

/** Test seam. */
export function resetLoginThrottleForTests(): void {
  limiter.reset();
  sinceLastPrune = 0;
}
