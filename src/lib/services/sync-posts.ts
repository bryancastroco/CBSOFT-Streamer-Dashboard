import "server-only";

import { eq } from "drizzle-orm";

import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from "@/lib/audit/actions";
import { recordAuditLogSafe } from "@/lib/audit/log";
import { sanitiseMessage } from "@/lib/automation/sanitise";
import { getDb } from "@/lib/db";
import { streamers, syncRuns, type SyncRunType } from "@/lib/db/schema";
import { indicatesTokenProblem, type NormalizedMetaError } from "@/lib/meta/errors";
import {
  POSTS_PAGE_SIZE,
  fetchPostInsights,
  fetchPublishedPosts,
  normalizeInsights,
  normalizePost,
  type NormalizedPost,
} from "@/lib/meta/posts";
import { DEFAULT_CONCURRENCY, mapWithConcurrency } from "@/lib/meta/retry";
import { getServerEnv } from "@/config/env";
import { childLogger } from "@/lib/observability/logger";
import { mapFacebookPostIds, upsertPostInsights, upsertPosts } from "@/lib/repositories/posts";
import { getStreamerById, withStreamerToken } from "@/lib/repositories/streamers";

/**
 * Page-post synchronisation.
 *
 * Sequence:
 *   1. Open a `running` row in `sync_runs`.
 *   2. Borrow the streamer's token via `withStreamerToken` — the plaintext
 *      never escapes that callback.
 *   3. Page through `/{page-id}/published_posts` and upsert what comes back.
 *   4. Fetch `/{post-id}/insights` for each post, with bounded concurrency.
 *   5. Close the run, update the streamer's sync state, write the audit entry.
 *
 * The run is closed on every path, including failure — an open `running` row
 * left behind would make the next operator think a sync was still in flight.
 */

export type SyncPostsOutcome =
  | { ok: true; result: SyncPostsResult }
  | { ok: false; reason: "not_found" | "deleted" | "no_token" | "inactive"; message: string };

export type SyncPostsResult = {
  syncRunId: string;
  postsProcessed: number;
  insightsWritten: number;
  postsWithInsightErrors: number;
  pagesFetched: number;
  truncated: boolean;
  status: "completed" | "completed_with_errors" | "failed";
  /** Present when the post fetch itself failed or was cut short. */
  error?: NormalizedMetaError;
  /** Per-post insight failures, capped for readability. */
  insightErrors: { facebookPostId: string; category: string; message: string }[];
};

/** Insight failures recorded in detail before the list is truncated. */
const MAX_RECORDED_INSIGHT_ERRORS = 20;

