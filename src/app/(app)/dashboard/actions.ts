"use server";

import { revalidatePath } from "next/cache";

import { AuthorizationError, assertAdmin } from "@/lib/auth/guards";
import type { ActionState } from "@/lib/forms/action-state";
import {
  SweepAlreadyRunningError,
  openSyncAllRun,
  runSyncAll,
} from "@/lib/services/sync-all";

/**
 * Sweep every streamer from the dashboard.
 *
 * The same code path the nightly cron and n8n use — `openSyncAllRun` then
 * `runSyncAll` — differing only in the trigger source it records, so the sync
 * history can answer "did a person do this or did the schedule".
 *
 * ## Why it blocks rather than returning immediately
 *
 * The automation route opens a run, returns the id, and lets a workflow poll.
 * That is right for n8n and wrong here: an admin who clicks a button and is told
 * "started" has learned nothing, and would have to go and look at Sync history
 * to find out whether it worked.
 *
 * So this waits and reports what happened. The cost is a slow button, which is
 * honest — the work genuinely takes that long.
 *
 * ## What happens when the roster outgrows one invocation
 *
 * `runSyncAll` processes what fits in its time budget and reports `finished`
 * and `remaining`. The parent run stays open, and invoking the sweep again
 * advances it. The message says so, because a partial result presented as a
 * complete one is how a roster silently stops being synced.
 */
export async function syncAllAction(
  _previous: ActionState,
  _formData: FormData,
): Promise<ActionState> {
  try {
    await assertAdmin();
  } catch (error) {
    if (error instanceof AuthorizationError) return { status: "error", message: error.message };
    throw error;
  }

  let result;

  try {
    // `openSyncAllRun` reclaims abandoned sweeps first, so a run killed by a
    // platform timeout does not block this one forever.
    const syncRunId = await openSyncAllRun("admin");
    result = await runSyncAll({ syncRunId });
  } catch (error) {
    if (error instanceof SweepAlreadyRunningError) {
      return {
        status: "error",
        message:
          "A synchronisation is already running — the nightly sweep, or another admin. Wait for it to finish and check Sync history.",
      };
    }
    throw error;
  }

  // Everything a sweep can change. The dashboard and the content lists all read
  // tables it wrote to, and leaving them cached would show the previous state
  // beside a message saying it had just been updated.
  for (const path of [
    "/dashboard",
    "/posts",
    "/videos",
    "/comment-analysis",
    "/streamers",
    "/admin/streamers",
    "/admin/sync-logs",
  ]) {
    revalidatePath(path);
  }

  const collected = [
    `${result.postsProcessed} post(s)`,
    `${result.videosProcessed} video(s)`,
    `${result.commentsProcessed} comment(s)`,
  ].join(", ");

  /*
   * Skipped is reported alongside failed rather than folded into it.
   *
   * A streamer skipped for an unusable token has not failed — nothing was
   * attempted, deliberately, because spending Graph quota on a Page whose
   * credential is known bad achieves nothing. But it does mean their numbers
   * are stale, and an admin reading "12 succeeded" without it would not know.
   */
  const trouble = [
    result.streamersFailed > 0 ? `${result.streamersFailed} failed` : null,
    result.streamersSkipped > 0 ? `${result.streamersSkipped} skipped` : null,
  ].filter((part): part is string => part !== null);

  const summary =
    `Synced ${result.streamersSucceeded} of ${result.streamersTotal} streamer(s): ${collected}.` +
    (trouble.length > 0 ? ` ${trouble.join(", ")} — see Sync history.` : "") +
    (result.finished
      ? ""
      : ` ${result.remaining} streamer(s) still to go — run it again to continue.`);

  return {
    // A sweep that finished with failures is not a success, and calling it one
    // would hide exactly the outcome worth acting on.
    status: result.status === "failed" || result.streamersFailed > 0 ? "error" : "success",
    message: summary,
  };
}
