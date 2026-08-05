import { z } from "zod";

import {
  DEFAULT_PERIOD,
  resolveContentScope,
  resolvePeriod,
  type ContentScope,
  type PeriodPreset,
  type ResolvedPeriod,
} from "@/lib/filters/period";
import { resolveSort, type SortDirection, type SortState } from "@/lib/filters/sorting";

/**
 * The shared query contract for every browsable screen — a PURE module.
 *
 * One resolver serves the dashboard, the posts and videos tables, the comment
 * analysis list and the CSV exports, which is what guarantees a CSV contains
 * exactly the rows the table showed. An export that quietly reinterprets the
 * filters is worse than no export.
 *
 * Nothing here throws. A malformed parameter falls back to a sane default and,
 * where it matters, the reader is told via `ResolvedPeriod.warning`.
 */

/** Raw search params, as Next hands them over. */
export type RawParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * The primitives worth validating strictly.
 *
 * `streamerId` must be a uuid — an arbitrary string would reach a `WHERE
 * streamer_id = $1` as a cast error rather than an empty result. `search` is
 * length-capped because it becomes an `ILIKE '%…%'` pattern.
 */
const primitivesSchema = z.object({
  streamerId: z.uuid().optional().catch(undefined),
  search: z.string().trim().min(1).max(200).optional().catch(undefined),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0).catch(0),
});

export const DEFAULT_PAGE_SIZE = 25;

export type BrowseQuery<K extends string> = {
  period: ResolvedPeriod;
  scope: ContentScope;
  streamerId: string | undefined;
  search: string | undefined;
  sort: SortState<K>;
  offset: number;
  limit: number;
};

export function resolveBrowseQuery<K extends string>(params: {
  raw: RawParams;
  sortKeys: readonly K[];
  defaultSort: SortState<K>;
  limit?: number;
  now?: Date;
}): BrowseQuery<K> {
  const raw = params.raw;

  const primitives = primitivesSchema.parse({
    streamerId: first(raw["streamerId"]),
    search: first(raw["search"]),
    offset: first(raw["offset"]) ?? 0,
  });

  return {
    period: resolvePeriod({
      preset: first(raw["period"]),
      from: first(raw["from"]),
      to: first(raw["to"]),
      ...(params.now ? { now: params.now } : {}),
    }),
    scope: resolveContentScope(first(raw["scope"])),
    streamerId: primitives.streamerId,
    search: primitives.search,
    sort: resolveSort(params.sortKeys, params.defaultSort, {
      sort: first(raw["sort"]),
      dir: first(raw["dir"]),
    }),
    offset: primitives.offset,
    limit: params.limit ?? DEFAULT_PAGE_SIZE,
  };
}

// ---------------------------------------------------------------------------
// Link building
// ---------------------------------------------------------------------------

export type BrowseOverrides<K extends string> = {
  period?: PeriodPreset;
  from?: string | null;
  to?: string | null;
  scope?: ContentScope;
  streamerId?: string | null;
  search?: string | null;
  sort?: K;
  dir?: SortDirection;
  offset?: number;
  /** Reset paging. Any filter change should pass this. */
  resetOffset?: boolean;
};

/**
 * Build a URL that preserves the current filters and changes only what is
 * given. Every sort header, page button and filter control routes through this,
 * so no control can drop a filter the reader had set — a class of bug that is
 * invisible until someone exports the wrong rows.
 *
 * Default values are omitted from the query string, which keeps shareable URLs
 * readable and makes `/posts` and `/posts?period=30d&dir=desc` the same page.
 *
 * `basePath` may already carry a query string — the streamer tabs pass
 * `/streamers/{id}?tab=posts` so that sorting a table inside a tab does not
 * navigate away from it. The separator is chosen accordingly.
 */
export function buildBrowseHref<K extends string>(
  basePath: string,
  query: BrowseQuery<K>,
  defaultSort: SortState<K>,
  overrides: BrowseOverrides<K> = {},
): string {
  const next = new URLSearchParams();

  /*
   * Compared against the constant, not a repeated literal.
   *
   * This read `!== "30d"`, which was the default when it was written. Moving
   * the default to a week left every "clean" link carrying `?period=7d` — the
   * parameter no longer matched the thing it was supposed to be omitted for.
   * Harmless to look at and wrong in the way that matters: `/posts` and
   * `/posts?period=7d` stopped being the same URL, so a shared link and a
   * bookmark diverged from the page they were copied from.
   */
  const period = overrides.period ?? query.period.preset;
  if (period !== DEFAULT_PERIOD) next.set("period", period);

  if (period === "custom") {
    const from =
      overrides.from !== undefined
        ? overrides.from
        : query.period.from
          ? query.period.from.toISOString().slice(0, 10)
          : null;
    const to =
      overrides.to !== undefined
        ? overrides.to
        : query.period.to
          ? query.period.to.toISOString().slice(0, 10)
          : null;

    if (from) next.set("from", from);
    if (to) next.set("to", to);
  }

  const scope = overrides.scope ?? query.scope;
  if (scope !== "all") next.set("scope", scope);

  const streamerId =
    overrides.streamerId !== undefined ? overrides.streamerId : (query.streamerId ?? null);
  if (streamerId) next.set("streamerId", streamerId);

  const search = overrides.search !== undefined ? overrides.search : (query.search ?? null);
  if (search) next.set("search", search);

  const sortKey = overrides.sort ?? query.sort.key;
  const sortDir = overrides.dir ?? (overrides.sort ? defaultSort.direction : query.sort.direction);
  if (sortKey !== defaultSort.key || sortDir !== defaultSort.direction) {
    next.set("sort", sortKey);
    next.set("dir", sortDir);
  }

  const resetOffset = overrides.resetOffset ?? overrides.offset === undefined;
  const offset = resetOffset ? 0 : (overrides.offset ?? query.offset);
  if (offset > 0) next.set("offset", String(offset));

  const qs = next.toString();
  if (!qs) return basePath;

  return `${basePath}${basePath.includes("?") ? "&" : "?"}${qs}`;
}
