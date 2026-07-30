import { z } from "zod";

import { automationError, automationOk, guardAutomationRequest } from "@/lib/automation/guard";
import { childLogger } from "@/lib/observability/logger";
import { getSyncRunStatus } from "@/lib/repositories/automation-exports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const runIdSchema = z.uuid();

/**
 * GET /api/automation/sync-runs/{id}
 *
 * The state of one run, and of every per-streamer run it spawned.
 *
 * This is the endpoint the documented n8n workflow polls after `sync-all`. Read
 * `finished`: it is derived from the parent's own status, and the parent is
 * closed last, so `finished === true` means the whole sweep is done — there is
 * no window where the parent looks complete while a child is still working.
 *
 * Rate-limited as a read, because polling in a loop is exactly what it is for.
 *
 * Error text is sanitised on the way out. A Graph failure can echo the request
 * that caused it, and a Graph request carries the access token in its query
 * string — forwarding that into an n8n execution log would put a live
 * credential somewhere it was never allowed to be.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = guardAutomationRequest(request, "read");
  if (!guard.ok) return guard.response;

  const { id } = await context.params;
  const parsed = runIdSchema.safeParse(id);

  if (!parsed.success) {
    return automationError(
      400,
      "invalid_id",
      "The sync run id must be a UUID.",
      undefined,
      guard.headers,
    );
  }

  try {
    const run = await getSyncRunStatus(parsed.data);

    if (!run) {
      return automationError(
        404,
        "sync_run_not_found",
        "No such sync run.",
        undefined,
        guard.headers,
      );
    }

    // Children are summed as well as listed: a workflow deciding whether the
    // sweep was worth exporting wants one number, not an array to reduce.
    const childTotals = run.children.reduce(
      (totals, child) => ({
        posts_processed: totals.posts_processed + child.posts_processed,
        videos_processed: totals.videos_processed + child.videos_processed,
        comments_processed: totals.comments_processed + child.comments_processed,
        summaries_generated: totals.summaries_generated + child.summaries_generated,
      }),
      {
        posts_processed: 0,
        videos_processed: 0,
        comments_processed: 0,
        summaries_generated: 0,
      },
    );

    return automationOk(
      {
        sync_run_id: run.sync_run_id,
        status: run.status,
        finished: run.finished,
        sync_type: run.sync_type,
        streamer_id: run.streamer_id,
        streamer_code: run.streamer_code,
        started_at: run.started_at,
        completed_at: run.completed_at,
        duration_seconds: run.duration_seconds,
        error_message: run.error_message,
        totals: {
          posts_processed: run.posts_processed,
          videos_processed: run.videos_processed,
          comments_processed: run.comments_processed,
          summaries_generated: run.summaries_generated,
        },
        child_totals: childTotals,
        child_run_count: run.children.length,
        children: run.children,
        streamers: run.streamers,
      },
      200,
      guard.headers,
    );
  } catch (cause) {
    childLogger({ component: "automation.sync_run_status" }).error("automation.status.failed", {
      error: cause instanceof Error ? cause.message : "unknown",
    });

    return automationError(
      500,
      "status_unavailable",
      "The run status could not be read.",
      undefined,
      guard.headers,
    );
  }
}
