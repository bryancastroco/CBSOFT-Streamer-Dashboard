import "server-only";

import { and, asc, eq, gt, inArray, isNull, notExists, sql } from "drizzle-orm";

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
import {
  resolveMetrics,
  retainKnownValues,
  toColumns,
  type PreviousMetrics,
  type RawInsight,
} from "@/lib/metrics/resolve";

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
 *
 * ## Why it is batched, and what it cost to learn
 *
 * The first version issued one insights query and two writes per post. At nine
 * posts that was invisible. At 1,624 it is roughly 4,900 round trips over the
 * Supabase transaction pooler, and a backfill ran for ten minutes, wrote 711
 * rows and was killed — leaving the table two-fifths populated with no record
 * of where it stopped.
 *
 * So the shape here is fixed at **five queries per batch** regardless of batch
 * size: select the content, select every insight for it at once, select what is
 * already stored, then one bulk upsert and one bulk snapshot insert. Nothing in
 * this file runs a query inside a per-item loop, and
 * `tests/metric-rollup-batching.test.ts` fails the build if that changes.
 *
 * ## Resumability
 *
 * There is no checkpoint table, deliberately. Progress is durable in the data
 * itself: a keyset cursor over `id`, and `onlyMissing` to skip content that
 * already has a row. A sweep that dies halfway leaves every completed batch
 * committed, and re-running finishes the rest. Batches are never wrapped in a
 * shared transaction — a single transaction over 1,624 items would hold locks
 * for minutes and lose everything on the first error.
 */

const log = childLogger({ component: "metric-rollup" });

/**
 * How many items one batch covers.
 *
 * 200 keeps a bulk insert around 4,000 bind parameters, well inside Postgres's
 * 65,535 limit, while cutting the round trips for the current roster from about
 * 4,900 to roughly 45.
 */
export const ROLLUP_BATCH_SIZE = 200;

/** Batches one invocation may run before returning a cursor to its caller. */
export const ROLLUP_MAX_BATCHES = 40;

/**
 * Wall-clock budget for one invocation.
 *
 * Comfortably inside the 300-second `maxDuration` the routes declare, so the
 * sweep returns a cursor and is resumed rather than being killed mid-batch.
 */
export const ROLLUP_TIME_BUDGET_MS = 240_000;

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

export type RollupStage = "posts" | "videos";

/** Where a sweep stopped, so the next invocation picks up from there. */
export type RollupCursor = { stage: RollupStage; after: string | null };

export type RollupBatchFailure = {
  batch: number;
  stage: RollupStage;
  after: string | null;
  /** Items in the batch that were skipped, all of them. */
  size: number;
  error: string;
};

export type RollupSummary = {
  /** Items read and attempted. */
  processed: number;
  /** Items whose canonical row was written. */
  succeeded: number;
  /** Items skipped because their batch failed. Re-runnable. */
  failed: number;
  currentUpdated: number;
  snapshotsWritten: number;
  snapshotsSkipped: number;
  /** Metric values kept from a previous collection rather than nulled. */
  retained: number;
  warnings: number;
  batches: number;
  /** Queries this invocation issued, so N+1 growth is visible in the output. */
  queries: number;
  durationMs: number;
  failures: RollupBatchFailure[];
  /** Null once both stages are exhausted. */
  cursor: RollupCursor | null;
  finished: boolean;
};

/**
 * The `SET` clause of the bulk upsert.
 *
 * Every column takes the incoming value, because retention already happened in
 * memory: `retainKnownValues` merged anything the fresh resolution lost, so the
 * row being inserted is the merged one. Doing it here in SQL instead would
 * leave `availability_json` and `metric_hash` describing values the row no
 * longer holds.
 */
const CURRENT_UPDATE_SET = {
  contentType: sql`excluded.content_type`,
  streamerId: sql`excluded.streamer_id`,
  reach: sql`excluded.reach`,
  views: sql`excluded.views`,
  viewers: sql`excluded.viewers`,
  interactions: sql`excluded.interactions`,
  interactionsIsCalculated: sql`excluded.interactions_is_calculated`,
  likes: sql`excluded.likes`,
  reactions: sql`excluded.reactions`,
  comments: sql`excluded.comments`,
  shares: sql`excluded.shares`,
  watchTimeMs: sql`excluded.watch_time_ms`,
  averagePlayTimeMs: sql`excluded.average_play_time_ms`,
  threeSecondViews: sql`excluded.three_second_views`,
  reelsPlays: sql`excluded.reels_plays`,
  availabilityJson: sql`excluded.availability_json`,
  sourceMappingJson: sql`excluded.source_mapping_json`,
  graphApiVersion: sql`excluded.graph_api_version`,
  metricHash: sql`excluded.metric_hash`,
  lastCollectedAt: sql`excluded.last_collected_at`,
  updatedAt: sql`now()`,
} as const;

