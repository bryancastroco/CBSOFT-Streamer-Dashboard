import { after } from "next/server";
import { z } from "zod";

import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from "@/lib/audit/actions";
import { recordAuditLogSafe } from "@/lib/audit/log";
import {
  automationError,
  automationOk,
  guardAutomationRequest,
  readAutomationBody,
} from "@/lib/automation/guard";
import { sanitiseThrown } from "@/lib/automation/sanitise";
import { childLogger } from "@/lib/observability/logger";
import { getSyncRunStatus } from "@/lib/repositories/automation-exports";
import {
  openSyncAllRun,
  runSyncAll,
  SweepAlreadyRunningError,
  SYNC_ALL_DEFAULTS,
} from "@/lib/services/sync-all";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/**
 * 300 seconds, not 800.
 *
 * Vercel's ceiling depends on the plan: Hobby allows up to 300s, Pro up to 800s
 * and only with Fluid Compute enabled. A route declaring 800 fails to deploy on
 * Hobby, so the value here is the one that works everywhere. It is a ceiling,
 * not a target — a slice is sized by `MAX_STREAMERS_PER_SYNC` to finish well
 * inside it, and the sweep is resumed across invocations rather than stretched
 * to fit one.
 *
 * Raising this alone does not make a long sweep safe; it only moves where the
 * truncation happens. Prefer a smaller slice.
 */
export const maxDuration = 300;

/**
 * POST /api/automation/sync-all
 *
 * Starts a synchronisation sweep of every active streamer and returns a run id
 * immediately. n8n saves the id, waits, then polls
 * `GET /api/automation/sync-runs/{id}` until `finished` is true.
 *
 * ## Why it returns before the work is done
 *
 * A sweep of a real roster takes minutes. Holding the HTTP connection open for
 * that long means the workflow's request times out somewhere it cannot control
 * — an n8n node default, a proxy, a platform limit — and n8n retries, starting a
 * *second* sweep against the same Pages. Returning a run id and polling makes
 * the duration irrelevant, which is why the documented workflow is shaped that
 * way. `after()` keeps the work running once the response has been sent.
 *
 * Pass `{"mode": "wait"}` to run synchronously and get the full result in the
 * response instead. That is for a small roster and for verifying a new
 * deployment by hand; a scheduled workflow should use the default.
 *
 * ## What n8n does not get
 *
 * A Page token, in either direction. The body is screened and a request
 * carrying credential material is refused (`400 token_material_refused`); the
 * response carries counters and sanitised messages. Every Graph call happens
 * here, on the server, through `withStreamerToken`.
 */
const bodySchema = z.object({
  mode: z.enum(["async", "wait"]).default("async"),
  /** Only collect content published after this instant. */
  since: z.iso.datetime().optional(),
  max_pages: z.coerce.number().int().min(1).max(50).optional(),
  concurrency: z.coerce.number().int().min(1).max(8).optional(),
  max_posts_for_comments: z.coerce.number().int().min(0).max(100).optional(),
  max_videos_for_comments: z.coerce.number().int().min(0).max(100).optional(),
  skip_comments: z.boolean().optional(),
  skip_token_validation: z.boolean().optional(),
  /** Streamers this invocation may process. Defaults to MAX_STREAMERS_PER_SYNC. */
  max_streamers: z.coerce.number().int().min(1).max(200).optional(),
  /**
   * Continue an existing run instead of opening a new one.
   *
   * How a roster larger than one function window gets finished: the caller
   * repeats the request with the id it was given until `remaining` is 0.
   */
  resume_sync_run_id: z.uuid().optional(),
});

