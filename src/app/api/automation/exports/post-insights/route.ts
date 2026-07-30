import { handleExportRequest } from "@/lib/automation/export-handler";
import { exportPostInsights } from "@/lib/repositories/automation-exports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/automation/exports/post-insights
 *
 * One row per stored metric. No metric name is hard-coded anywhere in the
 * system, so this dataset is as wide as whatever Meta returned.
 *
 * Each value is carried three ways — `value_display` for the cell a person
 * reads, `value_json` for the exact value, and `value_type` — because a Sheets
 * cell holds one scalar and a Meta metric can be a nested tree.
 *
 * `from`/`to` filter on the parent post's publication date, not on collection
 * time: "insights for July's posts" is what a report asks, and a re-sync must
 * not move a post into a different month.
 */
export async function GET(request: Request) {
  return handleExportRequest(request, "post_insights", exportPostInsights);
}