/** The stored metric columns, shaped for the retention rule. */
const storedMetricColumns = {
  postId: contentMetricsCurrent.postId,
  videoId: contentMetricsCurrent.videoId,
  reach: contentMetricsCurrent.reach,
  views: contentMetricsCurrent.views,
  viewers: contentMetricsCurrent.viewers,
  interactions: contentMetricsCurrent.interactions,
  likes: contentMetricsCurrent.likes,
  reactions: contentMetricsCurrent.reactions,
  comments: contentMetricsCurrent.comments,
  shares: contentMetricsCurrent.shares,
  watchTimeMs: contentMetricsCurrent.watchTimeMs,
  averagePlayTimeMs: contentMetricsCurrent.averagePlayTimeMs,
  threeSecondViews: contentMetricsCurrent.threeSecondViews,
  reelsPlays: contentMetricsCurrent.reelsPlays,
  availabilityJson: contentMetricsCurrent.availabilityJson,
  sourceMappingJson: contentMetricsCurrent.sourceMappingJson,
} as const;

type StoredMetricRow = {
  [K in keyof typeof storedMetricColumns]: K extends "postId" | "videoId"
    ? string | null
    : K extends "availabilityJson" | "sourceMappingJson"
      ? unknown
      : number | null;
};

function toPrevious(row: StoredMetricRow): PreviousMetrics {
  const record = (value: unknown): Record<string, unknown> | null =>
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;

  return {
    values: {
      reach: row.reach,
      views: row.views,
      viewers: row.viewers,
      interactions: row.interactions,
      likes: row.likes,
      reactions: row.reactions,
      comments: row.comments,
      shares: row.shares,
      watch_time: row.watchTimeMs,
      average_play_time: row.averagePlayTimeMs,
      three_second_views: row.threeSecondViews,
      reels_plays: row.reelsPlays,
    },
    availability: record(row.availabilityJson),
    sourceMapping: record(row.sourceMappingJson),
  };
}

/** Group insight rows by the content they belong to, in one pass. */
function groupByContent<T extends { contentId: string }>(rows: readonly T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();

  for (const row of rows) {
    const existing = grouped.get(row.contentId);
    if (existing) existing.push(row);
    else grouped.set(row.contentId, [row]);
  }

  return grouped;
}

/** What one batch did. `lastId` is null only when the stage is exhausted. */
type BatchOutcome = {
  size: number;
  lastId: string | null;
  succeeded: number;
  failed: number;
  snapshotsWritten: number;
  retained: number;
  warnings: number;
  queries: number;
  error?: string;
};

const EXHAUSTED: BatchOutcome = {
  size: 0,
  lastId: null,
  succeeded: 0,
  failed: 0,
  snapshotsWritten: 0,
  retained: 0,
  warnings: 0,
  queries: 1,
};

type BatchInput = {
  streamerId: string | undefined;
  after: string | null;
  batchSize: number;
  onlyMissing: boolean;
  graphApiVersion: string;
  collectedAt: Date;
};

