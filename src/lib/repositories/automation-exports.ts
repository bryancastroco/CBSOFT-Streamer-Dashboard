import "server-only";

import { and, asc, count, eq, gte, isNull, lte, sql, type AnyColumn, type SQL } from "drizzle-orm";

import { NO_SIGNIFICANT_FINDINGS } from "@/lib/ai/contract";
import { realFindings } from "@/lib/ai/presentation";
import { sanitiseMessage } from "@/lib/automation/sanitise";
import type { ExportQuery } from "@/lib/automation/query";
import { getDb } from "@/lib/db";
import { pageOffset, pageSize, tsParam } from "@/lib/db/params";
import {
  commentSummaries,
  postInsights,
  posts,
  streamers,
  syncRuns,
  videoInsights,
  videos,
} from "@/lib/db/schema";
import { buildInsightKey } from "@/lib/google-sheets/export-contract";
import type {
  CommentSummaryExportRow,
  PostExportRow,
  PostInsightExportRow,
  StreamerExportRow,
  SyncLogExportRow,
  VideoExportRow,
  VideoInsightExportRow,
} from "@/lib/google-sheets/export-contract";

/**
 * The seven export queries behind `/api/automation/exports/*`.
 *
 * ## Ordering is part of the contract
 *
 * Every query orders by `(watermark asc, id asc)`. Two reasons, both about
 * correctness rather than presentation:
 *
 * 1. **Stable pagination.** A workflow walks a dataset with `offset`. Without a
 *    total order, two pages can overlap or skip rows when the underlying data
 *    changes between requests — and a skipped row is a row that never reaches
 *    the spreadsheet.
 * 2. **A usable checkpoint.** Ascending watermark means the last row of the last
 *    page carries the highest value, so `max_watermark` is a safe
 *    `updated_after` for the next run.
 *
 * ## What is not here
 *
 * No query selects the stored token ciphertext, its suffix, an internal user id
 * or a commenter — the row types they build have no field capable of holding
 * one. `tests/automation-exports.test.ts` asserts the exact column list of every
 * dataset from the outside.
 */

export type ExportPage<T> = {
  rows: T[];
  total: number;
  /**
   * The highest watermark across the **whole filtered set**, at microsecond
   * precision, or null when the set is empty.
   *
   * Supplied by Postgres rather than derived from the rows, because the rows'
   * own ISO strings are millisecond-precision — a `Date` cannot hold more — and
   * a checkpoint that is 456 microseconds too early re-delivers the boundary
   * rows on every run. Since a bulk upsert stamps every row it writes with the
   * same transaction timestamp, that means re-delivering the entire previous
   * batch.
   *
   * Whole-set rather than this-page, so a caller that pages to the end and
   * checkpoints gets the same answer as one that reads `max_watermark` from the
   * first page.
   */
  maxWatermark: string | null;
};

/**
 * `max(column)` rendered as a full-precision ISO 8601 instant.
 *
 * `to_char` rather than a cast: `timestamptz::text` yields
 * `2026-07-30 01:12:50.921456+00`, which Postgres accepts back but is not ISO
 * 8601 and would fail the envelope's `z.iso.datetime()`. This produces
 * `2026-07-30T01:12:50.921456Z` — valid ISO, accepted by Postgres on the way
 * back in, and lossless.
 */
