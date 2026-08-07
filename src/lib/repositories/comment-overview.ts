import "server-only";

import { createHash } from "node:crypto";

import { and, desc, eq, inArray, isNotNull, or, sql, type SQL } from "drizzle-orm";

import { getServerEnv } from "@/config/env";
import { analyseOffline } from "@/lib/ai/offline";
import { analyzeWithFallback } from "@/lib/ai/resolve";
import type { CommentAnalysis } from "@/lib/ai/contract";
import { getDb } from "@/lib/db";
import { commentOverviewSummaries, commentSummaries, comments } from "@/lib/db/schema";
import { gameClause } from "@/lib/db/game-filter";
import { resultRows, tsParam } from "@/lib/db/params";
import type { ContentScope } from "@/lib/filters/period";
import type { DashboardFilters } from "@/lib/repositories/dashboard";
import { mediaKindClause } from "@/lib/db/content-kind";
import { scopeIncludesPosts, scopeIncludesVideos } from "@/lib/filters/period";

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

/**
 * Comments sent to the model when one is configured.
 *
 * Far below the comment cap, because these become prompt tokens. Measured on
 * this project's own data an average comment is about 25 tokens, so 400 is
 * roughly 10k in — a fraction of a cent — where 5,000 would be 125k and turn
 * a dashboard render into a real expense.
 *
 * A tone-and-themes reading does not improve materially past a few hundred
 * comments; what it needs is a representative recent sample, which is what
 * this is.
 */
export const OVERVIEW_MODEL_COMMENT_CAP = 400;

export type CommentOverview = {
  /** Comments actually fed into the analysis. */
  analysed: number;
  /** Content items whose comments were read. */
  contentSampled: number;
  /** Content items matching the filters, before the cap. */
  contentInScope: number;
  /**
   * Which content the reading covers.
   *
   * Carried so the caption can name it. It said "posts and videos" whatever the
   * Content filter was set to, which is a claim about coverage the reading did
   * not make — and the one thing somebody checks when a finding looks like it
   * came from the wrong place.
   */
  scope: ContentScope;
  /** True when the reading covers less than the full selection. */
  truncated: boolean;
  /** Per-item sentiment for the sampled content, from stored summaries. */
  sentiment: { positive: number; neutral: number; negative: number; mixed: number };
  analysis: CommentAnalysis;
  /** Which produced the reading: a model, or the in-process counter. */
  provider: string;
  /** True when this came from cache rather than a fresh model call. */
  cached: boolean;
};

