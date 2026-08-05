import "server-only";

import { getServerEnv } from "@/config/env";
import { sanitiseMetaError, sanitiseThrown } from "@/lib/automation/sanitise";
import { childLogger } from "@/lib/observability/logger";
import {
  countCommentBacklog,
  listContentAwaitingAnalysis,
  listContentAwaitingCollection,
  toContentRef,
  type BacklogItem,
} from "@/lib/repositories/comment-backlog";
import { syncContentComments } from "@/lib/services/sync-comments";

/**
 * The unattended drain that gets every piece of content to a stored analysis.
 *
 * ## The gap this closes
 *
 * The nightly sweep refreshes comments for the ten newest posts and ten newest
 * videos per streamer. That ceiling is right for a *sweep* — each item costs its
 * own paginated walk of the comments edge, and engagement on a Facebook post is
 * heavily front-loaded, so re-walking a hundred old posts every night buys
 * almost nothing. But it also means content outside that window is never
 * reached at all, no matter how many nights pass. A roster of sixteen hundred
 * posts stays at eighteen analysed for ever.
 *
 * This walks the rest, a bounded slice per invocation, and stops. Progress is
 * durable in the data — `comments_synced_at` for collection, the presence of a
 * settled summary for analysis — so there is no checkpoint to lose and any run
 * can be interrupted at any point without repeating or skipping work.
 *
 * ## Two stages, two budgets
 *
 * Collection is bounded by Meta Graph quota and runs at Graph speed. Analysis
 * is bounded by the provider's requests per minute — on Gemini's free tier,
 * single figures — and must be paced. Running them as one loop would drag the
 * whole drain down to the model's rate, turning a two-night job into a
 * fortnight, so collection defers the model call and the analysis stage picks
 * the work up afterwards.
 *
 * ## Why it stops rather than pushes through
 *
 * A provider failure is not per-item. A rate limit means the next fifty
 * attempts fail too; a rejected key means all fifteen hundred do. So the first
 * provider-level failure ends the analysis stage and is reported. The
 * alternative — carrying on — writes a `failed` row against every remaining
 * item, and the operator then has to distinguish fifteen hundred symptoms from
 * one cause.
 *
 * For the same reason this stage never accepts the offline fallback. A local
 * tally is stored against the current comment hash, which closes the gate that
 * would otherwise bring the real model back; an hour of rate limiting would
 * leave a permanent tally on everything it touched, with nothing in the data
 * saying so. A reader waiting on a page should get a tally rather than nothing.
 * An unattended drain should get it right or wait.
 */

/**
 * Content items whose comments are collected per invocation.
 *
 * A safety valve rather than the real bound — at roughly a third of a second
 * per Graph walk the wall-clock budget below binds first on any normal run.
 * It exists so a pathologically fast run (everything cached, everything empty)
 * still cannot walk an unbounded number of items in one go.
 */
export const BACKFILL_MAX_COLLECT = 1_000;

/**
 * Analyses per invocation.
 *
 * Sized for a free-tier daily ceiling shared with everything else the system
 * does. Raising it is safe on a paid key; on a free one it converts a working
 * drain into a run that spends its budget and then fails the rest.
 */
export const BACKFILL_MAX_ANALYSES = 25;

/**
 * Pause between model calls.
 *
 * Gemini's free flash tier allows single-digit requests per minute, and the
 * penalty for exceeding it is a 429 that ends the stage. Roughly nine per
 * minute leaves headroom for an interactive regeneration happening at the same
 * time.
 */
export const BACKFILL_ANALYSIS_THROTTLE_MS = 6_500;

/**
 * Wall-clock ceiling.
 *
 * Comfortably inside `maxDuration = 300`. A function killed by the platform
 * returns nothing at all — no counts, no reason, no record that it ran — so the
 * budget is what turns "ran out of time" from a silent truncation into a
 * reported, resumable stop.
 */
export const BACKFILL_TIME_BUDGET_MS = 240_000;

export type BackfillStop =
  /** Nothing left in either queue. */
  | "complete"
  /** The per-run item or analysis ceiling was reached. */
  | "budget"
  /** The wall-clock budget was reached. */
  | "time"
  /** The provider said no in a way that will repeat. Resumes next run. */
  | "provider_unavailable"
  /** AI_SUMMARIZATION_ENABLED is false. Collection still ran. */
  | "analysis_disabled";

