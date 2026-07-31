import "server-only";

import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  lte,
  or,
  sql,
  type AnyColumn,
  type SQL,
} from "drizzle-orm";

import { getDb } from "@/lib/db";
import { commentSummaries, postInsights, posts, streamers } from "@/lib/db/schema";
import type { PostSortKey, SortState } from "@/lib/filters/sorting";
import type { NormalizedInsight, NormalizedPost } from "@/lib/meta/posts";

/**
 * Post and insight persistence.
 *
 * Uses the service-role connection. Reads are safe for any authenticated user
 * (post content is public on Facebook); writes happen only from the sync
 * engine, which is why neither table has a write policy.
 */

export type PostListItem = {
  id: string;
  facebookPostId: string;
  streamerId: string;
  streamerCode: string;
  streamerName: string;
  message: string | null;
  createdTime: Date;
  permalinkUrl: string | null;
  reactionCount: number | null;
  likeCount: number | null;
  commentCount: number | null;
  shareCount: number | null;
  lastSyncedAt: Date;
};

/** A row of the posts table, which needs more than the post itself. */
export type PostTableItem = PostListItem & {
  /** How many insight metrics Meta actually returned for this post. */
  metricCount: number;
  /** From the stored analysis, when one exists. Null means never analysed. */
  sentiment: string | null;
  summaryStatus: string | null;
  storedCommentCount: number | null;
};

const LIST_COLUMNS = {
  id: posts.id,
  facebookPostId: posts.facebookPostId,
  streamerId: posts.streamerId,
  streamerCode: streamers.streamerCode,
  streamerName: streamers.streamerName,
  message: posts.message,
  createdTime: posts.createdTime,
  permalinkUrl: posts.permalinkUrl,
  reactionCount: posts.reactionCount,
  likeCount: posts.likeCount,
  commentCount: posts.commentCount,
  shareCount: posts.shareCount,
  lastSyncedAt: posts.lastSyncedAt,
} as const;

/**
 * Metrics available for a post.
 *
 * A correlated subquery rather than a `group by`: the table already joins
 * `streamers` and `comment_summaries`, and grouping across those would need
 * every selected column in the `GROUP BY` clause for no benefit.
 */
const metricCountExpression = sql<number>`(
  select count(*)::int from ${postInsights} where ${postInsights.postId} = ${posts.id}
)`;

/** Columns the table view adds on top of the post row itself. */
const TABLE_COLUMNS = {
  ...LIST_COLUMNS,
  metricCount: metricCountExpression,
  sentiment: commentSummaries.sentiment,
  summaryStatus: commentSummaries.status,
  storedCommentCount: commentSummaries.commentCount,
} as const;

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Upsert a batch of posts, keyed on `facebook_post_id`.
 *
 * Meta's identifier is the natural key, so a re-sync updates counts in place
 * rather than duplicating history. `created_time` is never updated — a post's
 * publication time does not change, and letting it drift would corrupt
 * ordering.
 */
export async function upsertPosts(params: {
  streamerId: string;
  posts: NormalizedPost[];
}): Promise<{ written: number }> {
  if (params.posts.length === 0) return { written: 0 };

  const db = getDb();
  const now = new Date();

  const values = params.posts.map((post) => ({
    streamerId: params.streamerId,
    facebookPostId: post.facebookPostId,
    message: post.message,
    createdTime: post.createdTime,
    permalinkUrl: post.permalinkUrl,
    reactionCount: post.reactionCount,
    likeCount: post.likeCount,
    commentCount: post.commentCount,
    shareCount: post.shareCount,
    rawJson: post.raw,
    lastSyncedAt: now,
  }));

  const written = await db
    .insert(posts)
    .values(values)
    .onConflictDoUpdate({
      target: posts.facebookPostId,
      set: {
        message: sql`excluded.message`,
        permalinkUrl: sql`excluded.permalink_url`,
        reactionCount: sql`excluded.reaction_count`,
        /*
         * Coalesced, unlike its neighbours. Every post already stored predates
         * the `like_reactions` field, so a sync that returns nothing for it —
         * an older cached response, a partial failure — would replace a value
         * the rollup had already resolved with null. The other counts have
         * always been requested, so they have no such history.
         */
        likeCount: sql`coalesce(excluded.like_count, ${posts.likeCount})`,
        commentCount: sql`excluded.comment_count`,
        shareCount: sql`excluded.share_count`,
        rawJson: sql`excluded.raw_json`,
        lastSyncedAt: sql`excluded.last_synced_at`,
      },
    })
    .returning({ id: posts.id });

  return { written: written.length };
}

