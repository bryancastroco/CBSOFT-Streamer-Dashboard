import "server-only";

import { and, desc, eq, isNull, sql, type SQL } from "drizzle-orm";

import { NO_SIGNIFICANT_FINDINGS } from "@/lib/ai/contract";
import { getDb } from "@/lib/db";
import { tsParam } from "@/lib/db/params";
import { commentSummaries, posts, streamers, videos } from "@/lib/db/schema";
import type { ContentScope } from "@/lib/filters/period";
import type { SentimentSlice, TimeSeriesPoint, TopStreamer } from "@/lib/ui/dashboard-shapes";
import { getDashboardMetrics, type DashboardMetrics, type MetricsFilters } from "./metrics";

/**
 * The queries behind the dashboard's sections.
 *
 * Aggregates that already existed live in `metrics.ts`; this adds the shapes
 * Phase 17 needs — a previous-period comparison, time series, distributions and
 * two short lists.
 *
 * ## What is deliberately absent
 *
 * No query here selects the stored token ciphertext, and no returned type has
 * a field that could carry one. Token health is reported as counts by status,
 * which is all the dashboard ever needs to say.
 *
 * ## Videos are not posts
 *
 * Posts carry `reaction_count`, `comment_count` and `share_count` as columns.
 * Videos do not — their engagement lives in `video_insights`, keyed by metric
 * name, and Meta does not report the same metrics for both. So the engagement
 * series is computed from posts alone and says so in the UI, rather than
 * silently summing two things that are not comparable. The volume series
 * counts both, because a count of items is comparable.
 */

export type { SentimentSlice, TimeSeriesPoint, TopStreamer };

export type Period = { from: Date | null; to: Date | null };

export type DashboardFilters = {
  streamerId?: string | undefined;
  period: Period;
  scope: ContentScope;
};

function streamerFilter(
  column: typeof posts.streamerId | typeof videos.streamerId,
  streamerId?: string,
) {
  return streamerId ? eq(column, streamerId) : undefined;
}

/*
 * Period bounds as a raw fragment with an explicit cast, matching
 * `metrics.ts`. `tsParam` hands Postgres an ISO string rather than a Date
 * because postgres.js under `prepare: false` cannot serialise a Date inside a
 * template — it throws ERR_INVALID_ARG_TYPE and takes the whole statement with
 * it. The cast is what makes the string a timestamptz again.
 */
function within(
  column: typeof posts.createdTime | typeof videos.createdTime,
  period: Period,
): SQL[] {
  const clauses: SQL[] = [];
  if (period.from) clauses.push(sql`${column} >= ${tsParam(period.from)}::timestamptz`);
  if (period.to) clauses.push(sql`${column} <= ${tsParam(period.to)}::timestamptz`);
  return clauses;
}

/**
 * The window immediately before this one, of the same length.
 *
 * Returns null when the current period is open-ended. "All time" has no
 * previous period, and inventing one — the preceding year, say — would produce
 * a comparison that looks authoritative and means nothing.
 */
export function previousPeriod(period: Period): Period | null {
  if (!period.from || !period.to) return null;

  const span = period.to.getTime() - period.from.getTime();
  if (span <= 0) return null;

  return {
    from: new Date(period.from.getTime() - span),
    to: new Date(period.from.getTime()),
  };
}

export type MetricsComparison = {
  current: DashboardMetrics;
  /** Null when the period is open-ended, so the cards hide the comparison. */
  previous: DashboardMetrics | null;
};

/**
 * Current and preceding window, from the same tested aggregate.
 *
 * Reusing `getDashboardMetrics` rather than writing a second set of sums keeps
 * the two halves of every comparison computed identically — a comparison
 * between two subtly different definitions is worse than no comparison.
 */
export async function getMetricsComparison(filters: DashboardFilters): Promise<MetricsComparison> {
  const base: MetricsFilters = {
    streamerId: filters.streamerId,
    scope: filters.scope,
  };

  const earlier = previousPeriod(filters.period);

  const [current, previous] = await Promise.all([
    getDashboardMetrics({ ...base, from: filters.period.from, to: filters.period.to }),
    earlier ? getDashboardMetrics({ ...base, from: earlier.from, to: earlier.to }) : null,
  ]);

  return { current, previous };
}

