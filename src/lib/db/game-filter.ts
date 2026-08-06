import "server-only";

import { sql, type AnyColumn, type SQL } from "drizzle-orm";

import { UNFILED_GAME } from "@/lib/filters/browse";

/**
 * One predicate for the game filter, shared by every query that honours it.
 *
 * Written once because the filter has three states and only two of them are
 * obvious. `undefined` is "no filter"; a uuid is "this game"; `UNFILED_GAME` is
 * "attributed to nothing", which is a real selection and must become `is null`
 * rather than an equality against a sentinel that matches no row. Repeating that
 * in seven repositories is how one of them ends up returning everything.
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
  if (gameId === UNFILED_GAME) return sql`${column} is null`;
  return sql`${column} = ${gameId}::uuid`;
}
