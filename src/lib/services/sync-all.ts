import "server-only";

import { and, eq, isNull, lt, sql } from "drizzle-orm";

import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from "@/lib/audit/actions";
import { recordAuditLogSafe } from "@/lib/audit/log";
import { sanitiseMetaError, sanitiseThrown, type SafeMetaError } from "@/lib/automation/sanitise";
import { getServerEnv } from "@/config/env";
import { getDb } from "@/lib/db";
import { syncRuns } from "@/lib/db/schema";
import { childLogger } from "@/lib/observability/logger";
import { listRecentPostIdsForStreamer } from "@/lib/repositories/posts";
import {
  extendStreamerToken,
  listPendingStreamersForRun,
  listSyncableStreamers,
  validateStreamerToken,
  type StreamerOption,
} from "@/lib/repositories/streamers";
import { listRecentVideoIdsForStreamer } from "@/lib/repositories/videos";
import { rollUpMetrics } from "@/lib/services/metric-rollup";
import { syncContentComments } from "@/lib/services/sync-comments";
import { syncPageMetrics } from "@/lib/services/sync-page-metrics";
import { syncStreamerPosts } from "@/lib/services/sync-posts";
import { syncStreamerVideos } from "@/lib/services/sync-videos";

/**
 * The roster-wide automation sweep behind `POST /api/automation/sync-all`.
 *
 * Eleven steps per streamer, in the order the specification lists them:
 * validate the token, posts, post insights, post comments, changed summaries,
 * then videos, video insights, video comments, changed video summaries. Insights
 * are collected inside the post and video syncs — Meta returns them on a
 * per-item edge, so fetching them as a separate pass would double the round
 * trips for no benefit.
 *
 * ## One streamer failing must not end the sweep
 *
 * This is the requirement that shapes the whole file. A Page whose token expired
 * last week, a Page Meta is rate-limiting, a Page that was deleted out from
 * under us — each of those is normal, and each must cost exactly one streamer's
 * results. So every streamer runs inside its own `try`, and every failure is
 * recorded against that streamer and moved past. The sweep finishes `partial`
 * rather than `failed` when some streamers worked.
 *
 * ## No token ever leaves the server
 *
 * n8n triggers this; it does not participate in it. Every Graph call happens
 * here, through `withStreamerToken`, which lends the plaintext to a callback and
 * never returns it. What n8n gets back is a run id.
 */

/**
 * Defaults chosen so a scheduled sweep of a normal roster fits one invocation.
 *
 * The comment caps are separate from `MAX_POSTS_PER_STREAMER` and deliberately
 * much smaller. Collecting a post is one row from a paginated list; collecting
 * its comments is a paginated walk of its own, and a *changed* comment set is
 * an Anthropic call. Refreshing comments for a hundred posts a night would
 * spend both budgets on content nobody is still commenting on — engagement on a
 * Facebook post is heavily front-loaded.
 */
export const SYNC_ALL_DEFAULTS = {
  /** Posts per streamer whose comments are refreshed, newest first. */
  maxPostsForComments: 10,
  /** Videos per streamer whose comments are refreshed, newest first. */
  maxVideosForComments: 10,
  /** Graph pages per content edge. A safety valve against a huge backfill. */
  maxPages: 5,
  concurrency: 4,
} as const;

/**
 * The configured ceilings, read once per sweep.
 *
 * `since` is derived from `CONTENT_SYNC_LOOKBACK_DAYS` unless the caller named
 * an explicit instant. A sweep is incremental by intent — last night's run
 * already has everything older — and the window is what lets a run that has
 * been failing for a few days catch up when it recovers, without walking a
 * Page's whole history every night.
 */
