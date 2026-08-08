import "server-only";

import { and, desc, eq, isNull, sql, type SQL } from "drizzle-orm";

import { NO_SIGNIFICANT_FINDINGS } from "@/lib/ai/contract";
import { getDb } from "@/lib/db";
import { excludeFeedStories, mediaKindClause } from "@/lib/db/content-kind";
import { displayDayText, displayDay } from "@/lib/db/display-day";
import { gameClause } from "@/lib/db/game-filter";
import { resultRows, tsParam } from "@/lib/db/params";
import {
  commentSummaries,
  contentMetricsCurrent,
  pageMetricsDaily,
  posts,
  streamers,
  videos,
} from "@/lib/db/schema";
import {
  scopeIncludesPosts,
  scopeIncludesVideos,
  type ContentScope,
} from "@/lib/filters/period";
import { toDisplayIsoDate as toIsoDate } from "@/lib/time/zone";
import type {
  SentimentSlice,
  StreamerTotals,
  TimeSeriesPoint,
} from "@/lib/ui/dashboard-shapes";
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

export type { SentimentSlice, StreamerTotals, TimeSeriesPoint };

export type Period = { from: Date | null; to: Date | null };

export type DashboardFilters = {
  streamerId?: string | undefined;
  /** A game id, or `ANY_GAME` / `UNFILED_GAME`. See `gameClause`. */
  gameId?: string | undefined;
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
 * Streamer, game and period for one content table, in one place.
 *
 * Every query below scopes the same three ways, and each was previously
 * spelling that out inline. Collecting it means a fourth filter cannot be added
 * to five of six queries — which is a silent wrong answer, not an error.
 */
function contentScope(
  table: typeof posts | typeof videos,
  filters: DashboardFilters,
): (SQL | undefined)[] {
  const shared = [
    streamerFilter(table.streamerId, filters.streamerId),
    gameClause(table.gameId, filters.gameId),
    ...within(table.createdTime, filters.period),
  ];

  /*
   * The kind predicate belongs here rather than at each call site, for the same
   * reason the three above do: a query that forgets it returns plausible rows.
   */
  return table === posts
    ? [...shared, excludeFeedStories(posts.videoId)]
    : [...shared, mediaKindClause(videos.mediaKind, filters.scope)];
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
    gameId: filters.gameId,
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
 *
 * ## Which day a post falls on
 *
 * The display zone's, matching what every table prints beside the same post.
 * `date_trunc` on a `timestamptz` buckets by the session zone — UTC here — so
 * a 07:00 post would have been labelled 7 August in the table and counted
 * under 6 August in the bar beside it. Nobody would report that as a bug; they
 * would just quietly stop trusting the chart.
 */
export async function getTimeSeries(filters: DashboardFilters): Promise<TimeSeriesPoint[]> {
  const db = getDb();
  const scope = filters.scope;
  const includePosts = scopeIncludesPosts(scope);
  const includeVideos = scopeIncludesVideos(scope);

  const postRows = includePosts
    ? await db
        .select({
          day: displayDayText(posts.createdTime),
          reactions: sql<number>`coalesce(sum(${posts.reactionCount}), 0)::int`,
          comments: sql<number>`coalesce(sum(${posts.commentCount}), 0)::int`,
          shares: sql<number>`coalesce(sum(${posts.shareCount}), 0)::int`,
          count: sql<number>`count(*)::int`,
        })
        .from(posts)
        .where(and(...contentScope(posts, filters)))
        .groupBy(displayDay(posts.createdTime))
    : [];

  const videoRows = includeVideos
    ? await db
        .select({
          day: displayDayText(videos.createdTime),
          count: sql<number>`count(*)::int`,
        })
        .from(videos)
        .where(and(...contentScope(videos, filters)))
        .groupBy(displayDay(videos.createdTime))
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

  const postGame = gameClause(sql`p.game_id`, filters.gameId);
  const videoGame = gameClause(sql`v.game_id`, filters.gameId);
  const videoKind = mediaKindClause(sql`v.media_kind`, scope);

  const postMatch = sql`exists (
    select 1 from ${posts} p
     where p.id = ${commentSummaries.postId}
       and p.video_id is null
       ${streamerId ? sql`and p.streamer_id = ${streamerId}` : sql``}
       ${postGame ? sql`and ${postGame}` : sql``}
       ${period.from ? sql`and p.created_time >= ${tsParam(period.from)}::timestamptz` : sql``}
       ${period.to ? sql`and p.created_time <= ${tsParam(period.to)}::timestamptz` : sql``}
  )`;

  const videoMatch = sql`exists (
    select 1 from ${videos} v
     where v.id = ${commentSummaries.videoId}
       ${videoKind ? sql`and ${videoKind}` : sql``}
       ${streamerId ? sql`and v.streamer_id = ${streamerId}` : sql``}
       ${videoGame ? sql`and ${videoGame}` : sql``}
       ${period.from ? sql`and v.created_time >= ${tsParam(period.from)}::timestamptz` : sql``}
       ${period.to ? sql`and v.created_time <= ${tsParam(period.to)}::timestamptz` : sql``}
  )`;

  const wantsPosts = scopeIncludesPosts(scope);
  const wantsVideos = scopeIncludesVideos(scope);

  if (wantsPosts && wantsVideos) clauses.push(sql`(${postMatch} or ${videoMatch})`);
  else if (wantsPosts) clauses.push(postMatch);
  else clauses.push(videoMatch);

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
    !scopeIncludesPosts(scope)
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
          .where(and(isNull(streamers.deletedAt), ...contentScope(posts, filters)))
          .orderBy(desc(posts.createdTime))
          .limit(limit);

  const videoRows =
    !scopeIncludesVideos(scope)
      ? []
      : await db
          .select({
            id: videos.id,
            streamerId: videos.streamerId,
            streamerName: streamers.streamerName,
            /*
             * Meta leaves `title` null on these, so the description is the
             * only text there is. The videos list already falls back this way;
             * without it every video rendered as "No text" on the dashboard
             * while showing a title one page over.
             */
            preview: sql<string | null>`coalesce(${videos.title}, ${videos.description})`,
            permalinkUrl: videos.permalinkUrl,
            createdTime: videos.createdTime,
            sentiment: sql<string | null>`${commentSummaries.sentiment}::text`,
            summaryStatus: sql<string | null>`${commentSummaries.status}::text`,
          })
          .from(videos)
          .innerJoin(streamers, eq(streamers.id, videos.streamerId))
          .leftJoin(commentSummaries, eq(commentSummaries.videoId, videos.id))
          .where(and(isNull(streamers.deletedAt), ...contentScope(videos, filters)))
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

/**
 * Per-streamer totals for every leaderboard on the dashboard.
 *
 * ## Three passes, not one join
 *
 * Posts, videos and canonical metrics each have their own row-per-item, so
 * joining them would multiply rows and make every sum wrong by whatever the
 * other tables happened to contain. They are counted separately and merged by
 * streamer id, which is arithmetic nobody can get subtly wrong.
 *
 * ## Why engagement comes from posts and views from metrics
 *
 * Because that is where the cards get them. Reactions, comments and shares are
 * columns on `posts`, and taking them from `content_metrics_current` instead
 * would produce leaderboards that quietly disagree with the totals above them
 * on the same screen — two numbers for one thing is worse than one number with
 * a caveat.
 *
 * `views` has no equivalent column and exists only in canonical metrics, which
 * is also the one source spanning posts and videos. It is therefore the single
 * figure here that includes video performance.
 */
export async function getStreamerTotals(filters: DashboardFilters): Promise<StreamerTotals[]> {
  const db = getDb();

  const [postRows, videoRows, metricRows, growthRows] = await Promise.all([
    db
      .select({
        streamerId: streamers.id,
        streamerName: streamers.streamerName,
        streamerCode: streamers.streamerCode,
        postCount: sql<number>`count(${posts.id})::int`,
        reactions: sql<number>`coalesce(sum(${posts.reactionCount}), 0)::int`,
        comments: sql<number>`coalesce(sum(${posts.commentCount}), 0)::int`,
        shares: sql<number>`coalesce(sum(${posts.shareCount}), 0)::int`,
      })
      .from(posts)
      .innerJoin(streamers, eq(streamers.id, posts.streamerId))
      .where(and(isNull(streamers.deletedAt), ...contentScope(posts, filters)))
      .groupBy(streamers.id, streamers.streamerName, streamers.streamerCode),

    db
      .select({
        streamerId: streamers.id,
        streamerName: streamers.streamerName,
        streamerCode: streamers.streamerCode,
        videoCount: sql<number>`count(*) filter (where ${videos.mediaKind} = 'video')::int`,
        livestreamCount: sql<number>`count(*) filter (where ${videos.mediaKind} = 'livestream')::int`,
      })
      .from(videos)
      .innerJoin(streamers, eq(streamers.id, videos.streamerId))
      .where(and(isNull(streamers.deletedAt), ...contentScope(videos, filters)))
      .groupBy(streamers.id, streamers.streamerName, streamers.streamerCode),

    db
      .select({
        streamerId: streamers.id,
        streamerName: streamers.streamerName,
        streamerCode: streamers.streamerCode,
        views: sql<number>`coalesce(sum(${contentMetricsCurrent.views}), 0)::int`,
      })
      .from(contentMetricsCurrent)
      .innerJoin(streamers, eq(streamers.id, contentMetricsCurrent.streamerId))
      .leftJoin(posts, eq(posts.id, contentMetricsCurrent.postId))
      .leftJoin(videos, eq(videos.id, contentMetricsCurrent.videoId))
      .where(and(isNull(streamers.deletedAt), ...metricScope(filters)))
      .groupBy(streamers.id, streamers.streamerName, streamers.streamerCode),

    /*
     * Net follower change: the last known count in the window minus the first.
     *
     * `array_agg … filter` rather than min/max, because the smallest follower
     * count is not the earliest one — a Page that lost followers and recovered
     * would report growth from its trough. Days Meta did not report are skipped
     * rather than read as zero, which would show a collapse and a recovery that
     * never happened.
     *
     * No game or content predicate. Followers belong to the Page, so no filter
     * over content can narrow them, and applying one would produce a figure
     * that looks filtered and is not.
     */
    db.execute<{
      streamer_id: string;
      streamer_name: string;
      streamer_code: string;
      growth: number | null;
    }>(sql`
      select s.id as streamer_id,
             s.streamer_name,
             s.streamer_code,
             (array_agg(d.followers order by d.metric_date desc)
                filter (where d.followers is not null))[1]
             - (array_agg(d.followers order by d.metric_date asc)
                filter (where d.followers is not null))[1] as growth
        from ${pageMetricsDaily} d
        join ${streamers} s on s.id = d.streamer_id
       where s.deleted_at is null
         ${filters.streamerId ? sql`and d.streamer_id = ${filters.streamerId}` : sql``}
         ${filters.period.from ? sql`and d.metric_date >= ${toIsoDate(filters.period.from)}::date` : sql``}
         ${filters.period.to ? sql`and d.metric_date <= ${toIsoDate(filters.period.to)}::date` : sql``}
       group by s.id, s.streamer_name, s.streamer_code
    `),
  ]);

  const byStreamer = new Map<string, StreamerTotals>();

  const seat = (row: { streamerId: string; streamerName: string; streamerCode: string }) => {
    const existing = byStreamer.get(row.streamerId);
    if (existing) return existing;

    const created: StreamerTotals = {
      streamerId: row.streamerId,
      streamerName: row.streamerName,
      streamerCode: row.streamerCode,
      followerGrowth: 0,
      postCount: 0,
      videoCount: 0,
      livestreamCount: 0,
      views: 0,
      reactions: 0,
      comments: 0,
      shares: 0,
    };
    byStreamer.set(row.streamerId, created);
    return created;
  };

  for (const row of postRows) {
    const total = seat(row);
    total.postCount = row.postCount;
    total.reactions = row.reactions;
    total.comments = row.comments;
    total.shares = row.shares;
  }

  for (const row of videoRows) {
    const total = seat(row);
    total.videoCount = row.videoCount;
    total.livestreamCount = row.livestreamCount;
  }

  for (const row of metricRows) {
    seat(row).views = row.views;
  }

  for (const row of resultRows<{
    streamer_id: string;
    streamer_name: string;
    streamer_code: string;
    growth: number | null;
  }>(growthRows)) {
    seat({
      streamerId: row.streamer_id,
      streamerName: row.streamer_name,
      streamerCode: row.streamer_code,
    }).followerGrowth = Number(row.growth ?? 0);
  }

  return [...byStreamer.values()];
}

/**
 * Period, streamer and game predicates for a canonical metrics row.
 *
 * The row carries no publication time or attribution of its own — both come
 * from whichever content table it points at, which is why this reaches through
 * the joins rather than filtering the metrics table directly.
 */
function metricScope(filters: DashboardFilters): (SQL | undefined)[] {
  const published = sql`coalesce(${posts.createdTime}, ${videos.createdTime})`;

  return [
    filters.streamerId ? eq(contentMetricsCurrent.streamerId, filters.streamerId) : undefined,
    gameClause(sql`coalesce(${posts.gameId}, ${videos.gameId})`, filters.gameId),
    // The feed story of a broadcast carries a metrics row that duplicates the
    // video's. Counting both would rank a livestreaming Page twice as high.
    sql`(${posts.videoId} is null or ${posts.id} is null)`,
    mediaKindClause(videos.mediaKind, filters.scope),
    filters.period.from
      ? sql`${published} >= ${tsParam(filters.period.from)}::timestamptz`
      : undefined,
    filters.period.to ? sql`${published} <= ${tsParam(filters.period.to)}::timestamptz` : undefined,
  ];
}
