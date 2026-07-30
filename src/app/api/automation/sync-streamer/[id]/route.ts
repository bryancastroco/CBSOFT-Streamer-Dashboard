import { z } from "zod";

import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from "@/lib/audit/actions";
import { recordAuditLogSafe } from "@/lib/audit/log";
import {
  automationError,
  automationOk,
  guardAutomationRequest,
  readAutomationBody,
} from "@/lib/automation/guard";
import { sanitiseMetaError, sanitiseThrown } from "@/lib/automation/sanitise";
import { childLogger } from "@/lib/observability/logger";
import { listRecentPostIdsForStreamer } from "@/lib/repositories/posts";
import { getStreamerIdentity, validateStreamerToken } from "@/lib/repositories/streamers";
import { listRecentVideoIdsForStreamer } from "@/lib/repositories/videos";
import { syncContentComments } from "@/lib/services/sync-comments";
import { syncStreamerPosts } from "@/lib/services/sync-posts";
import { syncStreamerVideos } from "@/lib/services/sync-videos";
import { SYNC_ALL_DEFAULTS } from "@/lib/services/sync-all";
import { streamerIdSchema } from "@/lib/validation/streamers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/automation/sync-streamer/{id}
 *
 * One streamer, synchronously. Same eleven steps as a sweep, scoped to a single
 * Page.
 *
 * Synchronous by default because a single streamer fits comfortably inside one
 * invocation, and a workflow retrying one Page wants the answer, not another id
 * to poll. It still records `sync_runs` rows, so the result also shows up in the
 * `sync-logs` export.
 *
 * n8n never receives a Page token here either. It names a streamer; the
 * application decrypts that streamer's token server-side and calls Meta itself.
 */
