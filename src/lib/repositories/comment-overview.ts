import "server-only";

import { and, desc, inArray, isNotNull, or, sql, type SQL } from "drizzle-orm";

import { analyseOffline } from "@/lib/ai/offline";
import type { CommentAnalysis } from "@/lib/ai/contract";
import { getDb } from "@/lib/db";
import { commentSummaries, comments } from "@/lib/db/schema";
import { resultRows, tsParam } from "@/lib/db/params";
import type { DashboardFilters } from "@/lib/repositories/dashboard";

/**
 * One analysis across every comment the dashboard filters currently select.
 *
 * ## Why this is not the per-post analysis repeated
 *
 * A post's summary answers "what did people say about this?". Fifteen hundred
 * of those answer nothing on their own — nobody reads fifteen hundred
 * summaries. A roster view has to answer "what are people saying, across this
 * streamer, this period, this content type", and that is a different
 * computation over a different input: the comments themselves, pooled.
 *
 * ## Why it costs nothing
 *
 * It runs the deterministic analyser over the pooled set. Sending a hundred
 * thousand comments to a model would be slow and expensive, and the aggregate
 * questions — how tone breaks down, which words dominate, what is being asked,
 * what looks urgent — are all countable. Per-item summaries remain where
 * interpretation is worth paying for.
 *
 * So this is always available and always current, including on a deployment
 * running `AI_PROVIDER=offline` with no key at all.
 *
 * ## Why it samples content rather than comments
 *
 * Measured against production, warm connection, one streamer's 106,540
 * comments:
 *
 *   scanning comments and taking the newest 5,000   ~1,070ms
 *   taking the newest 300 items, then their comments  ~280ms
 *
 * `comments` has no index on `created_time` alone — only `(post_id,
 * created_time)` and `(video_id, created_time)` — so ordering the whole table
 * sorts every row. Content is small and indexed by `(streamer_id,
 * created_time)`, and each item's comments are then reached through the index
 * that does exist.
 *
 * The difference matters because the roster is meant to grow to thirty
 * streamers. Sampling comments scales with the comment table, which would be
 * millions of rows; sampling content scales with the content table, which stays
 * in the tens of thousands.
 */

/**
 * Content items whose comments are pooled.
 *
 * Bounded because this runs on every dashboard render. Three hundred items is
 * far more than any tone or term-frequency reading needs, and the newest are
 * what a reader means when they ask what people are saying.
 */
export const OVERVIEW_CONTENT_CAP = 300;

/** A second ceiling, for the case where a few items carry enormous threads. */
export const OVERVIEW_COMMENT_CAP = 5_000;

export type CommentOverview = {
  /** Comments actually fed into the analysis. */
  analysed: number;
  /** Content items whose comments were read. */
  contentSampled: number;
  /** Content items matching the filters, before the cap. */
  contentInScope: number;
  /** True when the reading covers less than the full selection. */
  truncated: boolean;
  /** Per-item sentiment for the sampled content, from stored summaries. */
  sentiment: { positive: number; neutral: number; negative: number; mixed: number };
  analysis: CommentAnalysis;
};

/** Period and streamer predicates, for a content table aliased `t`. */
function contentClauses(filters: DashboardFilters): SQL {
  const { streamerId, period } = filters;

  return sql`true
    ${streamerId ? sql`and t.streamer_id = ${streamerId}` : sql``}
    ${period.from ? sql`and t.created_time >= ${tsParam(period.from)}::timestamptz` : sql``}
    ${period.to ? sql`and t.created_time <= ${tsParam(period.to)}::timestamptz` : sql``}`;
}

/**
 * Content in scope, newest first, as a `UNION ALL` the caller can count or slice.
 *
 * `UNION ALL` rather than a join across both tables: a post and a video are
 * separate rows with no relationship, and each contributes independently.
 */
function scopedContent(filters: DashboardFilters): SQL {
  const posts = sql`select t.id, 'post' as kind, t.created_time from posts t where ${contentClauses(filters)}`;
  const videos = sql`select t.id, 'video' as kind, t.created_time from videos t where ${contentClauses(filters)}`;

  if (filters.scope === "posts") return posts;
  if (filters.scope === "videos") return videos;
  return sql`${posts} union all ${videos}`;
}

