"use server";

import { revalidatePath } from "next/cache";

import type { ActionState } from "@/lib/forms/action-state";
import { AuthorizationError, assertAdmin } from "@/lib/auth/guards";
import { setGameFilterOptions } from "@/lib/repositories/app-settings";
import { deleteGame, saveGame, setStreamerGames } from "@/lib/repositories/games";
import { resolveContentGames } from "@/lib/services/resolve-games";
import { gameFormSchema, streamerGamesSchema } from "@/lib/validation/games";

/**
 * Server Actions for the games registry.
 *
 * Every one begins with `assertAdmin()`. A Server Action is an ordinary POST
 * endpoint; the check belongs here and not in the component rendering the form.
 *
 * ## Why each one re-resolves attribution
 *
 * Editing a hashtag or a primary game changes what every existing post is
 * *about*. Leaving that until the next nightly sweep would mean an admin adds a
 * tag, reloads, sees no change, and reasonably concludes the feature is broken.
 * The pass is a few queries over the roster, so it runs inline.
 */

async function requireActor(): Promise<{ id: string } | ActionState> {
  try {
    const actor = await assertAdmin();
    return { id: actor.id };
  } catch (error) {
    if (error instanceof AuthorizationError) return { status: "error", message: error.message };
    throw error;
  }
}

function isActionState(value: unknown): value is ActionState {
  return typeof value === "object" && value !== null && "status" in value;
}

function fieldErrorsFrom(issues: { path: PropertyKey[]; message: string }[]): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of issues) {
    const key = String(issue.path[0] ?? "");
    if (key && !errors[key]) errors[key] = issue.message;
  }
  return errors;
}

/** Everything the registry touched, so a stale game filter cannot linger. */
function revalidateGameSurfaces(): void {
  revalidatePath("/admin/games");
  revalidatePath("/dashboard");
  revalidatePath("/posts");
  revalidatePath("/videos");
  revalidatePath("/comment-analysis");
  revalidatePath("/streamers");
}

export async function saveGameAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireActor();
  if (isActionState(actor)) return actor;

  const parsed = gameFormSchema.safeParse({
    ...(formData.get("id") ? { id: String(formData.get("id")) } : {}),
    name: formData.get("name"),
    slug: formData.get("slug") ?? "",
    notes: formData.get("notes") ?? "",
    active: formData.get("active") === "on" || formData.get("active") === "true",
    hashtags: formData.get("hashtags") ?? "",
  });

  if (!parsed.success) {
    return {
      status: "error",
      message: "Check the highlighted fields.",
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const input = parsed.data;

  const outcome = await saveGame({
    actorId: actor.id,
    ...(input.id ? { id: input.id } : {}),
    name: input.name,
    slug: input.slug,
    active: input.active,
    notes: input.notes,
    hashtags: input.hashtags,
  });

  if (!outcome.ok) {
    return {
      status: "error",
      message: outcome.message,
      fieldErrors:
        outcome.reason === "duplicate_tag"
          ? { hashtags: outcome.message }
          : outcome.reason === "duplicate_slug"
            ? { slug: outcome.message }
            : outcome.reason === "duplicate_name"
              ? { name: outcome.message }
              : undefined,
    };
  }

  const resolved = await resolveContentGames();
  revalidateGameSurfaces();

  /*
   * The rejected list is reported rather than swallowed. One malformed entry in
   * a pasted list is saved around, not saved silently — an operator who typed
   * `#cabal-pc` should learn it became nothing rather than assume it worked.
   */
  const rejected =
    input.rejectedHashtags.length > 0
      ? ` Ignored ${input.rejectedHashtags.length} entry that is not a usable hashtag: ${input.rejectedHashtags.join(", ")}.`
      : "";

  return {
    status: "success",
    message:
      `Saved. ${resolved.postsUpdated} post(s) and ${resolved.videosUpdated} video(s) re-filed.` +
      rejected,
  };
}

export async function deleteGameAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireActor();
  if (isActionState(actor)) return actor;

  const id = String(formData.get("id") ?? "");
  const confirmation = String(formData.get("confirm") ?? "").trim();
  const expected = String(formData.get("gameName") ?? "").trim();

  // Typed confirmation, because deleting unfiles every post attributed to it.
  if (confirmation !== expected) {
    return { status: "error", message: `Type ${expected} exactly to confirm.` };
  }

  const outcome = await deleteGame({ actorId: actor.id, id });
  if (!outcome.ok) return { status: "error", message: outcome.message };

  await resolveContentGames();
  revalidateGameSurfaces();

  return { status: "success", message: `${outcome.data.name} deleted. Its content was kept.` };
}

/**
 * Which wide entries the Game control offers.
 *
 * Booleans arrive as the strings a hidden input carries — a shadcn Switch is a
 * button and submits nothing of its own. Compared against `"true"` rather than
 * coerced, so anything unexpected reads as off, which is the safe direction:
 * an entry that fails to appear is visible, one that appears unbidden is not.
 */
export async function setGameFilterOptionsAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireActor();
  if (isActionState(actor)) return actor;

  const options = {
    showAllContent: formData.get("showAllContent") === "true",
    showUnregistered: formData.get("showUnregistered") === "true",
  };

  await setGameFilterOptions({ actorId: actor.id, options });

  // Every screen with a filter bar, because the control is on all of them.
  revalidateGameSurfaces();

  const shown = [
    options.showAllContent ? "All content" : null,
    options.showUnregistered ? "Not registered games" : null,
  ].filter((label): label is string => label !== null);

  return {
    status: "success",
    message:
      shown.length > 0
        ? `Saved. The Game filter now also offers ${shown.join(" and ")}.`
        : "Saved. The Game filter now offers registered games only.",
  };
}

export async function setStreamerGamesAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireActor();
  if (isActionState(actor)) return actor;

  const primary = String(formData.get("primaryGameId") ?? "");

  const parsed = streamerGamesSchema.safeParse({
    streamerId: formData.get("streamerId"),
    gameIds: formData.getAll("gameIds").map(String),
    primaryGameId: primary.length > 0 ? primary : null,
  });

  if (!parsed.success) {
    return { status: "error", message: parsed.error.issues[0]?.message ?? "Check the selection." };
  }

  const outcome = await setStreamerGames({
    actorId: actor.id,
    streamerId: parsed.data.streamerId,
    gameIds: parsed.data.gameIds,
    primaryGameId: parsed.data.primaryGameId ?? null,
  });

  if (!outcome.ok) return { status: "error", message: outcome.message };

  // Scoped to this streamer: their untagged content is the only attribution
  // that could have moved.
  const resolved = await resolveContentGames({ streamerId: parsed.data.streamerId });
  revalidateGameSurfaces();
  revalidatePath(`/streamers/${parsed.data.streamerId}`);
  revalidatePath(`/admin/streamers/${parsed.data.streamerId}`);

  return {
    status: "success",
    message: `Saved ${outcome.data.count} game(s). ${resolved.postsUpdated} post(s) re-filed.`,
  };
}
