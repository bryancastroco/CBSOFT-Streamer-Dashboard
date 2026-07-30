import { jsonError, jsonOk } from "@/lib/api/admin-guard";
import { requireApiUser } from "@/lib/api/user-guard";
import { getPostById } from "@/lib/repositories/posts";
import { describeInsights } from "@/lib/meta/insight-display";
import { postIdSchema } from "@/lib/validation/posts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/posts/{id} — one post with every stored metric.
 *
 * `insights` contains only what Meta actually returned. `availability` marks
 * each engagement count as reported or not, so a consumer never has to guess
 * whether a missing number means zero — it does not.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const { id } = await context.params;
  const parsed = postIdSchema.safeParse(id);
  if (!parsed.success) return jsonError(400, "invalid_id", "That is not a valid post id.");

  const post = await getPostById(parsed.data);
  if (!post) return jsonError(404, "not_found", "No such post.");

  return jsonOk({
    post,
    insights: describeInsights(post.insights),
    availability: {
      reactionCount: post.reactionCount === null ? "not_available" : "reported",
      commentCount: post.commentCount === null ? "not_available" : "reported",
      shareCount: post.shareCount === null ? "not_available" : "reported",
    },
  });
}
