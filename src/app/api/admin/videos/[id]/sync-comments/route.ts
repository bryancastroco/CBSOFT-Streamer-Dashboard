import { jsonError, jsonOk, requireApiAdmin } from "@/lib/api/admin-guard";
import { syncContentComments } from "@/lib/services/sync-comments";
import { videoIdSchema } from "@/lib/validation/videos";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/admin/videos/{id}/sync-comments
 *
 * The same pipeline as the post equivalent — same Graph edge, same field list
 * with no commenter identity, same deduplication, same source hash, same
 * summarisation — differing only in which parent row the comments attach to.
 *
 * The AI is called only when the comment set has actually changed.
 */
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAdmin();
  if (!auth.ok) return auth.response;

  const { id } = await context.params;
  const parsed = videoIdSchema.safeParse(id);
  if (!parsed.success) return jsonError(400, "invalid_id", "That is not a valid video id.");

  const outcome = await syncContentComments({
    actorId: auth.user.id,
    content: { type: "video", id: parsed.data },
  });

  if (!outcome.ok) {
    const status = outcome.reason === "content_not_found" ? 404 : 422;
    return jsonError(status, outcome.reason, outcome.message);
  }

  return jsonOk({ sync: outcome.result });
}
