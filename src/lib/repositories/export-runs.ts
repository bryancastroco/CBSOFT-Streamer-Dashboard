import "server-only";

import { desc, eq, gte, sql } from "drizzle-orm";

import { sanitiseMessage } from "@/lib/automation/sanitise";
import { getDb } from "@/lib/db";
import { exportRuns, syncRuns } from "@/lib/db/schema";
import { tsResult } from "@/lib/db/params";
import { childLogger } from "@/lib/observability/logger";

/**
 * Export telemetry, for the Settings page.
 *
 * Answers the four questions an operator asks when a spreadsheet looks stale:
 * did the last export succeed, when, how many rows did it move, and is n8n
 * reaching us at all. None of those can be read from `sync_runs`, which records
 * collection *from Meta* rather than delivery *to Sheets* — a sweep can succeed
 * perfectly while every export request is bouncing off a rotated secret.
 */

export type RecordExportRunInput = {
  dataset: string;
  format: "json" | "sheets" | "csv";
  caller: "n8n" | "browser";
  status: "succeeded" | "failed";
  rowCount: number;
  totalAvailable?: number | null;
  filters?: Record<string, unknown> | null;
  errorMessage?: string | null;
  durationMs?: number | null;
};

/**
 * Record one export request. Never throws.
 *
 * Telemetry must not be able to fail the thing it is measuring. If this insert
 * breaks — a migration not yet applied, a connection blip — the export itself
 * still succeeds and the caller still gets its rows; the loss is one row of
 * history, which is strictly better than a `500` on a working export.
 */