const bodySchema = z.object({
  since: z.iso.datetime().optional(),
  max_pages: z.coerce.number().int().min(1).max(50).optional(),
  concurrency: z.coerce.number().int().min(1).max(8).optional(),
  max_posts_for_comments: z.coerce.number().int().min(0).max(100).optional(),
  max_videos_for_comments: z.coerce.number().int().min(0).max(100).optional(),
  skip_comments: z.boolean().optional(),
  skip_token_validation: z.boolean().optional(),
});

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = guardAutomationRequest(request, "write");
  if (!guard.ok) return guard.response;

  const { id } = await context.params;
  const parsedId = streamerIdSchema.safeParse(id);

  if (!parsedId.success) {
    return automationError(
      400,
      "invalid_id",
      "The streamer id must be a UUID.",
      undefined,
      guard.headers,
    );
  }

  const body = await readAutomationBody(request, guard.headers);
  if (!body.ok) return body.response;

  const parsed = bodySchema.safeParse(body.body);

  if (!parsed.success) {
    return automationError(
      400,
      "invalid_body",
      "One or more body fields are invalid.",
      {
        issues: parsed.error.issues.map((issue) => ({
          field: issue.path.join(".") || "(body)",
          message: issue.message,
        })),
      },
      guard.headers,
    );
  }

  const streamerId = parsedId.data;
  const input = parsed.data;
  const log = childLogger({ component: "automation.sync_streamer", streamerId });

  const streamer = await getStreamerIdentity(streamerId);

  if (!streamer || streamer.deletedAt) {
    return automationError(
      404,
      "streamer_not_found",
      "No such streamer.",
      undefined,
      guard.headers,
    );
  }

  const errors: { step: string; message: string; category?: string }[] = [];
  const counters = {
    posts_processed: 0,
    post_insights_written: 0,
    videos_processed: 0,
    video_insights_written: 0,
    comments_processed: 0,
    summaries_generated: 0,
  };
  const runIds: string[] = [];
  let tokenStatus: string | null = null;

  try {
    // ---- Validate the token ------------------------------------------------
    if (!input.skip_token_validation) {
      const validation = await validateStreamerToken({ actorId: null, id: streamerId });

      if (!validation.ok) {
        return automationError(422, "token_unusable", validation.message, undefined, guard.headers);
      }

      tokenStatus = validation.data.validation.status;

      if (["missing", "expired", "invalid", "missing_permission"].includes(tokenStatus)) {
        // 422 rather than 500: nothing is broken, the credential needs
        // replacing, and a workflow should treat that as actionable rather
        // than as a transient error to retry.
        return automationError(
          422,
          "token_unusable",
          `The Page token is ${tokenStatus}. Replace it in the admin panel before syncing.`,
          { token_status: tokenStatus },
          guard.headers,
        );
      }
    }

    const shared = {
      actorId: null,
      streamerId,
      syncType: "automation" as const,
      ...(input.since ? { since: new Date(input.since) } : {}),
      maxPages: input.max_pages ?? SYNC_ALL_DEFAULTS.maxPages,
      concurrency: input.concurrency ?? SYNC_ALL_DEFAULTS.concurrency,
    };

    // ---- Posts and their insights -----------------------------------------
    const posts = await syncStreamerPosts(shared);

    if (!posts.ok) {
      errors.push({ step: "posts", message: posts.message });
    } else {
      runIds.push(posts.result.syncRunId);
      counters.posts_processed = posts.result.postsProcessed;
      counters.post_insights_written = posts.result.insightsWritten;

      if (posts.result.error) {
        const safe = sanitiseMetaError(posts.result.error);
        errors.push({ step: "posts", message: safe.message, category: safe.category });
      }
    }

    // ---- Post comments and changed summaries ------------------------------
    if (!input.skip_comments) {
      const ids = await listRecentPostIdsForStreamer(
        streamerId,
        input.max_posts_for_comments ?? SYNC_ALL_DEFAULTS.maxPostsForComments,
      );
      const outcome = await sweepComments("post", ids);
      counters.comments_processed += outcome.comments;
      counters.summaries_generated += outcome.summaries;
      errors.push(...outcome.errors.map((message) => ({ step: "post_comments", message })));
    }

    // ---- Videos and their insights ----------------------------------------
    const videos = await syncStreamerVideos(shared);

    if (!videos.ok) {
      errors.push({ step: "videos", message: videos.message });
    } else {
      runIds.push(videos.result.syncRunId);
      counters.videos_processed = videos.result.videosProcessed;
      counters.video_insights_written = videos.result.insightsWritten;

      if (videos.result.error) {
        const safe = sanitiseMetaError(videos.result.error);
        errors.push({ step: "videos", message: safe.message, category: safe.category });
      }
    }

    // ---- Video comments and changed summaries -----------------------------
    if (!input.skip_comments) {
      const ids = await listRecentVideoIdsForStreamer(
        streamerId,
        input.max_videos_for_comments ?? SYNC_ALL_DEFAULTS.maxVideosForComments,
      );
      const outcome = await sweepComments("video", ids);
      counters.comments_processed += outcome.comments;
      counters.summaries_generated += outcome.summaries;
      errors.push(...outcome.errors.map((message) => ({ step: "video_comments", message })));
    }
  } catch (cause) {
    const message = sanitiseThrown(cause, "The synchronisation failed.");
    log.error("automation.sync_streamer.failed", { error: message });

    return automationError(
      500,
      "sync_failed",
      message,
      { sync_run_ids: runIds, counters },
      guard.headers,
    );
  }

  const status = errors.length === 0 ? "succeeded" : "partial";

  await recordAuditLogSafe({
    userId: null,
    action: AUDIT_ACTIONS.automationSyncCompleted,
    entityType: AUDIT_ENTITY_TYPES.streamer,
    entityId: streamerId,
    metadata: { status, streamerCode: streamer.streamerCode, ...counters },
  });

  log.info("automation.sync_streamer.finished", { status, ...counters });

  return automationOk(
    {
      streamer_id: streamerId,
      streamer_code: streamer.streamerCode,
      status,
      finished: true,
      token_status: tokenStatus,
      // Two runs, one for posts and one for videos. Both appear in the
      // `sync-logs` export.
      sync_run_ids: runIds,
      summary: counters,
      errors,
    },
    200,
    guard.headers,
  );
}

/** Errors recorded per content type before the list is truncated. */
const MAX_RECORDED_COMMENT_ERRORS = 5;

/** Sequential, for the same reason as the sweep: the AI provider is the bottleneck. */
async function sweepComments(
  type: "post" | "video",
  contentIds: readonly string[],
): Promise<{ comments: number; summaries: number; errors: string[] }> {
  let comments = 0;
  let summaries = 0;
  const errors: string[] = [];

  for (const id of contentIds) {
    const outcome = await syncContentComments({ actorId: null, content: { type, id } });

    if (!outcome.ok) {
      if (errors.length < MAX_RECORDED_COMMENT_ERRORS) errors.push(outcome.message);
      continue;
    }

    comments += outcome.result.commentsStored;
    if (outcome.result.summaryRegenerated) summaries += 1;

    if (outcome.result.summaryStatus === "failed" && errors.length < MAX_RECORDED_COMMENT_ERRORS) {
      errors.push(outcome.result.summaryError ?? "The analysis failed.");
    }
  }

  return { comments, summaries, errors };
}
