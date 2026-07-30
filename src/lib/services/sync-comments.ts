import "server-only";

import { getServerEnv } from "@/config/env";
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from "@/lib/audit/actions";
import { recordAuditLogSafe } from "@/lib/audit/log";
import { getAiProvider } from "@/lib/ai/anthropic";
import { emptyAnalysis } from "@/lib/ai/contract";
import type { ContentRef } from "@/lib/comments/content-ref";
import {
  commentSourceHash,
  shouldRegenerateSummary,
  type RegenerateReason,
} from "@/lib/comments/hashing";
import type { NormalizedMetaError } from "@/lib/meta/errors";
import { dedupeComments, fetchComments, normalizeComment } from "@/lib/meta/comments";
import type { NormalizedComment } from "@/lib/meta/comments";
import { childLogger } from "@/lib/observability/logger";
import {
  getSummaryForContent,
  listCommentsForContent,
  markSummaryProcessing,
  saveSummaryFailure,
  saveSummarySuccess,
  upsertContentComments,
} from "@/lib/repositories/comments";
import { getPostById } from "@/lib/repositories/posts";
import { withStreamerToken } from "@/lib/repositories/streamers";
import { getVideoById } from "@/lib/repositories/videos";

/**
 * Comment collection and AI summarisation, for posts and videos alike.
 *
 * One implementation serves both content types. The Graph edge is the same
 * (`/{object-id}/comments`), the field list is the same, and the hash gate,
 * privacy rules and summarisation are identical — so the only thing that varies
 * is which table the parent row lives in.
 *
 * Sequence:
 *   1. Resolve the content item to its Meta id and owning streamer.
 *   2. Fetch comments (never requesting commenter identity).
 *   3. Upsert them, deduplicating on `facebook_comment_id`.
 *   4. Compute the source hash over the stored set.
 *   5. Call the AI **only** if comments are new, comments changed, or an admin
 *      forced it.
 *   6. Record the outcome with an explicit status.
 */

export type SyncCommentsOutcome =
  | { ok: true; result: SyncCommentsResult }
  | { ok: false; reason: "content_not_found" | "no_token"; message: string };

export type SyncCommentsResult = {
  content: ContentRef;
  commentsFetched: number;
  commentsStored: number;
  truncated: boolean;
  summaryRegenerated: boolean;
  regenerateReason: RegenerateReason;
  summaryStatus: "completed" | "no_comments" | "failed" | "unchanged" | "skipped";
  summaryError?: string;
  fetchError?: NormalizedMetaError;
};

/** The parent row's Meta id and owning streamer, whichever table it lives in. */
type ResolvedContent = { facebookId: string; streamerId: string };

async function resolveContent(content: ContentRef): Promise<ResolvedContent | null> {
  if (content.type === "post") {
    const post = await getPostById(content.id);
    return post ? { facebookId: post.facebookPostId, streamerId: post.streamerId } : null;
  }

  const video = await getVideoById(content.id);
  return video ? { facebookId: video.facebookVideoId, streamerId: video.streamerId } : null;
}

