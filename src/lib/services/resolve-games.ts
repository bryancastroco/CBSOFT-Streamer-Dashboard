import "server-only";

import { eq, isNull, sql } from "drizzle-orm";

import { getDb } from "@/lib/db";
import { gameHashtags, posts, videos } from "@/lib/db/schema";
import { resolveGameFor } from "@/lib/games/hashtags";
import { childLogger } from "@/lib/observability/logger";

/**
 * Decide which game each post and video is about.
 *
 * ## Why this is a pass rather than a trigger
 *
 * Attribution depends on data an admin edits: adding a hashtag to a game should
 * re-file the posts that already mention it, and moving a streamer's primary
 * game should re-file everything untagged. A trigger on insert would only ever
 * see new rows and would leave history describing a configuration that no
 * longer exists.
 *
 * So it re-resolves, and is cheap enough to run whenever the configuration
 * changes: three reads for the whole roster, then one bulk update per batch.
 *
 * ## Why every row is reconsidered by default
 *
 * `onlyMissing` exists for the sync path, where the question is just "file the
 * posts collected tonight". Everywhere else the answer for an *existing* row
 * may have changed, and skipping those is how a hashtag edit appears to do
 * nothing.
 */

export const RESOLVE_BATCH_SIZE = 500;

export type ResolveGamesSummary = {
  postsUpdated: number;
  videosUpdated: number;
  /** Content that matched no hashtag and whose streamer has no primary game. */
  unattributed: number;
  durationMs: number;
};

export async function resolveContentGames(
  options: { streamerId?: string | undefined; onlyMissing?: boolean } = {},
): Promise<ResolveGamesSummary> {
  const db = getDb();
  const log = childLogger({ component: "games.resolve" });
  const startedAt = Date.now();

  // ---- The configuration, read once ---------------------------------------
  const tags = await db
    .select({ tag: gameHashtags.tag, gameId: gameHashtags.gameId })
    .from(gameHashtags);

  const hashtagToGame = new Map(tags.map((row) => [row.tag, row.gameId]));

  /*
   * Nothing configured means nothing to resolve — and clearing every existing
   * attribution would be a destructive answer to "no games have been set up
   * yet", which is the state on the very first run.
   *
   * Hashtags alone decide this now. It previously also checked for a streamer
   * with a primary game, which was correct while that seeded attribution and
   * would now be a way to keep running with no evidence to run on.
   */
  if (hashtagToGame.size === 0) {
    log.info("games.resolve.no_configuration");
    return { postsUpdated: 0, videosUpdated: 0, unattributed: 0, durationMs: 0 };
  }

  let postsUpdated = 0;
  let videosUpdated = 0;
  let unattributed = 0;

  // ---- Posts ---------------------------------------------------------------
  const postFilters = [
    ...(options.streamerId ? [eq(posts.streamerId, options.streamerId)] : []),
    ...(options.onlyMissing ? [isNull(posts.gameId)] : []),
  ];

  const postRows = await db
    .select({
      id: posts.id,
      streamerId: posts.streamerId,
      message: posts.message,
      gameId: posts.gameId,
      gameSource: posts.gameSource,
    })
    .from(posts)
    .where(postFilters.length > 0 ? sql`${sql.join(postFilters, sql` and `)}` : undefined);

  for (const batch of chunk(postRows, RESOLVE_BATCH_SIZE)) {
    const changes = batch
      .map((row) => {
        const resolved = resolveGameFor({
          text: row.message,
          hashtagToGame,
        });

        if (resolved.gameId === null) unattributed += 1;

        // Only write a row whose answer actually moved. A no-op update would
        // still be a write, and this runs over the whole roster.
        const unchanged = resolved.gameId === row.gameId && resolved.source === row.gameSource;

        return unchanged ? null : { id: row.id, ...resolved };
      })
      .filter((change): change is { id: string; gameId: string | null; source: "hashtag" | "streamer" | null } => change !== null);

    if (changes.length === 0) continue;

    await applyPostChanges(changes);
    postsUpdated += changes.length;
  }

  // ---- Videos --------------------------------------------------------------
  const videoFilters = [
    ...(options.streamerId ? [eq(videos.streamerId, options.streamerId)] : []),
    ...(options.onlyMissing ? [isNull(videos.gameId)] : []),
  ];

  const videoRows = await db
    .select({
      id: videos.id,
      streamerId: videos.streamerId,
      title: videos.title,
      description: videos.description,
      gameId: videos.gameId,
      gameSource: videos.gameSource,
    })
    .from(videos)
    .where(videoFilters.length > 0 ? sql`${sql.join(videoFilters, sql` and `)}` : undefined);

  for (const batch of chunk(videoRows, RESOLVE_BATCH_SIZE)) {
    const changes = batch
      .map((row) => {
        const resolved = resolveGameFor({
          // Title and description both, because a hashtag lives in either.
          text: `${row.title ?? ""}\n${row.description ?? ""}`,
          hashtagToGame,
        });

        if (resolved.gameId === null) unattributed += 1;

        const unchanged = resolved.gameId === row.gameId && resolved.source === row.gameSource;
        return unchanged ? null : { id: row.id, ...resolved };
      })
      .filter((change): change is { id: string; gameId: string | null; source: "hashtag" | "streamer" | null } => change !== null);

    if (changes.length === 0) continue;

    await applyVideoChanges(changes);
    videosUpdated += changes.length;
  }

  const durationMs = Date.now() - startedAt;

  log.info("games.resolve.finished", { postsUpdated, videosUpdated, unattributed, durationMs });

  return { postsUpdated, videosUpdated, unattributed, durationMs };
}

type Change = { id: string; gameId: string | null; source: "hashtag" | "streamer" | null };

/**
 * One statement per batch rather than one per row.
 *
 * A `CASE` over a value list keeps the roster's whole re-resolution inside a
 * handful of round trips. The alternative — an update per changed row — is the
 * N+1 that made the metric rollup time out at 1,624 posts.
 */
async function applyPostChanges(changes: readonly Change[]): Promise<void> {
  const db = getDb();

  const ids = sql.join(
    changes.map((change) => sql`${change.id}::uuid`),
    sql`, `,
  );
  const gameCase = sql.join(
    changes.map((change) => sql`when id = ${change.id}::uuid then ${change.gameId}::uuid`),
    sql` `,
  );
  const sourceCase = sql.join(
    changes.map((change) => sql`when id = ${change.id}::uuid then ${change.source}::text`),
    sql` `,
  );

  await db.execute(sql`
    update posts
       set game_id = case ${gameCase} end,
           game_source = case ${sourceCase} end
     where id in (${ids})
  `);
}

async function applyVideoChanges(changes: readonly Change[]): Promise<void> {
  const db = getDb();

  const ids = sql.join(
    changes.map((change) => sql`${change.id}::uuid`),
    sql`, `,
  );
  const gameCase = sql.join(
    changes.map((change) => sql`when id = ${change.id}::uuid then ${change.gameId}::uuid`),
    sql` `,
  );
  const sourceCase = sql.join(
    changes.map((change) => sql`when id = ${change.id}::uuid then ${change.source}::text`),
    sql` `,
  );

  await db.execute(sql`
    update videos
       set game_id = case ${gameCase} end,
           game_source = case ${sourceCase} end
     where id in (${ids})
  `);
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}