/** Period and streamer predicates, for a content table aliased `t`. */
function contentClauses(filters: DashboardFilters): SQL {
  const { streamerId, period } = filters;
  const game = gameClause(sql`t.game_id`, filters.gameId);

  return sql`true
    ${streamerId ? sql`and t.streamer_id = ${streamerId}` : sql``}
    ${game ? sql`and ${game}` : sql``}
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
  /*
   * A feed story for a broadcast is excluded here as everywhere: its comments
   * are the livestream's comments, reached through the video, and counting the
   * row as a post as well would pool the same conversation twice.
   */
  const kind = mediaKindClause(sql`t.media_kind`, filters.scope);

  const posts = sql`select t.id, 'post' as kind, t.created_time from posts t
    where ${contentClauses(filters)} and t.video_id is null`;
  const videos = sql`select t.id, 'video' as kind, t.created_time from videos t
    where ${contentClauses(filters)} ${kind ? sql`and ${kind}` : sql``}`;

  const wantsPosts = scopeIncludesPosts(filters.scope);
  const wantsVideos = scopeIncludesVideos(filters.scope);

  if (wantsPosts && wantsVideos) return sql`${posts} union all ${videos}`;
  return wantsPosts ? posts : videos;
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
    scope: filters.scope,
    truncated: false,
    sentiment: { positive: 0, neutral: 0, negative: 0, mixed: 0 },
    analysis: analyseOffline([]),
    provider: "offline",
    cached: false,
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

  const shape = {
    analysed: messages.length,
    contentSampled: rows.length,
    contentInScope,
    scope: filters.scope,
    truncated: rows.length < contentInScope || messages.length >= commentCap,
    sentiment,
  };

  /*
   * ---- The written reading, computed once per distinct content set --------
   *
   * A dashboard re-renders on every filter change, navigation and refresh.
   * Calling the model each time would bill repeatedly for the same answer —
   * the mistake the per-post hash gate exists to prevent, at roster scale.
   *
   * The hash covers the sampled content and how many comments each carries, so
   * it is stable across renders and changes exactly when the conversation does.
   */
  const sourceHash = overviewSourceHash(rows, messages.length);
  const cached = await readCachedOverview(sourceHash);

  /*
   * A cached tally is not a hit while a real provider is configured.
   *
   * `writeOverviewAnalysis` falls back to the counter when the provider
   * refuses — a depleted balance, a rate limit — and stores the result so the
   * panel renders. Treating that as final would freeze the tally in place: the
   * content has not changed, so the hash never moves, so the model is never
   * asked again no matter how much credit is added afterwards.
   *
   * This is the same rule the per-post backfill follows, and the same mistake
   * it already had to fix once: a local reading is a loan, never a
   * substitution. Anything the model actually wrote is served straight from
   * cache, which is the whole point.
   */
  const config = getServerEnv();
  const modelWanted = config.AI_SUMMARIZATION_ENABLED && config.AI_PROVIDER !== "offline";
  const usable = cached && !(cached.provider === "offline" && modelWanted);

  if (cached && usable) {
    return { ...shape, analysis: cached.analysis, provider: cached.provider, cached: true };
  }

  const fresh = await writeOverviewAnalysis({
    sourceHash,
    messages,
    contentSampled: rows.length,
  });

  return { ...shape, analysis: fresh.analysis, provider: fresh.provider, cached: false };
}

/**
 * A stable identity for "this set of content, in this state".
 *
 * Deliberately not derived from the filter values: `last 30 days` resolves to a
 * different instant every render, so a key built from those would never hit and
 * the cache would be decorative. Two selections that resolve to the same posts
 * deserve the same answer.
 *
 * The comment count is included so that new comments invalidate it, which is
 * exactly when a fresh reading is warranted.
 */
function overviewSourceHash(
  rows: readonly { id: string; kind: string }[],
  commentCount: number,
): string {
  const ids = rows
    .map((row) => `${row.kind}:${row.id}`)
    .sort()
    .join(",");

  return createHash("sha256").update(`${ids}|${commentCount}`, "utf8").digest("hex");
}

async function readCachedOverview(
  sourceHash: string,
): Promise<{ analysis: CommentAnalysis; provider: string } | null> {
  const db = getDb();

  const [row] = await db
    .select()
    .from(commentOverviewSummaries)
    .where(eq(commentOverviewSummaries.sourceHash, sourceHash))
    .limit(1);

  if (!row) return null;

  return {
    provider: row.aiProvider,
    analysis: {
      summary: row.summary,
      sentiment: (row.sentiment ?? "neutral") as CommentAnalysis["sentiment"],
      positive_points: (row.positivePointsJson ?? []) as string[],
      concerns: (row.concernsJson ?? []) as string[],
      suggestions: (row.suggestionsJson ?? []) as string[],
      questions: (row.questionsJson ?? []) as string[],
      urgent_issues: (row.urgentIssuesJson ?? []) as string[],
    },
  };
}

/**
 * Produce the reading and store it.
 *
 * Falls back to the counter on any provider failure, and stores that too — a
 * dashboard panel must render, and a depleted balance or a rate limit is not a
 * reason to show nothing. The stored row records which produced it, so the
 * panel can say so and a later run can tell a tally from an interpretation.
 */
async function writeOverviewAnalysis(params: {
  sourceHash: string;
  messages: readonly string[];
  contentSampled: number;
}): Promise<{ analysis: CommentAnalysis; provider: string }> {
  const env = getServerEnv();
  const db = getDb();

  const sample = params.messages.slice(0, OVERVIEW_MODEL_COMMENT_CAP);

  let analysis = analyseOffline(params.messages);
  let provider = "offline";
  let model = "lexicon";

  if (env.AI_SUMMARIZATION_ENABLED && env.AI_PROVIDER !== "offline" && sample.length > 0) {
    // `allowOffline` is left at its default: a reader is waiting on this panel,
    // and a tally now beats an empty card.
    const result = await analyzeWithFallback({ messages: [...sample] });

    if (result.ok) {
      analysis = result.analysis;
      provider = result.provider;
      model = result.model;
    }
  }

  await db
    .insert(commentOverviewSummaries)
    .values({
      sourceHash: params.sourceHash,
      summary: analysis.summary,
      sentiment: analysis.sentiment === "no_comments" ? null : analysis.sentiment,
      positivePointsJson: analysis.positive_points,
      concernsJson: analysis.concerns,
      suggestionsJson: analysis.suggestions,
      questionsJson: analysis.questions,
      urgentIssuesJson: analysis.urgent_issues,
      aiProvider: provider,
      model,
      contentSampled: params.contentSampled,
      commentCount: params.messages.length,
    })
    /*
     * Overwrites rather than ignoring the conflict.
     *
     * A row for this content may already exist and be a tally, written while
     * the provider was refusing. Once the model answers, that stand-in has to
     * be replaced — leaving it would mean the reading never improves, which is
     * exactly the freeze this whole path exists to avoid.
     *
     * Two concurrent renders both produce a valid answer, so the last writer
     * winning is fine.
     */
    .onConflictDoUpdate({
      target: commentOverviewSummaries.sourceHash,
      set: {
        summary: sql`excluded.summary`,
        sentiment: sql`excluded.sentiment`,
        positivePointsJson: sql`excluded.positive_points_json`,
        concernsJson: sql`excluded.concerns_json`,
        suggestionsJson: sql`excluded.suggestions_json`,
        questionsJson: sql`excluded.questions_json`,
        urgentIssuesJson: sql`excluded.urgent_issues_json`,
        aiProvider: sql`excluded.ai_provider`,
        model: sql`excluded.model`,
        contentSampled: sql`excluded.content_sampled`,
        commentCount: sql`excluded.comment_count`,
        generatedAt: sql`excluded.generated_at`,
      },
    });

  return { analysis, provider };
}
