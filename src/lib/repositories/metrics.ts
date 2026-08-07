import "server-only";

import { and, eq, isNull, sql, type SQL } from "drizzle-orm";

import { NO_SIGNIFICANT_FINDINGS } from "@/lib/ai/contract";
import { getDb } from "@/lib/db";
import { gameClause, streamerGameClause } from "@/lib/db/game-filter";
import { resultRows, tsParam, tsResult } from "@/lib/db/params";
import {
  commentSummaries,
  comments,
  games,
  posts,
  streamerGames,
  streamers,
  videos,
} from "@/lib/db/schema";
import type { ContentScope } from "@/lib/filters/period";
import { scopeIncludesPosts, scopeIncludesVideos } from "@/lib/filters/period";

/**
 * Dashboard aggregates.
 *
 * Read-only, service-role, and safe for any signed-in user: everything counted
 * here is post and video engagement, which is public on Facebook. No query in
 * this file selects the stored token ciphertext, and no returned shape has a
 * field capable of holding one — token health is reported only as counts by
 * status.
 *
 * ## Sums and the missing-is-never-zero rule
 *
 * `sum(reaction_count)` silently skips nulls, which would report "1,000
 * reactions" for a window where half the posts never reported a figure — an
 * understatement dressed up as a total. Every engagement total therefore comes
 * back as a `MetricTotal` carrying both the sum and how many rows had nothing
 * to contribute, so the card can say so instead of implying zero.
 */

export type MetricTotal = {
  /** Sum over rows that reported a figure. Null when none did. */
  total: number | null;
  /** Rows that reported a figure. */
  reported: number;
  /** Rows where Meta reported nothing — excluded from `total`, never as zero. */
  notReported: number;
};

export type DashboardMetrics = {
  /** Roster state: current, deliberately not period-scoped. */
  activeStreamers: number;
  validTokens: number;
  tokensNeedingAttention: number;
  /** Period- and filter-scoped. */
  postsCollected: number;
  videosCollected: number;
  totalReactions: MetricTotal;
  totalComments: MetricTotal;
  totalShares: MetricTotal;
  summariesGenerated: number;
  urgentIssues: number;
};

export type MetricsFilters = {
  streamerId?: string | undefined;
  /** A game id, or `ANY_GAME` / `UNFILED_GAME`. See `gameClause`. */
  gameId?: string | undefined;
  from?: Date | null;
  to?: Date | null;
  scope?: ContentScope;
};

/**
 * True when a summary holds at least one real urgent issue.
 *
 * The model writes the placeholder `No significant findings` into an otherwise
 * empty list, so a non-empty array is not the same as a finding — counting array
 * length would report every analysed item as urgent.
 */
export const hasUrgentIssue = sql`
  jsonb_typeof(${commentSummaries.urgentIssuesJson}) = 'array'
  and exists (
    select 1
    from jsonb_array_elements_text(${commentSummaries.urgentIssuesJson}) as issue
    where btrim(issue) <> '' and btrim(issue) <> ${NO_SIGNIFICANT_FINDINGS}
  )
`;

const EMPTY_TOTAL: MetricTotal = { total: null, reported: 0, notReported: 0 };

/**
 * `sum(bigint)` arrives from postgres.js as a string. Number is safe here —
 * engagement counts are many orders of magnitude below 2^53.
 */
function toTotal(sum: string | number | null, reported: number, missing: number): MetricTotal {
  if (sum === null) return { total: null, reported, notReported: missing };
  const value = Number(sum);
  return {
    total: Number.isFinite(value) ? value : null,
    reported,
    notReported: missing,
  };
}

function postWindow(filters: MetricsFilters): SQL[] {
  const conditions: SQL[] = [];
  if (filters.streamerId) conditions.push(eq(posts.streamerId, filters.streamerId));
  const game = gameClause(posts.gameId, filters.gameId);
  if (game) conditions.push(game);
  if (filters.from)
    conditions.push(sql`${posts.createdTime} >= ${tsParam(filters.from)}::timestamptz`);
  if (filters.to) conditions.push(sql`${posts.createdTime} <= ${tsParam(filters.to)}::timestamptz`);
  return conditions;
}

function videoWindow(filters: MetricsFilters): SQL[] {
  const conditions: SQL[] = [];
  if (filters.streamerId) conditions.push(eq(videos.streamerId, filters.streamerId));
  const game = gameClause(videos.gameId, filters.gameId);
  if (game) conditions.push(game);
  if (filters.from)
    conditions.push(sql`${videos.createdTime} >= ${tsParam(filters.from)}::timestamptz`);
  if (filters.to)
    conditions.push(sql`${videos.createdTime} <= ${tsParam(filters.to)}::timestamptz`);
  return conditions;
}

