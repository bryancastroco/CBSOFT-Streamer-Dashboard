"use server";

import { revalidatePath } from "next/cache";

import { AuthorizationError, assertAdmin } from "@/lib/auth/guards";
import { REGENERATE_REASON_LABELS } from "@/lib/comments/hashing";
import { syncContentComments } from "@/lib/services/sync-comments";
import { videoIdSchema } from "@/lib/validation/videos";

/**
 * Comment actions on the video detail screen.
 *
 * Thin wrappers over the shared `syncContentComments` — the video path differs
 * from the post path only in the content ref it passes.
 */

export type VideoCommentActionState = {
  status: "idle" | "success" | "error";
  message: string | null;
};

export const idleVideoCommentState: VideoCommentActionState = { status: "idle", message: null };

async function requireAdminActor(): Promise<{ id: string } | VideoCommentActionState> {
  try {
    const actor = await assertAdmin();
    return { id: actor.id };
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return { status: "error", message: error.message };
    }
    throw error;
  }
}

function isState(value: unknown): value is VideoCommentActionState {
  return typeof value === "object" && value !== null && "status" in value;
}

export async function syncVideoCommentsAction(
  _previous: VideoCommentActionState,
  formData: FormData,
): Promise<VideoCommentActionState> {
  const actor = await requireAdminActor();
  if (isState(actor)) return actor;

  const id = videoIdSchema.safeParse(formData.get("videoId"));
  if (!id.success) return { status: "error", message: "That video id is not valid." };

  const outcome = await syncContentComments({
    actorId: actor.id,
    content: { type: "video", id: id.data },
  });

  if (!outcome.ok) return { status: "error", message: outcome.message };

  const { result } = outcome;
  revalidatePath(`/videos/${id.data}`);

  const collected = `Collected ${result.commentsStored} comment${result.commentsStored === 1 ? "" : "s"}`;

  if (result.summaryStatus === "failed") {
    return {
      status: "error",
      message: `${collected}, but the analysis failed: ${result.summaryError ?? "unknown error"}`,
    };
  }

  if (result.summaryStatus === "unchanged") {
    return {
      status: "success",
      message: `${collected}. ${REGENERATE_REASON_LABELS.unchanged} — no AI call was made.`,
    };
  }

  if (result.summaryStatus === "no_comments") {
    return { status: "success", message: `${collected}. Nothing analysable was found.` };
  }

  const truncatedNote = result.truncated
    ? " The per-video comment limit was reached, so older comments were not collected."
    : "";

  return { status: "success", message: `${collected} and refreshed the analysis.${truncatedNote}` };
}

export async function regenerateVideoSummaryAction(
  _previous: VideoCommentActionState,
  formData: FormData,
): Promise<VideoCommentActionState> {
  const actor = await requireAdminActor();
  if (isState(actor)) return actor;

  const id = videoIdSchema.safeParse(formData.get("videoId"));
  if (!id.success) return { status: "error", message: "That video id is not valid." };

  const outcome = await syncContentComments({
    actorId: actor.id,
    content: { type: "video", id: id.data },
    forceRegenerate: true,
    skipFetch: true,
  });

  if (!outcome.ok) return { status: "error", message: outcome.message };

  const { result } = outcome;
  revalidatePath(`/videos/${id.data}`);

  if (result.summaryStatus === "failed") {
    return { status: "error", message: result.summaryError ?? "The analysis failed." };
  }

  if (result.summaryStatus === "no_comments") {
    return { status: "success", message: "No readable comments were found to analyse." };
  }

  return { status: "success", message: "Summary regenerated." };
}
