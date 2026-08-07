import "server-only";

import { sql, type AnyColumn, type SQL } from "drizzle-orm";

import { ALL_CONTENT, ANY_GAME, UNFILED_GAME } from "@/lib/filters/browse";

/**
 * One predicate for the game filter, shared by every query that honours it.
 *
 * Written once because the filter has five inputs and only one of them is the
 * obvious equality:
 *
 *   undefined     no filter — the caller resolved no default
 *   ALL_CONTENT   no filter — the reader asked for everything, explicitly
 *   ANY_GAME      `is not null` — the registered catalogue, as a whole
 *   a uuid        `= that game`
 *   UNFILED_GAME  `is null` — everything the catalogue does not reach
 *
 * The first two produce the same SQL and mean different things upstream: one is
 * "nobody chose", the other is "somebody chose everything". They stay separate
 * in the URL so a screen whose default is a filter can still express the
 * unfiltered view; they converge only here, where the distinction has no
 * consequence.
 *
 * The set-valued cases are the ones worth centralising. Each must become a null
 * test, not an equality against a sentinel string: compared as a uuid the cast
 * would error, and compared as text it would match nothing and read as an empty
 * result rather than a broken filter. Repeating that reasoning across seven
 * repositories is how one of them ends up quietly returning everything.
 *
 * Accepts a Drizzle column or a raw fragment, because the queries here are split
 * between both styles — `posts.gameId` in the builder, `p.game_id` inside a
 * hand-written union.
 *
 * The `::uuid` cast is required for the same reason `tsParam` needs its own:
 * under `prepare: false` a bare text parameter has no inferable type.
 */
export function gameClause(
  column: AnyColumn | SQL,
  gameId: string | null | undefined,
): SQL | undefined {
  if (!gameId || gameId === ALL_CONTENT) return undefined;
  if (gameId === ANY_GAME) return sql`${column} is not null`;
  if (gameId === UNFILED_GAME) return sql`${column} is null`;
  return sql`${column} = ${gameId}::uuid`;
}

/**
 * The same filter, applied to a *streamer* rather than a piece of content.
 *
 * Content carries `game_id` directly; a streamer carries an assignment in
 * `streamer_games`, so the equality above cannot be reused. The four inputs
 * keep their meanings, translated to "who covers this":
 *
 *   ALL_CONTENT   every streamer
 *   ANY_GAME      streamers with at least one game assigned
 *   a uuid        streamers assigned that game
 *   UNFILED_GAME  streamers with no game at all
 *
 * `UNFILED_GAME` is the useful one on a roster screen and has no equivalent
 * anywhere else: it answers "whose games has nobody set up yet", which is the
 * question behind most content that cannot be filtered.
 *
 * Takes the streamer id column so a caller can pass an alias, matching
 * `gameClause`.
 */
export function streamerGameClause(
  streamerIdColumn: AnyColumn | SQL,
  gameId: string | null | undefined,
): SQL | undefined {
  if (!gameId || gameId === ALL_CONTENT) return undefined;

  const assigned = (extra: SQL | null) => sql`exists (
    select 1 from streamer_games sg
     where sg.streamer_id = ${streamerIdColumn}
     ${extra ? sql`and ${extra}` : sql``}
  )`;

  if (gameId === ANY_GAME) return assigned(null);
  if (gameId === UNFILED_GAME) return sql`not ${assigned(null)}`;

  return assigned(sql`sg.game_id = ${gameId}::uuid`);
}
