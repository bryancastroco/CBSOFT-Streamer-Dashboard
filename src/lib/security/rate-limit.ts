/**
 * Fixed-window rate limiting — a PURE module with an injectable clock.
 *
 * ## What this is for
 *
 * The automation endpoints hold a single shared secret and can trigger expensive
 * work: a sync-all sweep spends Meta API quota against a shared app rate limit
 * and can spend Anthropic tokens. A misconfigured n8n schedule firing every
 * minute instead of every night would do real damage before anyone noticed. The
 * limiter turns that into a `429` with a `Retry-After`.
 *
 * ## What this is NOT
 *
 * It is not a defence against a distributed attacker, and on a serverless
 * platform the counters are **per instance**: two concurrent Vercel functions
 * keep separate maps, so the effective ceiling is `limit × instances`. That is
 * accepted deliberately. The purpose is to stop a runaway workflow and an
 * accidental retry storm — both of which come from one caller and are caught by
 * a per-instance counter — not to be a security boundary. The security boundary
 * is the bearer secret, compared in constant time.
 *
 * If a hard global ceiling is ever needed, the store below is the seam: swap the
 * `Map` for Redis or Postgres without touching a route.
 */

export type RateLimitRule = {
  /** Requests permitted per window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
};

export type RateLimitDecision = {
  allowed: boolean;
  limit: number;
  /** Requests left in the current window, after accounting for this one. */
  remaining: number;
  /** When the current window ends, as epoch milliseconds. */
  resetAt: number;
  /** Whole seconds until the window ends. Only meaningful when denied. */
  retryAfterSeconds: number;
};

type Window = { count: number; resetAt: number };

/**
 * A counter store.
 *
 * `Map` in production; a fresh instance per test, so tests cannot leak state
 * into one another through a module-level singleton.
 */
export class RateLimiter {
  private readonly windows = new Map<string, Window>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Count one request against `key` and decide whether it may proceed.
   *
   * A denied request still occupies its slot rather than being free — otherwise
   * a caller hammering a limited endpoint would keep the window open forever
   * without ever being told to stop.
   */
  check(key: string, rule: RateLimitRule): RateLimitDecision {
    const now = this.now();
    const existing = this.windows.get(key);

    if (!existing || existing.resetAt <= now) {
      const resetAt = now + rule.windowMs;
      this.windows.set(key, { count: 1, resetAt });

      return {
        allowed: true,
        limit: rule.limit,
        remaining: Math.max(0, rule.limit - 1),
        resetAt,
        retryAfterSeconds: 0,
      };
    }

    existing.count += 1;

    const allowed = existing.count <= rule.limit;

    return {
      allowed,
      limit: rule.limit,
      remaining: Math.max(0, rule.limit - existing.count),
      resetAt: existing.resetAt,
      retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    };
  }

  /**
   * Drop windows that have expired.
   *
   * Called opportunistically rather than on a timer: a long-lived instance
   * serving many distinct keys would otherwise grow its map without bound, and a
   * timer would keep a serverless function alive.
   */
  prune(): void {
    const now = this.now();
    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(key);
    }
  }

  /**
   * Drop one key's window.
   *
   * Used after a successful sign-in: somebody who mistypes their password four
   * times and then gets it right should not stay throttled for the rest of the
   * window, punished for eventually succeeding.
   */
  forget(key: string): void {
    this.windows.delete(key);
  }

  /** Test seam. */
  reset(): void {
    this.windows.clear();
  }

  get size(): number {
    return this.windows.size;
  }
}

/**
 * Response headers describing a decision.
 *
 * The `RateLimit-*` names are the IETF draft spelling, which is what n8n's HTTP
 * Request node and most clients read. `Retry-After` is sent only on a denial,
 * because that is the only time it means anything.
 */
export function rateLimitHeaders(decision: RateLimitDecision): Record<string, string> {
  const headers: Record<string, string> = {
    "RateLimit-Limit": String(decision.limit),
    "RateLimit-Remaining": String(decision.remaining),
    "RateLimit-Reset": String(Math.max(0, Math.ceil((decision.resetAt - Date.now()) / 1000))),
  };

  if (!decision.allowed) {
    headers["Retry-After"] = String(decision.retryAfterSeconds);
  }

  return headers;
}