/** Resolve internal ids for a set of Meta post ids, for insight association. */
export async function mapFacebookPostIds(facebookPostIds: string[]): Promise<Map<string, string>> {
  if (facebookPostIds.length === 0) return new Map();

  const db = getDb();

  const rows = await db
    .select({ id: posts.id, facebookPostId: posts.facebookPostId })
    .from(posts)
    /*
     * `inArray`, not `sql\`... = ANY(${ids})\``.
     *
     * Drizzle's template tag expands a JS array into one bind parameter per
     * element, so `ANY(${ids})` compiles to `ANY(($1, $2))` — a row
     * constructor, which Postgres rejects outright. The failure surfaced only
     * against a real Page: every insight silently went unwritten because the
     * Meta id could never be mapped to an internal row.
     */
    .where(inArray(posts.facebookPostId, facebookPostIds));

  return new Map(rows.map((row) => [row.facebookPostId, row.id]));
}

/**
 * Upsert insights for one post.
 *
 * Keyed on (post, metric, period, end_time) so re-running a sync refreshes a
 * value rather than accumulating duplicates, while a periodic metric's series
 * is preserved across distinct `end_time`s.
 *
 * Note what this does NOT do: it never writes a row for a metric Meta did not
 * return. An absent metric stays absent, and the UI reports it as unavailable.
 */