export async function syncStreamerPosts(params: {
  actorId: string | null;
  streamerId: string;
  /** Only fetch posts published after this instant. */
  since?: Date;
  maxPages?: number;
  concurrency?: number;
  /** Defaults to `manual`; an automation sweep passes `automation`. */
  syncType?: SyncRunType;
  /** The roster-wide run this belongs to, when one triggered it. */
  parentSyncRunId?: string | null;
}): Promise<SyncPostsOutcome> {
  const db = getDb();

  const streamer = await getStreamerById(params.streamerId);
  if (!streamer)
    return { ok: false, reason: "not_found", message: "That streamer no longer exists." };
  if (streamer.deletedAt) {
    return { ok: false, reason: "deleted", message: "That streamer has been deleted." };
  }
  if (!streamer.hasToken) {
    return {
      ok: false,
      reason: "no_token",
      message: "This streamer has no Page token. Add one before syncing.",
    };
  }

  // ---- 1. Open the run ----------------------------------------------------
  const [run] = await db
    .insert(syncRuns)
    .values({
      streamerId: streamer.id,
      syncType: params.syncType ?? "manual",
      status: "processing",
      parentSyncRunId: params.parentSyncRunId ?? null,
    })
    .returning({ id: syncRuns.id });

  if (!run) throw new Error("Failed to open a sync run");

  const log = childLogger({
    component: "sync.posts",
    syncRunId: run.id,
    streamerCode: streamer.streamerCode,
    pageId: streamer.pageId,
  });

  /*
   * Bound the window, always.
   *
   * `since` and `maxPages` were optional with no default, so a manual sync —
   * which passes neither — walked the Page's entire history. On a real Page
   * that meant 1,624 posts back to 2019 and 7,000 insight rows, one Graph call
   * per post, far past any function timeout. It never finished, and each
   * attempt left an abandoned run holding the sweep lock.
   *
   * The limits already existed in configuration and were simply not applied
   * here: the automation sweep passes its own `since`, which is why it only
   * ever processed a handful of posts and this went unnoticed.
   *
   * A full backfill is a legitimate thing to want, but it is a deliberate
   * operation with its own pacing — not what a button labelled "Sync posts"
   * should do by surprise.
   */
  const env = getServerEnv();
  const since =
    params.since ?? new Date(Date.now() - env.CONTENT_SYNC_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const maxPages =
    params.maxPages ?? Math.max(1, Math.ceil(env.MAX_POSTS_PER_STREAMER / POSTS_PAGE_SIZE));

  log.info("sync.started", {
    since: since.toISOString(),
    maxPages,
    lookbackDays: env.CONTENT_SYNC_LOOKBACK_DAYS,
  });

  let postsProcessed = 0;
  let insightsWritten = 0;
  let pagesFetched = 0;
  let truncated = false;
  let fetchError: NormalizedMetaError | undefined;
  const insightErrors: SyncPostsResult["insightErrors"] = [];

  try {
    // ---- 2 & 3. Fetch and store posts ------------------------------------
    const lent = await withStreamerToken(streamer.id, async (token) => {
      const fetched = await fetchPublishedPosts({
        pageId: streamer.pageId,
        token,
        since,
        maxPages,
        logger: log,
      });

      pagesFetched = fetched.pagesFetched;
      truncated = fetched.truncated;
      fetchError = fetched.error;

      // Posts missing an id or created_time cannot be stored; they are dropped
      // here rather than being given invented values.
      const normalized = fetched.posts
        .map(normalizePost)
        .filter((post): post is NormalizedPost => post !== null);

      const skipped = fetched.posts.length - normalized.length;
      if (skipped > 0) log.warn("sync.posts.skipped_malformed", { skipped });

      if (normalized.length > 0) {
        await upsertPosts({ streamerId: streamer.id, posts: normalized });
      }
      postsProcessed = normalized.length;

      log.info("sync.posts.stored", { postsProcessed, pagesFetched, truncated });

      if (normalized.length === 0) return;

      // ---- 4. Insights, with bounded concurrency -------------------------
      const idMap = await mapFacebookPostIds(normalized.map((post) => post.facebookPostId));

      await mapWithConcurrency(
        normalized,
        params.concurrency ?? DEFAULT_CONCURRENCY,
        async (post) => {
          const internalId = idMap.get(post.facebookPostId);
          if (!internalId) return;

          const outcome = await fetchPostInsights({
            postId: post.facebookPostId,
            token,
            logger: log,
          });

          if (!outcome.ok) {
            // One post's insights failing must not abandon the rest — a single
            // unavailable post is normal on a busy Page.
            if (insightErrors.length < MAX_RECORDED_INSIGHT_ERRORS) {
              insightErrors.push({
                facebookPostId: post.facebookPostId,
                category: outcome.error.category,
                message: outcome.error.message,
              });
            }
            return;
          }

          const rows = normalizeInsights(outcome.data.data ?? []);
          if (rows.length === 0) return;

          const { written } = await upsertPostInsights({ postId: internalId, insights: rows });
          insightsWritten += written;
        },
      );

      log.info("sync.insights.stored", {
        insightsWritten,
        postsWithInsightErrors: insightErrors.length,
      });
    });

    if (!lent.ok) {
      await closeRun(run.id, "failed", "The Page token could not be read.", null);
      return {
        ok: false,
        reason: "no_token",
        message: "This streamer has no Page token. Add one before syncing.",
      };
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "Unexpected synchronisation failure";
    log.error("sync.failed", { error: message });

    await closeRun(run.id, "failed", message, { postsProcessed, insightsWritten });
    await recordStreamerFailure(streamer.id, message);

    return {
      ok: true,
      result: {
        syncRunId: run.id,
        postsProcessed,
        insightsWritten,
        postsWithInsightErrors: insightErrors.length,
        pagesFetched,
        truncated,
        status: "failed",
        insightErrors,
      },
    };
  }

  // ---- 5. Close out -------------------------------------------------------
  const hadProblems = Boolean(fetchError) || truncated || insightErrors.length > 0;
  const nothingWorked = Boolean(fetchError) && postsProcessed === 0;

  const status: SyncPostsResult["status"] = nothingWorked
    ? "failed"
    : hadProblems
      ? "completed_with_errors"
      : "completed";

  const summary = buildSummary({ fetchError, truncated, insightErrors: insightErrors.length });

  await closeRun(run.id, status, summary, {
    postsProcessed,
    insightsWritten,
    pagesFetched,
    truncated,
    insightErrors: insightErrors.slice(0, MAX_RECORDED_INSIGHT_ERRORS),
    ...(fetchError ? { fetchError: { category: fetchError.category, code: fetchError.code } } : {}),
  });

  if (status === "completed" || status === "completed_with_errors") {
    await markStreamerSynced(streamer.id, summary);
  } else if (summary) {
    await recordStreamerFailure(streamer.id, summary);
  }

  // A token problem is actionable by an admin, so reflect it on the streamer.
  if (fetchError && indicatesTokenProblem(fetchError.category)) {
    await db
      .update(streamers)
      .set({ tokenValidationError: fetchError.message })
      .where(eq(streamers.id, streamer.id));
  }

  await recordAuditLogSafe({
    userId: params.actorId,
    action: AUDIT_ACTIONS.postsSynced,
    entityType: AUDIT_ENTITY_TYPES.streamer,
    entityId: streamer.id,
    metadata: {
      syncRunId: run.id,
      streamerCode: streamer.streamerCode,
      postsProcessed,
      insightsWritten,
      status,
      truncated,
      postsWithInsightErrors: insightErrors.length,
    },
  });

  log.info("sync.finished", { status, postsProcessed, insightsWritten });

  return {
    ok: true,
    result: {
      syncRunId: run.id,
      postsProcessed,
      insightsWritten,
      postsWithInsightErrors: insightErrors.length,
      pagesFetched,
      truncated,
      status,
      ...(fetchError ? { error: fetchError } : {}),
      insightErrors,
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildSummary(params: {
  fetchError?: NormalizedMetaError | undefined;
  truncated: boolean;
  insightErrors: number;
}): string | null {
  const parts: string[] = [];

  if (params.fetchError) {
    parts.push(`Post fetch: ${params.fetchError.category} — ${params.fetchError.message}`);
  }
  if (params.truncated) {
    parts.push("Stopped at the page limit; more posts remain. Run again to continue.");
  }
  if (params.insightErrors > 0) {
    parts.push(`${params.insightErrors} post(s) returned no insights.`);
  }

  return parts.length > 0 ? parts.join(" ") : null;
}

/**
 * Close a sync run. `sync_runs` has check constraints requiring a terminal
 * status to carry `completed_at`, and a `failed` run to carry a message, so
 * both are always supplied here.
 */
async function closeRun(
  runId: string,
  status: "completed" | "completed_with_errors" | "failed",
  message: string | null,
  details: unknown,
): Promise<void> {
  const db = getDb();

  await db
    .update(syncRuns)
    .set({
      status,
      completedAt: new Date(),
      // The constraint demands a message on failure; give it one either way.
      errorMessage: status === "failed" ? (message ?? "Synchronisation failed.") : message,
      errorDetailsJson: details === null ? null : (details as never),
      postsProcessed: isCounts(details) ? details.postsProcessed : 0,
    })
    .where(eq(syncRuns.id, runId));
}

function isCounts(value: unknown): value is { postsProcessed: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { postsProcessed?: unknown }).postsProcessed === "number"
  );
}

async function markStreamerSynced(streamerId: string, warning: string | null): Promise<void> {
  const db = getDb();

  await db
    .update(streamers)
    .set({ lastSuccessfulSyncAt: new Date(), lastSyncError: warning })
    .where(eq(streamers.id, streamerId));
}

/** Scrubbed and capped before storage. See the note in `sync-videos.ts`. */
async function recordStreamerFailure(streamerId: string, message: string): Promise<void> {
  const db = getDb();

  await db
    .update(streamers)
    .set({ lastSyncError: sanitiseMessage(message) })
    .where(eq(streamers.id, streamerId));
}
