import { z } from "zod";

import {
  automationError,
  automationOk,
  guardAutomationRequest,
  readAutomationBody,
} from "@/lib/automation/guard";
import { sanitiseThrown } from "@/lib/automation/sanitise";
import { getServerEnv } from "@/config/env";
import { childLogger } from "@/lib/observability/logger";
import {
  countUnrolledContent,
  rollUpMetrics,
  ROLLUP_BATCH_SIZE,
  ROLLUP_MAX_BATCHES,
  ROLLUP_TIME_BUDGET_MS,
  type RollupCursor,
} from "@/lib/services/metric-rollup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** See the note in `sync-all/route.ts`: 300 is the ceiling that works on Hobby. */
export const maxDuration = 300;

/**
 * POST /api/automation/metrics/rollup
 *
 * Resolve stored Meta insights into the canonical metric tables. No Graph call
 * happens here and no Meta quota is spent — it reads `post_insights` and
 * `video_insights`, which the sync already collected, and writes
 * `content_metrics_current` and `content_metric_snapshots`.
 *
 * ## Why it hands back a cursor instead of just finishing
 *
 * A full roster does not fit in one function invocation, and the honest
 * response to that is to stop early and say where. The service works to a batch
 * count and a wall-clock budget, both well inside `maxDuration`; when either
 * runs out it returns `finished: false` and a cursor. Repeat the request with
 * that cursor until `finished` is true.
 *
 * The alternative — raising `maxDuration` until the sweep fits — only moves
 * where the truncation happens, and a truncated sweep leaves the table
 * half-populated with nothing recording how far it got. That is the failure
 * this endpoint exists to make impossible.
 *
 * `only_missing` is the cheaper resume: it skips content that already has a
 * canonical row, so an interrupted backfill can be finished without a cursor at
 * all. Progress is durable in the data rather than in a checkpoint.
 */
const cursorSchema = z.object({
  stage: z.enum(["posts", "videos"]),
  after: z.uuid().nullable(),
});

const bodySchema = z.object({
  /** Limit the sweep to one streamer. */
  streamer_id: z.uuid().optional(),
  batch_size: z.coerce.number().int().min(1).max(500).optional(),
  max_batches: z.coerce.number().int().min(1).max(200).optional(),
  time_budget_ms: z.coerce.number().int().min(1_000).max(280_000).optional(),
  /** Only roll up content that has no canonical row yet. */
  only_missing: z.boolean().optional(),
  /** Continue a sweep that returned `finished: false`. */
  cursor: cursorSchema.nullish(),
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
  const log = childLogger({ component: "automation.metrics_rollup", requestId: guard.requestId });

  try {
    const summary = await rollUpMetrics({
      graphApiVersion: getServerEnv().META_GRAPH_API_VERSION,
      ...(input.streamer_id ? { streamerId: input.streamer_id } : {}),
      ...(input.batch_size !== undefined ? { batchSize: input.batch_size } : {}),
      ...(input.max_batches !== undefined ? { maxBatches: input.max_batches } : {}),
      ...(input.time_budget_ms !== undefined ? { timeBudgetMs: input.time_budget_ms } : {}),
      ...(input.only_missing !== undefined ? { onlyMissing: input.only_missing } : {}),
      ...(input.cursor ? { cursor: input.cursor as RollupCursor } : {}),
    });

    /*
     * Counted after the sweep, not before. It is the one number that answers
     * "is the backfill actually done", independently of what the summary
     * claims, and it costs two aggregate queries.
     */
    const remaining = await countUnrolledContent();

    return automationOk(
      {
        finished: summary.finished,
        cursor: summary.cursor,
        remaining_without_metrics: remaining,
        summary: {
          processed: summary.processed,
          succeeded: summary.succeeded,
          failed: summary.failed,
          current_rows_written: summary.currentUpdated,
          snapshots_written: summary.snapshotsWritten,
          snapshots_skipped_as_unchanged: summary.snapshotsSkipped,
          values_retained_from_previous: summary.retained,
          warnings: summary.warnings,
          batches: summary.batches,
          queries: summary.queries,
          duration_ms: summary.durationMs,
        },
        failures: summary.failures,
        defaults_applied: {
          batch_size: input.batch_size ?? ROLLUP_BATCH_SIZE,
          max_batches: input.max_batches ?? ROLLUP_MAX_BATCHES,
          time_budget_ms: input.time_budget_ms ?? ROLLUP_TIME_BUDGET_MS,
          only_missing: input.only_missing ?? false,
        },
        message: summary.finished
          ? "Every piece of content has a canonical metric row."
          : "Budget reached. POST again with this cursor, or with only_missing true, to continue.",
      },
      200,
      guard.headers,
    );
  } catch (cause) {
    log.error("automation.metrics_rollup.failed", { error: sanitiseThrown(cause) });

    return automationError(
      500,
      "rollup_failed",
      "The metric rollup could not be completed.",
      undefined,
      guard.headers,
    );
  }
}
