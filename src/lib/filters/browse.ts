import { z } from "zod";

import {
  DEFAULT_PERIOD,
  resolveContentScope,
  resolvePeriod,
  toIsoDate,
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
/**
 * The three set-valued selections, alongside "a specific game".
 *
 *   ALL_CONTENT   every piece of content, filed or not — no predicate
 *   ANY_GAME      anything attributed to a registered game
 *   a uuid        that one game
 *   UNFILED_GAME  anything attributed to nothing
 *
 * `ANY_GAME` and `UNFILED_GAME` partition the content between them, and
 * `ALL_CONTENT` is their union. Those are the questions an operator actually
 * asks of a catalogue — how is what I registered doing, what is still falling
 * outside it, and show me everything — none of which is answerable by listing
 * games one at a time.
 *
 * ## Why "no filter" needs a token of its own
 *
 * It did not, while absence meant it. Once the default became `ANY_GAME`,
 * absence means "the default" and the unfiltered view needs a way to be said
 * out loud — otherwise selecting it produces a URL indistinguishable from
 * having selected nothing, and the filter springs back on the next navigation.
 *
 * `undefined` therefore no longer means "everything"; it means "whatever this
 * screen defaults to", which `resolveBrowseQuery` substitutes. Keeping the two
 * distinct is what lets `buildBrowseHref` omit the default from a URL while
 * still writing a non-default choice into it.
 *
 * None of the three is a uuid, so none can collide with a real game id.
 */
export const ALL_CONTENT = "all";
export const ANY_GAME = "any";
export const UNFILED_GAME = "none";

const primitivesSchema = z.object({
  streamerId: z.uuid().optional().catch(undefined),
  gameId: z
    .union([
      z.uuid(),
      z.literal(ALL_CONTENT),
      z.literal(ANY_GAME),
      z.literal(UNFILED_GAME),
    ])
    .optional()
    .catch(undefined),
  search: z.string().trim().min(1).max(200).optional().catch(undefined),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0).catch(0),
});

export const DEFAULT_PAGE_SIZE = 25;

export type BrowseQuery<K extends string> = {
  period: ResolvedPeriod;
  scope: ContentScope;
  streamerId: string | undefined;
  /**
   * The game a piece of content was filed under.
   *
   * An id rather than the slug that appears in the admin screen: a game can be
   * renamed, and a filter that survives a rename is the one keyed on identity.
   * The slug stays a display and lookup concern.
   *
   * `ANY_GAME` selects everything filed under a registered game;
   * `UNFILED_GAME` selects everything filed under none; `ALL_CONTENT` selects
   * both.
   *
   * Always the *effective* selection — the default has already been
   * substituted, so a consumer never has to know what the screen falls back to.
   */
  gameId: string | undefined;
  /**
   * What `gameId` falls back to when the URL says nothing.
   *
   * Carried on the query so `buildBrowseHref` can leave the default out of the
   * link. Without it every URL would carry `?gameId=any`, and `/posts` would
   * stop being the same page as the one a reader copied from it.
   */
  defaultGameId: string | undefined;
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
  /**
   * What to select when the URL names no game.
   *
   * Supplied by the caller because it depends on state this pure module cannot
   * see: which games exist, and what the workspace has been configured to
   * offer. See `resolveGameFilter` on the server side, which decides it once.
   */
  defaultGameId?: string | undefined;
}): BrowseQuery<K> {
  const raw = params.raw;

  const primitives = primitivesSchema.parse({
    streamerId: first(raw["streamerId"]),
    gameId: first(raw["gameId"]),
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
    gameId: primitives.gameId ?? params.defaultGameId,
    defaultGameId: params.defaultGameId,
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
  gameId?: string | null;
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
    /*
     * `toIsoDate`, not `toISOString().slice(0, 10)`.
     *
     * The bounds are display-zone day edges, so the lower one sits at 16:00 the
     * previous UTC day and slicing the ISO string reports yesterday. The upper
     * bound survives the same treatment by coincidence, which is what made this
     * worth a comment: the bug appeared on one end of the range only, silently
     * widening every custom filter by a day each time a link was rebuilt.
     */
    const from =
      overrides.from !== undefined
        ? overrides.from
        : query.period.from
          ? toIsoDate(query.period.from)
          : null;
    const to =
      overrides.to !== undefined ? overrides.to : query.period.to ? toIsoDate(query.period.to) : null;

    if (from) next.set("from", from);
    if (to) next.set("to", to);
  }

  const scope = overrides.scope ?? query.scope;
  if (scope !== "all") next.set("scope", scope);

  const streamerId =
    overrides.streamerId !== undefined ? overrides.streamerId : (query.streamerId ?? null);
  if (streamerId) next.set("streamerId", streamerId);

  /*
   * Written only when it differs from the screen's default, like `period`.
   *
   * `null` from an override means "back to the default", not "no filter" —
   * there is a token for that now (`ALL_CONTENT`), and conflating the two would
   * make Reset unable to express itself on a screen whose default is a filter.
   */
  const gameId = overrides.gameId !== undefined ? overrides.gameId : (query.gameId ?? null);
  if (gameId && gameId !== query.defaultGameId) next.set("gameId", gameId);

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
