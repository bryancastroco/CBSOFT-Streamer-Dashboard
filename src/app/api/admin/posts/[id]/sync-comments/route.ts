import { jsonError, jsonOk, requireApiAdmin } from "@/lib/api/admin-guard";
import { syncPostComments } from "@/lib/services/sync-comments";
import { postIdSchema } from "@/lib/validation/posts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Paginated comment fetch plus one AI call. */
export const maxDuration = 300;

/**
 * POST /api/admin/posts/{id}/sync-comments
 *
 * Collects comments from Meta and summarises them — but only calls the AI when
 * the comment set has actually changed. A re-run over unchanged comments
 * returns `summaryStatus: "unchanged"` and costs nothing.
 *
 * Admin-only: it spends both Meta quota and AI tokens.
 */
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAdmin();
  if (!auth.ok) return auth.response;

  const { id } = await context.params;
  const parsed = postIdSchema.safeParse(id);
  if (!parsed.success) return jsonError(400, "invalid_id", "That is not a valid post id.");

  const outcome = await syncPostComments({ actorId: auth.user.id, postId: parsed.data });

  if (!outcome.ok) {
    const status = outcome.reason === "content_not_found" ? 404 : 422;
    return jsonError(status, outcome.reason, outcome.message);
  }

  return jsonOk({ sync: outcome.result });
}