export async function POST(request: Request) {
  const guard = guardAutomationRequest(request, "write");
  if (!guard.ok) return guard.response;

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

  const input = parsed.data;
  const log = childLogger({ component: "automation.sync_all" });

  const options = {
    ...(input.since ? { since: new Date(input.since) } : {}),
    ...(input.max_pages !== undefined ? { maxPages: input.max_pages } : {}),
    ...(input.concurrency !== undefined ? { concurrency: input.concurrency } : {}),
    ...(input.max_posts_for_comments !== undefined
      ? { maxPostsForComments: input.max_posts_for_comments }
      : {}),
    ...(input.max_videos_for_comments !== undefined
      ? { maxVideosForComments: input.max_videos_for_comments }
      : {}),
    ...(input.skip_comments !== undefined ? { skipComments: input.skip_comments } : {}),
    ...(input.skip_token_validation !== undefined
      ? { skipTokenValidation: input.skip_token_validation }
      : {}),
    ...(input.max_streamers !== undefined ? { maxStreamers: input.max_streamers } : {}),
  };

  let syncRunId: string;
  const resuming = input.resume_sync_run_id !== undefined;

  try {
    if (input.resume_sync_run_id) {
      /*
       * Resuming: the run must exist and still be open. Refusing a closed run
       * matters — silently reopening one would let a retry append a second
       * sweep's results to a run an operator already read as finished.
       */
      const existing = await getSyncRunStatus(input.resume_sync_run_id);

      if (!existing) {
        return automationError(
          404,
          "sync_run_not_found",
          "No such sync run to resume.",
          undefined,
          guard.headers,
        );
      }

      if (existing.finished) {
        return automationError(
          409,
          "sync_run_already_finished",
          "That sync run has already completed. Start a new one.",
          { status: existing.status },
          guard.headers,
        );
      }

      syncRunId = input.resume_sync_run_id;
    } else {
      syncRunId = await openSyncAllRun("n8n");
    }
  } catch (cause) {
    /*
     * A sweep already running is not a server fault — it is the concurrency
     * guard doing its job, and 409 is what tells a workflow to back off rather
     * than retry into the same wall. 500 would make n8n retry and lose.
     */
    if (cause instanceof SweepAlreadyRunningError) {
      return automationError(
        409,
        "sync_already_running",
        "A synchronisation sweep is already in progress. Poll it instead of starting another.",
        undefined,
        guard.headers,
      );
    }

    log.error("automation.sync_all.open_failed", { error: sanitiseThrown(cause) });

    return automationError(
      500,
      "sync_run_not_started",
      "The synchronisation run could not be started.",
      undefined,
      guard.headers,
    );
  }

  // Only a genuinely new run is a "sync started". Auditing every resume would
  // turn one sweep into a dozen indistinguishable entries.
  if (!resuming) {
    await recordAuditLogSafe({
      userId: null,
      action: AUDIT_ACTIONS.automationSyncStarted,
      entityType: AUDIT_ENTITY_TYPES.syncRun,
      entityId: syncRunId,
      metadata: { mode: input.mode, ...options, since: input.since ?? null },
    });
  }

  // ---- Synchronous mode ----------------------------------------------------
  if (input.mode === "wait") {
    const result = await runSyncAll({ syncRunId, options });

    return automationOk(
      {
        sync_run_id: result.syncRunId,
        mode: "wait",
        status: result.status,
        finished: result.finished,
        remaining_streamers: result.remaining,
        resumed: resuming,
        summary: {
          streamers_total: result.streamersTotal,
          streamers_succeeded: result.streamersSucceeded,
          streamers_failed: result.streamersFailed,
          streamers_skipped: result.streamersSkipped,
          posts_processed: result.postsProcessed,
          videos_processed: result.videosProcessed,
          comments_processed: result.commentsProcessed,
          summaries_generated: result.summariesGenerated,
        },
        started_at: result.startedAt,
        completed_at: result.completedAt,
        streamers: result.streamers,
      },
      200,
      guard.headers,
    );
  }

  // ---- Asynchronous mode (the default) ------------------------------------
  after(async () => {
    try {
      await runSyncAll({ syncRunId, options });
    } catch (cause) {
      // `runSyncAll` catches its own failures and closes the run; this is the
      // last resort. An uncaught rejection here would leave the run stuck in
      // `running`, which is the one state a polling workflow cannot recover
      // from — it would poll forever.
      log.error("automation.sync_all.unhandled", { syncRunId, error: sanitiseThrown(cause) });
    }
  });

  return automationOk(
    {
      sync_run_id: syncRunId,
      mode: "async",
      status: "running",
      finished: false,
      resumed: resuming,
      poll_url: `/api/automation/sync-runs/${syncRunId}`,
      resume_url: "/api/automation/sync-all",
      defaults_applied: {
        max_pages: options.maxPages ?? SYNC_ALL_DEFAULTS.maxPages,
        concurrency: options.concurrency ?? SYNC_ALL_DEFAULTS.concurrency,
        max_posts_for_comments:
          options.maxPostsForComments ?? SYNC_ALL_DEFAULTS.maxPostsForComments,
        max_videos_for_comments:
          options.maxVideosForComments ?? SYNC_ALL_DEFAULTS.maxVideosForComments,
      },
      message:
        "The sweep is running. Poll poll_url until finished is true. If the run " +
        "reports remaining streamers, POST here again with resume_sync_run_id " +
        "set to this sync_run_id to advance it, then read the exports.",
    },
    202,
    guard.headers,
  );
}
