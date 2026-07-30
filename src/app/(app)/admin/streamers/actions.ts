"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { AuthorizationError, assertAdmin } from "@/lib/auth/guards";
import type { TokenValidation } from "@/lib/meta/token-status";
import {
  createStreamer,
  replaceStreamerToken,
  requestManualSync,
  softDeleteStreamer,
  updateStreamer,
  validateStreamerToken,
} from "@/lib/repositories/streamers";
import { syncStreamerPosts } from "@/lib/services/sync-posts";
import { syncStreamerVideos } from "@/lib/services/sync-videos";
import {
  createStreamerSchema,
  replaceTokenSchema,
  streamerIdSchema,
  updateStreamerSchema,
} from "@/lib/validation/streamers";

/**
 * Server Actions for streamer administration.
 *
 * Every one begins with `assertAdmin()`. A Server Action is an ordinary POST
 * endpoint — anyone who can reach the app can invoke it directly, so the check
 * belongs here and not in the component that renders the button. The admin
 * layout and the proxy have both already checked; this is the layer that
 * cannot be bypassed.
 *
 * No action ever accepts a token in a field it then echoes back, and no
 * returned state carries token material.
 */

export type ActionState = {
  status: "idle" | "success" | "error";
  message: string | null;
  /** Field-level messages, keyed by form field name. */
  fieldErrors?: Record<string, string>;
  /** Populated after a token operation, so the UI can show the verdict. */
  validation?: TokenValidation | null;
};

export const idleState: ActionState = { status: "idle", message: null };

async function requireActor(): Promise<{ id: string } | ActionState> {
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

function isActionState(value: unknown): value is ActionState {
  return typeof value === "object" && value !== null && "status" in value;
}

function fieldErrorsFrom(
  issues: { path: PropertyKey[]; message: string }[],
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of issues) {
    const key = String(issue.path[0] ?? "");
    if (key && !errors[key]) errors[key] = issue.message;
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createStreamerAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireActor();
  if (isActionState(actor)) return actor;

  const parsed = createStreamerSchema.safeParse({
    streamerName: formData.get("streamerName"),
    streamerCode: formData.get("streamerCode"),
    pageId: formData.get("pageId"),
    pageName: formData.get("pageName"),
    pageAccessToken: formData.get("pageAccessToken") ?? "",
    notes: formData.get("notes") ?? "",
    active: formData.get("active") === "on" || formData.get("active") === "true",
  });

  if (!parsed.success) {
    return {
      status: "error",
      message: "Check the highlighted fields.",
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const outcome = await createStreamer({ actorId: actor.id, input: parsed.data });

  if (!outcome.ok) {
    return {
      status: "error",
      message: outcome.message,
      fieldErrors:
        outcome.reason === "duplicate_code"
          ? { streamerCode: outcome.message }
          : outcome.reason === "duplicate_page"
            ? { pageId: outcome.message }
            : outcome.reason === "token_rejected"
              ? { pageAccessToken: outcome.message }
              : undefined,
    };
  }

  revalidatePath("/admin/streamers");
  redirect(`/admin/streamers/${outcome.data.streamer.id}?created=1`);
}

// ---------------------------------------------------------------------------
// Update / disable
// ---------------------------------------------------------------------------

export async function updateStreamerAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireActor();
  if (isActionState(actor)) return actor;

  const id = streamerIdSchema.safeParse(formData.get("id"));
  if (!id.success) return { status: "error", message: "That streamer id is not valid." };

  const parsed = updateStreamerSchema.safeParse({
    streamerName: formData.get("streamerName") ?? undefined,
    streamerCode: formData.get("streamerCode") ?? undefined,
    pageId: formData.get("pageId") ?? undefined,
    pageName: formData.get("pageName") ?? undefined,
    notes: formData.get("notes") ?? undefined,
    active: formData.get("active") === "on" || formData.get("active") === "true",
  });

  if (!parsed.success) {
    return {
      status: "error",
      message: "Check the highlighted fields.",
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const outcome = await updateStreamer({ actorId: actor.id, id: id.data, input: parsed.data });

  if (!outcome.ok) return { status: "error", message: outcome.message };

  revalidatePath("/admin/streamers");
  revalidatePath(`/admin/streamers/${id.data}`);

  return { status: "success", message: "Streamer updated." };
}

/** Enable/disable toggle, kept separate so the audit action is unambiguous. */
export async function setStreamerActiveAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireActor();
  if (isActionState(actor)) return actor;

  const id = streamerIdSchema.safeParse(formData.get("id"));
  if (!id.success) return { status: "error", message: "That streamer id is not valid." };

  const active = formData.get("active") === "true";

  const outcome = await updateStreamer({ actorId: actor.id, id: id.data, input: { active } });
  if (!outcome.ok) return { status: "error", message: outcome.message };

  revalidatePath("/admin/streamers");
  revalidatePath(`/admin/streamers/${id.data}`);

  return {
    status: "success",
    message: active ? "Streamer enabled." : "Streamer disabled.",
  };
}

// ---------------------------------------------------------------------------
// Soft delete
// ---------------------------------------------------------------------------

export async function deleteStreamerAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireActor();
  if (isActionState(actor)) return actor;

  const id = streamerIdSchema.safeParse(formData.get("id"));
  if (!id.success) return { status: "error", message: "That streamer id is not valid." };

  // Typed confirmation. Deleting destroys the stored token, so it should not be
  // reachable by a stray click.
  const confirmation = String(formData.get("confirm") ?? "").trim();
  const expected = String(formData.get("streamerCode") ?? "").trim();

  if (confirmation !== expected) {
    return { status: "error", message: `Type ${expected} exactly to confirm.` };
  }

  const outcome = await softDeleteStreamer({ actorId: actor.id, id: id.data });
  if (!outcome.ok) return { status: "error", message: outcome.message };

  revalidatePath("/admin/streamers");
  redirect("/admin/streamers?deleted=1");
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

export async function replaceTokenAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireActor();
  if (isActionState(actor)) return actor;

  const id = streamerIdSchema.safeParse(formData.get("id"));
  if (!id.success) return { status: "error", message: "That streamer id is not valid." };

  const parsed = replaceTokenSchema.safeParse({ pageAccessToken: formData.get("pageAccessToken") });

  if (!parsed.success) {
    // The message only. Never reflect the submitted value — it is the token.
    return {
      status: "error",
      message: parsed.error.issues[0]?.message ?? "That does not look like a Page access token.",
    };
  }

  const outcome = await replaceStreamerToken({
    actorId: actor.id,
    id: id.data,
    token: parsed.data.pageAccessToken,
  });

  if (!outcome.ok) return { status: "error", message: outcome.message };

  revalidatePath("/admin/streamers");
  revalidatePath(`/admin/streamers/${id.data}`);

  return {
    status: "success",
    message: outcome.data.validation.message,
    validation: outcome.data.validation,
  };
}

export async function validateTokenAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireActor();
  if (isActionState(actor)) return actor;

  const id = streamerIdSchema.safeParse(formData.get("id"));
  if (!id.success) return { status: "error", message: "That streamer id is not valid." };

  const outcome = await validateStreamerToken({ actorId: actor.id, id: id.data });
  if (!outcome.ok) return { status: "error", message: outcome.message };

  revalidatePath("/admin/streamers");
  revalidatePath(`/admin/streamers/${id.data}`);

  return {
    status: outcome.data.validation.status === "valid" ? "success" : "error",
    message: outcome.data.validation.message,
    validation: outcome.data.validation,
  };
}

// ---------------------------------------------------------------------------
// Manual sync
// ---------------------------------------------------------------------------

/**
 * Run post synchronisation now.
 *
 * Reports a partial run honestly rather than as a plain success: posts that
 * were collected are real, but the operator needs to know the run was cut short
 * so they can run it again.
 */
export async function syncPostsAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireActor();
  if (isActionState(actor)) return actor;

  const id = streamerIdSchema.safeParse(formData.get("id"));
  if (!id.success) return { status: "error", message: "That streamer id is not valid." };

  const outcome = await syncStreamerPosts({ actorId: actor.id, streamerId: id.data });

  if (!outcome.ok) return { status: "error", message: outcome.message };

  const { result } = outcome;

  revalidatePath("/admin/streamers");
  revalidatePath(`/admin/streamers/${id.data}`);
  revalidatePath("/posts");

  const summary = `${result.postsProcessed} post${result.postsProcessed === 1 ? "" : "s"}, ${result.insightsWritten} metric${result.insightsWritten === 1 ? "" : "s"}`;

  if (result.status === "failed") {
    return {
      status: "error",
      message: `Sync failed. ${result.error?.message ?? "See the sync run for detail."}`,
    };
  }

  if (result.status === "partial") {
    const notes: string[] = [];
    if (result.truncated) notes.push("stopped at the page limit — run again to continue");
    if (result.postsWithInsightErrors > 0) {
      notes.push(`${result.postsWithInsightErrors} post(s) returned no insights`);
    }
    if (result.error) notes.push(result.error.message);

    return {
      status: "error",
      message: `Partial sync: ${summary}. ${notes.join("; ")}.`,
    };
  }

  return { status: "success", message: `Synced ${summary}.` };
}

