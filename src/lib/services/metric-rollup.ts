import "server-only";

import { and, eq, isNull, sql } from "drizzle-orm";

import { getDb } from "@/lib/db";
import {
  contentMetricSnapshots,
  contentMetricsCurrent,
  postInsights,
  posts,
  videoInsights,
  videos,
} from "@/lib/db/schema";
import { childLogger } from "@/lib/observability/logger";
import type { ContentApplicability } from "@/lib/metrics/registry";
import { resolveMetrics, toColumns, type RawInsight } from "@/lib/metrics/resolve";

/**
 * Roll raw Meta insights up into the canonical metric tables.
 *
 * Raw `post_insights` and `video_insights` remain the record of exactly what
 * Meta returned and are never modified here. This reads them, resolves the
 * canonical values, and writes two things: one current row per piece of
 * content, and a snapshot when the numbers have actually moved.
 *
 * ## Why this is separate from the sync service
 *
 * Rolling up is not fetching. Keeping it apart means it can run over content
 * already collected — a backfill, or a re-run after the registry gains a
 * candidate — without touching Meta at all. A registry change should be
 * replayable against stored data, not require re-syncing every post.
 */

const log = childLogger({ component: "metric-rollup" });

/**
 * Whether a post carries video.
 *
 * Presence of a `post_video_*` metric is not the signal, which is what this
 * originally used. Meta returns `post_video_views: 0` for ordinary text posts
 * rather than omitting it, so that test classified every post in the roster as
 * a video post — and video metrics then read as "not reported" instead of "not
 * applicable", which is a different and wrong claim.
 *
 * A non-zero video metric is the signal instead. That leaves one known gap: a
 * genuine video nobody watched looks like a text post. The honest fix is
 * Meta's own `attachments`/`status_type` on the post object, which Phase 21
 * Step 4 calls for and which this will switch to once those fields are stored.
 */
function applicabilityOfPost(rows: readonly RawInsight[]): ContentApplicability {
  const hasVideoSignal = rows.some(
    (row) =>
      row.metricName.startsWith("post_video_") && typeof row.value === "number" && row.value > 0,
  );

  return hasVideoSignal ? "video_post" : "post";
}

export type RollupSummary = {
  processed: number;
  currentUpdated: number;
  snapshotsWritten: number;
  snapshotsSkipped: number;
  warnings: number;
};

/**
 * Write one content item's metrics.
 *
 * The snapshot insert is `ON CONFLICT DO NOTHING` against the partial unique
 * index on `(content_id, metric_hash)`. The database decides whether this is a
 * change, not the application — two sweeps racing would otherwise both read
 * "no existing snapshot" and both insert.
 */
async function persist(params: {
  contentType: "post" | "video";
  postId: string | null;
  videoId: string | null;
  streamerId: string;
  applicability: ContentApplicability;
  postRows: RawInsight[];
  videoRows: RawInsight[];
  fields: {
    reactionCount?: number | null;
    commentCount?: number | null;
    shareCount?: number | null;
  };
  graphApiVersion: string;
  collectedAt: Date;
}): Promise<{ snapshotWritten: boolean; warnings: number }> {
  const db = getDb();

  const resolved = resolveMetrics({
    applicability: params.applicability,
    postInsights: params.postRows,
    videoInsights: params.videoRows,
    fields: params.fields,
    graphApiVersion: params.graphApiVersion,
    collectedAt: params.collectedAt,
  });

  const columns = toColumns(resolved);

  const target = params.postId
    ? { postId: params.postId, videoId: null }
    : { postId: null, videoId: params.videoId };

  await db
    .insert(contentMetricsCurrent)
    .values({
      contentType: params.contentType,
      ...target,
      streamerId: params.streamerId,
      ...columns,
      graphApiVersion: params.graphApiVersion,
      lastCollectedAt: params.collectedAt,
    })
    .onConflictDoUpdate({
      target: params.postId ? contentMetricsCurrent.postId : contentMetricsCurrent.videoId,
      set: {
        ...columns,
        graphApiVersion: params.graphApiVersion,
        lastCollectedAt: params.collectedAt,
        updatedAt: sql`now()`,
      },
    });

  const inserted = await db
    .insert(contentMetricSnapshots)
    .values({
      contentType: params.contentType,
      ...target,
      streamerId: params.streamerId,
      ...columns,
      graphApiVersion: params.graphApiVersion,
      collectedAt: params.collectedAt,
    })
    .onConflictDoNothing()
    .returning({ id: contentMetricSnapshots.id });

  for (const warning of resolved.warnings) {
    // Metric names and numbers only — nothing here can carry a credential.
    log.warn("metric_conflict", { detail: warning });
  }

  return { snapshotWritten: inserted.length > 0, warnings: resolved.warnings.length };
}

