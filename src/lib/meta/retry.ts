import type { NormalizedMetaError } from "@/lib/meta/errors";

/**
 * Retry, backoff and concurrency primitives — a PURE module.
 *
 * Kept free of I/O and of `Date.now()` so the schedule can be asserted exactly
 * rather than observed by waiting. `computeBackoffMs` takes its randomness as
 * an argument for the same reason.
 */

export type RetryPolicy = {
  /** Attempts after the first. 2 means up to three requests in total. */
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Multiplier per attempt. 2 doubles the window each time. */
  factor: number;
};

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  factor: 2,
};

/**
 * Full-jitter exponential backoff.
 *
 * `delay = random(0, min(cap, base * factor^attempt))`. Full jitter rather than
 * fixed exponential because every streamer in a sync run hits Meta at once —
 * without jitter a rate-limit response would put them all back in lockstep and
 * they would collide again on the retry.
 *
 * @param attempt zero-based retry index
 * @param random  value in [0, 1); injected so tests are deterministic
 */
export function computeBackoffMs(
  attempt: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  random: number = Math.random(),
): number {
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * policy.factor ** attempt);
  return Math.max(0, Math.round(ceiling * random));
}

/**
 * Delay for a retry, preferring an explicit instruction from Meta.
 *
 * When a `Retry-After` was supplied we honour it exactly: guessing shorter than
 * a stated cooldown is how an application earns a longer block.
 */
export function nextDelayMs(
  attempt: number,
  error: NormalizedMetaError,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  random: number = Math.random(),
): number {
  if (typeof error.retryAfterSeconds === "number" && error.retryAfterSeconds > 0) {
    return Math.min(policy.maxDelayMs, Math.round(error.retryAfterSeconds * 1000));
  }
  return computeBackoffMs(attempt, policy, random);
}

export function shouldRetry(
  error: NormalizedMetaError,
  attempt: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): boolean {
  if (attempt >= policy.maxRetries) return false;
  return error.retryable;
}

/** Parse a `Retry-After` header — either seconds, or an HTTP date. */
export function parseRetryAfter(header: string | null, now: Date = new Date()): number | undefined {
  if (!header) return undefined;

  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds);

  const when = Date.parse(header);
  if (Number.isNaN(when)) return undefined;

  const delta = Math.round((when - now.getTime()) / 1000);
  return delta > 0 ? delta : 0;
}

/**
 * Meta's `X-App-Usage` / `X-Business-Use-Case-Usage` headers report percentage
 * of quota consumed. Reading them lets the client slow down *before* being
 * throttled rather than after.
 *
 * Returns the highest percentage seen, or undefined when unparseable.
 */
export function parseUsagePercent(header: string | null): number | undefined {
  if (!header) return undefined;

  try {
    const parsed: unknown = JSON.parse(header);
    if (!parsed || typeof parsed !== "object") return undefined;

    const values: number[] = [];

    const collect = (record: Record<string, unknown>) => {
      for (const key of ["call_count", "total_cputime", "total_time"]) {
        const value = record[key];
        if (typeof value === "number") values.push(value);
      }
    };

    // X-App-Usage is a flat object; X-Business-Use-Case-Usage maps id -> array.
    for (const entry of Object.values(parsed as Record<string, unknown>)) {
      if (Array.isArray(entry)) {
        for (const item of entry) {
          if (item && typeof item === "object") collect(item as Record<string, unknown>);
        }
      }
    }
    collect(parsed as Record<string, unknown>);

    return values.length > 0 ? Math.max(...values) : undefined;
  } catch {
    return undefined;
  }
}

/** Above this percentage of quota the client pauses between requests. */
export const USAGE_SLOWDOWN_THRESHOLD = 90;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `worker` over `items` with at most `limit` in flight, preserving input
 * order in the results.
 *
 * Post insights are one request per post, so a Page with 200 posts is 200
 * requests. Unbounded parallelism would trip Meta's rate limiter immediately;
 * serial would be needlessly slow. This is the middle.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];

  const effectiveLimit = Math.max(1, Math.min(limit, items.length));
  const results = new Array<R>(items.length);
  let cursor = 0;

  async function runner(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index] as T, index);
    }
  }

  await Promise.all(Array.from({ length: effectiveLimit }, () => runner()));

  return results;
}

/** How many post-insight requests may be in flight at once. */
export const DEFAULT_CONCURRENCY = 4;
