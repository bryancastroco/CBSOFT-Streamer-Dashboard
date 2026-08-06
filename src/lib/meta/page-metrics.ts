import "server-only";

import { graphRequest } from "@/lib/meta/client";
import type { GraphOutcome } from "@/lib/meta/client";
import type { Logger } from "@/lib/observability/logger";

/**
 * A Page's audience size over time.
 *
 * ## Which metric names, and why only these
 *
 * Probed against a live Page on v25.0 on 2026-08-06, before any of this was
 * written, because one invalid name fails the whole insights request and would
 * take every other metric down with it:
 *
 *   page_follows              OK — running total, one value per day
 *   page_daily_follows        OK — that day's gain
 *   page_daily_follows_unique OK — same shape, deduplicated by person
 *   page_views_total          OK
 *
 *   page_fans, page_fan_adds, page_fan_removes, page_impressions,
 *   page_impressions_unique  — all `(#100) The value must be a valid insights
 *                              metric`
 *
 * The rejected list is worth keeping written down: several of them are the
 * names Meta's own documentation and most tutorials use, so the next person to
 * reach for "page_fans" should find out here rather than by breaking the sync.
 *
 * ## Why `page_follows` rather than the `followers_count` field
 *
 * The field answers "how many now" and nothing else. `page_follows` returns the
 * same number *for each of the last thirty days*, which means growth is
 * available the first time this runs rather than after a month of collecting
 * snapshots. The field is still useful as a same-day cross-check; it is not a
 * substitute.
 */

/** Metric names confirmed to answer. Adding to this list requires a probe. */
export const PAGE_GROWTH_METRICS = [
  "page_follows",
  "page_daily_follows",
  "page_views_total",
] as const;

/**
 * How far back to ask.
 *
 * Meta serves a rolling window and stops answering beyond it. Thirty days is
 * what the probe returned in full; asking for materially more risks an empty
 * response rather than a longer one.
 */
export const PAGE_METRICS_LOOKBACK_DAYS = 30;

type RawPageInsight = {
  name?: string;
  period?: string;
  values?: { value?: unknown; end_time?: string }[];
};

export type PageMetricsResult = GraphOutcome<{ data: RawPageInsight[] }>;

export async function fetchPageGrowth(params: {
  pageId: string;
  token: string;
  since?: Date;
  until?: Date;
  logger?: Logger;
}): Promise<PageMetricsResult> {
  const until = params.until ?? new Date();
  const since =
    params.since ?? new Date(until.getTime() - PAGE_METRICS_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  return graphRequest<{ data: RawPageInsight[] }>(`${params.pageId}/insights`, {
    token: params.token,
    context: "content",
    params: {
      metric: PAGE_GROWTH_METRICS.join(","),
      period: "day",
      // Unix seconds. Meta ignores a millisecond value rather than erroring,
      // and silently returns the default window instead.
      since: String(Math.floor(since.getTime() / 1000)),
      until: String(Math.floor(until.getTime() / 1000)),
    },
    ...(params.logger ? { logger: params.logger } : {}),
  });
}

// ---------------------------------------------------------------------------
// Normalisation — pure
// ---------------------------------------------------------------------------

export type DailyPageMetrics = {
  /** `YYYY-MM-DD`, UTC. The granularity Meta actually reports. */
  metricDate: string;
  followers: number | null;
  newFollows: number | null;
  pageViews: number | null;
};

/** A finite, non-negative integer, or null. Never a coerced zero. */
function toCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value);
}

/**
 * Turn Meta's per-metric series into one row per day.
 *
 * Meta returns a separate object per metric, each with its own list of daily
 * values, and the lists do not always cover the same days. Pivoting on the date
 * is what makes "followers on the 3rd" and "new follows on the 3rd" the same
 * row — and a metric missing for a day leaves a null rather than dropping the
 * day, because a gap in one series is not a gap in the others.
 *
 * `end_time` is the *end* of the day the value describes, which Meta returns as
 * midnight of the following day in the Page's timezone. Taking the date part
 * verbatim would therefore label every figure one day late, so a day is
 * subtracted.
 */
export function normalizePageGrowth(insights: readonly RawPageInsight[]): DailyPageMetrics[] {
  const byDate = new Map<string, DailyPageMetrics>();

  const field = (name: string): keyof Omit<DailyPageMetrics, "metricDate"> | null => {
    if (name === "page_follows") return "followers";
    if (name === "page_daily_follows") return "newFollows";
    if (name === "page_views_total") return "pageViews";
    return null;
  };

  for (const insight of insights) {
    const key = field(insight.name ?? "");
    if (!key) continue;

    for (const point of insight.values ?? []) {
      if (!point.end_time) continue;

      const endTime = new Date(point.end_time);
      if (Number.isNaN(endTime.getTime())) continue;

      // See above: `end_time` is the boundary after the day it describes.
      const day = new Date(endTime.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

      const row = byDate.get(day) ?? {
        metricDate: day,
        followers: null,
        newFollows: null,
        pageViews: null,
      };

      row[key] = toCount(point.value);
      byDate.set(day, row);
    }
  }

  return [...byDate.values()].sort((a, b) => a.metricDate.localeCompare(b.metricDate));
}
