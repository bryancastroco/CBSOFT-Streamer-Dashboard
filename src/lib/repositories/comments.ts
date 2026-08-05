import "server-only";

import { asc, eq, sql, type SQL } from "drizzle-orm";

import type { CommentAnalysis } from "@/lib/ai/contract";
import type { ContentRef } from "@/lib/comments/content-ref";
import { commentContentHash } from "@/lib/comments/hashing";
import { getDb } from "@/lib/db";
import { commentSummaries, comments, posts, videos } from "@/lib/db/schema";
import type { NormalizedComment } from "@/lib/meta/comments";

/**
 * Comment and summary persistence, for posts and videos alike.
 *
 * Every function takes a `ContentRef` rather than a post id, so one
 * implementation serves both content types. No column in either table holds a
 * commenter identity, and none is written here — the Graph fetch never
 * requests one.
 */

/** The parent columns for a content ref: exactly one is set. */
function parentColumns(content: ContentRef) {
  return {
    contentType: content.type,
    postId: content.type === "post" ? content.id : null,
    videoId: content.type === "video" ? content.id : null,
  } as const;
}

/** Match rows belonging to this content item. */
function parentMatch(content: ContentRef): SQL {
  return content.type === "post"
    ? eq(comments.postId, content.id)
    : eq(comments.videoId, content.id);
}

function summaryMatch(content: ContentRef): SQL {
  return content.type === "post"
    ? eq(commentSummaries.postId, content.id)
    : eq(commentSummaries.videoId, content.id);
}

/**
 * The conflict target for a summary upsert.
 *
 * `comment_summaries` has two PARTIAL unique indexes — one on `post_id where
 * post_id is not null`, one on `video_id` — because exactly one of the two
 * columns is populated. A partial index requires its predicate in the conflict
 * clause, which is what `targetWhere` supplies.
 */
function summaryConflictTarget(content: ContentRef) {
  return content.type === "post"
    ? { target: commentSummaries.postId, targetWhere: sql`post_id is not null` }
    : { target: commentSummaries.videoId, targetWhere: sql`video_id is not null` };
}

export type StoredComment = {
  id: string;
  facebookCommentId: string;
  message: string | null;
  createdTime: Date;
  likeCount: number | null;
  replyCount: number | null;
  contentHash: string;
};

/**
 * Upsert comments for a content item, keyed on `facebook_comment_id`.
 *
 * The unique key is what makes duplicates a non-event: Meta re-returns the same
 * comments on every sync, and each one updates in place rather than
 * accumulating. `created_time` is never updated.
 */
export async function upsertContentComments(params: {
  content: ContentRef;
  comments: NormalizedComment[];
}): Promise<{ written: number }> {
  if (params.comments.length === 0) return { written: 0 };

  const db = getDb();
  const now = new Date();
  const parent = parentColumns(params.content);

  const values = params.comments.map((comment) => ({
    ...parent,
    facebookCommentId: comment.facebookCommentId,
    message: comment.message,
    createdTime: comment.createdTime,
    likeCount: comment.likeCount,
    replyCount: comment.replyCount,
    contentHash: commentContentHash(comment),
    lastSyncedAt: now,
  }));

  const written = await db
    .insert(comments)
    .values(values)
    .onConflictDoUpdate({
      target: comments.facebookCommentId,
      set: {
        message: sql`excluded.message`,
        likeCount: sql`excluded.like_count`,
        replyCount: sql`excluded.reply_count`,
        contentHash: sql`excluded.content_hash`,
        lastSyncedAt: sql`excluded.last_synced_at`,
      },
    })
    .returning({ id: comments.id });

  return { written: written.length };
}

/**
 * Record that the comments edge has been walked for this item.
 *
 * Written after a *successful* fetch and only then. A failed walk must leave
 * the marker null, or the backfill would count a rate-limited item as done and
 * never come back to it — silently losing that post's comments for good.
 *
 * Note this is stamped even when the walk found nothing: "we looked, there were
 * none" is exactly the fact the backfill needs recorded, and it is the one that
 * the presence of comment rows cannot express.
 */
export async function markCommentsSynced(content: ContentRef, at = new Date()): Promise<void> {
  const db = getDb();

  if (content.type === "post") {
    await db.update(posts).set({ commentsSyncedAt: at }).where(eq(posts.id, content.id));
    return;
  }

  await db.update(videos).set({ commentsSyncedAt: at }).where(eq(videos.id, content.id));
}

/** All stored comments for a content item, oldest first. */
export async function listCommentsForContent(content: ContentRef): Promise<StoredComment[]> {
  const db = getDb();

  return db
    .select({
      id: comments.id,
      facebookCommentId: comments.facebookCommentId,
      message: comments.message,
      createdTime: comments.createdTime,
      likeCount: comments.likeCount,
      replyCount: comments.replyCount,
      contentHash: comments.contentHash,
    })
    .from(comments)
    .where(parentMatch(content))
    .orderBy(asc(comments.createdTime));
}

export async function countCommentsForContent(content: ContentRef): Promise<number> {
  const db = getDb();

  const [row] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(comments)
    .where(parentMatch(content));

  return row?.value ?? 0;
}

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

