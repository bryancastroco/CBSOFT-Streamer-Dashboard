import { jsonError, jsonOk, requireApiAdmin } from "@/lib/api/admin-guard";
import { syncPostComments } from "@/lib/services/sync-comments";
import { postIdSchema } from "@/lib/validation/posts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/admin/posts/{id}/regenerate-summary
 *
 * Re-runs the analysis over the comments already stored, bypassing the
 * unchanged-comments gate. This is the third of the three conditions under
 * which the AI is called — the deliberate, admin-initiated one.
 *
 * It does **not** re-fetch from Meta: regenerating is about getting a better
 * analysis of the same evidence, and a fresh fetch would change the input and
 * make the comparison meaningless. Use `sync-comments` to pull new comments.
 */
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAdmin();
  if (!auth.ok) return auth.response;

  const { id } = await context.params;
  const parsed = postIdSchema.safeParse(id);
  if (!parsed.success) return jsonError(400, "invalid_id", "That is not a valid post id.");

  const outcome = await syncPostComments({
    actorId: auth.user.id,
    postId: parsed.data,
    forceRegenerate: true,
    skipFetch: true,
  });

  if (!outcome.ok) {
    const status = outcome.reason === "content_not_found" ? 404 : 422;
    return jsonError(status, outcome.reason, outcome.message);
  }

  return jsonOk({ sync: outcome.result });
}
