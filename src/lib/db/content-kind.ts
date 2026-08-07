import "server-only";

import { sql, type AnyColumn, type SQL } from "drizzle-orm";

import { scopeVideoKind, type ContentScope } from "@/lib/filters/period";

/**
 * The two predicates that make "post", "video" and "livestream" mean something
 * in a query.
 *
 * Both exist because the same broadcast is stored twice — Meta returns a live
 * recording from `/videos` *and* publishes a feed story for it, and each edge
 * was synced into its own table. Thirty-three of 286 posts were a second copy
 * of a video: every content count inflated, and one broadcast split across two
 * rows with the comments on one and the watch time on the other.
 */

/**
 * A row in `posts` that is a post in its own right.
 *
 * `posts.video_id` is set only on a feed story for a video. Excluding those is
 * what stops a livestream appearing under Posts and being counted a second
 * time — and it belongs on *every* post query, not only the ones scoped to
 * posts, because "all content" must not count it twice either.
 *
 * The comments still live on that row; the link is how a livestream reaches
 * them. Nothing is hidden, it is just no longer its own item.
 */
export function excludeFeedStories(videoIdColumn: AnyColumn | SQL): SQL {
  return sql`${videoIdColumn} is null`;
}

/**
 * Narrow videos to one kind, or don't.
 *
 * Returns undefined for a scope that does not distinguish — `all` covers every
 * kind including ones added later, which is why it is an absence of a clause
 * rather than a list of the kinds that exist today.
 */
export function mediaKindClause(
  mediaKindColumn: AnyColumn | SQL,
  scope: ContentScope,
): SQL | undefined {
  const kind = scopeVideoKind(scope);
  return kind ? sql`${mediaKindColumn} = ${kind}` : undefined;
}
