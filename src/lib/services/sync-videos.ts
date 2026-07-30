import "server-only";

import { eq } from "drizzle-orm";

import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from "@/lib/audit/actions";
import { recordAuditLogSafe } from "@/lib/audit/log";
import { sanitiseMessage } from "@/lib/automation/sanitise";
import { getDb } from "@/lib/db";
import { streamers, syncRuns, type SyncRunType } from "@/lib/db/schema";
import { indicatesTokenProblem, type NormalizedMetaError } from "@/lib/meta/errors";
import { normalizeInsights } from "@/lib/meta/posts";
import { DEFAULT_CONCURRENCY, mapWithConcurrency } from "@/lib/meta/retry";
import {
  fetchPageVideos,
  fetchVideoInsights,
  normalizeVideo,
  type NormalizedVideo,
} from "@/lib/meta/videos";
import { childLogger } from "@/lib/observability/logger";
import { getStreamerById, withStreamerToken } from "@/lib/repositories/streamers";
import { mapFacebookVideoIds, upsertVideoInsights, upsertVideos } from "@/lib/repositories/videos";

/**
 * Page-video synchronisation.
 *
 * The same shape as `sync-posts.ts` — open a `sync_runs` row, borrow the token
 * through `withStreamerToken`, page through the edge, then fan out to insights
 * with bounded concurrency — differing only in which Graph edges it reads.
 *
 * The run is closed on every path, including failure: an abandoned `running`
 * row would make the next operator think a sync was still in flight.
 */

export type SyncVideosOutcome =
  | { ok: true; result: SyncVideosResult }
  | { ok: false; reason: "not_found" | "deleted" | "no_token"; message: string };

export type SyncVideosResult = {
  syncRunId: string;
  videosProcessed: number;
  insightsWritten: number;
  videosWithInsightErrors: number;
  pagesFetched: number;
  truncated: boolean;
  status: "completed" | "completed_with_errors" | "failed";
  error?: NormalizedMetaError;
  insightErrors: { facebookVideoId: string; category: string; message: string }[];
};

const MAX_RECORDED_INSIGHT_ERRORS = 20;

