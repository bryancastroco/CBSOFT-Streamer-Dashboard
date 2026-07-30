import { describe, expect, it, vi } from "vitest";

import type { NormalizedMetaError } from "@/lib/meta/errors";
import {
  DEFAULT_RETRY_POLICY,
  computeBackoffMs,
  mapWithConcurrency,
  nextDelayMs,
  parseRetryAfter,
  parseUsagePercent,
  shouldRetry,
} from "@/lib/meta/retry";

const retryable: NormalizedMetaError = {
  category: "rate_limited",
  message: "Too many calls",
  retryable: true,
};

const fatal: NormalizedMetaError = {
  category: "invalid_token",
  message: "Bad token",
  retryable: false,
};

describe("exponential backoff", () => {
  it("doubles the ceiling on each attempt", () => {
    // random = 1 exposes the ceiling itself.
    expect(computeBackoffMs(0, DEFAULT_RETRY_POLICY, 1)).toBe(500);
    expect(computeBackoffMs(1, DEFAULT_RETRY_POLICY, 1)).toBe(1000);
    expect(computeBackoffMs(2, DEFAULT_RETRY_POLICY, 1)).toBe(2000);
    expect(computeBackoffMs(3, DEFAULT_RETRY_POLICY, 1)).toBe(4000);
  });

  it("applies full jitter, so the delay is somewhere in [0, ceiling]", () => {
    expect(computeBackoffMs(2, DEFAULT_RETRY_POLICY, 0)).toBe(0);
    expect(computeBackoffMs(2, DEFAULT_RETRY_POLICY, 0.5)).toBe(1000);
    expect(computeBackoffMs(2, DEFAULT_RETRY_POLICY, 1)).toBe(2000);
  });

  it("caps the ceiling so a long run cannot back off for hours", () => {
    expect(computeBackoffMs(50, DEFAULT_RETRY_POLICY, 1)).toBe(DEFAULT_RETRY_POLICY.maxDelayMs);
  });

  it("never returns a negative delay", () => {
    expect(computeBackoffMs(0, DEFAULT_RETRY_POLICY, 0)).toBeGreaterThanOrEqual(0);
  });
});

describe("retry decisions", () => {
  it("retries a retryable error until the budget is spent", () => {
    expect(shouldRetry(retryable, 0)).toBe(true);
    expect(shouldRetry(retryable, 2)).toBe(true);
    expect(shouldRetry(retryable, DEFAULT_RETRY_POLICY.maxRetries)).toBe(false);
  });

  it("never retries a fatal error, even on the first attempt", () => {
    expect(shouldRetry(fatal, 0)).toBe(false);
  });
});

describe("honouring Retry-After", () => {
  it("prefers Meta's stated cooldown over computed backoff", () => {
    // Guessing shorter than a stated cooldown is how an app earns a longer ban.
    const delay = nextDelayMs(0, { ...retryable, retryAfterSeconds: 12 }, DEFAULT_RETRY_POLICY, 0);
    expect(delay).toBe(12_000);
  });

  it("still respects the maximum delay cap", () => {
    const delay = nextDelayMs(
      0,
      { ...retryable, retryAfterSeconds: 9999 },
      DEFAULT_RETRY_POLICY,
      1,
    );
    expect(delay).toBe(DEFAULT_RETRY_POLICY.maxDelayMs);
  });

  it("falls back to backoff when no cooldown was given", () => {
    expect(nextDelayMs(1, retryable, DEFAULT_RETRY_POLICY, 1)).toBe(1000);
  });

  it("parses a Retry-After given in seconds", () => {
    expect(parseRetryAfter("30")).toBe(30);
    expect(parseRetryAfter("0")).toBe(0);
  });

  it("parses a Retry-After given as an HTTP date", () => {
    const now = new Date("2026-07-29T12:00:00Z");
    expect(parseRetryAfter("Wed, 29 Jul 2026 12:00:45 GMT", now)).toBe(45);
  });

  it("clamps a past date to zero rather than going negative", () => {
    const now = new Date("2026-07-29T12:00:00Z");
    expect(parseRetryAfter("Wed, 29 Jul 2026 11:59:00 GMT", now)).toBe(0);
  });

  it("ignores an unparseable header", () => {
    expect(parseRetryAfter("soon")).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});

describe("quota headers", () => {
  it("reads the highest percentage from X-App-Usage", () => {
    const header = JSON.stringify({ call_count: 22, total_cputime: 47, total_time: 91 });
    expect(parseUsagePercent(header)).toBe(91);
  });

  it("reads nested business-use-case usage", () => {
    const header = JSON.stringify({
      "1234567890": [{ call_count: 10, total_cputime: 5, total_time: 3 }],
    });
    expect(parseUsagePercent(header)).toBe(10);
  });

  it("returns undefined for malformed or absent headers", () => {
    expect(parseUsagePercent(null)).toBeUndefined();
    expect(parseUsagePercent("not json")).toBeUndefined();
    expect(parseUsagePercent("[]")).toBeUndefined();
  });
});

describe("controlled concurrency", () => {
  it("preserves input order in the results", async () => {
    const items = [5, 1, 4, 2, 3];

    const results = await mapWithConcurrency(items, 2, async (item) => {
      await new Promise((resolve) => setTimeout(resolve, item));
      return item * 10;
    });

    expect(results).toEqual([50, 10, 40, 20, 30]);
  });

  it("never exceeds the requested limit", async () => {
    let inFlight = 0;
    let peak = 0;

    await mapWithConcurrency(
      Array.from({ length: 20 }, (_, i) => i),
      3,
      async (item) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        return item;
      },
    );

    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  it("visits every item exactly once", async () => {
    const worker = vi.fn(async (item: number) => item);
    await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 4, worker);

    expect(worker).toHaveBeenCalledTimes(7);
  });

  it("handles an empty list without spawning workers", async () => {
    const worker = vi.fn(async (item: number) => item);
    await expect(mapWithConcurrency([], 4, worker)).resolves.toEqual([]);
    expect(worker).not.toHaveBeenCalled();
  });

  it("does not spawn more runners than there are items", async () => {
    const results = await mapWithConcurrency([1], 16, async (item) => item);
    expect(results).toEqual([1]);
  });
});
