import { handleExportRequest } from "@/lib/automation/export-handler";
import { exportCommentSummaries } from "@/lib/repositories/automation-exports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/automation/exports/comment-summaries
 *
 * The AI analyses across posts and videos, in one list.
 *
 * This exports the *analysis*, not the comments. There is no commenter column
 * because none exists — the Graph request never asks for `from`, so no identity
 * is received, stored or exportable. Finding lists are pipe-joined; a list
 * containing only the model's "No significant findings" placeholder is exported
 * blank, because that placeholder means the absence of a finding.
 */
export async function GET(request: Request) {
  return handleExportRequest(request, "comment_summaries", exportCommentSummaries);
}
