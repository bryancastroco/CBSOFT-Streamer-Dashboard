import { jsonError, jsonOk } from "@/lib/api/admin-guard";
import { requireApiUser } from "@/lib/api/user-guard";
import { listPosts } from "@/lib/repositories/posts";
import { listPostsQuerySchema } from "@/lib/validation/posts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/posts — paginated post list.
 *
 * Readable by any signed-in user, admin or viewer. Post content is public on
 * Facebook; nothing here is sensitive, and no token or ciphertext is reachable
 * from these tables.
 */
export async function GET(request: Request) {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);

  const parsed = listPostsQuerySchema.safeParse({
    streamerId: url.searchParams.get("streamerId") ?? undefined,
    search: url.searchParams.get("search") ?? undefined,
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
    offset: url.searchParams.get("offset") ?? undefined,
  });

  if (!parsed.success) {
    return jsonError(400, "invalid_query", "Invalid query parameters.", parsed.error.issues);
  }

  const { items, total } = await listPosts({
    ...(parsed.data.streamerId ? { streamerId: parsed.data.streamerId } : {}),
    ...(parsed.data.search ? { search: parsed.data.search } : {}),
    ...(parsed.data.from ? { from: new Date(parsed.data.from) } : {}),
    ...(parsed.data.to ? { to: new Date(parsed.data.to) } : {}),
    limit: parsed.data.limit,
    offset: parsed.data.offset,
  });

  return jsonOk({
    posts: items,
    pagination: {
      total,
      limit: parsed.data.limit,
      offset: parsed.data.offset,
      hasMore: parsed.data.offset + items.length < total,
    },
  });
}