export function resolveSyncCeilings(options: SyncAllOptions = {}) {
  const env = getServerEnv();

  const lookbackSince = new Date(Date.now() - env.CONTENT_SYNC_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  return {
    since: options.since ?? lookbackSince,
    maxPosts: env.MAX_POSTS_PER_STREAMER,
    maxVideos: env.MAX_VIDEOS_PER_STREAMER,
    lookbackDays: env.CONTENT_SYNC_LOOKBACK_DAYS,
    aiEnabled: env.AI_SUMMARIZATION_ENABLED,
    syncFrequencyHours: env.SYNC_FREQUENCY_HOURS,
    maxStreamers: options.maxStreamers ?? env.MAX_STREAMERS_PER_SYNC,
  };
}

export type SyncAllOptions = {
  since?: Date | undefined;
  maxPages?: number | undefined;
  concurrency?: number | undefined;
  maxPostsForComments?: number | undefined;
  maxVideosForComments?: number | undefined;
  /** Skip comment collection and summarisation entirely. */
  skipComments?: boolean | undefined;
  /** Skip the per-streamer Graph token check. */
  skipTokenValidation?: boolean | undefined;
  /**
   * How many streamers this invocation may process before handing back.
   *
   * The ceiling that keeps a sweep inside one serverless function window. When
   * more streamers remain, the parent run is left `running` and the result
   * reports `remaining` — the caller invokes again with the same run id.
   */
  maxStreamers?: number | undefined;
};

export type StreamerSweepResult = {
  streamer_id: string;
  streamer_code: string;
  status: "completed" | "completed_with_errors" | "skipped" | "failed";
  token_status: string | null;
  posts_processed: number;
  post_insights_written: number;
  videos_processed: number;
  video_insights_written: number;
  comments_processed: number;
  summaries_generated: number;
  /** True when this sweep swapped the token for a longer-lived one. */
  token_extended: boolean;
  /** Daily audience rows written or refreshed. */
  follower_days_written: number;
  /** Most recent follower count Meta reported, or null when it did not. */
  followers: number | null;
  /** Content items whose canonical metrics were refreshed after the sync. */
  metrics_rolled_up: number;
  /** Sanitised. Never a raw Meta payload. */
  errors: { step: string; message: string; category?: string }[];
};

export type SyncAllResult = {
  syncRunId: string;
  status: "completed" | "completed_with_errors" | "failed";
  /**
   * False when streamers are still pending under this run.
   *
   * The parent run stays `running` in that case, so a polling workflow keeps
   * waiting — and the driver is expected to invoke the sweep again with the same
   * run id to advance it.
   */
  finished: boolean;
  /** Streamers still unprocessed under this run after this slice. */
  remaining: number;
  streamersTotal: number;
  streamersSucceeded: number;
  streamersFailed: number;
  streamersSkipped: number;
  postsProcessed: number;
  videosProcessed: number;
  commentsProcessed: number;
  summariesGenerated: number;
  startedAt: string;
  completedAt: string;
  streamers: StreamerSweepResult[];
};

/** Token states that mean "do not spend Graph quota on this Page tonight". */
const UNUSABLE_TOKEN_STATUSES = new Set(["missing", "expired", "invalid", "missing_permission"]);

/**
 * Open the parent run.
 *
 * Split out so a route can create the run, return its id immediately, and let
 * the sweep continue in the background — which is what the documented n8n
 * workflow relies on.
 */
export type TriggerSource = "admin" | "n8n" | "vercel_cron" | "system_retry";

/** Raised when a sweep is already in flight. Carries no detail worth leaking. */
export class SweepAlreadyRunningError extends Error {
  constructor() {
    super("A synchronisation sweep is already in progress.");
    this.name = "SweepAlreadyRunningError";
  }
}

/**
 * How long a `processing` run may sit before it is presumed dead.
 *
 * Generously beyond `maxDuration` (300s), because a run that is genuinely
 * working is being advanced by repeated invocations and its `started_at` does
 * not move. Twenty minutes is far longer than any real slice and far shorter
 * than the gap to the next scheduled sweep.
 */
export const SWEEP_ABANDONED_AFTER_MS = 20 * 60 * 1000;

/**
 * Close runs that a platform kill left open, and say so.
 *
 * ## Why this is necessary
 *
 * A serverless function killed at `maxDuration` executes no `catch`, no
 * `finally` and no cleanup — it simply stops. The run row it opened stays
 * `processing` for ever.
 *
 * That is not merely untidy. `sync_runs_one_active_sweep_idx` admits one
 * top-level run in `queued` or `processing`, and the cron refuses to start
 * while one is in flight. So a single killed invocation blocks *every*
 * subsequent sweep, permanently, with no error anywhere — collection simply
 * stops and the dashboard quietly goes stale.
 *
 * It happened: the run opened at 03:17 on 5 August was still `processing`
 * eighteen hours later, and would have refused every night that followed.
 *
 * ## Why `cancelled` rather than `failed`
 *
 * Nothing failed. Work was done and recorded — the counters on the row are
 * real — and the invocation ran out of wall clock. `failed` would demand an
 * error message describing a fault that did not occur, and would show up in the
 * health screens as something to investigate.
 */
export async function reclaimAbandonedSweeps(): Promise<number> {
  const db = getDb();

  const cutoff = new Date(Date.now() - SWEEP_ABANDONED_AFTER_MS);

  const reclaimed = await db
    .update(syncRuns)
    .set({
      status: "cancelled",
      completedAt: new Date(),
      errorMessage:
        "Abandoned: the invocation ended without closing this run, most likely a platform " +
        "timeout. Reclaimed automatically so the next sweep can start.",
    })
    .where(
      and(
        isNull(syncRuns.streamerId),
        eq(syncRuns.status, "processing"),
        lt(syncRuns.startedAt, cutoff),
      ),
    )
    .returning({ id: syncRuns.id });

  return reclaimed.length;
}

export async function openSyncAllRun(triggerSource: TriggerSource = "n8n"): Promise<string> {
  const db = getDb();

  // Before the insert, so a dead run cannot lose the race to the partial
  // unique index and turn a recoverable state into a permanent refusal.
  await reclaimAbandonedSweeps();

  try {
    const [run] = await db
      .insert(syncRuns)
      .values({
        streamerId: null,
        syncType: "automation",
        triggerSource,
        status: "processing",
      })
      .returning({ id: syncRuns.id });

    if (!run) throw new Error("Failed to open an automation sync run");
    return run.id;
  } catch (cause) {
    /*
     * Overlap is prevented by the database, not by this code.
     *
     * `sync_runs_one_active_sweep_idx` is a partial unique index admitting one
     * top-level run in `queued` or `processing`. The previous guard read for an
     * in-flight run and then inserted, which is a race: two callers arriving
     * together both saw nothing and both started a sweep. Here the second
     * inserter simply loses, and 23505 is the only way to find out.
     */
    if (isUniqueViolation(cause)) throw new SweepAlreadyRunningError();
    throw cause;
  }
}

/** Postgres unique-violation SQLSTATE, however the driver wrapped it. */
function isUniqueViolation(error: unknown): boolean {
  for (const candidate of [error, (error as { cause?: unknown })?.cause]) {
    if (candidate && typeof candidate === "object") {
      if ((candidate as { code?: string }).code === "23505") return true;
    }
  }
  return false;
}

/**
 * Run the sweep against an already-open parent run.
 *
 * Never throws. A failure anywhere is caught, recorded on the run, and returned
 * — a background caller has nobody to throw to, and an uncaught rejection would
 * leave the run stuck in `running` forever, which is the one state a polling
 * workflow cannot recover from.
 */
export async function runSyncAll(params: {
  syncRunId: string;
  options?: SyncAllOptions;
}): Promise<SyncAllResult> {
  const options = params.options ?? {};
  const startedAt = new Date();
  const ceilings = resolveSyncCeilings(options);

  const log = childLogger({ component: "sync.all", syncRunId: params.syncRunId });

  const totals = {
    posts: 0,
    videos: 0,
    comments: 0,
    summaries: 0,
  };
  const results: StreamerSweepResult[] = [];

  let roster: StreamerOption[] = [];
  let remaining = 0;
  let rosterTotal = 0;

  try {
    /*
     * Two reads, for two different questions. `listSyncableStreamers` answers
     * "how big is the roster" for the log; `listPendingStreamersForRun` answers
     * "what has this run not reached yet", which is what the slice is taken
     * from. Only the second one drives behaviour.
     */
    const [all, pending] = await Promise.all([
      listSyncableStreamers(),
      listPendingStreamersForRun(params.syncRunId),
    ]);

    rosterTotal = all.length;

    // The slice that fits one function window. Everything after it is left for
    // the next invocation of this same run.
    roster = pending.slice(0, ceilings.maxStreamers);
    remaining = pending.length - roster.length;
  } catch (cause) {
    const message = sanitiseThrown(cause, "The roster could not be read.");
    log.error("sync.all.roster_failed", { error: message });

    await closeRun(params.syncRunId, "failed", message, totals, { streamers: [] });

    return buildResult(params.syncRunId, "failed", startedAt, totals, []);
  }

  log.info("sync.all.started", {
    rosterTotal,
    streamersThisSlice: roster.length,
    remainingAfterSlice: remaining,
    maxStreamers: ceilings.maxStreamers,
    skipComments: options.skipComments ?? false,
    since: ceilings.since.toISOString(),
    lookbackDays: ceilings.lookbackDays,
    maxPostsPerStreamer: ceilings.maxPosts,
    maxVideosPerStreamer: ceilings.maxVideos,
    aiSummarisation: ceilings.aiEnabled,
  });

  // ---- 2. Process every active streamer ------------------------------------
  for (const streamer of roster) {
    // Each streamer is isolated. `sweepStreamer` never throws; the extra guard
    // is for anything thrown between iterations.
    try {
      const result = await sweepStreamer(streamer, params.syncRunId, options, ceilings, log);
      results.push(result);

      totals.posts += result.posts_processed;
      totals.videos += result.videos_processed;
      totals.comments += result.comments_processed;
      totals.summaries += result.summaries_generated;
    } catch (cause) {
      const message = sanitiseThrown(cause, "The streamer sweep failed unexpectedly.");
      log.error("sync.all.streamer_failed", {
        streamerCode: streamer.streamerCode,
        error: message,
      });

      results.push({
        streamer_id: streamer.id,
        streamer_code: streamer.streamerCode,
        status: "failed",
        token_status: null,
        posts_processed: 0,
        post_insights_written: 0,
        videos_processed: 0,
        video_insights_written: 0,
        comments_processed: 0,
        summaries_generated: 0,
        token_extended: false,
        follower_days_written: 0,
        followers: null,
        metrics_rolled_up: 0,
        errors: [{ step: "streamer", message }],
      });
    }
  }

  // ---- Close the parent run ------------------------------------------------
  const failed = results.filter((result) => result.status === "failed").length;
  const skipped = results.filter((result) => result.status === "skipped").length;
  const worked = results.filter(
    (result) => result.status === "completed" || result.status === "completed_with_errors",
  ).length;

  // `failed` only when nothing worked at all. A sweep where nine of ten Pages
  // synced is a partial success, and reporting it as a failure would train an
  // operator to ignore the status.
  const status: SyncAllResult["status"] =
    roster.length === 0
      ? "completed"
      : worked === 0
        ? "failed"
        : failed > 0 ||
            skipped > 0 ||
            results.some((result) => result.status === "completed_with_errors")
          ? "completed_with_errors"
          : "completed";

  const summary = buildSummary({ total: roster.length, worked, failed, skipped });

  /*
   * The run is only closed when nothing is pending.
   *
   * While streamers remain the parent stays `running`, which is exactly what a
   * polling workflow needs to keep waiting — and it is what makes the sweep safe
   * on Vercel, where a function is killed at `maxDuration` and `after()` work is
   * bounded by the same ceiling. Closing here regardless would mark a run
   * complete having touched only the first slice, which is the silent truncation
   * this design exists to prevent.
   *
   * `progressRun` records the slice's totals so the numbers are durable even if
   * the next invocation never arrives.
   */
  if (remaining > 0) {
    await progressRun(params.syncRunId, totals, { streamers: results, remaining });

    log.info("sync.all.slice_finished", {
      status,
      worked,
      failed,
      skipped,
      remaining,
      ...totals,
    });

    return buildResult(params.syncRunId, status, startedAt, totals, results, remaining);
  }

  await closeRun(params.syncRunId, status, summary, totals, { streamers: results });

  await recordAuditLogSafe({
    // No user: n8n is a machine actor, and inventing one would corrupt the
    // trail's answer to "who did this?".
    userId: null,
    action: AUDIT_ACTIONS.automationSyncCompleted,
    entityType: AUDIT_ENTITY_TYPES.syncRun,
    entityId: params.syncRunId,
    metadata: {
      status,
      rosterTotal,
      streamersTotal: roster.length,
      streamersSucceeded: worked,
      streamersFailed: failed,
      streamersSkipped: skipped,
      ...totals,
    },
  });

  log.info("sync.all.finished", { status, worked, failed, skipped, ...totals });

  return buildResult(params.syncRunId, status, startedAt, totals, results, 0);
}

/** Convenience for a caller that wants to open and run in one step. */
export async function syncAll(options?: SyncAllOptions): Promise<SyncAllResult> {
  const syncRunId = await openSyncAllRun();
  return runSyncAll({ syncRunId, ...(options ? { options } : {}) });
}

// ---------------------------------------------------------------------------
// One streamer
// ---------------------------------------------------------------------------

async function sweepStreamer(
  streamer: StreamerOption,
  parentSyncRunId: string,
  options: SyncAllOptions,
  ceilings: ReturnType<typeof resolveSyncCeilings>,
  parentLog: ReturnType<typeof childLogger>,
): Promise<StreamerSweepResult> {
  const log = childLogger({
    component: "sync.all.streamer",
    syncRunId: parentSyncRunId,
    streamerCode: streamer.streamerCode,
  });

  const result: StreamerSweepResult = {
    streamer_id: streamer.id,
    streamer_code: streamer.streamerCode,
    status: "completed",
    token_status: null,
    posts_processed: 0,
    post_insights_written: 0,
    videos_processed: 0,
    video_insights_written: 0,
    comments_processed: 0,
    summaries_generated: 0,
    token_extended: false,
    follower_days_written: 0,
    followers: null,
    metrics_rolled_up: 0,
    errors: [],
  };

  const fail = (step: string, message: string, error?: SafeMetaError) => {
    result.errors.push({
      step,
      message,
      ...(error ? { category: error.category } : {}),
    });
  };

  // ---- 3. Validate the token ----------------------------------------------
  if (!options.skipTokenValidation) {
    const validation = await validateStreamerToken({ actorId: null, id: streamer.id });

    if (!validation.ok) {
      result.status = "skipped";
      fail("token_validation", validation.message);
      return result;
    }

    result.token_status = validation.data.validation.status;

    if (UNUSABLE_TOKEN_STATUSES.has(validation.data.validation.status)) {
      // Skipped, not failed: the Page is fine, its credential needs attention.
      // Spending Graph quota on a call that cannot succeed helps nobody.
      result.status = "skipped";
      fail(
        "token_validation",
        `Token is ${validation.data.validation.status}; skipping this streamer until it is replaced.`,
      );

      log.warn("sync.all.token_unusable", { tokenStatus: validation.data.validation.status });
      return result;
    }

    /*
     * ---- 3b. Renew the token while it still works -------------------------
     *
     * The only self-service remedy for expiry that exists. Meta hands back a
     * non-expiring Page token when asked for the Page's own `access_token`
     * field — but only while the current one is valid. Once it lapses every
     * refresh path answers `(190) Session has expired` and a human has to sign
     * into Facebook.
     *
     * That is not hypothetical here: one Page's token expired mid-project and
     * took that streamer's collection down until it was replaced by hand. So
     * the sweep renews rather than waits, on every run.
     *
     * A no-op when the token is already permanent — `extendStreamerToken`
     * returns `unchanged` and writes nothing, so this costs one `debug_token`
     * call per streamer per sweep and produces no audit noise.
     */
    try {
      const extension = await extendStreamerToken({ actorId: null, id: streamer.id });

      if (extension.ok && extension.data.outcome.status === "extended") {
        result.token_extended = true;

        log.info("sync.all.token_extended", {
          expiresAt: extension.data.outcome.expiresAt?.toISOString() ?? "never",
        });
      }
    } catch (cause) {
      /*
       * Never fatal. The token that got us this far still works — failing the
       * streamer over a renewal that can be retried tomorrow would discard a
       * sync that was about to succeed.
       */
      log.warn("sync.all.token_extension_failed", { error: sanitiseThrown(cause) });
    }
  }

  const shared = {
    actorId: null,
    streamerId: streamer.id,
    syncType: "automation" as const,
    parentSyncRunId,
    // CONTENT_SYNC_LOOKBACK_DAYS unless the caller named an instant.
    since: ceilings.since,
    maxPages: options.maxPages ?? SYNC_ALL_DEFAULTS.maxPages,
    concurrency: options.concurrency ?? SYNC_ALL_DEFAULTS.concurrency,
  };

  /*
   * ---- 3c. Audience size ---------------------------------------------------
   *
   * One Graph call covering thirty days, before the content sweep, because it
   * is the cheapest thing here and the least likely to be cut short by a
   * timeout — a run that dies halfway through posts should still have recorded
   * today's follower count.
   *
   * Never fatal. Audience figures are a reporting nicety; content collection is
   * the job, and failing a streamer over a growth metric would trade something
   * valuable for something merely useful.
   */
  try {
    const audience = await syncPageMetrics({ streamerId: streamer.id });

    if (audience.ok) {
      result.follower_days_written = audience.daysWritten;
      result.followers = audience.latestFollowers;
    } else {
      fail("page_metrics", audience.message);
      if (result.status === "completed") result.status = "completed_with_errors";
    }
  } catch (cause) {
    fail("page_metrics", sanitiseThrown(cause, "Audience figures could not be collected."));
    if (result.status === "completed") result.status = "completed_with_errors";
  }

  // ---- 4 & 5. Posts and post insights -------------------------------------
  const posts = await syncStreamerPosts(shared);

  if (!posts.ok) {
    fail("posts", posts.message);
    result.status = "failed";
  } else {
    result.posts_processed = posts.result.postsProcessed;
    result.post_insights_written = posts.result.insightsWritten;

    if (posts.result.error) {
      fail("posts", posts.result.error.message, sanitiseMetaError(posts.result.error));
    }
    if (posts.result.status !== "completed") result.status = "completed_with_errors";
  }

  // ---- 6 & 7. Post comments and changed summaries -------------------------
  if (!options.skipComments) {
    const postIds = await listRecentPostIdsForStreamer(
      streamer.id,
      Math.min(
        options.maxPostsForComments ?? SYNC_ALL_DEFAULTS.maxPostsForComments,
        ceilings.maxPosts,
      ),
    );

    const commentOutcome = await sweepComments("post", postIds, log);
    result.comments_processed += commentOutcome.comments;
    result.summaries_generated += commentOutcome.summaries;
    for (const error of commentOutcome.errors) fail("post_comments", error);
    if (commentOutcome.errors.length > 0 && result.status === "completed") {
      result.status = "completed_with_errors";
    }
  }

  // ---- 8 & 9. Videos and video insights -----------------------------------
  const videos = await syncStreamerVideos(shared);

  if (!videos.ok) {
    fail("videos", videos.message);
    // Posts may still have worked; only mark the whole streamer failed when
    // neither half produced anything.
    result.status = result.posts_processed > 0 ? "completed_with_errors" : "failed";
  } else {
    result.videos_processed = videos.result.videosProcessed;
    result.video_insights_written = videos.result.insightsWritten;

    if (videos.result.error) {
      fail("videos", videos.result.error.message, sanitiseMetaError(videos.result.error));
    }
    if (videos.result.status !== "completed" && result.status === "completed") {
      result.status = "completed_with_errors";
    }
  }

  // ---- 10 & 11. Video comments and changed summaries ----------------------
  if (!options.skipComments) {
    const videoIds = await listRecentVideoIdsForStreamer(
      streamer.id,
      Math.min(
        options.maxVideosForComments ?? SYNC_ALL_DEFAULTS.maxVideosForComments,
        ceilings.maxVideos,
      ),
    );

    const commentOutcome = await sweepComments("video", videoIds, log);
    result.comments_processed += commentOutcome.comments;
    result.summaries_generated += commentOutcome.summaries;
    for (const error of commentOutcome.errors) fail("video_comments", error);
    if (commentOutcome.errors.length > 0 && result.status === "completed") {
      result.status = "completed_with_errors";
    }
  }

  /*
   * ---- 12. Roll the new insights into canonical metrics -------------------
   *
   * Without this the dashboard drifts. `content_metrics_current` is what every
   * performance figure reads from, and a sync that writes raw insights and
   * stops leaves those figures showing the previous sweep's numbers — with no
   * indication anywhere that they are stale.
   *
   * Scoped to this streamer, so the cost tracks the work just done rather than
   * the whole roster. It reads stored insights only: no Graph call, no Meta
   * quota, and nothing here can fail in a way that invalidates content already
   * collected — which is why a failure downgrades the status rather than
   * discarding the sync.
   */
  try {
    const rollup = await rollUpMetrics({
      streamerId: streamer.id,
      graphApiVersion: getServerEnv().META_GRAPH_API_VERSION,
    });

    result.metrics_rolled_up = rollup.succeeded;

    if (rollup.failed > 0 && result.status === "completed") {
      result.status = "completed_with_errors";
      fail("metric_rollup", `${rollup.failed} items could not be rolled up.`);
    }
  } catch (cause) {
    fail("metric_rollup", cause instanceof Error ? cause.message : "Metric rollup failed.");
    if (result.status === "completed") result.status = "completed_with_errors";
  }

  parentLog.info("sync.all.streamer_finished", {
    streamerCode: streamer.streamerCode,
    status: result.status,
    metricsRolledUp: result.metrics_rolled_up,
    posts: result.posts_processed,
    videos: result.videos_processed,
    comments: result.comments_processed,
    summaries: result.summaries_generated,
  });

  return result;
}

/** Errors recorded per content type before the list is truncated. */
const MAX_RECORDED_COMMENT_ERRORS = 5;

/**
 * Collect comments for a set of content items and summarise the changed ones.
 *
 * Sequential rather than concurrent: the AI provider is the bottleneck and the
 * expensive resource, and firing ten summarisations at once buys latency at the
 * cost of a burst against a rate-limited provider. A nightly sweep has time.
 *
 * The `summaryRegenerated` flag is what makes "generate changed summaries" true
 * — the service only calls the AI when the source hash moved, so an unchanged
 * comment set costs a Graph fetch and nothing else.
 */
async function sweepComments(
  type: "post" | "video",
  contentIds: readonly string[],
  log: ReturnType<typeof childLogger>,
): Promise<{ comments: number; summaries: number; errors: string[] }> {
  let comments = 0;
  let summaries = 0;
  const errors: string[] = [];

  for (const id of contentIds) {
    try {
      const outcome = await syncContentComments({
        actorId: null,
        content: { type, id },
      });

      if (!outcome.ok) {
        if (errors.length < MAX_RECORDED_COMMENT_ERRORS) errors.push(outcome.message);
        continue;
      }

      comments += outcome.result.commentsStored;
      if (outcome.result.summaryRegenerated) summaries += 1;

      if (
        outcome.result.summaryStatus === "failed" &&
        errors.length < MAX_RECORDED_COMMENT_ERRORS
      ) {
        errors.push(outcome.result.summaryError ?? "The analysis failed.");
      }
      if (outcome.result.fetchError && errors.length < MAX_RECORDED_COMMENT_ERRORS) {
        errors.push(sanitiseMetaError(outcome.result.fetchError).message);
      }
    } catch (cause) {
      // One item's comments failing must not abandon the rest.
      const message = sanitiseThrown(cause, "Comment collection failed.");
      log.warn("sync.all.comments_failed", { contentType: type, error: message });
      if (errors.length < MAX_RECORDED_COMMENT_ERRORS) errors.push(message);
    }
  }

  return { comments, summaries, errors };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildSummary(counts: {
  total: number;
  worked: number;
  failed: number;
  skipped: number;
}): string | null {
  if (counts.total === 0) return "No active streamers with a stored Page token.";
  if (counts.failed === 0 && counts.skipped === 0) return null;

  const parts: string[] = [];
  if (counts.failed > 0) parts.push(`${counts.failed} streamer(s) failed`);
  if (counts.skipped > 0) parts.push(`${counts.skipped} skipped for token health`);
  parts.push(`${counts.worked} of ${counts.total} synced`);

  return `${parts.join("; ")}.`;
}

type SliceTotals = { posts: number; videos: number; comments: number; summaries: number };

/**
 * Counters that accumulate rather than overwrite.
 *
 * A run may be advanced across several invocations, and each one reports only
 * the slice it processed. Assigning would leave the run showing the last slice's
 * numbers as if they were the whole sweep, so every counter is incremented in
 * SQL. That also makes the update safe without a read-modify-write: Postgres
 * does the addition, so two invocations cannot clobber one another.
 */
function accumulate(totals: SliceTotals) {
  return {
    postsProcessed: sql`${syncRuns.postsProcessed} + ${totals.posts}`,
    videosProcessed: sql`${syncRuns.videosProcessed} + ${totals.videos}`,
    commentsProcessed: sql`${syncRuns.commentsProcessed} + ${totals.comments}`,
    summariesGenerated: sql`${syncRuns.summariesGenerated} + ${totals.summaries}`,
  };
}

/**
 * Record a completed slice without closing the run.
 *
 * Leaves `status` as `running` and `completed_at` null, so `finished` stays
 * false for anything polling the run, and the next invocation can pick up the
 * streamers this one did not reach.
 *
 * `errorDetailsJson` holds the most recent slice only. The authoritative
 * per-streamer record is the child `sync_runs` row each streamer opens, which
 * `GET /api/automation/sync-runs/{id}` returns under `children` — so the parent's
 * copy is a convenience, and accumulating a JSON array across invocations would
 * buy nothing but a merge conflict.
 */
async function progressRun(
  runId: string,
  totals: SliceTotals,
  details: Record<string, unknown>,
): Promise<void> {
  const db = getDb();

  await db
    .update(syncRuns)
    .set({
      status: "processing",
      errorDetailsJson: details as never,
      ...accumulate(totals),
    })
    .where(eq(syncRuns.id, runId));
}

async function closeRun(
  runId: string,
  status: "completed" | "completed_with_errors" | "failed",
  message: string | null,
  totals: SliceTotals,
  details: Record<string, unknown>,
): Promise<void> {
  const db = getDb();

  await db
    .update(syncRuns)
    .set({
      status,
      completedAt: new Date(),
      // `sync_runs_failure_has_message_check` demands a message on failure.
      errorMessage: status === "failed" ? (message ?? "The automation sweep failed.") : message,
      errorDetailsJson: details as never,
      ...accumulate(totals),
    })
    .where(eq(syncRuns.id, runId));
}

function buildResult(
  syncRunId: string,
  status: SyncAllResult["status"],
  startedAt: Date,
  totals: { posts: number; videos: number; comments: number; summaries: number },
  streamers: StreamerSweepResult[],
  remaining = 0,
): SyncAllResult {
  return {
    syncRunId,
    status,
    finished: remaining === 0,
    remaining,
    streamersTotal: streamers.length,
    streamersSucceeded: streamers.filter(
      (entry) => entry.status === "completed" || entry.status === "completed_with_errors",
    ).length,
    streamersFailed: streamers.filter((entry) => entry.status === "failed").length,
    streamersSkipped: streamers.filter((entry) => entry.status === "skipped").length,
    postsProcessed: totals.posts,
    videosProcessed: totals.videos,
    commentsProcessed: totals.comments,
    summariesGenerated: totals.summaries,
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    streamers,
  };
}