async function runPostBatch(input: BatchInput): Promise<BatchOutcome> {
  const db = getDb();

  /*
   * Query 1. Keyset, not OFFSET: an offset scan re-reads every row it skips,
   * so the last batch of a large sweep costs the most, exactly when the budget
   * is tightest.
   */
  const batch = await db
    .select({
      id: posts.id,
      streamerId: posts.streamerId,
      reactionCount: posts.reactionCount,
      likeCount: posts.likeCount,
      commentCount: posts.commentCount,
      shareCount: posts.shareCount,
    })
    .from(posts)
    .where(
      and(
        input.streamerId ? eq(posts.streamerId, input.streamerId) : undefined,
        input.after ? gt(posts.id, input.after) : undefined,
        input.onlyMissing
          ? notExists(
              db
                .select({ one: sql`1` })
                .from(contentMetricsCurrent)
                .where(eq(contentMetricsCurrent.postId, posts.id)),
            )
          : undefined,
      ),
    )
    .orderBy(asc(posts.id))
    .limit(input.batchSize);

  if (batch.length === 0) return EXHAUSTED;

  const ids = batch.map((row) => row.id);
  const lastId = batch[batch.length - 1]!.id;

  try {
    // Query 2. Every insight for the whole batch, in one statement.
    const insightRows = await db
      .select({
        contentId: postInsights.postId,
        metricName: postInsights.metricName,
        value: postInsights.valueJson,
        period: postInsights.period,
      })
      .from(postInsights)
      .where(inArray(postInsights.postId, ids));

    const insightsByPost = groupByContent(insightRows);

    /*
     * Query 3, and only when it can return anything. In `onlyMissing` mode
     * every item is by definition unrolled, so there is nothing to retain and
     * the query would be a guaranteed empty scan.
     */
    const storedRows = input.onlyMissing
      ? []
      : await db
          .select(storedMetricColumns)
          .from(contentMetricsCurrent)
          .where(inArray(contentMetricsCurrent.postId, ids));

    const storedByPost = new Map(
      storedRows.filter((row) => row.postId !== null).map((row) => [row.postId!, row]),
    );

    const currentValues = [];
    const snapshotValues = [];
    let retained = 0;
    let warnings = 0;

    for (const post of batch) {
      const raw = insightsByPost.get(post.id) ?? [];

      const fresh = resolveMetrics({
        applicability: applicabilityOfPost(raw),
        postInsights: raw,
        videoInsights: [],
        fields: {
          reactionCount: post.reactionCount,
          likeCount: post.likeCount,
          commentCount: post.commentCount,
          shareCount: post.shareCount,
        },
        graphApiVersion: input.graphApiVersion,
        collectedAt: input.collectedAt,
      });

      const stored = storedByPost.get(post.id);
      const merged = retainKnownValues(fresh, stored ? toPrevious(stored) : null);

      retained += merged.retained.length;
      warnings += fresh.warnings.length;

      for (const warning of fresh.warnings) {
        // Metric names and numbers only — nothing here can carry a credential.
        log.warn("metric_conflict", { detail: warning });
      }

      const columns = toColumns(merged.resolved);

      currentValues.push({
        contentType: "post" as const,
        postId: post.id,
        videoId: null,
        streamerId: post.streamerId,
        ...columns,
        graphApiVersion: input.graphApiVersion,
        lastCollectedAt: input.collectedAt,
      });

      snapshotValues.push({
        contentType: "post" as const,
        postId: post.id,
        videoId: null,
        streamerId: post.streamerId,
        ...columns,
        graphApiVersion: input.graphApiVersion,
        collectedAt: input.collectedAt,
      });
    }

    // Query 4. One statement for the whole batch.
    await db
      .insert(contentMetricsCurrent)
      .values(currentValues)
      .onConflictDoUpdate({
        target: contentMetricsCurrent.postId,
        /*
         * The unique index is partial (`where post_id is not null`), and
         * Postgres will only infer a partial index when the predicate is
         * restated here.
         */
        targetWhere: sql`${contentMetricsCurrent.postId} is not null`,
        set: CURRENT_UPDATE_SET,
      });

    /*
     * Query 5. `ON CONFLICT DO NOTHING` against the partial unique index on
     * `(post_id, metric_hash)`: the database decides what counts as a change,
     * not the application. Two sweeps racing would otherwise both read "no
     * existing snapshot" and both insert.
     */
    const inserted = await db
      .insert(contentMetricSnapshots)
      .values(snapshotValues)
      .onConflictDoNothing()
      .returning({ id: contentMetricSnapshots.id });

    return {
      size: batch.length,
      lastId,
      succeeded: batch.length,
      failed: 0,
      snapshotsWritten: inserted.length,
      retained,
      warnings,
      queries: input.onlyMissing ? 4 : 5,
    };
  } catch (cause) {
    /*
     * The batch is lost, the sweep is not. The cursor still advances past it,
     * because a batch that fails twice for the same reason would otherwise
     * stall every batch behind it; `onlyMissing` picks the skipped items up on
     * the next run.
     */
    return {
      size: batch.length,
      lastId,
      succeeded: 0,
      failed: batch.length,
      snapshotsWritten: 0,
      retained: 0,
      warnings: 0,
      queries: 5,
      error: cause instanceof Error ? cause.message : "Unknown error",
    };
  }
}