export type BackfillSummary = {
  /** True only when both queues are empty. */
  finished: boolean;
  stoppedBecause: BackfillStop;
  collection: {
    attempted: number;
    collected: number;
    commentsStored: number;
    /** Items left unmarked because the Graph walk itself failed. */
    failed: number;
  };
  analysis: {
    attempted: number;
    completed: number;
    noComments: number;
    unchanged: number;
    failed: number;
  };
  remaining: { awaitingCollection: number; awaitingAnalysis: number };
  durationMs: number;
  /** Sanitised, and capped. Never a raw Meta or provider payload. */
  errors: { stage: "collection" | "analysis"; message: string }[];
};

export type BackfillOptions = {
  maxCollect?: number | undefined;
  maxAnalyses?: number | undefined;
  throttleMs?: number | undefined;
  timeBudgetMs?: number | undefined;
  /** Run only one stage. Used by the tail pass at the end of a sweep. */
  stages?: readonly ("collection" | "analysis")[] | undefined;
};

/** Errors kept per stage before the list stops growing. */
const MAX_RECORDED_ERRORS = 5;

export async function backfillCommentAnalysis(
  options: BackfillOptions = {},
): Promise<BackfillSummary> {
  const env = getServerEnv();
  const log = childLogger({ component: "comments.backfill" });

  const startedAt = Date.now();
  const deadline = startedAt + (options.timeBudgetMs ?? BACKFILL_TIME_BUDGET_MS);
  const maxCollect = options.maxCollect ?? BACKFILL_MAX_COLLECT;
  const maxAnalyses = options.maxAnalyses ?? BACKFILL_MAX_ANALYSES;
  const throttleMs = options.throttleMs ?? BACKFILL_ANALYSIS_THROTTLE_MS;
  const stages = options.stages ?? (["collection", "analysis"] as const);

  const summary: BackfillSummary = {
    finished: false,
    stoppedBecause: "complete",
    collection: { attempted: 0, collected: 0, commentsStored: 0, failed: 0 },
    analysis: { attempted: 0, completed: 0, noComments: 0, unchanged: 0, failed: 0 },
    remaining: { awaitingCollection: 0, awaitingAnalysis: 0 },
    durationMs: 0,
    errors: [],
  };

  const note = (stage: "collection" | "analysis", message: string) => {
    if (summary.errors.filter((entry) => entry.stage === stage).length < MAX_RECORDED_ERRORS) {
      summary.errors.push({ stage, message });
    }
  };

  let stop: BackfillStop = "complete";

  // ---- Stage 1: collect ----------------------------------------------------
  if (stages.includes("collection")) {
    const queue = await listContentAwaitingCollection(maxCollect);

    log.info("backfill.collection.claimed", { items: queue.length, maxCollect });

    for (const item of queue) {
      if (Date.now() >= deadline) {
        stop = "time";
        break;
      }

      summary.collection.attempted += 1;

      try {
        const outcome = await syncContentComments({
          actorId: null,
          content: toContentRef(item),
          // Collection only. The model is paced separately below.
          deferAnalysis: true,
        });

        if (!outcome.ok) {
          summary.collection.failed += 1;
          note("collection", outcome.message);
          continue;
        }

        if (outcome.result.fetchError) {
          /*
           * The item is deliberately left unmarked, so the next run returns to
           * it. `syncContentComments` only stamps `comments_synced_at` on a walk
           * that produced an answer.
           */
          summary.collection.failed += 1;
          note("collection", sanitiseMetaError(outcome.result.fetchError).message);
          continue;
        }

        summary.collection.collected += 1;
        summary.collection.commentsStored += outcome.result.commentsStored;
      } catch (cause) {
        summary.collection.failed += 1;
        note("collection", sanitiseThrown(cause, "Comment collection failed."));
      }
    }

    if (stop === "complete" && queue.length >= maxCollect) stop = "budget";
  }

  // ---- Stage 2: analyse ----------------------------------------------------
  /*
   * Read *after* collection, not alongside it. The items just collected are
   * exactly the ones that now need analysing, and claiming the queue first
   * would leave them for tomorrow for no reason.
   */
  if (stages.includes("analysis") && stop !== "time") {
    if (!env.AI_SUMMARIZATION_ENABLED) {
      // Not a failure. Collection above still ran, and the comments are stored;
      // the analysis stage simply has nothing it is permitted to do.
      stop = "analysis_disabled";
      log.info("backfill.analysis.disabled");
    } else {
      const queue = await listContentAwaitingAnalysis(maxAnalyses);

      log.info("backfill.analysis.claimed", { items: queue.length, maxAnalyses });

      const outcome = await analyseQueue(queue, { deadline, throttleMs, summary, note, log });

      if (outcome !== null) stop = outcome;
      else if (stop === "complete" && queue.length >= maxAnalyses) stop = "budget";
    }
  }

  summary.remaining = await countCommentBacklog();
  summary.stoppedBecause = stop;
  /*
   * `finished` is the counted answer, not the loop's opinion.
   *
   * A run can exhaust its budget on the last item in the queue and still have
   * emptied it, and a run can report a clean pass while new content arrived
   * behind it. Only the remaining counts settle it — and when analysis is
   * switched off, an empty analysis queue is not the same thing as finished.
   */
  summary.finished =
    summary.remaining.awaitingCollection === 0 &&
    summary.remaining.awaitingAnalysis === 0 &&
    stop !== "provider_unavailable" &&
    stop !== "analysis_disabled";
  summary.durationMs = Date.now() - startedAt;

  log.info("backfill.finished", {
    stoppedBecause: stop,
    finished: summary.finished,
    collected: summary.collection.collected,
    analysed: summary.analysis.completed + summary.analysis.noComments,
    remaining: summary.remaining,
    durationMs: summary.durationMs,
  });

  return summary;
}