export type StoredSummary = {
  id: string;
  sourceHash: string;
  commentCount: number;
  summary: string | null;
  sentiment: string | null;
  positivePoints: unknown;
  concerns: unknown;
  suggestions: unknown;
  questions: unknown;
  urgentIssues: unknown;
  aiProvider: string | null;
  model: string | null;
  status: string;
  errorMessage: string | null;
  generatedAt: Date | null;
  updatedAt: Date;
};

const SUMMARY_COLUMNS = {
  id: commentSummaries.id,
  sourceHash: commentSummaries.sourceHash,
  commentCount: commentSummaries.commentCount,
  summary: commentSummaries.summary,
  sentiment: commentSummaries.sentiment,
  positivePoints: commentSummaries.positivePointsJson,
  concerns: commentSummaries.concernsJson,
  suggestions: commentSummaries.suggestionsJson,
  questions: commentSummaries.questionsJson,
  urgentIssues: commentSummaries.urgentIssuesJson,
  aiProvider: commentSummaries.aiProvider,
  model: commentSummaries.model,
  status: commentSummaries.status,
  errorMessage: commentSummaries.errorMessage,
  generatedAt: commentSummaries.generatedAt,
  updatedAt: commentSummaries.updatedAt,
} as const;

export async function getSummaryForContent(content: ContentRef): Promise<StoredSummary | null> {
  const db = getDb();

  const [row] = await db
    .select(SUMMARY_COLUMNS)
    .from(commentSummaries)
    .where(summaryMatch(content))
    .limit(1);

  return row ?? null;
}

/** Convenience for the post detail page. */
export async function getSummaryForPost(postId: string): Promise<StoredSummary | null> {
  return getSummaryForContent({ type: "post", id: postId });
}

/** Convenience for the video detail page. */
export async function getSummaryForVideo(videoId: string): Promise<StoredSummary | null> {
  return getSummaryForContent({ type: "video", id: videoId });
}

/**
 * Mark a summary as in flight.
 *
 * Written before the AI call so a crashed or timed-out run leaves `processing`
 * behind rather than a stale `completed`.
 */
export async function markSummaryProcessing(params: {
  content: ContentRef;
  sourceHash: string;
  commentCount: number;
}): Promise<void> {
  const db = getDb();

  await db
    .insert(commentSummaries)
    .values({
      ...parentColumns(params.content),
      sourceHash: params.sourceHash,
      commentCount: params.commentCount,
      status: "processing",
    })
    .onConflictDoUpdate({
      ...summaryConflictTarget(params.content),
      set: {
        sourceHash: sql`excluded.source_hash`,
        commentCount: sql`excluded.comment_count`,
        status: sql`excluded.status`,
        errorMessage: sql`null`,
      },
    });
}

export async function saveSummarySuccess(params: {
  content: ContentRef;
  sourceHash: string;
  commentCount: number;
  analysis: CommentAnalysis;
  provider: string;
  model: string;
  raw: unknown;
  status: "completed" | "no_comments";
}): Promise<void> {
  const db = getDb();

  await db
    .insert(commentSummaries)
    .values({
      ...parentColumns(params.content),
      sourceHash: params.sourceHash,
      commentCount: params.commentCount,
      summary: params.analysis.summary,
      sentiment: params.analysis.sentiment,
      positivePointsJson: params.analysis.positive_points,
      concernsJson: params.analysis.concerns,
      suggestionsJson: params.analysis.suggestions,
      questionsJson: params.analysis.questions,
      urgentIssuesJson: params.analysis.urgent_issues,
      aiProvider: params.provider,
      model: params.model,
      status: params.status,
      errorMessage: null,
      rawAiResponse: params.raw as never,
      generatedAt: new Date(),
    })
    .onConflictDoUpdate({
      ...summaryConflictTarget(params.content),
      set: {
        sourceHash: sql`excluded.source_hash`,
        commentCount: sql`excluded.comment_count`,
        summary: sql`excluded.summary`,
        sentiment: sql`excluded.sentiment`,
        positivePointsJson: sql`excluded.positive_points_json`,
        concernsJson: sql`excluded.concerns_json`,
        suggestionsJson: sql`excluded.suggestions_json`,
        questionsJson: sql`excluded.questions_json`,
        urgentIssuesJson: sql`excluded.urgent_issues_json`,
        aiProvider: sql`excluded.ai_provider`,
        model: sql`excluded.model`,
        status: sql`excluded.status`,
        errorMessage: sql`null`,
        rawAiResponse: sql`excluded.raw_ai_response`,
        generatedAt: sql`excluded.generated_at`,
      },
    });
}

export async function saveSummaryFailure(params: {
  content: ContentRef;
  sourceHash: string;
  commentCount: number;
  message: string;
}): Promise<void> {
  const db = getDb();

  await db
    .insert(commentSummaries)
    .values({
      ...parentColumns(params.content),
      sourceHash: params.sourceHash,
      commentCount: params.commentCount,
      status: "failed",
      errorMessage: params.message,
    })
    .onConflictDoUpdate({
      ...summaryConflictTarget(params.content),
      set: {
        sourceHash: sql`excluded.source_hash`,
        commentCount: sql`excluded.comment_count`,
        status: sql`excluded.status`,
        errorMessage: sql`excluded.error_message`,
      },
    });
}