function whereOf(conditions: SQL[]): SQL | undefined {
  return conditions.length > 0 ? and(...conditions) : undefined;
}

/** Engagement aggregate over `posts`. One pass, one row. */
async function aggregatePosts(filters: MetricsFilters) {
  const db = getDb();

  const [row] = await db
    .select({
      rows: sql<number>`count(*)::int`,
      latest: sql<string | null>`max(${posts.createdTime})`,
      reactionsSum: sql<string | null>`sum(${posts.reactionCount})`,
      reactionsReported: sql<number>`count(${posts.reactionCount})::int`,
      reactionsMissing: sql<number>`(count(*) - count(${posts.reactionCount}))::int`,
      commentsSum: sql<string | null>`sum(${posts.commentCount})`,
      commentsReported: sql<number>`count(${posts.commentCount})::int`,
      commentsMissing: sql<number>`(count(*) - count(${posts.commentCount}))::int`,
      sharesSum: sql<string | null>`sum(${posts.shareCount})`,
      sharesReported: sql<number>`count(${posts.shareCount})::int`,
      sharesMissing: sql<number>`(count(*) - count(${posts.shareCount}))::int`,
    })
    .from(posts)
    .where(whereOf(postWindow(filters)));

  return {
    rows: row?.rows ?? 0,
    latest: tsResult(row?.latest),
    reactions: row
      ? toTotal(row.reactionsSum, row.reactionsReported, row.reactionsMissing)
      : EMPTY_TOTAL,
    comments: row
      ? toTotal(row.commentsSum, row.commentsReported, row.commentsMissing)
      : EMPTY_TOTAL,
    shares: row ? toTotal(row.sharesSum, row.sharesReported, row.sharesMissing) : EMPTY_TOTAL,
  };
}

async function aggregateVideos(filters: MetricsFilters) {
  const db = getDb();

  const [row] = await db
    .select({
      rows: sql<number>`count(*)::int`,
      latest: sql<string | null>`max(${videos.createdTime})`,
    })
    .from(videos)
    .where(whereOf(videoWindow(filters)));

  return { rows: row?.rows ?? 0, latest: tsResult(row?.latest) };
}

/**
 * Count summaries and urgent findings across both content types.
 *
 * A summary is scoped by its parent's `created_time`, not by when the analysis
 * ran: the reader asked "what happened in this window?", and regenerating a
 * summary today must not move last month's post into this month.
 */
async function countSummaries(
  filters: MetricsFilters & { scope: ContentScope },
): Promise<{ generated: number; urgent: number }> {
  const db = getDb();
  const includePosts = scopeIncludesPosts(filters.scope);
  const includeVideos = scopeIncludesVideos(filters.scope);

  const columns = {
    generated: sql<number>`count(*) filter (where ${commentSummaries.status} = 'completed')::int`,
    urgent: sql<number>`count(*) filter (where ${hasUrgentIssue})::int`,
  };

  const [fromPosts, fromVideos] = await Promise.all([
    includePosts
      ? db
          .select(columns)
          .from(commentSummaries)
          .innerJoin(posts, eq(commentSummaries.postId, posts.id))
          .where(whereOf(postWindow(filters)))
      : Promise.resolve([]),

    includeVideos
      ? db
          .select(columns)
          .from(commentSummaries)
          .innerJoin(videos, eq(commentSummaries.videoId, videos.id))
          .where(whereOf(videoWindow(filters)))
      : Promise.resolve([]),
  ]);

  return {
    generated: (fromPosts[0]?.generated ?? 0) + (fromVideos[0]?.generated ?? 0),
    urgent: (fromPosts[0]?.urgent ?? 0) + (fromVideos[0]?.urgent ?? 0),
  };
}

export async function getDashboardMetrics(filters: MetricsFilters = {}): Promise<DashboardMetrics> {
  const db = getDb();
  const scope = filters.scope ?? "all";
  const includePosts = scope === "all" || scope === "posts";
  const includeVideos = scope === "all" || scope === "videos";

  const [roster, postAgg, videoAgg, summaryAgg] = await Promise.all([
    // Soft-deleted streamers are excluded: the row exists so sync history stays
    // meaningful, not so it inflates the roster.
    db
      .select({
        active: sql<number>`count(*) filter (where ${streamers.active})::int`,
        valid: sql<number>`count(*) filter (where ${streamers.tokenStatus} = 'valid')::int`,
        // "Needs attention" is everything that is not `valid`, which includes
        // `missing`: a streamer with no token cannot sync, and hiding that
        // behind a separate state is how a Page silently stops updating.
        attention: sql<number>`count(*) filter (where ${streamers.tokenStatus} <> 'valid')::int`,
      })
      .from(streamers)
      .where(isNull(streamers.deletedAt)),

    includePosts ? aggregatePosts(filters) : Promise.resolve(null),
    includeVideos ? aggregateVideos(filters) : Promise.resolve(null),
    countSummaries({ ...filters, scope }),
  ]);

  return {
    activeStreamers: roster[0]?.active ?? 0,
    validTokens: roster[0]?.valid ?? 0,
    tokensNeedingAttention: roster[0]?.attention ?? 0,
    postsCollected: postAgg?.rows ?? 0,
    videosCollected: videoAgg?.rows ?? 0,
    totalReactions: postAgg?.reactions ?? EMPTY_TOTAL,
    totalComments: postAgg?.comments ?? EMPTY_TOTAL,
    totalShares: postAgg?.shares ?? EMPTY_TOTAL,
    summariesGenerated: summaryAgg.generated,
    urgentIssues: summaryAgg.urgent,
  };
}

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