/**
 * Roll up every post and video for a streamer, or for the whole roster.
 *
 * Reads stored insights rather than calling Meta, so it is safe to run at any
 * time and costs no rate-limit budget.
 */
export async function rollUpMetrics(params: {
  streamerId?: string | undefined;
  graphApiVersion: string;
  now?: Date;
}): Promise<RollupSummary> {
  const db = getDb();
  const collectedAt = params.now ?? new Date();

  const summary: RollupSummary = {
    processed: 0,
    currentUpdated: 0,
    snapshotsWritten: 0,
    snapshotsSkipped: 0,
    warnings: 0,
  };

  const postRows = await db
    .select({
      id: posts.id,
      streamerId: posts.streamerId,
      reactionCount: posts.reactionCount,
      commentCount: posts.commentCount,
      shareCount: posts.shareCount,
    })
    .from(posts)
    .where(and(params.streamerId ? eq(posts.streamerId, params.streamerId) : undefined));

  for (const post of postRows) {
    const insights = await db
      .select({
        metricName: postInsights.metricName,
        value: postInsights.valueJson,
        period: postInsights.period,
      })
      .from(postInsights)
      .where(eq(postInsights.postId, post.id));

    const raw: RawInsight[] = insights.map((row) => ({
      metricName: row.metricName,
      value: row.value,
      period: row.period,
    }));

    const outcome = await persist({
      contentType: "post",
      postId: post.id,
      videoId: null,
      streamerId: post.streamerId,
      applicability: applicabilityOfPost(raw),
      postRows: raw,
      videoRows: [],
      fields: {
        reactionCount: post.reactionCount,
        commentCount: post.commentCount,
        shareCount: post.shareCount,
      },
      graphApiVersion: params.graphApiVersion,
      collectedAt,
    });

    summary.processed += 1;
    summary.currentUpdated += 1;
    summary.warnings += outcome.warnings;
    if (outcome.snapshotWritten) summary.snapshotsWritten += 1;
    else summary.snapshotsSkipped += 1;
  }

  const videoRows = await db
    .select({ id: videos.id, streamerId: videos.streamerId })
    .from(videos)
    .where(and(params.streamerId ? eq(videos.streamerId, params.streamerId) : undefined));

  for (const video of videoRows) {
    const insights = await db
      .select({
        metricName: videoInsights.metricName,
        value: videoInsights.valueJson,
        period: videoInsights.period,
      })
      .from(videoInsights)
      .where(eq(videoInsights.videoId, video.id));

    const raw: RawInsight[] = insights.map((row) => ({
      metricName: row.metricName,
      value: row.value,
      period: row.period,
    }));

    const outcome = await persist({
      contentType: "video",
      postId: null,
      videoId: video.id,
      streamerId: video.streamerId,
      applicability: "video",
      postRows: [],
      videoRows: raw,
      // A video object carries no reaction/comment/share fields of its own;
      // those arrive through `post_video_social_actions` when Meta sends them.
      fields: {},
      graphApiVersion: params.graphApiVersion,
      collectedAt,
    });

    summary.processed += 1;
    summary.currentUpdated += 1;
    summary.warnings += outcome.warnings;
    if (outcome.snapshotWritten) summary.snapshotsWritten += 1;
    else summary.snapshotsSkipped += 1;
  }

  log.info("metric_rollup_complete", { ...summary });

  return summary;
}

/** Content with no rolled-up row yet — used to size a backfill. */
export async function countUnrolledContent(): Promise<{ posts: number; videos: number }> {
  const db = getDb();

  const [postGap] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(posts)
    .leftJoin(contentMetricsCurrent, eq(contentMetricsCurrent.postId, posts.id))
    .where(isNull(contentMetricsCurrent.id));

  const [videoGap] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(videos)
    .leftJoin(contentMetricsCurrent, eq(contentMetricsCurrent.videoId, videos.id))
    .where(isNull(contentMetricsCurrent.id));

  return { posts: postGap?.n ?? 0, videos: videoGap?.n ?? 0 };
}