function watermarkOf(column: AnyColumn) {
  return sql<
    string | null
  >`to_char(max(${column}) at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/**
 * The incremental predicate.
 *
 * The checkpoint is bound as text and cast by Postgres, so the comparison
 * happens at the precision the value was stored with. Binding a JS `Date` here
 * would silently truncate to milliseconds — see `ExportPage.maxWatermark`.
 */
function newerThan(column: AnyColumn, checkpoint: string): SQL {
  return sql`${column} > ${checkpoint}::timestamptz`;
}

/** Every export shares this filter vocabulary; only the columns differ. */
type Filters = Pick<
  ExportQuery,
  "updated_after" | "from" | "to" | "streamer_id" | "limit" | "offset"
>;

function toIso(value: Date): string {
  return value.toISOString();
}

function toIsoOrNull(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

/**
 * Render a metric value three ways for a spreadsheet.
 *
 * A cell holds one scalar, but a Meta metric can be a nested tree. So the row
 * carries a readable summary, the exact value JSON-encoded, and the type — a
 * workflow that only wants totals reads `value_display`; one that needs the
 * breakdown parses `value_json`. Flattening to a single field would either lose
 * the structure or fill the sheet with `[object Object]`.
 */
function describeValue(value: unknown): {
  value_display: string;
  value_json: string;
  value_type: "number" | "string" | "boolean" | "array" | "object" | "null";
} {
  if (value === null || value === undefined) {
    // An absent metric is blank, never "0". See SYNC-ENGINE.md §6.
    return { value_display: "", value_json: "null", value_type: "null" };
  }

  if (typeof value === "number") {
    return {
      value_display: String(value),
      value_json: JSON.stringify(value),
      value_type: "number",
    };
  }

  if (typeof value === "boolean") {
    return {
      value_display: value ? "true" : "false",
      value_json: JSON.stringify(value),
      value_type: "boolean",
    };
  }

  if (typeof value === "string") {
    return { value_display: value, value_json: JSON.stringify(value), value_type: "string" };
  }

  if (Array.isArray(value)) {
    return {
      value_display: `${value.length} entries`,
      value_json: JSON.stringify(value),
      value_type: "array",
    };
  }

  const entries = Object.entries(value as Record<string, unknown>);
  const allNumeric = entries.length > 0 && entries.every(([, entry]) => typeof entry === "number");

  return {
    value_display: allNumeric
      ? String(entries.reduce((sum, [, entry]) => sum + (entry as number), 0))
      : `${entries.length} breakdowns`,
    value_json: JSON.stringify(value),
    value_type: "object",
  };
}

/** Finding lists are pipe-joined: a comma fights both CSV and a sheet cell. */
function joinFindings(value: unknown): string | null {
  const items = realFindings(value);
  return items.length === 0 ? null : items.join(" | ");
}

function countRealFindings(value: unknown): number {
  return realFindings(value).length;
}

// ---------------------------------------------------------------------------
// streamers
// ---------------------------------------------------------------------------

export async function exportStreamers(filters: Filters): Promise<ExportPage<StreamerExportRow>> {
  const db = getDb();

  const conditions: SQL[] = [isNull(streamers.deletedAt)];
  if (filters.streamer_id) conditions.push(eq(streamers.id, filters.streamer_id));
  if (filters.updated_after) conditions.push(newerThan(streamers.updatedAt, filters.updated_after));
  // The content window means "created in this range" for a roster row.
  if (filters.from) conditions.push(gte(streamers.createdAt, filters.from));
  if (filters.to) conditions.push(lte(streamers.createdAt, filters.to));

  const where = and(...conditions);

  const [rows, totals] = await Promise.all([
    db
      .select({
        id: streamers.id,
        streamerCode: streamers.streamerCode,
        streamerName: streamers.streamerName,
        pageId: streamers.pageId,
        pageName: streamers.pageName,
        active: streamers.active,
        tokenStatus: streamers.tokenStatus,
        tokenExpiresAt: streamers.tokenExpiresAt,
        lastSuccessfulSyncAt: streamers.lastSuccessfulSyncAt,
        lastSyncError: streamers.lastSyncError,
        createdAt: streamers.createdAt,
        updatedAt: streamers.updatedAt,
      })
      .from(streamers)
      .where(where)
      .orderBy(asc(streamers.updatedAt), asc(streamers.id))
      .limit(filters.limit)
      .offset(filters.offset),
    db
      .select({ value: count(), watermark: watermarkOf(streamers.updatedAt) })
      .from(streamers)
      .where(where),
  ]);

  return {
    total: totals[0]?.value ?? 0,
    maxWatermark: totals[0]?.watermark ?? null,
    rows: rows.map((row) => ({
      streamer_id: row.id,
      streamer_code: row.streamerCode,
      streamer_name: row.streamerName,
      facebook_page_id: row.pageId,
      facebook_page_name: row.pageName,
      active: row.active,
      token_status: row.tokenStatus,
      token_expires_at: toIsoOrNull(row.tokenExpiresAt),
      last_successful_sync_at: toIsoOrNull(row.lastSuccessfulSyncAt),
      // Sanitised again on the way out. It was written sanitised, but this is
      // the boundary where a mistake becomes somebody else's log file.
      last_sync_error: row.lastSyncError ? sanitiseMessage(row.lastSyncError) : null,
      created_at: toIso(row.createdAt),
      updated_at: toIso(row.updatedAt),
    })),
  };
}

// ---------------------------------------------------------------------------
// posts
// ---------------------------------------------------------------------------

const postMetricCount = sql<number>`(
  select count(*)::int from ${postInsights} where ${postInsights.postId} = ${posts.id}
)`;

export async function exportPosts(filters: Filters): Promise<ExportPage<PostExportRow>> {
  const db = getDb();

  const conditions: SQL[] = [];
  if (filters.streamer_id) conditions.push(eq(posts.streamerId, filters.streamer_id));
  if (filters.updated_after) conditions.push(newerThan(posts.updatedAt, filters.updated_after));
  if (filters.from) conditions.push(gte(posts.createdTime, filters.from));
  if (filters.to) conditions.push(lte(posts.createdTime, filters.to));

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, totals] = await Promise.all([
    db
      .select({
        id: posts.id,
        streamerId: posts.streamerId,
        streamerCode: streamers.streamerCode,
        streamerName: streamers.streamerName,
        pageId: streamers.pageId,
        facebookPostId: posts.facebookPostId,
        message: posts.message,
        createdTime: posts.createdTime,
        permalinkUrl: posts.permalinkUrl,
        reactionCount: posts.reactionCount,
        commentCount: posts.commentCount,
        shareCount: posts.shareCount,
        metricCount: postMetricCount,
        lastSyncedAt: posts.lastSyncedAt,
        updatedAt: posts.updatedAt,
        videoId: posts.videoId,
      })
      .from(posts)
      .innerJoin(streamers, eq(posts.streamerId, streamers.id))
      .where(where)
      .orderBy(asc(posts.updatedAt), asc(posts.id))
      .limit(filters.limit)
      .offset(filters.offset),
    db
      .select({ value: count(), watermark: watermarkOf(posts.updatedAt) })
      .from(posts)
      .innerJoin(streamers, eq(posts.streamerId, streamers.id))
      .where(where),
  ]);

  return {
    total: totals[0]?.value ?? 0,
    maxWatermark: totals[0]?.watermark ?? null,
    rows: rows.map((row) => ({
      post_id: row.id,
      streamer_id: row.streamerId,
      streamer_code: row.streamerCode,
      streamer_name: row.streamerName,
      facebook_page_id: row.pageId,
      facebook_post_id: row.facebookPostId,
      message: row.message,
      created_time: toIso(row.createdTime),
      permalink_url: row.permalinkUrl,
      reactions: row.reactionCount,
      comments: row.commentCount,
      shares: row.shareCount,
      insight_metric_count: Number(row.metricCount ?? 0),
      last_synced_at: toIso(row.lastSyncedAt),
      updated_at: toIso(row.updatedAt),
      // Non-null on the feed story of a broadcast. See the contract for why
      // these rows stay in the tab rather than being filtered out of it.
      video_id: row.videoId,
    })),
  };
}

// ---------------------------------------------------------------------------
// post_insights
// ---------------------------------------------------------------------------

export async function exportPostInsights(
  filters: Filters,
): Promise<ExportPage<PostInsightExportRow>> {
  const db = getDb();

  const conditions: SQL[] = [];
  if (filters.streamer_id) conditions.push(eq(posts.streamerId, filters.streamer_id));
  if (filters.updated_after)
    conditions.push(newerThan(postInsights.collectedAt, filters.updated_after));
  // The window filters on the parent's publication date, not on when the metric
  // happened to be collected — "insights for July's posts" is the question a
  // report asks, and a re-sync must not move a post into a different month.
  if (filters.from) conditions.push(gte(posts.createdTime, filters.from));
  if (filters.to) conditions.push(lte(posts.createdTime, filters.to));

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, totals] = await Promise.all([
    db
      .select({
        id: postInsights.id,
        postId: postInsights.postId,
        streamerId: posts.streamerId,
        streamerCode: streamers.streamerCode,
        facebookPostId: posts.facebookPostId,
        metricName: postInsights.metricName,
        period: postInsights.period,
        value: postInsights.valueJson,
        endTime: postInsights.endTime,
        collectedAt: postInsights.collectedAt,
      })
      .from(postInsights)
      .innerJoin(posts, eq(postInsights.postId, posts.id))
      .innerJoin(streamers, eq(posts.streamerId, streamers.id))
      .where(where)
      .orderBy(asc(postInsights.collectedAt), asc(postInsights.id))
      .limit(filters.limit)
      .offset(filters.offset),
    db
      .select({ value: count(), watermark: watermarkOf(postInsights.collectedAt) })
      .from(postInsights)
      .innerJoin(posts, eq(postInsights.postId, posts.id))
      .innerJoin(streamers, eq(posts.streamerId, streamers.id))
      .where(where),
  ]);

  return {
    total: totals[0]?.value ?? 0,
    maxWatermark: totals[0]?.watermark ?? null,
    rows: rows.map((row) => ({
      insight_key: buildInsightKey({
        facebookContentId: row.facebookPostId,
        metricName: row.metricName,
        period: row.period,
        endTime: toIsoOrNull(row.endTime),
      }),
      post_insight_id: row.id,
      post_id: row.postId,
      streamer_id: row.streamerId,
      streamer_code: row.streamerCode,
      facebook_post_id: row.facebookPostId,
      metric_name: row.metricName,
      period: row.period,
      ...describeValue(row.value),
      end_time: toIsoOrNull(row.endTime),
      collected_at: toIso(row.collectedAt),
    })),
  };
}

// ---------------------------------------------------------------------------
// videos
// ---------------------------------------------------------------------------

const videoMetricCount = sql<number>`(
  select count(*)::int from ${videoInsights} where ${videoInsights.videoId} = ${videos.id}
)`;

export async function exportVideos(filters: Filters): Promise<ExportPage<VideoExportRow>> {
  const db = getDb();

  const conditions: SQL[] = [];
  if (filters.streamer_id) conditions.push(eq(videos.streamerId, filters.streamer_id));
  if (filters.updated_after) conditions.push(newerThan(videos.updatedAt, filters.updated_after));
  if (filters.from) conditions.push(gte(videos.createdTime, filters.from));
  if (filters.to) conditions.push(lte(videos.createdTime, filters.to));

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, totals] = await Promise.all([
    db
      .select({
        id: videos.id,
        streamerId: videos.streamerId,
        streamerCode: streamers.streamerCode,
        streamerName: streamers.streamerName,
        pageId: streamers.pageId,
        facebookVideoId: videos.facebookVideoId,
        title: videos.title,
        description: videos.description,
        lengthSeconds: videos.lengthSeconds,
        createdTime: videos.createdTime,
        permalinkUrl: videos.permalinkUrl,
        metricCount: videoMetricCount,
        lastSyncedAt: videos.lastSyncedAt,
        updatedAt: videos.updatedAt,
      })
      .from(videos)
      .innerJoin(streamers, eq(videos.streamerId, streamers.id))
      .where(where)
      .orderBy(asc(videos.updatedAt), asc(videos.id))
      .limit(filters.limit)
      .offset(filters.offset),
    db
      .select({ value: count(), watermark: watermarkOf(videos.updatedAt) })
      .from(videos)
      .innerJoin(streamers, eq(videos.streamerId, streamers.id))
      .where(where),
  ]);

  return {
    total: totals[0]?.value ?? 0,
    maxWatermark: totals[0]?.watermark ?? null,
    rows: rows.map((row) => ({
      video_id: row.id,
      streamer_id: row.streamerId,
      streamer_code: row.streamerCode,
      streamer_name: row.streamerName,
      facebook_page_id: row.pageId,
      facebook_video_id: row.facebookVideoId,
      title: row.title,
      description: row.description,
      length_seconds: row.lengthSeconds,
      created_time: toIso(row.createdTime),
      permalink_url: row.permalinkUrl,
      insight_metric_count: Number(row.metricCount ?? 0),
      last_synced_at: toIso(row.lastSyncedAt),
      updated_at: toIso(row.updatedAt),
    })),
  };
}

// ---------------------------------------------------------------------------
// video_insights
// ---------------------------------------------------------------------------

export async function exportVideoInsights(
  filters: Filters,
): Promise<ExportPage<VideoInsightExportRow>> {
  const db = getDb();

  const conditions: SQL[] = [];
  if (filters.streamer_id) conditions.push(eq(videos.streamerId, filters.streamer_id));
  if (filters.updated_after)
    conditions.push(newerThan(videoInsights.collectedAt, filters.updated_after));
  if (filters.from) conditions.push(gte(videos.createdTime, filters.from));
  if (filters.to) conditions.push(lte(videos.createdTime, filters.to));

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, totals] = await Promise.all([
    db
      .select({
        id: videoInsights.id,
        videoId: videoInsights.videoId,
        streamerId: videos.streamerId,
        streamerCode: streamers.streamerCode,
        facebookVideoId: videos.facebookVideoId,
        metricName: videoInsights.metricName,
        period: videoInsights.period,
        value: videoInsights.valueJson,
        endTime: videoInsights.endTime,
        collectedAt: videoInsights.collectedAt,
      })
      .from(videoInsights)
      .innerJoin(videos, eq(videoInsights.videoId, videos.id))
      .innerJoin(streamers, eq(videos.streamerId, streamers.id))
      .where(where)
      .orderBy(asc(videoInsights.collectedAt), asc(videoInsights.id))
      .limit(filters.limit)
      .offset(filters.offset),
    db
      .select({ value: count(), watermark: watermarkOf(videoInsights.collectedAt) })
      .from(videoInsights)
      .innerJoin(videos, eq(videoInsights.videoId, videos.id))
      .innerJoin(streamers, eq(videos.streamerId, streamers.id))
      .where(where),
  ]);

  return {
    total: totals[0]?.value ?? 0,
    maxWatermark: totals[0]?.watermark ?? null,
    rows: rows.map((row) => ({
      insight_key: buildInsightKey({
        facebookContentId: row.facebookVideoId,
        metricName: row.metricName,
        period: row.period,
        endTime: toIsoOrNull(row.endTime),
      }),
      video_insight_id: row.id,
      video_id: row.videoId,
      streamer_id: row.streamerId,
      streamer_code: row.streamerCode,
      facebook_video_id: row.facebookVideoId,
      metric_name: row.metricName,
      period: row.period,
      ...describeValue(row.value),
      end_time: toIsoOrNull(row.endTime),
      collected_at: toIso(row.collectedAt),
    })),
  };
}

// ---------------------------------------------------------------------------
// comment_summaries
// ---------------------------------------------------------------------------

type SummaryRow = {
  summary_id: string;
  streamer_id: string;
  streamer_code: string;
  streamer_name: string;
  content_type: string;
  content_id: string;
  facebook_content_id: string;
  content_title: string | null;
  content_created_time: Date;
  permalink_url: string | null;
  comments_analyzed: number;
  sentiment: string | null;
  summary: string | null;
  positive_points: unknown;
  concerns: unknown;
  suggestions: unknown;
  questions: unknown;
  urgent_issues: unknown;
  status: string;
  ai_provider: string | null;
  model: string | null;
  generated_at: Date | null;
  updated_at: Date;
};

/**
 * The summaries union.
 *
 * `comment_summaries` is polymorphic, so one reading list means one SQL
 * statement — paginating two halves separately and merging in memory would not
 * produce a correct page. Same reasoning as `repositories/analysis.ts`.
 */
function summarySource(filters: Filters): SQL {
  const branch = (kind: "post" | "video"): SQL => {
    const conditions: SQL[] = [
      kind === "post"
        ? sql`comment_summaries.post_id is not null`
        : sql`comment_summaries.video_id is not null`,
    ];

    if (filters.streamer_id) conditions.push(sql`streamers.id = ${filters.streamer_id}::uuid`);
    if (filters.updated_after) {
      conditions.push(sql`comment_summaries.updated_at > ${filters.updated_after}::timestamptz`);
    }

    if (kind === "post") {
      if (filters.from)
        conditions.push(sql`posts.created_time >= ${tsParam(filters.from)}::timestamptz`);
      if (filters.to)
        conditions.push(sql`posts.created_time <= ${tsParam(filters.to)}::timestamptz`);

      return sql`
        select
          comment_summaries.id                as summary_id,
          streamers.id                        as streamer_id,
          streamers.streamer_code             as streamer_code,
          streamers.streamer_name             as streamer_name,
          'post'::text                        as content_type,
          posts.id                            as content_id,
          posts.facebook_post_id              as facebook_content_id,
          posts.message                       as content_title,
          posts.created_time                  as content_created_time,
          posts.permalink_url                 as permalink_url,
          comment_summaries.comment_count     as comments_analyzed,
          comment_summaries.sentiment::text   as sentiment,
          comment_summaries.summary           as summary,
          comment_summaries.positive_points_json as positive_points,
          comment_summaries.concerns_json     as concerns,
          comment_summaries.suggestions_json  as suggestions,
          comment_summaries.questions_json    as questions,
          comment_summaries.urgent_issues_json as urgent_issues,
          comment_summaries.status::text      as status,
          comment_summaries.ai_provider       as ai_provider,
          comment_summaries.model             as model,
          comment_summaries.generated_at      as generated_at,
          comment_summaries.updated_at        as updated_at
        from ${commentSummaries}
        join ${posts} on posts.id = comment_summaries.post_id
        join ${streamers} on streamers.id = posts.streamer_id
        where ${sql.join(conditions, sql` and `)}
      `;
    }

    if (filters.from)
      conditions.push(sql`videos.created_time >= ${tsParam(filters.from)}::timestamptz`);
    if (filters.to)
      conditions.push(sql`videos.created_time <= ${tsParam(filters.to)}::timestamptz`);

    return sql`
      select
        comment_summaries.id                as summary_id,
        streamers.id                        as streamer_id,
        streamers.streamer_code             as streamer_code,
        streamers.streamer_name             as streamer_name,
        'video'::text                       as content_type,
        videos.id                           as content_id,
        videos.facebook_video_id            as facebook_content_id,
        coalesce(videos.title, videos.description) as content_title,
        videos.created_time                 as content_created_time,
        videos.permalink_url                as permalink_url,
        comment_summaries.comment_count     as comments_analyzed,
        comment_summaries.sentiment::text   as sentiment,
        comment_summaries.summary           as summary,
        comment_summaries.positive_points_json as positive_points,
        comment_summaries.concerns_json     as concerns,
        comment_summaries.suggestions_json  as suggestions,
        comment_summaries.questions_json    as questions,
        comment_summaries.urgent_issues_json as urgent_issues,
        comment_summaries.status::text      as status,
        comment_summaries.ai_provider       as ai_provider,
        comment_summaries.model             as model,
        comment_summaries.generated_at      as generated_at,
        comment_summaries.updated_at        as updated_at
      from ${commentSummaries}
      join ${videos} on videos.id = comment_summaries.video_id
      join ${streamers} on streamers.id = videos.streamer_id
      where ${sql.join(conditions, sql` and `)}
    `;
  };

  return sql`${branch("post")} union all ${branch("video")}`;
}

export async function exportCommentSummaries(
  filters: Filters,
): Promise<ExportPage<CommentSummaryExportRow>> {
  const db = getDb();
  const source = summarySource(filters);

  const [rows, totals] = await Promise.all([
    db.execute<SummaryRow>(sql`
      with unified as (${source})
      select * from unified
      order by updated_at asc, summary_id asc
      limit ${pageSize(filters.limit)} offset ${pageOffset(filters.offset)}
    `),
    db.execute<{ value: number; watermark: string | null }>(sql`
      with unified as (${source})
      select
        count(*)::int as value,
        to_char(max(updated_at) at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as watermark
      from unified
    `),
  ]);

  return {
    total: [...totals][0]?.value ?? 0,
    maxWatermark: [...totals][0]?.watermark ?? null,
    rows: [...rows].map((row) => ({
      summary_id: row.summary_id,
      streamer_id: row.streamer_id,
      streamer_code: row.streamer_code,
      streamer_name: row.streamer_name,
      content_type: row.content_type === "video" ? ("video" as const) : ("post" as const),
      content_id: row.content_id,
      facebook_content_id: row.facebook_content_id,
      content_title: row.content_title,
      content_created_time: toIso(new Date(row.content_created_time)),
      permalink_url: row.permalink_url,
      comments_analyzed: Number(row.comments_analyzed ?? 0),
      sentiment: row.sentiment,
      summary: row.summary,
      // The model writes `No significant findings` into an otherwise empty
      // list; exporting that as text would turn absence into a row of content.
      positive_points: joinFindings(row.positive_points),
      concerns: joinFindings(row.concerns),
      suggestions: joinFindings(row.suggestions),
      questions: joinFindings(row.questions),
      urgent_issues: joinFindings(row.urgent_issues),
      urgent_issue_count: countRealFindings(row.urgent_issues),
      status: row.status,
      ai_provider: row.ai_provider,
      model: row.model,
      generated_at: row.generated_at ? toIso(new Date(row.generated_at)) : null,
      updated_at: toIso(new Date(row.updated_at)),
    })),
  };
}

/** Re-exported so a test can assert the placeholder is never sent. */
export { NO_SIGNIFICANT_FINDINGS };

// ---------------------------------------------------------------------------
// Run status
// ---------------------------------------------------------------------------

export type SyncRunChild = {
  sync_run_id: string;
  streamer_id: string | null;
  streamer_code: string | null;
  sync_type: string;
  status: string;
  posts_processed: number;
  videos_processed: number;
  comments_processed: number;
  summaries_generated: number;
  started_at: string;
  completed_at: string | null;
  error_message: string | null;
};

export type SyncRunStatusView = SyncRunChild & {
  /** True once the run has reached a terminal state. */
  finished: boolean;
  duration_seconds: number | null;
  children: SyncRunChild[];
  /** Per-streamer detail recorded by the sweep, when this is a parent run. */
  streamers: unknown;
};

function toChild(row: {
  id: string;
  streamerId: string | null;
  streamerCode: string | null;
  syncType: string;
  status: string;
  postsProcessed: number;
  videosProcessed: number;
  commentsProcessed: number;
  summariesGenerated: number;
  startedAt: Date;
  completedAt: Date | null;
  errorMessage: string | null;
}): SyncRunChild {
  return {
    sync_run_id: row.id,
    streamer_id: row.streamerId,
    streamer_code: row.streamerCode,
    sync_type: row.syncType,
    status: row.status,
    posts_processed: row.postsProcessed,
    videos_processed: row.videosProcessed,
    comments_processed: row.commentsProcessed,
    summaries_generated: row.summariesGenerated,
    started_at: toIso(row.startedAt),
    completed_at: toIsoOrNull(row.completedAt),
    error_message: row.errorMessage ? sanitiseMessage(row.errorMessage) : null,
  };
}

const RUN_COLUMNS = {
  id: syncRuns.id,
  streamerId: syncRuns.streamerId,
  streamerCode: streamers.streamerCode,
  syncType: syncRuns.syncType,
  status: syncRuns.status,
  postsProcessed: syncRuns.postsProcessed,
  videosProcessed: syncRuns.videosProcessed,
  commentsProcessed: syncRuns.commentsProcessed,
  summariesGenerated: syncRuns.summariesGenerated,
  startedAt: syncRuns.startedAt,
  completedAt: syncRuns.completedAt,
  errorMessage: syncRuns.errorMessage,
} as const;

const TERMINAL_STATUSES = new Set(["succeeded", "partial", "failed"]);

/**
 * One run and everything it spawned, for the polling endpoint.
 *
 * A workflow holds one id — the parent — and needs to know when the whole sweep
 * is done. `finished` is derived from the parent's status rather than from the
 * children, because the parent is closed last: it is the only field that answers
 * "may I stop polling?" without a race.
 *
 * `error_details_json` is exposed only as the `streamers` array the sweep wrote
 * there, which is a list of per-streamer counters and sanitised messages. The
 * column can hold arbitrary structured detail from other run types, so nothing
 * else is passed through.
 */
export async function getSyncRunStatus(runId: string): Promise<SyncRunStatusView | null> {
  const db = getDb();

  const [run] = await db
    .select({ ...RUN_COLUMNS, details: syncRuns.errorDetailsJson })
    .from(syncRuns)
    .leftJoin(streamers, eq(syncRuns.streamerId, streamers.id))
    .where(eq(syncRuns.id, runId))
    .limit(1);

  if (!run) return null;

  const children = await db
    .select(RUN_COLUMNS)
    .from(syncRuns)
    .leftJoin(streamers, eq(syncRuns.streamerId, streamers.id))
    .where(eq(syncRuns.parentSyncRunId, runId))
    .orderBy(asc(syncRuns.startedAt), asc(syncRuns.id));

  const details = run.details;
  const streamerDetail =
    details !== null && typeof details === "object" && "streamers" in details
      ? (details as { streamers: unknown }).streamers
      : null;

  return {
    ...toChild(run),
    finished: TERMINAL_STATUSES.has(run.status),
    duration_seconds: run.completedAt
      ? Math.round(((run.completedAt.getTime() - run.startedAt.getTime()) / 1000) * 100) / 100
      : null,
    children: children.map(toChild),
    streamers: streamerDetail,
  };
}

// ---------------------------------------------------------------------------
// sync_logs
// ---------------------------------------------------------------------------

export async function exportSyncLogs(filters: Filters): Promise<ExportPage<SyncLogExportRow>> {
  const db = getDb();

  const conditions: SQL[] = [];
  if (filters.streamer_id) conditions.push(eq(syncRuns.streamerId, filters.streamer_id));
  // `started_at` is both the watermark and the content date for a run: when it
  // happened is the only date it has.
  if (filters.updated_after) conditions.push(newerThan(syncRuns.startedAt, filters.updated_after));
  if (filters.from) conditions.push(gte(syncRuns.startedAt, filters.from));
  if (filters.to) conditions.push(lte(syncRuns.startedAt, filters.to));

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, totals] = await Promise.all([
    db
      .select({
        id: syncRuns.id,
        parentSyncRunId: syncRuns.parentSyncRunId,
        streamerId: syncRuns.streamerId,
        streamerCode: streamers.streamerCode,
        syncType: syncRuns.syncType,
        status: syncRuns.status,
        postsProcessed: syncRuns.postsProcessed,
        videosProcessed: syncRuns.videosProcessed,
        commentsProcessed: syncRuns.commentsProcessed,
        summariesGenerated: syncRuns.summariesGenerated,
        startedAt: syncRuns.startedAt,
        completedAt: syncRuns.completedAt,
        errorMessage: syncRuns.errorMessage,
      })
      .from(syncRuns)
      // Left join: a roster-wide run has no streamer, and dropping those would
      // hide exactly the rows an automation dashboard is looking for.
      .leftJoin(streamers, eq(syncRuns.streamerId, streamers.id))
      .where(where)
      .orderBy(asc(syncRuns.startedAt), asc(syncRuns.id))
      .limit(filters.limit)
      .offset(filters.offset),
    db
      .select({ value: count(), watermark: watermarkOf(syncRuns.startedAt) })
      .from(syncRuns)
      .leftJoin(streamers, eq(syncRuns.streamerId, streamers.id))
      .where(where),
  ]);

  return {
    total: totals[0]?.value ?? 0,
    maxWatermark: totals[0]?.watermark ?? null,
    rows: rows.map((row) => ({
      sync_run_id: row.id,
      parent_sync_run_id: row.parentSyncRunId,
      streamer_id: row.streamerId,
      streamer_code: row.streamerCode,
      sync_type: row.syncType,
      status: row.status,
      posts_processed: row.postsProcessed,
      videos_processed: row.videosProcessed,
      comments_processed: row.commentsProcessed,
      summaries_generated: row.summariesGenerated,
      started_at: toIso(row.startedAt),
      completed_at: toIsoOrNull(row.completedAt),
      duration_seconds: row.completedAt
        ? Math.round(((row.completedAt.getTime() - row.startedAt.getTime()) / 1000) * 100) / 100
        : null,
      // `error_details_json` is deliberately NOT exported: it holds structured
      // failure detail meant for an operator reading the database, and an
      // automation payload is the wrong place for it.
      error_message: row.errorMessage ? sanitiseMessage(row.errorMessage) : null,
    })),
  };
}