async function runVideoBatch(input: BatchInput): Promise<BatchOutcome> {
  const db = getDb();

  const batch = await db
    .select({ id: videos.id, streamerId: videos.streamerId })
    .from(videos)
    .where(
      and(
        input.streamerId ? eq(videos.streamerId, input.streamerId) : undefined,
        input.after ? gt(videos.id, input.after) : undefined,
        input.onlyMissing
          ? notExists(
              db
                .select({ one: sql`1` })
                .from(contentMetricsCurrent)
                .where(eq(contentMetricsCurrent.videoId, videos.id)),
            )
          : undefined,
      ),
    )
    .orderBy(asc(videos.id))
    .limit(input.batchSize);

  if (batch.length === 0) return EXHAUSTED;

  const ids = batch.map((row) => row.id);
  const lastId = batch[batch.length - 1]!.id;

  try {
    const insightRows = await db
      .select({
        contentId: videoInsights.videoId,
        metricName: videoInsights.metricName,
        value: videoInsights.valueJson,
        period: videoInsights.period,
      })
      .from(videoInsights)
      .where(inArray(videoInsights.videoId, ids));

    const insightsByVideo = groupByContent(insightRows);

    const storedRows = input.onlyMissing
      ? []
      : await db
          .select(storedMetricColumns)
          .from(contentMetricsCurrent)
          .where(inArray(contentMetricsCurrent.videoId, ids));

    const storedByVideo = new Map(
      storedRows.filter((row) => row.videoId !== null).map((row) => [row.videoId!, row]),
    );

    const currentValues = [];
    const snapshotValues = [];
    let retained = 0;
    let warnings = 0;

    for (const video of batch) {
      const raw = insightsByVideo.get(video.id) ?? [];

      const fresh = resolveMetrics({
        applicability: "video",
        postInsights: [],
        videoInsights: raw,
        // A video object carries no reaction/comment/share fields of its own;
        // those arrive through `post_video_social_actions` when Meta sends them.
        fields: {},
        graphApiVersion: input.graphApiVersion,
        collectedAt: input.collectedAt,
      });

      const stored = storedByVideo.get(video.id);
      const merged = retainKnownValues(fresh, stored ? toPrevious(stored) : null);

      retained += merged.retained.length;
      warnings += fresh.warnings.length;

      for (const warning of fresh.warnings) {
        log.warn("metric_conflict", { detail: warning });
      }

      const columns = toColumns(merged.resolved);

      currentValues.push({
        contentType: "video" as const,
        postId: null,
        videoId: video.id,
        streamerId: video.streamerId,
        ...columns,
        graphApiVersion: input.graphApiVersion,
        lastCollectedAt: input.collectedAt,
      });

      snapshotValues.push({
        contentType: "video" as const,
        postId: null,
        videoId: video.id,
        streamerId: video.streamerId,
        ...columns,
        graphApiVersion: input.graphApiVersion,
        collectedAt: input.collectedAt,
      });
    }

    await db
      .insert(contentMetricsCurrent)
      .values(currentValues)
      .onConflictDoUpdate({
        target: contentMetricsCurrent.videoId,
        targetWhere: sql`${contentMetricsCurrent.videoId} is not null`,
        set: CURRENT_UPDATE_SET,
      });

    const inserted = await db
      .insert(contentMetricSnapshots)
      .values(snapshotValues)
      .onConflictDoNothing()
      .returning({ id: contentMetricSnapshots.id });

    return {
      size: batch.length,
      lastId,
      succeeded: batch.length,
      failed: 0,
      snapshotsWritten: inserted.length,
      retained,
      warnings,
      queries: input.onlyMissing ? 4 : 5,
    };
  } catch (cause) {
    return {
      size: batch.length,
      lastId,
      succeeded: 0,
      failed: batch.length,
      snapshotsWritten: 0,
      retained: 0,
      warnings: 0,
      queries: 5,
      error: cause instanceof Error ? cause.message : "Unknown error",
    };
  }
}

