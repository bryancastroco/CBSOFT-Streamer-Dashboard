"use server";

import type { ActionState as CommentActionState } from "@/lib/forms/action-state";

import { revalidatePath } from "next/cache";

import { AuthorizationError, assertAdmin } from "@/lib/auth/guards";
import { REGENERATE_REASON_LABELS } from "@/lib/comments/hashing";
import { syncPostComments } from "@/lib/services/sync-comments";
import { postIdSchema } from "@/lib/validation/posts";

/**
 * Comment actions on the post detail screen.
 *
 * Both begin with `assertAdmin()` — they spend Meta quota and AI tokens, so
 * they are not viewer-reachable even though the page they live on is.
 */

async function requireAdminActor(): Promise<{ id: string } | CommentActionState> {
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

function isState(value: unknown): value is CommentActionState {
  return typeof value === "object" && value !== null && "status" in value;
}

/** Collect comments from Meta, then summarise only if they changed. */
export async function syncCommentsAction(
  _previous: CommentActionState,
  formData: FormData,
): Promise<CommentActionState> {
  const actor = await requireAdminActor();
  if (isState(actor)) return actor;

  const id = postIdSchema.safeParse(formData.get("postId"));
  if (!id.success) return { status: "error", message: "That post id is not valid." };

  const outcome = await syncPostComments({ actorId: actor.id, postId: id.data });
  if (!outcome.ok) return { status: "error", message: outcome.message };

  const { result } = outcome;
  revalidatePath(`/posts/${id.data}`);

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
    ? " The per-post comment limit was reached, so older comments were not collected."
    : "";

  return { status: "success", message: `${collected} and refreshed the analysis.${truncatedNote}` };
}

/** Re-run the analysis over the stored comments, bypassing the hash gate. */
export async function regenerateSummaryAction(
  _previous: CommentActionState,
  formData: FormData,
): Promise<CommentActionState> {
  const actor = await requireAdminActor();
  if (isState(actor)) return actor;

  const id = postIdSchema.safeParse(formData.get("postId"));
  if (!id.success) return { status: "error", message: "That post id is not valid." };

  const outcome = await syncPostComments({
    actorId: actor.id,
    postId: id.data,
    forceRegenerate: true,
    skipFetch: true,
  });

  if (!outcome.ok) return { status: "error", message: outcome.message };

  const { result } = outcome;
  revalidatePath(`/posts/${id.data}`);

  if (result.summaryStatus === "failed") {
    return { status: "error", message: result.summaryError ?? "The analysis failed." };
  }

  if (result.summaryStatus === "no_comments") {
    return { status: "success", message: "No readable comments were found to analyse." };
  }

  return { status: "success", message: "Summary regenerated." };
}