export async function getCommentOverview(
  filters: DashboardFilters,
  options: { contentCap?: number; commentCap?: number } = {},
): Promise<CommentOverview> {
  const db = getDb();
  const contentCap = options.contentCap ?? OVERVIEW_CONTENT_CAP;
  const commentCap = options.commentCap ?? OVERVIEW_COMMENT_CAP;
  const scoped = scopedContent(filters);

  const empty: CommentOverview = {
    analysed: 0,
    contentSampled: 0,
    contentInScope: 0,
    truncated: false,
    sentiment: { positive: 0, neutral: 0, negative: 0, mixed: 0 },
    analysis: analyseOffline([]),
  };

  /*
   * Counted separately from the sample. A reader seeing 300 items has no way to
   * tell whether that is the whole selection or a fifth of it, and the
   * difference changes what the summary means.
   */
  const totals = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from (${scoped}) as scoped
  `);
  const contentInScope = resultRows<{ n: number }>(totals)[0]?.n ?? 0;

  if (contentInScope === 0) return empty;

  const sampled = await db.execute<{ id: string; kind: "post" | "video" }>(sql`
    select id::text as id, kind from (${scoped}) as scoped
     order by created_time desc
     limit ${contentCap}
  `);

  const rows = resultRows<{ id: string; kind: "post" | "video" }>(sampled);
  const postIds = rows.filter((row) => row.kind === "post").map((row) => row.id);
  const videoIds = rows.filter((row) => row.kind === "video").map((row) => row.id);

  if (rows.length === 0) return { ...empty, contentInScope };

  /*
   * Built with Drizzle's `inArray` rather than a raw `any(...)` cast.
   *
   * An array interpolated into a raw `sql` template is spread into a tuple —
   * `any(($1, $2)::uuid[])` — which Postgres rejects as `cannot cast type
   * record to uuid[]`. The operator emits a single bound array parameter.
   *
   * Either way this is reached through `comments_post_id_created_time_idx` and
   * its video twin, which is the whole reason for sampling content first.
   */
  const parentMatch = or(
    postIds.length > 0 ? inArray(comments.postId, postIds) : undefined,
    videoIds.length > 0 ? inArray(comments.videoId, videoIds) : undefined,
  );

  const commentRows = await db
    .select({ message: comments.message })
    .from(comments)
    .where(and(parentMatch, isNotNull(comments.message)))
    .orderBy(desc(comments.createdTime))
    .limit(commentCap);

  const messages = commentRows
    .map((row) => row.message)
    .filter((message): message is string => typeof message === "string");

  /*
   * Sentiment comes from the stored per-item summaries, not from re-scoring the
   * pooled text. Those rows are what every other figure on the dashboard counts
   * — the sentiment chart, the analysis table — and a second, differently
   * derived number under the same word would read as a bug.
   *
   * Scoped to the sampled items so it describes the same content the prose
   * above it describes.
   */
  const summaryMatch = or(
    postIds.length > 0 ? inArray(commentSummaries.postId, postIds) : undefined,
    videoIds.length > 0 ? inArray(commentSummaries.videoId, videoIds) : undefined,
  );

  const sentimentRows = await db
    .select({
      sentiment: sql<string>`coalesce(${commentSummaries.sentiment}::text, 'no_comments')`,
      n: sql<number>`count(*)::int`,
    })
    .from(commentSummaries)
    .where(summaryMatch)
    .groupBy(sql`coalesce(${commentSummaries.sentiment}::text, 'no_comments')`);

  const sentiment = { positive: 0, neutral: 0, negative: 0, mixed: 0 };

  for (const row of sentimentRows) {
    if (row.sentiment in sentiment) {
      sentiment[row.sentiment as keyof typeof sentiment] = row.n;
    }
  }

  return {
    analysed: messages.length,
    contentSampled: rows.length,
    contentInScope,
    truncated: rows.length < contentInScope || messages.length >= commentCap,
    sentiment,
    analysis: analyseOffline(messages),
  };
}