export async function syncContentComments(params: {
  actorId: string | null;
  content: ContentRef;
  /** Set by the Regenerate Summary action. Bypasses the hash gate. */
  forceRegenerate?: boolean;
  /** Skip the Meta fetch and summarise what is already stored. */
  skipFetch?: boolean;
}): Promise<SyncCommentsOutcome> {
  const env = getServerEnv();

  const resolved = await resolveContent(params.content);
  if (!resolved) {
    return {
      ok: false,
      reason: "content_not_found",
      message: `That ${params.content.type} no longer exists.`,
    };
  }

  const log = childLogger({
    component: "sync.comments",
    contentType: params.content.type,
    contentId: params.content.id,
  });

  let commentsFetched = 0;
  let commentsStored = 0;
  let truncated = false;
  let fetchError: NormalizedMetaError | undefined;

  // ---- 2 & 3. Fetch and store -------------------------------------------
  if (!params.skipFetch) {
    const lent = await withStreamerToken(resolved.streamerId, async (token) => {
      const fetched = await fetchComments({
        contentId: resolved.facebookId,
        token,
        maxComments: env.MAX_COMMENTS_PER_CONTENT,
        logger: log,
      });

      commentsFetched = fetched.comments.length;
      truncated = fetched.truncated;
      fetchError = fetched.error;

      const normalized = dedupeComments(
        fetched.comments
          .map(normalizeComment)
          .filter((comment): comment is NormalizedComment => comment !== null),
      );

      if (normalized.length > 0) {
        const { written } = await upsertContentComments({
          content: params.content,
          comments: normalized,
        });
        commentsStored = written;
      }

      log.info("comments.stored", { commentsFetched, commentsStored, truncated });
    });

    if (!lent.ok) {
      return {
        ok: false,
        reason: "no_token",
        message: "That streamer has no Page token, so comments cannot be collected.",
      };
    }
  }

  // ---- 4. Hash the stored set -------------------------------------------
  const stored = await listCommentsForContent(params.content);
  const sourceHash = commentSourceHash(stored);
  const existing = await getSummaryForContent(params.content);

  /*
   * ---- 5a. The AI kill switch --------------------------------------------
   *
   * Checked before the hash gate, and it overrides `forceRegenerate`. Comments
   * are already collected and stored by this point — that costs only Meta
   * quota — so turning summarisation off keeps the pipeline running while a
   * billing or provider problem is sorted out, rather than forcing the whole
   * sweep to be disabled.
   *
   * Reported as `skipped`, not `failed`: nothing went wrong.
   */
  if (!env.AI_SUMMARIZATION_ENABLED) {
    log.info("summary.disabled", { commentCount: stored.length });

    return {
      ok: true,
      result: {
        content: params.content,
        commentsFetched,
        commentsStored,
        truncated,
        summaryRegenerated: false,
        regenerateReason: "disabled",
        summaryStatus: "skipped",
        ...(fetchError ? { fetchError } : {}),
      },
    };
  }

  // ---- 5b. Decide whether to spend on the model --------------------------
  const decision = shouldRegenerateSummary({
    currentSourceHash: sourceHash,
    storedSourceHash: existing?.sourceHash ?? null,
    storedStatus: existing?.status ?? null,
    forced: params.forceRegenerate ?? false,
  });

  if (!decision.regenerate) {
    log.info("summary.skipped", { reason: decision.reason, commentCount: stored.length });

    return {
      ok: true,
      result: {
        content: params.content,
        commentsFetched,
        commentsStored,
        truncated,
        summaryRegenerated: false,
        regenerateReason: decision.reason,
        summaryStatus: "unchanged",
        ...(fetchError ? { fetchError } : {}),
      },
    };
  }

  await markSummaryProcessing({
    content: params.content,
    sourceHash,
    commentCount: stored.length,
  });

  // Only message text is passed. `stored` carries no identity fields.
  const messages = stored
    .map((comment) => comment.message)
    .filter(
      (message): message is string => typeof message === "string" && message.trim().length > 0,
    );

  if (messages.length === 0) {
    await saveSummarySuccess({
      content: params.content,
      sourceHash,
      commentCount: stored.length,
      analysis: emptyAnalysis(),
      provider: env.AI_PROVIDER,
      model: "none",
      raw: { skipped: "no_readable_comments" },
      status: "no_comments",
    });

    log.info("summary.no_comments", { storedComments: stored.length });

    return {
      ok: true,
      result: {
        content: params.content,
        commentsFetched,
        commentsStored,
        truncated,
        summaryRegenerated: false,
        regenerateReason: decision.reason,
        summaryStatus: "no_comments",
        ...(fetchError ? { fetchError } : {}),
      },
    };
  }

  const provider = getAiProvider();
  const analysis = await provider.analyzeComments({ messages });

  const entityType =
    params.content.type === "post" ? AUDIT_ENTITY_TYPES.post : AUDIT_ENTITY_TYPES.video;

  if (!analysis.ok) {
    await saveSummaryFailure({
      content: params.content,
      sourceHash,
      commentCount: stored.length,
      message: analysis.message,
    });

    log.warn("summary.failed", { category: analysis.category, retryable: analysis.retryable });

    await recordAuditLogSafe({
      userId: params.actorId,
      action: AUDIT_ACTIONS.commentsSummarized,
      entityType,
      entityId: params.content.id,
      metadata: {
        contentType: params.content.type,
        status: "failed",
        category: analysis.category,
        commentCount: stored.length,
        provider: analysis.provider,
      },
    });

    return {
      ok: true,
      result: {
        content: params.content,
        commentsFetched,
        commentsStored,
        truncated,
        summaryRegenerated: false,
        regenerateReason: decision.reason,
        summaryStatus: "failed",
        summaryError: analysis.message,
        ...(fetchError ? { fetchError } : {}),
      },
    };
  }

  const status = analysis.analysis.sentiment === "no_comments" ? "no_comments" : "completed";

  await saveSummarySuccess({
    content: params.content,
    sourceHash,
    commentCount: stored.length,
    analysis: analysis.analysis,
    provider: analysis.provider,
    model: analysis.model,
    raw: analysis.raw,
    status,
  });

  await recordAuditLogSafe({
    userId: params.actorId,
    action: AUDIT_ACTIONS.commentsSummarized,
    entityType,
    entityId: params.content.id,
    metadata: {
      contentType: params.content.type,
      status: "completed",
      reason: decision.reason,
      commentCount: stored.length,
      sentiment: analysis.analysis.sentiment,
      provider: analysis.provider,
      model: analysis.model,
      inputTokens: analysis.usage.inputTokens,
      outputTokens: analysis.usage.outputTokens,
    },
  });

  log.info("summary.completed", {
    sentiment: analysis.analysis.sentiment,
    commentCount: stored.length,
    reason: decision.reason,
  });

  return {
    ok: true,
    result: {
      content: params.content,
      commentsFetched,
      commentsStored,
      truncated,
      summaryRegenerated: true,
      regenerateReason: decision.reason,
      summaryStatus: status,
      ...(fetchError ? { fetchError } : {}),
    },
  };
}

/** Backwards-compatible entry point for the post screens. */
export async function syncPostComments(params: {
  actorId: string | null;
  postId: string;
  forceRegenerate?: boolean;
  skipFetch?: boolean;
}): Promise<SyncCommentsOutcome> {
  const { postId, ...rest } = params;
  return syncContentComments({ ...rest, content: { type: "post", id: postId } });
}
