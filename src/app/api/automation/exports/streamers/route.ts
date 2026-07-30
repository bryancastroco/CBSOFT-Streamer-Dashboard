import { handleExportRequest } from "@/lib/automation/export-handler";
import { exportStreamers } from "@/lib/repositories/automation-exports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/automation/exports/streamers
 *
 * The roster, normalised for Google Sheets. Supports `updated_after`, `from`,
 * `to`, `streamer_id`, `limit` and `offset`; see `docs/N8N-AUTOMATION.md`.
 *
 * No Page token, ciphertext or token suffix is in the column set. `token_status`
 * is a health enum, which is what lets a workflow alert on a Page that needs
 * reauthorising.
 */
export async function GET(request: Request) {
  return handleExportRequest(request, "streamers", exportStreamers);
}