export async function upsertPostInsights(params: {
  postId: string;
  insights: NormalizedInsight[];
}): Promise<{ written: number }> {
  if (params.insights.length === 0) return { written: 0 };

  const db = getDb();
  const collectedAt = new Date();

  // The uniqueness key is an EXPRESSION index — `coalesce(period, '')` and
  // `coalesce(end_time, 'epoch')` — because either column may be null and NULLs
  // would otherwise defeat uniqueness. Drizzle's `onConflictDoUpdate` target
  // accepts only plain columns, so the conflict clause is written out here.
  /*
   * Timestamps are bound as ISO strings, not `Date` objects.
   *
   * The pool runs with `prepare: false` (required by the Supabase transaction
   * pooler). On that path a `Date` interpolated into a raw `sql` fragment is
   * handed to postgres.js as a value it will not serialise:
   *
   *   ERR_INVALID_ARG_TYPE — The "string" argument must be of type string …
   *   Received an instance of Date
   *
   * The whole statement then fails, so *no* insight was ever written — for
   * posts or videos, in any environment using the pooler. It went unnoticed
   * because the sync counts what it intended to write, not what Postgres
   * accepted, and because the PGlite suite drives a different driver.
   */
  const rows = params.insights.map(
    (insight) => sql`(
      ${params.postId}::uuid,
      ${insight.metricName},
      ${insight.period},
      ${insight.value === null || insight.value === undefined ? null : JSON.stringify(insight.value)}::jsonb,
      ${insight.endTime ? insight.endTime.toISOString() : null}::timestamptz,
      ${JSON.stringify(insight.raw)}::jsonb,
      ${collectedAt.toISOString()}::timestamptz
    )`,
  );

  await db.execute(sql`
    INSERT INTO ${postInsights}
      (post_id, metric_name, period, value_json, end_time, raw_json, collected_at)
    VALUES ${sql.join(rows, sql`, `)}
    ON CONFLICT (post_id, metric_name, coalesce(period, ''), coalesce(end_time, 'epoch'::timestamptz))
    DO UPDATE SET
      value_json   = excluded.value_json,
      raw_json     = excluded.raw_json,
      collected_at = excluded.collected_at
  `);

  return { written: params.insights.length };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export type ListPostsFilters = {
  streamerId?: string | undefined;
  search?: string | undefined;
  from?: Date | null;
  to?: Date | null;
  sort?: SortState<PostSortKey>;
  limit: number;
  offset: number;
};

/**
 * Sort keys mapped to columns.
 *
 * This map is what keeps ordering safe: the key has already been resolved
 * against the allow-list in `lib/filters/sorting`, and an unrecognised value
 * cannot index into a `Record` of Drizzle column objects. No string from the
 * query string is ever interpolated into `ORDER BY`.
 */
const POST_SORT_COLUMNS: Record<PostSortKey, SQL | AnyColumn> = {
  createdTime: posts.createdTime,
  streamer: streamers.streamerCode,
  reactions: posts.reactionCount,
  comments: posts.commentCount,
  shares: posts.shareCount,
  metrics: metricCountExpression,
  sentiment: commentSummaries.sentiment,
  summaryStatus: commentSummaries.status,
};

const DEFAULT_POST_SORT: SortState<PostSortKey> = { key: "createdTime", direction: "desc" };

export async function listPosts(
  filters: ListPostsFilters,
): Promise<{ items: PostTableItem[]; total: number }> {
  const db = getDb();
  const conditions: SQL[] = [];

  if (filters.streamerId) conditions.push(eq(posts.streamerId, filters.streamerId));
  if (filters.from) conditions.push(gte(posts.createdTime, filters.from));
  if (filters.to) conditions.push(lte(posts.createdTime, filters.to));

  if (filters.search) {
    const term = `%${filters.search}%`;
    const match = or(
      ilike(posts.message, term),
      ilike(posts.facebookPostId, term),
      ilike(streamers.streamerName, term),
      ilike(streamers.streamerCode, term),
    );
    if (match) conditions.push(match);
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const sort = filters.sort ?? DEFAULT_POST_SORT;
  const column = POST_SORT_COLUMNS[sort.key] ?? POST_SORT_COLUMNS.createdTime;

  // `nulls last` in both directions. An unreported count and an unanalysed post
  // are the least informative rows on the page whichever way the reader sorted,
  // and letting them head an ascending sort buries the data that was asked for.
  const ordering =
    sort.direction === "asc" ? sql`${column} asc nulls last` : sql`${column} desc nulls last`;

  const [items, totals] = await Promise.all([
    db
      .select(TABLE_COLUMNS)
      .from(posts)
      .innerJoin(streamers, eq(posts.streamerId, streamers.id))
      .leftJoin(commentSummaries, eq(commentSummaries.postId, posts.id))
      .where(where)
      // A stable tiebreak, so paging cannot show the same row twice when the
      // sort column has duplicates.
      .orderBy(ordering, desc(posts.createdTime), asc(posts.id))
      .limit(filters.limit)
      .offset(filters.offset),
    db
      .select({ value: count() })
      .from(posts)
      .innerJoin(streamers, eq(posts.streamerId, streamers.id))
      .where(where),
  ]);

  return { items, total: totals[0]?.value ?? 0 };
}

export type PostInsightItem = {
  id: string;
  metricName: string;
  period: string | null;
  value: unknown;
  endTime: Date | null;
  collectedAt: Date;
};

export type PostDetail = PostListItem & {
  rawJson: unknown;
  insights: PostInsightItem[];
};

export async function getPostById(id: string): Promise<PostDetail | null> {
  const db = getDb();

  const [post] = await db
    .select({ ...LIST_COLUMNS, rawJson: posts.rawJson })
    .from(posts)
    .innerJoin(streamers, eq(posts.streamerId, streamers.id))
    .where(eq(posts.id, id))
    .limit(1);

  if (!post) return null;

  const insights = await db
    .select({
      id: postInsights.id,
      metricName: postInsights.metricName,
      period: postInsights.period,
      value: postInsights.valueJson,
      endTime: postInsights.endTime,
      collectedAt: postInsights.collectedAt,
    })
    .from(postInsights)
    .where(eq(postInsights.postId, id))
    .orderBy(postInsights.metricName, desc(postInsights.endTime));

  return { ...post, insights };
}

/**
 * The posts an automation sweep should refresh comments for.
 *
 * Newest first and capped, because comment collection is the expensive half of
 * a sweep: each post is a paginated Graph walk, and each *changed* set is an
 * Anthropic call. Walking a Page's entire history every night would spend both
 * budgets on content nobody is still commenting on.
 *
 * Newest-first is the right cut. Engagement on a Facebook post is heavily
 * front-loaded, so the recent ones are where comments actually change — and the
 * source-hash gate means an unchanged set costs a fetch and no AI call at all.
 */
export async function listRecentPostIdsForStreamer(
  streamerId: string,
  limit: number,
): Promise<string[]> {
  const db = getDb();

  const rows = await db
    .select({ id: posts.id })
    .from(posts)
    .where(eq(posts.streamerId, streamerId))
    .orderBy(desc(posts.createdTime), asc(posts.id))
    .limit(limit);

  return rows.map((row) => row.id);
}

export async function countPostsForStreamer(streamerId: string): Promise<number> {
  const db = getDb();

  const [row] = await db
    .select({ value: count() })
    .from(posts)
    .where(eq(posts.streamerId, streamerId));

  return row?.value ?? 0;
}
