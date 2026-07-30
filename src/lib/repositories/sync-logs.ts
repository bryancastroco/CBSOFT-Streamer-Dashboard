import "server-only";

import { desc, eq, isNull, sql } from "drizzle-orm";

import { getDb } from "@/lib/db";
import { streamers, syncRuns } from "@/lib/db/schema";

/**
 * Sync-run history for the admin log screen.
 *
 * ## Why only parents
 *
 * A roster sweep opens one parent run and one child run per streamer, so a
 * fifteen-streamer nightly sweep is sixteen rows. Listing all of them buries the
 * thing an operator is looking for — "did last night's sweep work?" — under the
 * per-streamer detail. So this lists the runs that represent a *decision*: parent
 * automation sweeps and manually triggered runs. The per-streamer breakdown is
 * already on each streamer's own page.
 *
 * `error_message` is read but never rendered raw; see the page.
 */

export type SyncLogRow = {
  id: string;
  syncType: string;
  status: string;
  streamerId: string | null;
  streamerCode: string | null;
  startedAt: Date;
  completedAt: Date | null;
  durationSeconds: number | null;
  errorMessage: string | null;
  postsProcessed: number;
  videosProcessed: number;
  commentsProcessed: number;
  summariesGenerated: number;
  /** How many per-streamer runs this one spawned. Zero for a single-streamer run. */
  childCount: number;
};

export async function listSyncLogs(limit = 50): Promise<SyncLogRow[]> {
  const db = getDb();

  const children = db.$with("children").as(
    db
      .select({
        parentId: syncRuns.parentSyncRunId,
        total: sql<number>`count(*)::int`.as("total"),
      })
      .from(syncRuns)
      .groupBy(syncRuns.parentSyncRunId),
  );

  const rows = await db
    .with(children)
    .select({
      id: syncRuns.id,
      syncType: syncRuns.syncType,
      status: syncRuns.status,
      streamerId: syncRuns.streamerId,
      streamerCode: streamers.streamerCode,
      startedAt: syncRuns.startedAt,
      completedAt: syncRuns.completedAt,
      errorMessage: syncRuns.errorMessage,
      postsProcessed: syncRuns.postsProcessed,
      videosProcessed: syncRuns.videosProcessed,
      commentsProcessed: syncRuns.commentsProcessed,
      summariesGenerated: syncRuns.summariesGenerated,
      childCount: sql<number>`coalesce(${children.total}, 0)::int`,
    })
    .from(syncRuns)
    .leftJoin(streamers, eq(streamers.id, syncRuns.streamerId))
    .leftJoin(children, eq(children.parentId, syncRuns.id))
    // Only top-level runs: a child run always carries a parent id.
    .where(isNull(syncRuns.parentSyncRunId))
    .orderBy(desc(syncRuns.startedAt))
    .limit(limit);

  return rows.map((row) => ({
    ...row,
    durationSeconds: row.completedAt
      ? Math.max(0, Math.round((row.completedAt.getTime() - row.startedAt.getTime()) / 1000))
      : null,
  }));
}

export type SyncLogTotals = {
  total: number;
  succeeded: number;
  partial: number;
  failed: number;
  running: number;
};

/** Counts across all top-level runs, for the summary strip. */
export async function getSyncLogTotals(): Promise<SyncLogTotals> {
  const db = getDb();

  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      /*
       * These literals must match the sync_status enum exactly.
       *
       * They did not. Migration 0009 renamed succeeded to completed, partial to
       * completed_with_errors and running to processing, and this query kept
       * the old names — which Postgres rejects outright rather than counting as
       * zero, so the whole Sync History page threw. `tests/sync-status-labels
       * .test.ts` now compares these against the schema enum.
       */
      succeeded: sql<number>`count(*) filter (where ${syncRuns.status} = 'completed')::int`,
      partial: sql<number>`count(*) filter (where ${syncRuns.status} = 'completed_with_errors')::int`,
      failed: sql<number>`count(*) filter (where ${syncRuns.status} = 'failed')::int`,
      running: sql<number>`count(*) filter (where ${syncRuns.status} = 'processing')::int`,
    })
    .from(syncRuns)
    .where(isNull(syncRuns.parentSyncRunId));

  return row ?? { total: 0, succeeded: 0, partial: 0, failed: 0, running: 0 };
}