export type RollupParams = {
  streamerId?: string | undefined;
  graphApiVersion: string;
  now?: Date;
  batchSize?: number;
  maxBatches?: number;
  timeBudgetMs?: number;
  /** Skip content that already has a canonical row. Resumes a backfill. */
  onlyMissing?: boolean;
  /** Continue a sweep that ran out of budget. */
  cursor?: RollupCursor | null;
};

/**
 * Roll up posts then videos, in bounded batches, resumable at any point.
 *
 * Reads stored insights rather than calling Meta, so it is safe to run at any
 * time and costs no rate-limit budget. Returns when both stages are exhausted,
 * when `maxBatches` is reached, or when the time budget runs out — the last two
 * hand back a cursor rather than truncating silently.
 */
export async function rollUpMetrics(params: RollupParams): Promise<RollupSummary> {
  const startedAt = Date.now();
  const collectedAt = params.now ?? new Date();

  const batchSize = Math.min(Math.max(params.batchSize ?? ROLLUP_BATCH_SIZE, 1), 500);
  const maxBatches = Math.max(params.maxBatches ?? ROLLUP_MAX_BATCHES, 1);
  const deadline = startedAt + (params.timeBudgetMs ?? ROLLUP_TIME_BUDGET_MS);
  const onlyMissing = params.onlyMissing ?? false;

  let cursor: RollupCursor | null = params.cursor ?? { stage: "posts", after: null };

  const summary: RollupSummary = {
    processed: 0,
    succeeded: 0,
    failed: 0,
    currentUpdated: 0,
    snapshotsWritten: 0,
    snapshotsSkipped: 0,
    retained: 0,
    warnings: 0,
    batches: 0,
    queries: 0,
    durationMs: 0,
    failures: [],
    cursor,
    finished: false,
  };

  while (cursor !== null && summary.batches < maxBatches && Date.now() < deadline) {
    const input: BatchInput = {
      streamerId: params.streamerId,
      after: cursor.after,
      batchSize,
      onlyMissing,
      graphApiVersion: params.graphApiVersion,
      collectedAt,
    };

    /*
     * Only the write phase is caught inside the batch. A failing *select* is
     * not item-specific — it means the connection or the table is unusable —
     * and advancing past it would spin through the whole roster recording a
     * failure per batch. That one propagates and ends the sweep.
     */
    const outcome =
      cursor.stage === "posts" ? await runPostBatch(input) : await runVideoBatch(input);

    summary.queries += outcome.queries;

    if (outcome.size === 0) {
      // Stage exhausted. Posts hand over to videos; videos end the sweep.
      cursor = cursor.stage === "posts" ? { stage: "videos", after: null } : null;
      summary.cursor = cursor;
      continue;
    }

    summary.batches += 1;
    summary.processed += outcome.size;
    summary.succeeded += outcome.succeeded;
    summary.failed += outcome.failed;
    summary.currentUpdated += outcome.succeeded;
    summary.snapshotsWritten += outcome.snapshotsWritten;
    summary.snapshotsSkipped += outcome.succeeded - outcome.snapshotsWritten;
    summary.retained += outcome.retained;
    summary.warnings += outcome.warnings;

    if (outcome.error) {
      summary.failures.push({
        batch: summary.batches,
        stage: cursor.stage,
        after: cursor.after,
        size: outcome.size,
        error: outcome.error,
      });

      log.error("metric_rollup_batch_failed", {
        batch: summary.batches,
        stage: cursor.stage,
        size: outcome.size,
        error: outcome.error,
      });
    } else {
      log.info("metric_rollup_batch", {
        batch: summary.batches,
        stage: cursor.stage,
        size: outcome.size,
        snapshotsWritten: outcome.snapshotsWritten,
        retained: outcome.retained,
        elapsedMs: Date.now() - startedAt,
      });
    }

    cursor = { stage: cursor.stage, after: outcome.lastId };
    summary.cursor = cursor;
  }

  summary.finished = cursor === null;
  summary.durationMs = Date.now() - startedAt;

  log.info("metric_rollup_complete", {
    processed: summary.processed,
    succeeded: summary.succeeded,
    failed: summary.failed,
    batches: summary.batches,
    queries: summary.queries,
    retained: summary.retained,
    durationMs: summary.durationMs,
    finished: summary.finished,
  });

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