/**
 * Daily engagement and volume.
 *
 * Days with no content are absent rather than zero-filled. A gap in a line
 * chart reads as "nothing was published", which is true; a zero reads as
 * "published and nobody engaged", which is a different and usually false
 * claim.
 */
export async function getTimeSeries(filters: DashboardFilters): Promise<TimeSeriesPoint[]> {
  const db = getDb();
  const scope = filters.scope;
  const includePosts = scope === "all" || scope === "posts";
  const includeVideos = scope === "all" || scope === "videos";

  const postRows = includePosts
    ? await db
        .select({
          day: sql<string>`to_char(date_trunc('day', ${posts.createdTime}), 'YYYY-MM-DD')`,
          reactions: sql<number>`coalesce(sum(${posts.reactionCount}), 0)::int`,
          comments: sql<number>`coalesce(sum(${posts.commentCount}), 0)::int`,
          shares: sql<number>`coalesce(sum(${posts.shareCount}), 0)::int`,
          count: sql<number>`count(*)::int`,
        })
        .from(posts)
        .where(
          and(
            streamerFilter(posts.streamerId, filters.streamerId),
            ...within(posts.createdTime, filters.period),
          ),
        )
        .groupBy(sql`date_trunc('day', ${posts.createdTime})`)
    : [];

  const videoRows = includeVideos
    ? await db
        .select({
          day: sql<string>`to_char(date_trunc('day', ${videos.createdTime}), 'YYYY-MM-DD')`,
          count: sql<number>`count(*)::int`,
        })
        .from(videos)
        .where(
          and(
            streamerFilter(videos.streamerId, filters.streamerId),
            ...within(videos.createdTime, filters.period),
          ),
        )
        .groupBy(sql`date_trunc('day', ${videos.createdTime})`)
    : [];

  const byDay = new Map<string, TimeSeriesPoint>();

  for (const row of postRows) {
    byDay.set(row.day, {
      day: row.day,
      reactions: row.reactions,
      comments: row.comments,
      shares: row.shares,
      postCount: row.count,
      videoCount: 0,
    });
  }

  for (const row of videoRows) {
    const existing = byDay.get(row.day);
    if (existing) existing.videoCount = row.count;
    else
      byDay.set(row.day, {
        day: row.day,
        reactions: 0,
        comments: 0,
        shares: 0,
        postCount: 0,
        videoCount: row.count,
      });
  }

  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

/**
 * Streamers ranked by post engagement in the window.
 *
 * Posts only, for the reason given at the top of this file. Limited to a
 * handful: a bar chart of forty streamers is a wall, not a finding.
 */
export async function getTopStreamers(
  filters: DashboardFilters,
  limit = 6,
): Promise<TopStreamer[]> {
  const db = getDb();

  const rows = await db
    .select({
      streamerId: streamers.id,
      streamerName: streamers.streamerName,
      streamerCode: streamers.streamerCode,
      reactions: sql<number>`coalesce(sum(${posts.reactionCount}), 0)::int`,
      comments: sql<number>`coalesce(sum(${posts.commentCount}), 0)::int`,
      shares: sql<number>`coalesce(sum(${posts.shareCount}), 0)::int`,
      postCount: sql<number>`count(${posts.id})::int`,
    })
    .from(posts)
    .innerJoin(streamers, eq(streamers.id, posts.streamerId))
    .where(
      and(
        isNull(streamers.deletedAt),
        streamerFilter(posts.streamerId, filters.streamerId),
        ...within(posts.createdTime, filters.period),
      ),
    )
    .groupBy(streamers.id, streamers.streamerName, streamers.streamerCode)
    .orderBy(
      desc(
        sql`coalesce(sum(${posts.reactionCount}), 0) + coalesce(sum(${posts.commentCount}), 0) + coalesce(sum(${posts.shareCount}), 0)`,
      ),
    )
    .limit(limit);

  return rows;
}

/** Sentiment distribution across analysed content in the window. */
export async function getSentimentDistribution(
  filters: DashboardFilters,
): Promise<SentimentSlice[]> {
  const db = getDb();

  const rows = await db
    .select({
      sentiment: sql<string>`coalesce(${commentSummaries.sentiment}::text, 'no_comments')`,
      count: sql<number>`count(*)::int`,
    })
    .from(commentSummaries)
    .where(and(...summaryScopeClauses(filters)))
    .groupBy(sql`coalesce(${commentSummaries.sentiment}::text, 'no_comments')`);

  return rows;
}

/**
 * Scope a comment-summary query by streamer, period and content type.
 *
 * A summary reaches its streamer through whichever of `post_id` or `video_id`
 * is set, so the filters are expressed as existence checks rather than a join
 * — a join on both would multiply rows.
 */
function summaryScopeClauses(filters: DashboardFilters): SQL[] {
  const clauses: SQL[] = [];
  const { streamerId, period, scope } = filters;

  const postMatch = sql`exists (
    select 1 from ${posts} p
     where p.id = ${commentSummaries.postId}
       ${streamerId ? sql`and p.streamer_id = ${streamerId}` : sql``}
       ${period.from ? sql`and p.created_time >= ${tsParam(period.from)}::timestamptz` : sql``}
       ${period.to ? sql`and p.created_time <= ${tsParam(period.to)}::timestamptz` : sql``}
  )`;

  const videoMatch = sql`exists (
    select 1 from ${videos} v
     where v.id = ${commentSummaries.videoId}
       ${streamerId ? sql`and v.streamer_id = ${streamerId}` : sql``}
       ${period.from ? sql`and v.created_time >= ${tsParam(period.from)}::timestamptz` : sql``}
       ${period.to ? sql`and v.created_time <= ${tsParam(period.to)}::timestamptz` : sql``}
  )`;

  if (scope === "posts") clauses.push(postMatch);
  else if (scope === "videos") clauses.push(videoMatch);
  else clauses.push(sql`(${postMatch} or ${videoMatch})`);

  return clauses;
}

export type TokenHealthCounts = Record<string, number>;

/**
 * Streamers grouped by token status.
 *
 * Counts only. The status is the whole point — a dashboard never needs the
 * secret itself, and not selecting it means no future edit can expose one
 * through this path.
 */
export async function getTokenHealth(): Promise<TokenHealthCounts> {
  const db = getDb();

  const rows = await db
    .select({
      status: sql<string>`${streamers.tokenStatus}::text`,
      count: sql<number>`count(*)::int`,
    })
    .from(streamers)
    .where(and(isNull(streamers.deletedAt), eq(streamers.active, true)))
    .groupBy(streamers.tokenStatus);

  return Object.fromEntries(rows.map((row) => [row.status, row.count]));
}

export type RecentContentRow = {
  id: string;
  contentType: "post" | "video";
  streamerId: string;
  streamerName: string;
  preview: string | null;
  permalinkUrl: string | null;
  createdTime: Date;
  reactions: number | null;
  comments: number | null;
  shares: number | null;
  sentiment: string | null;
  summaryStatus: string | null;
};

/**
 * Newest posts and videos together, newest first.
 *
 * Video engagement columns come back null rather than zero. Videos genuinely
 * do not carry these figures — the metrics Meta reports for a video are a
 * different set — and a zero would read as "nobody reacted".
 */
export async function listRecentContent(
  filters: DashboardFilters,
  limit = 8,
): Promise<RecentContentRow[]> {
  const db = getDb();
  const scope = filters.scope;

  const postRows =
    scope === "videos"
      ? []
      : await db
          .select({
            id: posts.id,
            streamerId: posts.streamerId,
            streamerName: streamers.streamerName,
            preview: posts.message,
            permalinkUrl: posts.permalinkUrl,
            createdTime: posts.createdTime,
            reactions: posts.reactionCount,
            comments: posts.commentCount,
            shares: posts.shareCount,
            sentiment: sql<string | null>`${commentSummaries.sentiment}::text`,
            summaryStatus: sql<string | null>`${commentSummaries.status}::text`,
          })
          .from(posts)
          .innerJoin(streamers, eq(streamers.id, posts.streamerId))
          .leftJoin(commentSummaries, eq(commentSummaries.postId, posts.id))
          .where(
            and(
              isNull(streamers.deletedAt),
              streamerFilter(posts.streamerId, filters.streamerId),
              ...within(posts.createdTime, filters.period),
            ),
          )
          .orderBy(desc(posts.createdTime))
          .limit(limit);

  const videoRows =
    scope === "posts"
      ? []
      : await db
          .select({
            id: videos.id,
            streamerId: videos.streamerId,
            streamerName: streamers.streamerName,
            preview: videos.title,
            permalinkUrl: videos.permalinkUrl,
            createdTime: videos.createdTime,
            sentiment: sql<string | null>`${commentSummaries.sentiment}::text`,
            summaryStatus: sql<string | null>`${commentSummaries.status}::text`,
          })
          .from(videos)
          .innerJoin(streamers, eq(streamers.id, videos.streamerId))
          .leftJoin(commentSummaries, eq(commentSummaries.videoId, videos.id))
          .where(
            and(
              isNull(streamers.deletedAt),
              streamerFilter(videos.streamerId, filters.streamerId),
              ...within(videos.createdTime, filters.period),
            ),
          )
          .orderBy(desc(videos.createdTime))
          .limit(limit);

  const combined: RecentContentRow[] = [
    ...postRows.map((row) => ({ ...row, contentType: "post" as const })),
    ...videoRows.map((row) => ({
      ...row,
      contentType: "video" as const,
      reactions: null,
      comments: null,
      shares: null,
    })),
  ];

  return combined.sort((a, b) => b.createdTime.getTime() - a.createdTime.getTime()).slice(0, limit);
}

export type UrgentIssueRow = {
  summaryId: string;
  contentType: "post" | "video";
  contentId: string | null;
  streamerName: string | null;
  preview: string | null;
  issues: string[];
  sentiment: string | null;
  commentCount: number;
  detectedAt: Date | null;
};

/**
 * Content the model flagged as needing attention.
 *
 * The placeholder the model writes into an otherwise empty list is filtered
 * out in SQL, matching `metrics.ts`. Counting array length instead would mark
 * every analysed item urgent, which is how an alert list becomes noise nobody
 * reads.
 */
export async function listUrgentIssues(
  filters: DashboardFilters,
  limit = 6,
): Promise<UrgentIssueRow[]> {
  const db = getDb();

  const rows = await db
    .select({
      summaryId: commentSummaries.id,
      contentType: sql<"post" | "video">`${commentSummaries.contentType}::text`,
      postId: commentSummaries.postId,
      videoId: commentSummaries.videoId,
      issuesJson: commentSummaries.urgentIssuesJson,
      sentiment: sql<string | null>`${commentSummaries.sentiment}::text`,
      commentCount: commentSummaries.commentCount,
      detectedAt: commentSummaries.generatedAt,
      postPreview: posts.message,
      videoPreview: videos.title,
      postStreamer: sql<string | null>`ps.streamer_name`,
      videoStreamer: sql<string | null>`vs.streamer_name`,
    })
    .from(commentSummaries)
    .leftJoin(posts, eq(posts.id, commentSummaries.postId))
    .leftJoin(videos, eq(videos.id, commentSummaries.videoId))
    .leftJoin(sql`${streamers} ps`, sql`ps.id = ${posts.streamerId}`)
    .leftJoin(sql`${streamers} vs`, sql`vs.id = ${videos.streamerId}`)
    .where(
      and(
        sql`jsonb_typeof(${commentSummaries.urgentIssuesJson}) = 'array'
            and exists (
              select 1 from jsonb_array_elements_text(${commentSummaries.urgentIssuesJson}) as issue
               where issue <> ${NO_SIGNIFICANT_FINDINGS}
            )`,
        ...summaryScopeClauses(filters),
      ),
    )
    .orderBy(desc(commentSummaries.generatedAt))
    .limit(limit);

  return rows.map((row) => {
    const raw = Array.isArray(row.issuesJson) ? (row.issuesJson as unknown[]) : [];
    const issues = raw
      .filter((issue): issue is string => typeof issue === "string")
      .filter((issue) => issue !== NO_SIGNIFICANT_FINDINGS);

    return {
      summaryId: row.summaryId,
      contentType: row.contentType,
      contentId: row.postId ?? row.videoId,
      streamerName: row.postStreamer ?? row.videoStreamer,
      preview: row.postPreview ?? row.videoPreview,
      issues,
      sentiment: row.sentiment,
      commentCount: row.commentCount ?? 0,
      detectedAt: row.detectedAt,
    };
  });
}
