import { handleExportRequest } from "@/lib/automation/export-handler";
import { exportSyncLogs } from "@/lib/repositories/automation-exports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/automation/exports/sync-logs
 *
 * Every synchronisation run, so the workflow's own history can be recorded
 * alongside the data it moved — the "Record automation result" step of the
 * documented n8n workflow reads from here.
 *
 * `parent_sync_run_id` links a per-streamer run to the sweep that spawned it.
 * `error_message` is sanitised; the structured `error_details_json` column is
 * deliberately not exported — it is for an operator reading the database.
 */
export async function GET(request: Request) {
  return handleExportRequest(request, "sync_logs", exportSyncLogs);
}
