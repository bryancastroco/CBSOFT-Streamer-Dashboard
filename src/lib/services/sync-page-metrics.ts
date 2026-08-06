import "server-only";

import { sql } from "drizzle-orm";

import { getDb } from "@/lib/db";
import { pageMetricsDaily } from "@/lib/db/schema";
import type { NormalizedMetaError } from "@/lib/meta/errors";
import { fetchPageGrowth, normalizePageGrowth } from "@/lib/meta/page-metrics";
import { childLogger } from "@/lib/observability/logger";
import { getStreamerIdentity, withStreamerToken } from "@/lib/repositories/streamers";

/**
 * Collect a Page's audience history.
 *
 * ## Why every run re-fetches the whole window
 *
 * Meta revises recent days — a figure for yesterday can change today as late
 * events are counted — and the call costs one request regardless of how many
 * days it covers. Fetching only "since the last row" would save nothing and
 * would freeze whatever value happened to be reported first.
 *
 * The unique key on `(streamer_id, metric_date)` turns that into an update
 * rather than an accumulation, so re-running is free of consequence.
 *
 * ## Why a null is never written over a number
 *
 * The same rule the metric rollup follows. Meta occasionally omits a metric for
 * a day it previously reported, and letting that overwrite a stored figure
 * would silently delete history — a growth chart that develops holes is worse
 * than one that is honestly short.
 */

export type SyncPageMetricsOutcome =
  | { ok: true; daysWritten: number; latestFollowers: number | null }
  | { ok: false; reason: "not_found" | "no_token" | "meta_error"; message: string };

export async function syncPageMetrics(params: {
  streamerId: string;
  since?: Date;
}): Promise<SyncPageMetricsOutcome> {
  const streamer = await getStreamerIdentity(params.streamerId);

  if (!streamer) {
    return { ok: false, reason: "not_found", message: "That streamer no longer exists." };
  }

  const log = childLogger({ component: "sync.page_metrics", streamerCode: streamer.streamerCode });

  let error: NormalizedMetaError | null = null;
  let days: ReturnType<typeof normalizePageGrowth> = [];

  const lent = await withStreamerToken(params.streamerId, async (token) => {
    const result = await fetchPageGrowth({
      pageId: streamer.pageId,
      token,
      ...(params.since ? { since: params.since } : {}),
      logger: log,
    });

    if (!result.ok) {
      error = result.error;
      return;
    }

    days = normalizePageGrowth(result.data.data ?? []);
  });

  if (!lent.ok) {
    return {
      ok: false,
      reason: "no_token",
      message: "That streamer has no Page token, so audience figures cannot be collected.",
    };
  }

  if (error) {
    return { ok: false, reason: "meta_error", message: (error as NormalizedMetaError).message };
  }

  if (days.length === 0) {
    log.info("page_metrics.empty");
    return { ok: true, daysWritten: 0, latestFollowers: null };
  }

  const db = getDb();

  await db
    .insert(pageMetricsDaily)
    .values(
      days.map((day) => ({
        streamerId: params.streamerId,
        metricDate: day.metricDate,
        followers: day.followers,
        newFollows: day.newFollows,
        pageViews: day.pageViews,
        rawJson: day as never,
        collectedAt: new Date(),
      })),
    )
    .onConflictDoUpdate({
      target: [pageMetricsDaily.streamerId, pageMetricsDaily.metricDate],
      set: {
        // `coalesce(excluded, existing)` rather than a plain overwrite: a day
        // Meta has stopped reporting keeps the figure it once gave.
        followers: sql`coalesce(excluded.followers, ${pageMetricsDaily.followers})`,
        newFollows: sql`coalesce(excluded.new_follows, ${pageMetricsDaily.newFollows})`,
        pageViews: sql`coalesce(excluded.page_views, ${pageMetricsDaily.pageViews})`,
        rawJson: sql`excluded.raw_json`,
        collectedAt: sql`excluded.collected_at`,
      },
    });

  const latest = days.at(-1)?.followers ?? null;

  log.info("page_metrics.stored", { days: days.length, latestFollowers: latest });

  return { ok: true, daysWritten: days.length, latestFollowers: latest };
}
