import { handleExportRequest } from "@/lib/automation/export-handler";
import { exportVideos } from "@/lib/repositories/automation-exports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/automation/exports/videos
 *
 * One row per video. `length_seconds` is fractional because Meta reports it
 * that way, and null when Meta reported no length at all — not 0.
 */
export async function GET(request: Request) {
  return handleExportRequest(request, "videos", exportVideos);
}
