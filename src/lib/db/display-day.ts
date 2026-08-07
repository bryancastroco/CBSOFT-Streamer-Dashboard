import "server-only";

import { sql, type SQL } from "drizzle-orm";
import type { AnyColumn } from "drizzle-orm";

import { DISPLAY_TIME_ZONE } from "@/lib/time/zone";

/**
 * Bucket a `timestamptz` by the day it fell on in the display zone.
 *
 * ## Why the zone is inlined rather than bound
 *
 * The obvious spelling — `` sql`... at time zone ${DISPLAY_TIME_ZONE}` `` —
 * produces a query that runs fine on its own and fails the moment it is
 * grouped. Drizzle turns the interpolated string into a bind parameter, and
 * each use gets its own number, so the same expression is emitted as `$1` in
 * the SELECT list and `$2` in the GROUP BY. Postgres matches grouping
 * expressions syntactically, decides those two are different, and answers:
 *
 *     column "posts.created_time" must appear in the GROUP BY clause
 *
 * which names a column that is right there in the GROUP BY, and says nothing
 * about time zones at all. Nothing catches it earlier: it type-checks, and a
 * hand-written version of the same query with the zone typed out twice — which
 * is how anyone would sanity-check it — works, because two identical literals
 * *do* match.
 *
 * So the zone becomes part of the SQL text. Both call sites then emit the same
 * bytes and the grouping matches.
 *
 * ## Why that is not an injection
 *
 * `DISPLAY_TIME_ZONE` is a module constant, never user input. The guard below
 * is not defending against today's value; it is there so that a future edit
 * pointing this at something dynamic fails loudly at import, rather than
 * quietly concatenating it into SQL.
 */

const ZONE_LITERAL = ((): string => {
  // IANA names: alphanumeric segments, separated by `/`, with `_`, `+` and `-`.
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/.test(DISPLAY_TIME_ZONE)) {
    throw new Error(
      `DISPLAY_TIME_ZONE ${JSON.stringify(DISPLAY_TIME_ZONE)} is not a plain IANA zone name, ` +
        "and this module inlines it into SQL. Bind it as a parameter instead.",
    );
  }

  return `'${DISPLAY_TIME_ZONE}'`;
})();

/**
 * `date_trunc('day', column at time zone <display zone>)`.
 *
 * Use the *same call* in the projection and in the `groupBy` — they render
 * identical text, which is what makes the grouping legal.
 */
export function displayDay(column: AnyColumn | SQL): SQL {
  return sql`date_trunc('day', ${column} at time zone ${sql.raw(ZONE_LITERAL)})`;
}

/** The same bucket, rendered as the `YYYY-MM-DD` the charts label. */
export function displayDayText(column: AnyColumn | SQL): SQL<string> {
  return sql<string>`to_char(${displayDay(column)}, 'YYYY-MM-DD')`;
}
