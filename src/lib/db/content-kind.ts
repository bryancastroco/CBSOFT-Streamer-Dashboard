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

// ---------------------------------------------------------------------------
// Comments live where Meta put them
// ---------------------------------------------------------------------------

/**
 * The rule for anything that reads *comments* rather than counting content.
 *
 * A broadcast's comments are on its feed story, not on its video row — 800 of
 * them against 34, in production. So `excludeFeedStories` is exactly wrong
 * here: applied to a comment query it hides the richest threads on the Page,
 * silently, because a livestream's video row has almost nothing attached to it.
 *
 * The rule that makes both work is: **the row that owns the comments is the row
 * that represents the item.** A livestream is represented by its feed story; a
 * reel or an upload by its video row; a post by itself. Every item appears
 * exactly once and carries its own conversation.
 *
 * That is why these are two helpers rather than one. Counting content and
 * reading its comments are different questions here, and answering the second
 * with the first is the mistake this pair exists to make hard.
 */

/**
 * Post rows that represent an item, for the given scope.
 *
 * Takes the alias because the three callers name the table differently — `p`,
 * `t`, and Drizzle's own `"posts"`. A helper that assumed one of those would
 * work in one query and fail to compile in the next, which is a good failure;
 * worse is the version that silently resolves to the wrong table.
 */
export function commentPostScope(scope: ContentScope, postsAlias: SQL): SQL | undefined {
  if (scope === "posts") return sql`${postsAlias}.video_id is null`;

  if (scope === "videos" || scope === "livestreams") {
    const kind = scopeVideoKind(scope);
    return sql`exists (
      select 1 from videos kv
       where kv.id = ${postsAlias}.video_id
         and kv.media_kind = ${kind}
    )`;
  }

  // `all` — every post row, whether it stands alone or fronts a broadcast.
  return undefined;
}

/**
 * Video rows whose comments are genuinely their own.
 *
 * A video with a feed story is represented by that story, so including it here
 * as well would put one broadcast in the list twice — once with its comments
 * and once with the handful that landed on the video object.
 */
export function videosOwningTheirComments(videosAlias: SQL): SQL {
  return sql`not exists (select 1 from posts kp where kp.video_id = ${videosAlias}.id)`;
}