export type StreamerRosterRow = {
  id: string;
  streamerCode: string;
  streamerName: string;
  pageName: string;
  pageId: string;
  active: boolean;
  tokenStatus: string;
  lastSuccessfulSyncAt: Date | null;
  postCount: number;
  videoCount: number;
  summaryCount: number;
  urgentCount: number;
  /** Titles this streamer covers, primary first. Empty when none are assigned. */
  games: { name: string; isPrimary: boolean }[];
};

/**
 * The roster with per-streamer content counts, within the selected window.
 *
 * `token_status` is included because the admin roster shows it. It is a health
 * enum — `valid`, `expiring`, `missing` and so on — not token material, and the
 * caller decides whether the viewer is allowed to see it. The stored ciphertext
 * column is not selected, here or anywhere in this file.
 */
/** The raw shape of the roster query, before it is mapped to camelCase. */
type RosterQueryRow = {
  id: string;
  streamer_code: string;
  streamer_name: string;
  page_name: string;
  page_id: string;
  active: boolean;
  token_status: string;
  last_successful_sync_at: Date | null;
  post_count: number;
  video_count: number;
  summary_count: number;
  urgent_count: number;
  games: { name: string; primary: boolean }[] | null;
};

export async function listStreamerRoster(params: {
  from?: Date | null;
  to?: Date | null;
  search?: string | undefined;
  /** A game id, or `ANY_GAME` / `UNFILED_GAME`. See `streamerGameClause`. */
  gameId?: string | undefined;
}): Promise<StreamerRosterRow[]> {
  const db = getDb();

  const from = params.from ?? null;
  const to = params.to ?? null;
  const search = params.search ? `%${params.search}%` : null;

  /*
   * Filters the roster by who *covers* a game, not by what they published.
   * A streamer assigned to Cabal belongs in a Cabal-filtered roster even in a
   * week they posted nothing, because the question here is "who is on this
   * title", not "who was active".
   */
  const game = streamerGameClause(sql`streamers.id`, params.gameId);

  // Correlated subqueries rather than joins: joining four child tables to one
  // roster row would multiply the rows and force a `group by` over every
  // selected column, and the roster is small enough that clarity wins.
  const fromParam = tsParam(from);
  const toParam = tsParam(to);

  const inWindow = (createdTime: SQL) => sql`
    (${fromParam}::timestamptz is null or ${createdTime} >= ${fromParam}::timestamptz)
    and (${toParam}::timestamptz is null or ${createdTime} <= ${toParam}::timestamptz)
  `;

  // Tables are referenced unaliased throughout: `hasUrgentIssue` is built from
  // Drizzle column objects, which render as `"comment_summaries"."…"`, and an
  // alias would put that name out of scope.
  const rows = await db.execute<RosterQueryRow>(sql`
    select
      streamers.id,
      streamers.streamer_code,
      streamers.streamer_name,
      streamers.page_name,
      streamers.page_id,
      streamers.active,
      streamers.token_status::text as token_status,
      streamers.last_successful_sync_at,
      (
        select count(*)::int from ${posts}
        where posts.streamer_id = streamers.id
          and ${inWindow(sql`posts.created_time`)}
      ) as post_count,
      (
        select count(*)::int from ${videos}
        where videos.streamer_id = streamers.id
          and ${inWindow(sql`videos.created_time`)}
      ) as video_count,
      (
        select count(*)::int from ${commentSummaries}
        left join ${posts}  on posts.id  = comment_summaries.post_id
        left join ${videos} on videos.id = comment_summaries.video_id
        where coalesce(posts.streamer_id, videos.streamer_id) = streamers.id
          and comment_summaries.status = 'completed'
          and ${inWindow(sql`coalesce(posts.created_time, videos.created_time)`)}
      ) as summary_count,
      (
        select count(*)::int from ${commentSummaries}
        left join ${posts}  on posts.id  = comment_summaries.post_id
        left join ${videos} on videos.id = comment_summaries.video_id
        where coalesce(posts.streamer_id, videos.streamer_id) = streamers.id
          and ${hasUrgentIssue}
          and ${inWindow(sql`coalesce(posts.created_time, videos.created_time)`)}
      ) as urgent_count,
      (
        /*
         * Aggregated here rather than fetched per row. The roster is one query
         * and a second round trip per streamer would make it N+1 for a column
         * that is decoration on a page listing seven people.
         *
         * Primary first, then alphabetical, so the badge order is stable
         * between renders and the one that matters is leftmost.
         */
        select coalesce(
          json_agg(
            json_build_object('name', g.name, 'primary', sg.is_primary)
            order by sg.is_primary desc, g.name asc
          ),
          '[]'::json
        )
        from ${streamerGames} sg
        join ${games} g on g.id = sg.game_id
        where sg.streamer_id = streamers.id
      ) as games
    from ${streamers}
    where streamers.deleted_at is null
      ${game ? sql`and ${game}` : sql``}
      and (
        ${search}::text is null
        or streamers.streamer_name ilike ${search}
        or streamers.streamer_code ilike ${search}
        or streamers.page_name ilike ${search}
        or streamers.page_id ilike ${search}
      )
    order by streamers.streamer_code asc
  `);

  /*
   * `resultRows`, not a spread. `db.execute` returns a different shape by
   * driver — an array under postgres.js, `{ rows }` under PGlite — and the
   * spread worked in production while making this function untestable against
   * a real database. The helper exists for exactly that difference.
   */
  return resultRows<RosterQueryRow>(rows).map((row) => ({
    id: row.id,
    streamerCode: row.streamer_code,
    streamerName: row.streamer_name,
    pageName: row.page_name,
    pageId: row.page_id,
    active: row.active,
    tokenStatus: row.token_status,
    lastSuccessfulSyncAt: row.last_successful_sync_at
      ? new Date(row.last_successful_sync_at)
      : null,
    postCount: Number(row.post_count ?? 0),
    videoCount: Number(row.video_count ?? 0),
    summaryCount: Number(row.summary_count ?? 0),
    urgentCount: Number(row.urgent_count ?? 0),
    games: Array.isArray(row.games)
      ? row.games.map((entry) => ({ name: entry.name, isPrimary: Boolean(entry.primary) }))
      : [],
  }));
}

