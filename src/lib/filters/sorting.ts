/**
 * Sortable-column contracts — a PURE module.
 *
 * ## Why an allow-list rather than a column name
 *
 * A sort key arrives from the query string, and the query string is
 * attacker-controlled. Passing it through to `ORDER BY` — even via a template
 * literal that "looks" safe — is how ordering becomes an injection point. Each
 * table below declares the keys it accepts; anything else resolves to that
 * table's default. The repository then maps the key to a Drizzle column object,
 * so no user-supplied string ever reaches SQL.
 */

export const SORT_DIRECTIONS = ["asc", "desc"] as const;

export type SortDirection = (typeof SORT_DIRECTIONS)[number];

export function isSortDirection(value: unknown): value is SortDirection {
  return value === "asc" || value === "desc";
}

export const POST_SORT_KEYS = [
  "createdTime",
  "streamer",
  "reactions",
  "comments",
  "shares",
  "metrics",
  "sentiment",
  "summaryStatus",
] as const;

export type PostSortKey = (typeof POST_SORT_KEYS)[number];

export const VIDEO_SORT_KEYS = [
  "createdTime",
  "streamer",
  "title",
  "length",
  "metrics",
  "comments",
  "sentiment",
  "summaryStatus",
] as const;

export type VideoSortKey = (typeof VIDEO_SORT_KEYS)[number];

export const ANALYSIS_SORT_KEYS = [
  "generatedAt",
  "streamer",
  "contentType",
  "commentCount",
  "sentiment",
  "urgentCount",
] as const;

export type AnalysisSortKey = (typeof ANALYSIS_SORT_KEYS)[number];

export type SortState<K extends string> = { key: K; direction: SortDirection };

/**
 * Resolve a sort key and direction against an allow-list.
 *
 * Unrecognised input falls back to the default rather than erroring: a stale
 * bookmark or a hand-edited URL should still render the table.
 */
export function resolveSort<K extends string>(
  allowed: readonly K[],
  fallback: SortState<K>,
  input: { sort?: string | null | undefined; dir?: string | null | undefined },
): SortState<K> {
  // A direction is only honoured alongside a valid key, so `?dir=asc` on its
  // own cannot quietly reverse the default ordering.
  if (!(allowed as readonly string[]).includes(input.sort ?? "")) {
    return fallback;
  }

  return {
    key: input.sort as K,
    direction: isSortDirection(input.dir) ? input.dir : fallback.direction,
  };
}

/** The `aria-sort` value for a column header. */
export function ariaSortFor<K extends string>(
  column: K,
  state: SortState<K>,
): "ascending" | "descending" | "none" {
  if (state.key !== column) return "none";
  return state.direction === "asc" ? "ascending" : "descending";
}

/**
 * The direction a header link should request.
 *
 * Clicking the active column flips it; clicking any other column starts at that
 * column's natural direction — descending for dates and counts, ascending for
 * names, which is what a reader expects without being told.
 */
export function nextDirectionFor<K extends string>(
  column: K,
  state: SortState<K>,
  naturalDirection: SortDirection = "desc",
): SortDirection {
  if (state.key !== column) return naturalDirection;
  return state.direction === "asc" ? "desc" : "asc";
}
