import { z } from "zod";

import {
  automationError,
  automationOk,
  guardAutomationRequest,
  readAutomationBody,
} from "@/lib/automation/guard";
import { sanitiseThrown } from "@/lib/automation/sanitise";
import { childLogger } from "@/lib/observability/logger";
import {
  backfillCommentAnalysis,
  BACKFILL_ANALYSIS_THROTTLE_MS,
  BACKFILL_MAX_ANALYSES,
  BACKFILL_MAX_COLLECT,
  BACKFILL_TIME_BUDGET_MS,
} from "@/lib/services/comment-backfill";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** See the note in `sync-all/route.ts`: 300 is the ceiling that works on Hobby. */
export const maxDuration = 300;

/**
 * POST /api/automation/comments/backfill
 *
 * Advance every piece of content towards a stored comment analysis, a bounded
 * slice at a time.
 *
 * The nightly sweep covers the ten newest posts and videos per streamer, which
 * is right for a sweep and leaves everything older permanently unanalysed. This
 * walks the rest. Two stages: collect comments for content whose comments edge
 * has never been walked, then analyse content that has comments and no usable
 * summary.
 *
 * ## Why it stops early and says so
 *
 * Same reasoning as the metric rollup: a function killed by the platform
 * returns nothing at all, so the honest response to a queue larger than one
 * invocation is to stop inside the budget and report where things stand. Repeat
 * the request until `finished` is true — there is no cursor to carry, because
 * progress lives in the data (`comments_synced_at`, and the presence of a
 * settled summary) rather than in a checkpoint.
 *
 * `stopped_because` is the field worth reading. `budget` and `time` mean call
 * again now. `provider_unavailable` means the AI provider refused in a way that
 * would repeat — calling again immediately will not help, and the reason is on
 * `/admin/ai`.
 */
const bodySchema = z.object({
  max_collect: z.coerce.number().int().min(1).max(2000).optional(),
  max_analyses: z.coerce.number().int().min(1).max(500).optional(),
  throttle_ms: z.coerce.number().int().min(0).max(60_000).optional(),
  time_budget_ms: z.coerce.number().int().min(1_000).max(280_000).optional(),
  /** Run one stage only. Omit for both. */
  stages: z.array(z.enum(["collection", "analysis"])).min(1).optional(),
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
  const log = childLogger({ component: "automation.comment_backfill", requestId: guard.requestId });

  try {
    const summary = await backfillCommentAnalysis({
      ...(input.max_collect !== undefined ? { maxCollect: input.max_collect } : {}),
      ...(input.max_analyses !== undefined ? { maxAnalyses: input.max_analyses } : {}),
      ...(input.throttle_ms !== undefined ? { throttleMs: input.throttle_ms } : {}),
      ...(input.time_budget_ms !== undefined ? { timeBudgetMs: input.time_budget_ms } : {}),
      ...(input.stages ? { stages: input.stages } : {}),
    });

    return automationOk(
      {
        finished: summary.finished,
        stopped_because: summary.stoppedBecause,
        collection: {
          attempted: summary.collection.attempted,
          collected: summary.collection.collected,
          comments_stored: summary.collection.commentsStored,
          failed: summary.collection.failed,
        },
        analysis: {
          attempted: summary.analysis.attempted,
          completed: summary.analysis.completed,
          no_comments: summary.analysis.noComments,
          already_current: summary.analysis.unchanged,
          failed: summary.analysis.failed,
        },
        remaining: {
          awaiting_collection: summary.remaining.awaitingCollection,
          awaiting_analysis: summary.remaining.awaitingAnalysis,
        },
        duration_ms: summary.durationMs,
        errors: summary.errors,
        defaults_applied: {
          max_collect: input.max_collect ?? BACKFILL_MAX_COLLECT,
          max_analyses: input.max_analyses ?? BACKFILL_MAX_ANALYSES,
          throttle_ms: input.throttle_ms ?? BACKFILL_ANALYSIS_THROTTLE_MS,
          time_budget_ms: input.time_budget_ms ?? BACKFILL_TIME_BUDGET_MS,
        },
        message: describe(summary.finished, summary.stoppedBecause),
      },
      200,
      guard.headers,
    );
  } catch (cause) {
    log.error("automation.comment_backfill.failed", { error: sanitiseThrown(cause) });

    return automationError(
      500,
      "backfill_failed",
      "The comment backfill could not be completed.",
      undefined,
      guard.headers,
    );
  }
}

function describe(finished: boolean, stop: string): string {
  if (finished) return "Every piece of content has a stored comment analysis.";

  switch (stop) {
    case "provider_unavailable":
      return "The AI provider refused in a way that would repeat, so the run stopped rather than failing every remaining item. See /admin/ai for the reason.";
    case "analysis_disabled":
      return "Comments were collected. Analysis is switched off — set AI_SUMMARIZATION_ENABLED to true.";
    case "time":
      return "The wall-clock budget was reached. POST again to continue.";
    default:
      return "The per-run ceiling was reached. POST again to continue.";
  }
}