// ---------------------------------------------------------------------------
// Per-streamer overview
// ---------------------------------------------------------------------------

export type StreamerOverview = {
  postCount: number;
  videoCount: number;
  commentCount: number;
  summaryCount: number;
  urgentCount: number;
  reactions: MetricTotal;
  comments: MetricTotal;
  shares: MetricTotal;
  latestPostAt: Date | null;
  latestVideoAt: Date | null;
};

/** Stored comments for one streamer, counted through whichever parent they hang off. */
async function countStoredComments(filters: MetricsFilters): Promise<number> {
  const db = getDb();

  const [onPosts, onVideos] = await Promise.all([
    db
      .select({ rows: sql<number>`count(*)::int` })
      .from(comments)
      .innerJoin(posts, eq(comments.postId, posts.id))
      .where(whereOf(postWindow(filters))),
    db
      .select({ rows: sql<number>`count(*)::int` })
      .from(comments)
      .innerJoin(videos, eq(comments.videoId, videos.id))
      .where(whereOf(videoWindow(filters))),
  ]);

  return (onPosts[0]?.rows ?? 0) + (onVideos[0]?.rows ?? 0);
}

/** Aggregates for one streamer's Overview tab, within the selected window. */
export async function getStreamerOverview(params: {
  streamerId: string;
  gameId?: string | undefined;
  from?: Date | null;
  to?: Date | null;
}): Promise<StreamerOverview> {
  const filters: MetricsFilters = {
    streamerId: params.streamerId,
    gameId: params.gameId,
    from: params.from ?? null,
    to: params.to ?? null,
  };

  const [postAgg, videoAgg, commentCount, summaryAgg] = await Promise.all([
    aggregatePosts(filters),
    aggregateVideos(filters),
    countStoredComments(filters),
    countSummaries({ ...filters, scope: "all" }),
  ]);

  return {
    postCount: postAgg.rows,
    videoCount: videoAgg.rows,
    commentCount,
    summaryCount: summaryAgg.generated,
    urgentCount: summaryAgg.urgent,
    reactions: postAgg.reactions,
    comments: postAgg.comments,
    shares: postAgg.shares,
    latestPostAt: postAgg.latest,
    latestVideoAt: videoAgg.latest,
  };
}