export async function recordExportRun(input: RecordExportRunInput): Promise<void> {
  try {
    const db = getDb();

    await db.insert(exportRuns).values({
      dataset: input.dataset,
      format: input.format,
      caller: input.caller,
      status: input.status,
      rowCount: input.rowCount,
      totalAvailable: input.totalAvailable ?? null,
      filtersJson: (input.filters ?? null) as never,
      // The check constraint requires a message on failure; give it one either
      // way, and sanitise it — this is telemetry, not a debugging channel.
      errorMessage:
        input.status === "failed"
          ? sanitiseMessage(input.errorMessage ?? "The export failed.")
          : input.errorMessage
            ? sanitiseMessage(input.errorMessage)
            : null,
      durationMs: input.durationMs ?? null,
    });
  } catch (cause) {
    childLogger({ component: "export.telemetry" }).warn("export_run.record_failed", {
      dataset: input.dataset,
      error: cause instanceof Error ? cause.message : "unknown",
    });
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export type ExportRunSummary = {
  id: string;
  dataset: string;
  format: string;
  caller: string;
  status: string;
  rowCount: number;
  totalAvailable: number | null;
  errorMessage: string | null;
  durationMs: number | null;
  createdAt: Date;
};

/**
 * How long without a request before n8n is considered out of contact.
 *
 * 36 hours: comfortably longer than a daily schedule plus a late start, short
 * enough that a workflow that has been switched off for two days is noticed.
 */
export const N8N_CONTACT_WINDOW_HOURS = 36;

export type ExportStatusView = {
  /** Most recent successful export of any dataset. */
  lastSuccess: ExportRunSummary | null;
  /** Most recent failure, whether or not a later run succeeded. */
  lastFailure: ExportRunSummary | null;
  /** Rows exported in the last 24 hours and in total. */
  rowsLast24h: number;
  rowsAllTime: number;
  /** Export requests in the last 24 hours, by outcome. */
  succeededLast24h: number;
  failedLast24h: number;
  /** Per-dataset last outcome, so a single broken branch is visible. */
  perDataset: {
    dataset: string;
    lastRunAt: Date;
    status: string;
    rowCount: number;
    errorMessage: string | null;
  }[];
  /**
   * The most recent authenticated automation contact of any kind — an export or
   * a sync trigger. Broader than the export history on purpose: a workflow whose
   * export branches are all disabled is still connected.
   */
  lastAutomationContactAt: Date | null;
  connection: "never_connected" | "connected" | "stale";
  recent: ExportRunSummary[];
};

const RUN_COLUMNS = {
  id: exportRuns.id,
  dataset: exportRuns.dataset,
  format: exportRuns.format,
  caller: exportRuns.caller,
  status: exportRuns.status,
  rowCount: exportRuns.rowCount,
  totalAvailable: exportRuns.totalAvailable,
  errorMessage: exportRuns.errorMessage,
  durationMs: exportRuns.durationMs,
  createdAt: exportRuns.createdAt,
} as const;

export async function getExportStatus(): Promise<ExportStatusView> {
  const db = getDb();
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [lastSuccess, lastFailure, totals, dayTotals, perDataset, lastSync, recent] =
    await Promise.all([
      db
        .select(RUN_COLUMNS)
        .from(exportRuns)
        .where(eq(exportRuns.status, "succeeded"))
        .orderBy(desc(exportRuns.createdAt))
        .limit(1),

      db
        .select(RUN_COLUMNS)
        .from(exportRuns)
        .where(eq(exportRuns.status, "failed"))
        .orderBy(desc(exportRuns.createdAt))
        .limit(1),

      db
        .select({
          rows: sql<
            string | null
          >`sum(${exportRuns.rowCount}) filter (where ${exportRuns.status} = 'succeeded')`,
        })
        .from(exportRuns),

      db
        .select({
          rows: sql<
            string | null
          >`sum(${exportRuns.rowCount}) filter (where ${exportRuns.status} = 'succeeded')`,
          succeeded: sql<number>`count(*) filter (where ${exportRuns.status} = 'succeeded')::int`,
          failed: sql<number>`count(*) filter (where ${exportRuns.status} = 'failed')::int`,
        })
        .from(exportRuns)
        .where(gte(exportRuns.createdAt, dayAgo)),

      // The latest run per dataset. `distinct on` is the direct way to say that
      // in Postgres and avoids a window function over a table that is mostly
      // history.
      db.execute<{
        dataset: string;
        created_at: Date;
        status: string;
        row_count: number;
        error_message: string | null;
      }>(sql`
        select distinct on (dataset)
          dataset, created_at, status::text as status, row_count, error_message
        from ${exportRuns}
        order by dataset asc, created_at desc
      `),

      // Any authenticated automation contact, not just an export.
      db
        .select({ at: sql<string | null>`max(${syncRuns.startedAt})` })
        .from(syncRuns)
        .where(eq(syncRuns.syncType, "automation")),

      db.select(RUN_COLUMNS).from(exportRuns).orderBy(desc(exportRuns.createdAt)).limit(10),
    ]);

  const lastExportAt = [lastSuccess[0]?.createdAt, lastFailure[0]?.createdAt]
    .filter((value): value is Date => value instanceof Date)
    .sort((a, b) => b.getTime() - a.getTime())[0];

  const lastSyncAt = tsResult(lastSync[0]?.at);

  const lastContact = [lastExportAt, lastSyncAt]
    .filter((value): value is Date => value instanceof Date)
    .sort((a, b) => b.getTime() - a.getTime())[0];

  const staleAfter = Date.now() - N8N_CONTACT_WINDOW_HOURS * 60 * 60 * 1000;

  return {
    lastSuccess: lastSuccess[0] ?? null,
    lastFailure: lastFailure[0] ?? null,
    // `sum` arrives from postgres.js as a string; Number is safe at these sizes.
    rowsAllTime: Number(totals[0]?.rows ?? 0),
    rowsLast24h: Number(dayTotals[0]?.rows ?? 0),
    succeededLast24h: dayTotals[0]?.succeeded ?? 0,
    failedLast24h: dayTotals[0]?.failed ?? 0,
    perDataset: [...perDataset].map((row) => ({
      dataset: row.dataset,
      lastRunAt: new Date(row.created_at),
      status: row.status,
      rowCount: Number(row.row_count ?? 0),
      errorMessage: row.error_message,
    })),
    lastAutomationContactAt: lastContact ?? null,
    connection: !lastContact
      ? "never_connected"
      : lastContact.getTime() >= staleAfter
        ? "connected"
        : "stale",
    recent,
  };
}
