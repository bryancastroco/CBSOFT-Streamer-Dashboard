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
import { openSyncAllRun, resolveSyncCeilings, runSyncAll } from "@/lib/services/sync-all";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

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

  // ---- Is a sweep already running? ----------------------------------------
  const [inFlight] = await db
    .select({ id: syncRuns.id, startedAt: syncRuns.startedAt })
    .from(syncRuns)
    .where(eq(syncRuns.status, "running"))
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
    syncRunId = await openSyncAllRun();
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
    try {
      await runSyncAll({ syncRunId });
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
      status: "running",
      poll_url: `/api/automation/sync-runs/${syncRunId}`,
      lookback_days: ceilings.lookbackDays,
      message: "Synchronisation started.",
    },
    { status: 202, headers: { "cache-control": "no-store" } },
  );
}