export async function syncStreamerVideos(params: {
  actorId: string | null;
  streamerId: string;
  since?: Date;
  maxPages?: number;
  concurrency?: number;
  /** Defaults to `manual`; an automation sweep passes `automation`. */
  syncType?: SyncRunType;
  /** The roster-wide run this belongs to, when one triggered it. */
  parentSyncRunId?: string | null;
}): Promise<SyncVideosOutcome> {
  const db = getDb();

  const streamer = await getStreamerById(params.streamerId);
  if (!streamer) {
    return { ok: false, reason: "not_found", message: "That streamer no longer exists." };
  }
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
    component: "sync.videos",
    syncRunId: run.id,
    streamerCode: streamer.streamerCode,
    pageId: streamer.pageId,
  });

  log.info("sync.started", { since: params.since?.toISOString() ?? null });

  let videosProcessed = 0;
  let insightsWritten = 0;
  let pagesFetched = 0;
  let truncated = false;
  let fetchError: NormalizedMetaError | undefined;
  const insightErrors: SyncVideosResult["insightErrors"] = [];

  try {
    const lent = await withStreamerToken(streamer.id, async (token) => {
      const fetched = await fetchPageVideos({
        pageId: streamer.pageId,
        token,
        ...(params.since ? { since: params.since } : {}),
        ...(params.maxPages !== undefined ? { maxPages: params.maxPages } : {}),
        logger: log,
      });

      pagesFetched = fetched.pagesFetched;
      truncated = fetched.truncated;
      fetchError = fetched.error;

      const normalized = fetched.videos
        .map(normalizeVideo)
        .filter((video): video is NormalizedVideo => video !== null);

      const skipped = fetched.videos.length - normalized.length;
      if (skipped > 0) log.warn("sync.videos.skipped_malformed", { skipped });

      if (normalized.length > 0) {
        await upsertVideos({ streamerId: streamer.id, videos: normalized });
      }
      videosProcessed = normalized.length;

      log.info("sync.videos.stored", { videosProcessed, pagesFetched, truncated });

      if (normalized.length === 0) return;

      const idMap = await mapFacebookVideoIds(normalized.map((video) => video.facebookVideoId));

      await mapWithConcurrency(
        normalized,
        params.concurrency ?? DEFAULT_CONCURRENCY,
        async (video) => {
          const internalId = idMap.get(video.facebookVideoId);
          if (!internalId) return;

          const outcome = await fetchVideoInsights({
            videoId: video.facebookVideoId,
            token,
            logger: log,
          });

          if (!outcome.ok) {
            // One video's insights failing must not abandon the rest.
            if (insightErrors.length < MAX_RECORDED_INSIGHT_ERRORS) {
              insightErrors.push({
                facebookVideoId: video.facebookVideoId,
                category: outcome.error.category,
                message: outcome.error.message,
              });
            }
            return;
          }

          // The same normaliser as post insights: a metric arrives as
          // { name, period, values: [...] } on both edges, and every value
          // shape — scalar, array, nested object — round-trips into jsonb.
          const rows = normalizeInsights(outcome.data.data ?? []);
          if (rows.length === 0) return;

          const { written } = await upsertVideoInsights({ videoId: internalId, insights: rows });
          insightsWritten += written;
        },
      );

      log.info("sync.insights.stored", {
        insightsWritten,
        videosWithInsightErrors: insightErrors.length,
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

    await closeRun(run.id, "failed", message, { videosProcessed, insightsWritten });
    await recordStreamerFailure(streamer.id, message);

    return {
      ok: true,
      result: {
        syncRunId: run.id,
        videosProcessed,
        insightsWritten,
        videosWithInsightErrors: insightErrors.length,
        pagesFetched,
        truncated,
        status: "failed",
        insightErrors,
      },
    };
  }

  const hadProblems = Boolean(fetchError) || truncated || insightErrors.length > 0;
  const nothingWorked = Boolean(fetchError) && videosProcessed === 0;

  const status: SyncVideosResult["status"] = nothingWorked
    ? "failed"
    : hadProblems
      ? "completed_with_errors"
      : "completed";

  const summary = buildSummary({ fetchError, truncated, insightErrors: insightErrors.length });

  await closeRun(run.id, status, summary, {
    videosProcessed,
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

  if (fetchError && indicatesTokenProblem(fetchError.category)) {
    await db
      .update(streamers)
      .set({ tokenValidationError: fetchError.message })
      .where(eq(streamers.id, streamer.id));
  }

  await recordAuditLogSafe({
    userId: params.actorId,
    action: AUDIT_ACTIONS.videosSynced,
    entityType: AUDIT_ENTITY_TYPES.streamer,
    entityId: streamer.id,
    metadata: {
      syncRunId: run.id,
      streamerCode: streamer.streamerCode,
      videosProcessed,
      insightsWritten,
      status,
      truncated,
      videosWithInsightErrors: insightErrors.length,
    },
  });

  log.info("sync.finished", { status, videosProcessed, insightsWritten });

  return {
    ok: true,
    result: {
      syncRunId: run.id,
      videosProcessed,
      insightsWritten,
      videosWithInsightErrors: insightErrors.length,
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
    parts.push(`Video fetch: ${params.fetchError.category} — ${params.fetchError.message}`);
  }
  if (params.truncated) {
    parts.push("Stopped at the page limit; more videos remain. Run again to continue.");
  }
  if (params.insightErrors > 0) {
    parts.push(`${params.insightErrors} video(s) returned no insights.`);
  }

  return parts.length > 0 ? parts.join(" ") : null;
}

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
      errorMessage: status === "failed" ? (message ?? "Synchronisation failed.") : message,
      errorDetailsJson: details === null ? null : (details as never),
      videosProcessed: isCounts(details) ? details.videosProcessed : 0,
    })
    .where(eq(syncRuns.id, runId));
}

function isCounts(value: unknown): value is { videosProcessed: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { videosProcessed?: unknown }).videosProcessed === "number"
  );
}

async function markStreamerSynced(streamerId: string, warning: string | null): Promise<void> {
  const db = getDb();

  await db
    .update(streamers)
    .set({ lastSuccessfulSyncAt: new Date(), lastSyncError: warning })
    .where(eq(streamers.id, streamerId));
}

/**
 * Scrubbed and capped **before** it is stored, not only on the way out.
 *
 * `last_sync_error` is read by the dashboard, the CSV export and the Sheets
 * mirror. The export layer sanitises too, but relying on that alone means the
 * raw text still sits in a column three surfaces read from — and a driver
 * error arrives with the failing SQL and its bound parameters attached, which
 * is neither useful to an operator nor something to keep at rest.
 */
async function recordStreamerFailure(streamerId: string, message: string): Promise<void> {
  const db = getDb();

  await db
    .update(streamers)
    .set({ lastSyncError: sanitiseMessage(message) })
    .where(eq(streamers.id, streamerId));
}
