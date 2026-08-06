import "server-only";

import { sql, type AnyColumn, type SQL } from "drizzle-orm";

import { ANY_GAME, UNFILED_GAME } from "@/lib/filters/browse";

/**
 * One predicate for the game filter, shared by every query that honours it.
 *
 * Written once because the filter has four states and only one of them is the
 * obvious equality:
 *
 *   undefined     no filter at all
 *   ANY_GAME      `is not null` — the registered catalogue, as a whole
 *   a uuid        `= that game`
 *   UNFILED_GAME  `is null` — everything the catalogue does not reach
 *
 * The two set-valued cases are the ones worth centralising. Each must become a
 * null test, not an equality against a sentinel string: compared as a uuid the
 * cast would error, and compared as text it would match nothing and read as an
 * empty result rather than a broken filter. Repeating that reasoning across
 * seven repositories is how one of them ends up quietly returning everything.
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
  if (!gameId) return undefined;
  if (gameId === ANY_GAME) return sql`${column} is not null`;
  if (gameId === UNFILED_GAME) return sql`${column} is null`;
  return sql`${column} = ${gameId}::uuid`;
}
