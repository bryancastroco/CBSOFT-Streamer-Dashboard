import { after } from "next/server";
import { desc, eq } from "drizzle-orm";

import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from "@/lib/audit/actions";
import { recordAuditLogSafe } from "@/lib/audit/log";
import { sanitiseThrown } from "@/lib/automation/sanitise";
import { getServerEnv } from "@/config/env";
import { getDb } from "@/lib/db";
import { syncRuns } from "@/lib/db/schema";
import { childLogger } from "@/lib/observability/logger";
import { authenticateMachineRequest, machineAuthErrorResponse } from "@/lib/security/machine-auth";
import { backfillCommentAnalysis } from "@/lib/services/comment-backfill";
import {
  openSyncAllRun,
  reclaimAbandonedSweeps,
  resolveSyncCeilings,
  runSyncAll,
} from "@/lib/services/sync-all";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * The share of the invocation the sweep and the drain may use between them.
 *
 * Below `maxDuration`, with headroom: a function killed at the ceiling returns
 * nothing at all — no counts, no reason, no record that it ran — so the point
 * of a budget is to stop *before* that and say where things stand.
 */
const BACKFILL_WINDOW_MS = 270_000;

/**
 * Below this, do not start draining.
 *
 * A slice with seconds left collects a handful of items and reports a stop
 * reason, which is noise. The next run picks the same work up regardless.
 */
const MIN_BACKFILL_MS = 20_000;

/**
 * Below this, do not start another sweep slice.
 *
 * A slice of five streamers takes about two minutes against a live roster, so
 * this is not enough time to guarantee one finishes — it is enough that trying
 * is worthwhile. Being killed mid-slice is survivable: the run stays open,
 * `reclaimAbandonedSweeps` closes it, and the work already committed is durable
 * per streamer. Starting a slice with ten seconds left is not.
 */
const MIN_SLICE_MS = 60_000;

/**
 * GET /api/cron/daily-sync
 *
 * The scheduled sweep, triggered by Vercel Cron.
 *
 * ## Why this exists alongside `/api/automation/sync-all`
 *
 * They do the same work; they differ in who is trusted to ask, and in what the
 * caller can do with the answer.
 *
 * n8n triggers a sweep and then *stays involved* — it polls the run, reads the
 * exports and writes the spreadsheet. Vercel Cron can do none of that: it fires
 * an HTTP GET and discards the response. So this endpoint is for the deployment
 * that wants collection to keep working when n8n is down, unreachable, or not
 * yet configured. The reporting mirror falls behind; the data does not.
 *
 * Authenticated with `CRON_SECRET` — a different secret from `N8N_API_SECRET`,
 * so an n8n compromise cannot drive the scheduler and rotating one does not
 * disturb the other. Vercel Cron sends it as `Authorization: Bearer …`.
 *
 * ## Overlap protection
 *
 * A sweep can outlive its schedule — a slow Meta day, a large backfill — and two
 * concurrent sweeps against the same Pages double the quota spend and race each
 * other's upserts. So a run already in flight, or one that started more recently
 * than `SYNC_FREQUENCY_HOURS` ago, is answered `200 skipped` rather than
 * starting a second.
 *
 * `200` rather than an error, deliberately: nothing is wrong, and a cron
 * platform that retries on a non-2xx would hammer the endpoint for as long as
 * the first sweep took.
 */
