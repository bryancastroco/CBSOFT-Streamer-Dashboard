import { handleExportRequest } from "@/lib/automation/export-handler";
import { exportPosts } from "@/lib/repositories/automation-exports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/automation/exports/posts
 *
 * One row per post. Engagement counts are nullable: Meta omits `shares`
 * entirely on a post with none, and a blank cell is the honest rendering — it
 * is never written as 0.
 */
export async function GET(request: Request) {
  return handleExportRequest(request, "posts", exportPosts);
}