/**
 * Run the analysis queue, pacing between model calls.
 *
 * Returns the reason it stopped early, or null if it worked through the queue.
 */
async function analyseQueue(
  queue: readonly BacklogItem[],
  context: {
    deadline: number;
    throttleMs: number;
    summary: BackfillSummary;
    note: (stage: "collection" | "analysis", message: string) => void;
    log: ReturnType<typeof childLogger>;
  },
): Promise<BackfillStop | null> {
  const { summary, note, log } = context;

  for (const [index, item] of queue.entries()) {
    if (Date.now() >= context.deadline) return "time";

    /*
     * Before the call rather than after, and skipped for the first item: the
     * pause exists to space *requests*, so paying it once at the end of the
     * queue would just burn budget on nothing.
     */
    if (index > 0 && context.throttleMs > 0) {
      const remaining = context.deadline - Date.now();
      if (remaining <= context.throttleMs) return "time";
      await sleep(context.throttleMs);
    }

    summary.analysis.attempted += 1;

    try {
      const outcome = await syncContentComments({
        actorId: null,
        content: toContentRef(item),
        // The comments are already stored — this stage spends no Graph quota.
        skipFetch: true,
        // Never a tally. See the note at the top of this file.
        allowOfflineFallback: false,
      });

      if (!outcome.ok) {
        summary.analysis.failed += 1;
        note("analysis", outcome.message);
        continue;
      }

      switch (outcome.result.summaryStatus) {
        case "completed":
          summary.analysis.completed += 1;
          break;
        case "no_comments":
          summary.analysis.noComments += 1;
          break;
        case "unchanged":
          // Claimed by the coarse SQL filter, settled by the hash gate. Cost a
          // read, not a model call.
          summary.analysis.unchanged += 1;
          break;
        case "failed": {
          summary.analysis.failed += 1;
          note("analysis", outcome.result.summaryError ?? "The analysis failed.");

          /*
           * The whole reason this stage tracks retryability.
           *
           * Retryable means the provider is unavailable right now — a rate
           * limit, an outage, an exhausted free tier. Non-retryable means a
           * rejected key or a request the provider will not accept. Neither is
           * about *this item*, so continuing writes the same failure against
           * every remaining one and buries the single real cause under a
           * hundred identical symptoms.
           */
          log.warn("backfill.analysis.provider_stopped", {
            retryable: outcome.result.summaryRetryable ?? true,
            analysed: summary.analysis.attempted,
          });

          return "provider_unavailable";
        }
        default:
          break;
      }
    } catch (cause) {
      summary.analysis.failed += 1;
      note("analysis", sanitiseThrown(cause, "The analysis failed."));
    }
  }

  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