export async function GET(request: Request) {
  const auth = authenticateMachineRequest(request, "cron");

  if (!auth.ok) {
    return machineAuthErrorResponse(auth);
  }

  const log = childLogger({ component: "cron.daily_sync" });
  const env = getServerEnv();
  const db = getDb();

  /*
   * ---- Release anything a platform kill left holding the lock -------------
   *
   * A function killed at `maxDuration` runs no cleanup, so the run row it
   * opened stays `processing` for ever — and the check immediately below then
   * refuses every subsequent sweep, permanently, without raising anything.
   * Collection just stops and the dashboard quietly goes stale.
   *
   * That is not hypothetical: the run opened at 03:17 on 5 August was still
   * `processing` eighteen hours later.
   */
  const reclaimed = await reclaimAbandonedSweeps();
  if (reclaimed > 0) log.warn("cron.reclaimed_abandoned", { runs: reclaimed });

  // ---- Is a sweep already running? ----------------------------------------
  const [inFlight] = await db
    .select({ id: syncRuns.id, startedAt: syncRuns.startedAt })
    .from(syncRuns)
    .where(eq(syncRuns.status, "processing"))
    .orderBy(desc(syncRuns.startedAt))
    .limit(1);

  if (inFlight) {
    log.warn("cron.skipped.in_flight", { syncRunId: inFlight.id });

    return Response.json(
      {
        ok: true,
        skipped: true,
        reason: "sync_in_flight",
        message: "A synchronisation run is already in progress.",
        sync_run_id: inFlight.id,
      },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  }

  // ---- Did one start too recently? ----------------------------------------
  const [lastRun] = await db
    .select({ id: syncRuns.id, startedAt: syncRuns.startedAt })
    .from(syncRuns)
    .where(eq(syncRuns.syncType, "automation"))
    .orderBy(desc(syncRuns.startedAt))
    .limit(1);

  const minimumGapMs = env.SYNC_FREQUENCY_HOURS * 60 * 60 * 1000;

  /*
   * `?force=true` bypasses the gap, for an operator triggering a catch-up by
   * hand. It cannot bypass the in-flight check above — that one is about
   * correctness, not scheduling.
   */
  const forced = new URL(request.url).searchParams.get("force") === "true";

  if (!forced && lastRun) {
    const elapsedMs = Date.now() - lastRun.startedAt.getTime();

    if (elapsedMs < minimumGapMs) {
      const waitMinutes = Math.ceil((minimumGapMs - elapsedMs) / 60_000);
      log.info("cron.skipped.too_soon", { lastRunId: lastRun.id, waitMinutes });

      return Response.json(
        {
          ok: true,
          skipped: true,
          reason: "too_soon",
          message:
            `The last run started ${Math.round(elapsedMs / 60_000)} minutes ago; ` +
            `SYNC_FREQUENCY_HOURS is ${env.SYNC_FREQUENCY_HOURS}.`,
          next_eligible_in_minutes: waitMinutes,
          sync_run_id: lastRun.id,
        },
        { status: 200, headers: { "cache-control": "no-store" } },
      );
    }
  }

  // ---- Start the sweep -----------------------------------------------------
  let syncRunId: string;

  try {
    syncRunId = await openSyncAllRun("vercel_cron");
  } catch (cause) {
    log.error("cron.open_failed", { error: sanitiseThrown(cause) });

    return Response.json(
      { ok: false, error: "sync_run_not_started" },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }

  const ceilings = resolveSyncCeilings();

  await recordAuditLogSafe({
    userId: null,
    action: AUDIT_ACTIONS.automationSyncStarted,
    entityType: AUDIT_ENTITY_TYPES.syncRun,
    entityId: syncRunId,
    metadata: {
      trigger: "cron",
      forced,
      lookbackDays: ceilings.lookbackDays,
      syncFrequencyHours: env.SYNC_FREQUENCY_HOURS,
    },
  });

  /*
   * Return immediately and continue in the background.
   *
   * Nobody is waiting on the body, and holding the connection open for the
   * length of a sweep invites a platform timeout — then a retry, which would
   * start exactly the second sweep this endpoint just went to some trouble to
   * prevent.
   */
  after(async () => {
    const startedAt = Date.now();

    try {
      let result = await runSyncAll({ syncRunId });

      /*
       * ---- Advance the same run until the roster is finished ----------------
       *
       * ## The bug this closes
       *
       * A slice covers `MAX_STREAMERS_PER_SYNC` streamers (5) and hands back a
       * cursor. Nothing here picked it up. n8n is documented to re-POST with
       * `resume_sync_run_id`, but Vercel Cron fires a GET and discards the
       * response, so on a roster of eight the sweep did the first five, left
       * the run `processing`, and stopped.
       *
       * That is worse than truncation. The partial unique index admits one
       * active top-level run, so the next tick was refused outright until
       * `reclaimAbandonedSweeps` marked the run cancelled twenty minutes later
       * — and the run after that started from the top of the roster again,
       * because pending is per-run. The streamers sorting last by code were
       * therefore never reachable *by any run*: STM-006, STM-007 and STM-008
       * read "Synced never" for as long as the roster stayed above five.
       *
       * Nothing about it looked broken. Every run reported
       * `completed_with_errors` with real counts against the streamers it did
       * reach, and the three it never touched simply had no rows to be missing
       * from.
       *
       * The loop stops on the same budget as the drain below, so a roster too
       * large for one invocation still ends the night part-swept rather than
       * killed mid-slice — but it now resumes from where it stopped, because
       * the run stays open and pending is computed from child runs.
       */
      while (!result.finished && BACKFILL_WINDOW_MS - (Date.now() - startedAt) >= MIN_SLICE_MS) {
        const before = result.remaining;

        result = await runSyncAll({ syncRunId });

        /*
         * Stall guard.
         *
         * A streamer skipped for token health returns before opening a child
         * run, and pending is derived from child runs — so it stays pending and
         * the next slice picks it up again. When every streamer in a slice is
         * skipped, `remaining` does not move and this would spin, revalidating
         * the same dead tokens against Meta until the budget ran out.
         */
        if (result.remaining >= before) {
          log.warn("cron.sweep_stalled", { syncRunId, remaining: result.remaining });
          break;
        }
      }

      if (!result.finished) {
        // Not an error: the budget is doing its job. Logged because a run that
        // reports this every night means the roster has outgrown one window.
        log.info("cron.sweep_unfinished", { syncRunId, remaining: result.remaining });
      }

      /*
       * ---- Then drain the backlog with whatever time is left ---------------
       *
       * The sweep only refreshes comments for the ten newest posts and videos
       * per streamer. Everything older is never reached by it at all, so
       * without this the roster stays permanently part-analysed no matter how
       * many nights pass.
       *
       * Ordered after the sweep's run row is closed, deliberately. This work
       * shares the invocation's `maxDuration`, and a function killed here must
       * not be able to leave a sweep stuck in `running` — the one state a
       * polling workflow cannot recover from. By this point the run is
       * finished either way, and the backfill's own progress is durable per
       * item, so being killed mid-drain costs nothing but the remainder.
       *
       * Skipped when streamers are still pending: the next invocation of this
       * run has more sweeping to do, and collecting new content matters more
       * than reaching old content.
       */
      if (result.finished) {
        const remainingMs = BACKFILL_WINDOW_MS - (Date.now() - startedAt);

        if (remainingMs >= MIN_BACKFILL_MS) {
          const backfill = await backfillCommentAnalysis({ timeBudgetMs: remainingMs });

          log.info("cron.backfill_finished", {
            stoppedBecause: backfill.stoppedBecause,
            collected: backfill.collection.collected,
            analysed: backfill.analysis.completed + backfill.analysis.noComments,
            remaining: backfill.remaining,
          });
        } else {
          log.info("cron.backfill_skipped", { reason: "no_time_left", remainingMs });
        }
      }
    } catch (cause) {
      // `runSyncAll` closes its own run on failure; this is the last resort. An
      // uncaught rejection would leave the run stuck in `running`, and the
      // in-flight check above would then refuse every subsequent tick.
      log.error("cron.unhandled", { syncRunId, error: sanitiseThrown(cause) });
    }
  });

  log.info("cron.started", { syncRunId, forced });

  return Response.json(
    {
      ok: true,
      skipped: false,
      sync_run_id: syncRunId,
      status: "processing",
      poll_url: `/api/automation/sync-runs/${syncRunId}`,
      lookback_days: ceilings.lookbackDays,
      message: "Synchronisation started.",
    },
    { status: 202, headers: { "cache-control": "no-store" } },
  );
}
