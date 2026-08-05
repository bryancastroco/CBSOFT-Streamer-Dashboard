import { after } from "next/server";

import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from "@/lib/audit/actions";
import { recordAuditLogSafe } from "@/lib/audit/log";
import { sanitiseThrown } from "@/lib/automation/sanitise";
import { childLogger } from "@/lib/observability/logger";
import { authenticateMachineRequest, machineAuthErrorResponse } from "@/lib/security/machine-auth";
import { countCommentBacklog } from "@/lib/repositories/comment-backlog";
import { backfillCommentAnalysis } from "@/lib/services/comment-backfill";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * GET /api/cron/comment-backfill
 *
 * The scheduled drain, so that "every post has an analysis" needs nobody to
 * press anything.
 *
 * ## Why it is separate from the nightly sweep
 *
 * The sweep spends Meta quota on collecting *new* content and is sized to
 * finish inside one function window with the whole roster in it. The backfill
 * spends its time on *old* content and, on a roster this size, needs several
 * windows to get through. Bolting it onto the sweep would mean either a sweep
 * that gets killed by the platform, or a backfill so small it never finishes —
 * and a sweep killed mid-flight leaves its run row stuck, which is the one
 * state a polling workflow cannot recover from.
 *
 * Separate schedules also mean a backfill that goes wrong cannot stop new
 * content being collected, which is the more valuable of the two jobs.
 *
 * ## Why there is no overlap guard
 *
 * There is nothing to guard. Both stages claim their work from durable state
 * and every write is an upsert keyed on the content item, so two concurrent
 * runs would at worst do the same item twice — wasteful, not wrong. The sweep
 * needs a guard because it opens a run row; this opens nothing.
 */
export async function GET(request: Request) {
  const auth = authenticateMachineRequest(request, "cron");

  if (!auth.ok) {
    return machineAuthErrorResponse(auth);
  }

  const log = childLogger({ component: "cron.comment_backfill" });

  /*
   * Counted before starting, and returned immediately.
   *
   * Vercel Cron fires an HTTP GET and discards the response, so this body is
   * for a human running the same URL by hand. The backlog figure is the one
   * thing worth having in front of them, and it is two index-only counts.
   */
  const before = await countCommentBacklog();

  if (before.awaitingCollection === 0 && before.awaitingAnalysis === 0) {
    log.info("cron.comment_backfill.nothing_to_do");

    return Response.json(
      {
        ok: true,
        skipped: true,
        reason: "backlog_empty",
        message: "Every piece of content already has a stored comment analysis.",
      },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  }

  await recordAuditLogSafe({
    userId: null,
    action: AUDIT_ACTIONS.commentBackfillStarted,
    entityType: AUDIT_ENTITY_TYPES.syncRun,
    entityId: null,
    metadata: {
      trigger: "cron",
      awaitingCollection: before.awaitingCollection,
      awaitingAnalysis: before.awaitingAnalysis,
    },
  });

  // Returned immediately and continued in the background: nobody is waiting on
  // the body, and holding the connection open for four minutes invites a
  // platform timeout and then a retry.
  after(async () => {
    try {
      await backfillCommentAnalysis();
    } catch (cause) {
      log.error("cron.comment_backfill.unhandled", { error: sanitiseThrown(cause) });
    }
  });

  log.info("cron.comment_backfill.started", before);

  return Response.json(
    {
      ok: true,
      skipped: false,
      status: "processing",
      backlog_at_start: {
        awaiting_collection: before.awaitingCollection,
        awaiting_analysis: before.awaitingAnalysis,
      },
      message: "Comment backfill started. Progress is visible on /admin/ai.",
    },
    { status: 202, headers: { "cache-control": "no-store" } },
  );
}
