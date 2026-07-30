import { handleExportRequest } from "@/lib/automation/export-handler";
import { exportVideoInsights } from "@/lib/repositories/automation-exports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/automation/exports/video-insights
 *
 * As `post-insights`, keyed on the video. Video metrics in particular arrive in
 * every JSON shape — a scalar count, a retention-curve array, a
 * reactions-by-type object, a nested demographics tree — which is why the value
 * is carried both displayed and JSON-encoded.
 */
export async function GET(request: Request) {
  return handleExportRequest(request, "video_insights", exportVideoInsights);
}