/**
 * Run video synchronisation now.
 *
 * Same reporting rules as `syncPostsAction`: a partial run is reported as such
 * rather than as a plain success, so the operator knows to run it again.
 */
export async function syncVideosAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireActor();
  if (isActionState(actor)) return actor;

  const id = streamerIdSchema.safeParse(formData.get("id"));
  if (!id.success) return { status: "error", message: "That streamer id is not valid." };

  const outcome = await syncStreamerVideos({ actorId: actor.id, streamerId: id.data });

  if (!outcome.ok) return { status: "error", message: outcome.message };

  const { result } = outcome;

  revalidatePath("/admin/streamers");
  revalidatePath(`/admin/streamers/${id.data}`);
  revalidatePath("/videos");

  const summary = `${result.videosProcessed} video${result.videosProcessed === 1 ? "" : "s"}, ${result.insightsWritten} metric${result.insightsWritten === 1 ? "" : "s"}`;

  if (result.status === "failed") {
    return {
      status: "error",
      message: `Video sync failed. ${result.error?.message ?? "See the sync run for detail."}`,
    };
  }

  if (result.status === "partial") {
    const notes: string[] = [];
    if (result.truncated) notes.push("stopped at the page limit — run again to continue");
    if (result.videosWithInsightErrors > 0) {
      notes.push(`${result.videosWithInsightErrors} video(s) returned no insights`);
    }
    if (result.error) notes.push(result.error.message);

    return { status: "error", message: `Partial sync: ${summary}. ${notes.join("; ")}.` };
  }

  return { status: "success", message: `Synced ${summary}.` };
}

export async function requestSyncAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireActor();
  if (isActionState(actor)) return actor;

  const id = streamerIdSchema.safeParse(formData.get("id"));
  if (!id.success) return { status: "error", message: "That streamer id is not valid." };

  const outcome = await requestManualSync({ actorId: actor.id, id: id.data });
  if (!outcome.ok) return { status: "error", message: outcome.message };

  revalidatePath(`/admin/streamers/${id.data}`);

  return {
    status: "success",
    message: "Manual sync queued. The sync engine that runs it arrives in Phase 5.",
  };
}
