import { describe, expect, it } from "vitest";

import {
  ALL_CONTENT,
  ANY_GAME,
  UNFILED_GAME,
  buildBrowseHref,
  resolveBrowseQuery,
} from "@/lib/filters/browse";
import {
  DEFAULT_PERIOD,
  PERIOD_PRESETS,
  isContentScope,
  isPeriodPreset,
  parseIsoDate,
  resolveContentScope,
  resolvePeriod,
  toIsoDate,
} from "@/lib/filters/period";
import {
  ANALYSIS_SORT_KEYS,
  POST_SORT_KEYS,
  VIDEO_SORT_KEYS,
  ariaSortFor,
  nextDirectionFor,
  resolveSort,
  type PostSortKey,
  type SortState,
} from "@/lib/filters/sorting";

/** A fixed instant, mid-month and mid-day, so no boundary is accidental. */
const NOW = new Date("2026-07-15T13:47:11.500Z");

describe("period presets", () => {
  it("declares exactly the presets the specification names", () => {
    expect([...PERIOD_PRESETS]).toEqual(["today", "7d", "30d", "custom", "all"]);
  });

  it("recognises valid presets and rejects anything else", () => {
    expect(isPeriodPreset("7d")).toBe(true);
    expect(isPeriodPreset("last week")).toBe(false);
    expect(isPeriodPreset("")).toBe(false);
    expect(isPeriodPreset(null)).toBe(false);
    expect(isPeriodPreset(7)).toBe(false);
  });

  it("falls back to the default rather than throwing on nonsense", () => {
    expect(resolvePeriod({ preset: "nonsense", now: NOW }).preset).toBe(DEFAULT_PERIOD);
  });
});

describe("period resolution", () => {
  it("bounds Today to that whole display-zone day, not the last 24 hours", () => {
    const period = resolvePeriod({ preset: "today", now: NOW });

    expect(toIsoDate(period.from as Date)).toBe("2026-07-15");
    expect(toIsoDate(period.to as Date)).toBe("2026-07-15");
  });

  /*
   * The one assertion that pins the actual offset. Everything else above is
   * written in display-zone days and would keep passing if the zone silently
   * reverted to UTC — this would not.
   */
  it("puts the day boundary at midnight in Manila, not at midnight UTC", () => {
    const period = resolvePeriod({ preset: "today", now: NOW });

    expect(period.from?.toISOString()).toBe("2026-07-14T16:00:00.000Z");
    expect(period.to?.toISOString()).toBe("2026-07-15T15:59:59.999Z");
  });

  it("counts the last 7 days inclusive of today", () => {
    // Today plus the six days before it — not 168 hours back from 13:47.
    const period = resolvePeriod({ preset: "7d", now: NOW });

    expect(toIsoDate(period.from as Date)).toBe("2026-07-09");
    expect(toIsoDate(period.to as Date)).toBe("2026-07-15");
  });

  it("counts the last 30 days inclusive of today", () => {
    const period = resolvePeriod({ preset: "30d", now: NOW });

    expect(toIsoDate(period.from as Date)).toBe("2026-06-16");
    expect(toIsoDate(period.to as Date)).toBe("2026-07-15");
  });

  it("crosses a month boundary correctly", () => {
    const period = resolvePeriod({ preset: "7d", now: new Date("2026-03-02T09:00:00Z") });

    // February 2026 has 28 days.
    expect(toIsoDate(period.from as Date)).toBe("2026-02-24");
  });

  it("leaves All time unbounded on both ends", () => {
    const period = resolvePeriod({ preset: "all", now: NOW });

    expect(period.from).toBeNull();
    expect(period.to).toBeNull();
  });

  it("is deterministic — the same instant always yields the same window", () => {
    expect(resolvePeriod({ preset: "30d", now: NOW })).toEqual(
      resolvePeriod({ preset: "30d", now: NOW }),
    );
  });
});

describe("custom ranges", () => {
  it("expands the given dates to whole display-zone days", () => {
    const period = resolvePeriod({
      preset: "custom",
      from: "2026-07-01",
      to: "2026-07-07",
      now: NOW,
    });

    expect(toIsoDate(period.from as Date)).toBe("2026-07-01");
    // Inclusive of the end date, or a report for "1st to 7th" would omit the 7th.
    expect(toIsoDate(period.to as Date)).toBe("2026-07-07");
    expect(period.warning).toBeNull();
  });

  it("accepts an open-ended range", () => {
    const fromOnly = resolvePeriod({ preset: "custom", from: "2026-07-01", now: NOW });
    expect(toIsoDate(fromOnly.from as Date)).toBe("2026-07-01");
    expect(fromOnly.to).toBeNull();

    const toOnly = resolvePeriod({ preset: "custom", to: "2026-07-01", now: NOW });
    expect(toOnly.from).toBeNull();
    expect(toIsoDate(toOnly.to as Date)).toBe("2026-07-01");
  });

  it("swaps a reversed range and says so, rather than showing nothing", () => {
    const period = resolvePeriod({
      preset: "custom",
      from: "2026-07-07",
      to: "2026-07-01",
      now: NOW,
    });

    expect(toIsoDate(period.from as Date)).toBe("2026-07-01");
    expect(toIsoDate(period.to as Date)).toBe("2026-07-07");
    expect(period.warning).toMatch(/swapped/i);
  });

  it("warns rather than silently showing a different window when a date is unreadable", () => {
    const period = resolvePeriod({ preset: "custom", from: "07/01/2026", now: NOW });

    expect(period.warning).toContain("07/01/2026");
    // Still renders something usable.
    expect(period.from).not.toBeNull();
  });

  it("treats a custom range with no dates as all time, and says so", () => {
    const period = resolvePeriod({ preset: "custom", now: NOW });

    expect(period.from).toBeNull();
    expect(period.to).toBeNull();
    expect(period.warning).toMatch(/all time/i);
  });
});

describe("date parsing", () => {
  it("accepts only YYYY-MM-DD", () => {
    // The instant that calendar day begins in Manila, not UTC midnight.
    expect(parseIsoDate("2026-07-15")?.toISOString()).toBe("2026-07-14T16:00:00.000Z");

    expect(parseIsoDate("2026-7-15")).toBeNull();
    expect(parseIsoDate("15/07/2026")).toBeNull();
    expect(parseIsoDate("last tuesday")).toBeNull();
    expect(parseIsoDate("2026-07-15T10:00:00Z")).toBeNull();
    expect(parseIsoDate("")).toBeNull();
    expect(parseIsoDate(null)).toBeNull();
  });

  it("rejects a date that does not exist rather than rolling it over", () => {
    // `new Date("2026-02-31")` would silently become March 3rd.
    expect(parseIsoDate("2026-02-31")).toBeNull();
    expect(parseIsoDate("2026-13-01")).toBeNull();
    expect(parseIsoDate("2026-00-10")).toBeNull();
  });

  it("accepts a real leap day and rejects a fake one", () => {
    expect(parseIsoDate("2028-02-29")).not.toBeNull();
    expect(parseIsoDate("2026-02-29")).toBeNull();
  });

  it("round-trips through toIsoDate", () => {
    const parsed = parseIsoDate("2026-07-15");
    expect(parsed).not.toBeNull();
    expect(toIsoDate(parsed as Date)).toBe("2026-07-15");
  });
});

describe("content scope", () => {
  it("recognises the three scope values", () => {
    expect(isContentScope("all")).toBe(true);
    expect(isContentScope("posts")).toBe(true);
    expect(isContentScope("videos")).toBe(true);
    expect(isContentScope("reels")).toBe(false);
  });

  it("defaults to everything", () => {
    expect(resolveContentScope(undefined)).toBe("all");
    expect(resolveContentScope("nonsense")).toBe("all");
  });
});

describe("sort resolution", () => {
  const fallback: SortState<PostSortKey> = { key: "createdTime", direction: "desc" };

  it("accepts a key from the allow-list", () => {
    expect(resolveSort(POST_SORT_KEYS, fallback, { sort: "reactions", dir: "asc" })).toEqual({
      key: "reactions",
      direction: "asc",
    });
  });

  it("rejects a key that is not on the allow-list", () => {
    // The guarantee that matters: no query-string value can reach ORDER BY.
    for (const attempt of [
      "encrypted_page_token",
      "streamers.encrypted_page_token",
      "createdTime; drop table posts",
      "(select 1)",
      "",
    ]) {
      expect(resolveSort(POST_SORT_KEYS, fallback, { sort: attempt })).toEqual(fallback);
    }
  });

  it("ignores a direction supplied without a valid key", () => {
    expect(resolveSort(POST_SORT_KEYS, fallback, { dir: "asc" })).toEqual(fallback);
    expect(resolveSort(POST_SORT_KEYS, fallback, { sort: "bogus", dir: "asc" })).toEqual(fallback);
  });

  it("falls back to the default direction for an unreadable one", () => {
    expect(resolveSort(POST_SORT_KEYS, fallback, { sort: "shares", dir: "sideways" })).toEqual({
      key: "shares",
      direction: "desc",
    });
  });

  it("declares distinct, non-empty key sets per table", () => {
    for (const keys of [POST_SORT_KEYS, VIDEO_SORT_KEYS, ANALYSIS_SORT_KEYS]) {
      expect(keys.length).toBeGreaterThan(0);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
});

describe("sort affordances", () => {
  const state: SortState<PostSortKey> = { key: "reactions", direction: "desc" };

  it("reports aria-sort only for the active column", () => {
    expect(ariaSortFor("reactions", state)).toBe("descending");
    expect(ariaSortFor("shares", state)).toBe("none");
    expect(ariaSortFor("reactions", { key: "reactions", direction: "asc" })).toBe("ascending");
  });

  it("flips the active column and starts a new one at its natural direction", () => {
    expect(nextDirectionFor("reactions", state)).toBe("asc");
    expect(nextDirectionFor("shares", state)).toBe("desc");
    expect(nextDirectionFor("streamer", state, "asc")).toBe("asc");
  });
});

describe("browse query", () => {
  const sortKeys = POST_SORT_KEYS;
  const defaultSort: SortState<PostSortKey> = { key: "createdTime", direction: "desc" };

  const resolve = (raw: Record<string, string | string[] | undefined>) =>
    resolveBrowseQuery({ raw, sortKeys, defaultSort, now: NOW });

  it("reads a full query string", () => {
    const query = resolve({
      period: "7d",
      scope: "videos",
      streamerId: "3f0a5b6c-1d2e-4f3a-8b9c-0d1e2f3a4b5c",
      search: "  ranked  ",
      sort: "reactions",
      dir: "asc",
      offset: "50",
    });

    expect(query.period.preset).toBe("7d");
    expect(query.scope).toBe("videos");
    expect(query.streamerId).toBe("3f0a5b6c-1d2e-4f3a-8b9c-0d1e2f3a4b5c");
    expect(query.search).toBe("ranked");
    expect(query.sort).toEqual({ key: "reactions", direction: "asc" });
    expect(query.offset).toBe(50);
  });

  it("never throws on hostile or malformed input", () => {
    const query = resolve({
      streamerId: "not-a-uuid",
      offset: "-10",
      search: "",
      period: "🙂",
      sort: "'; delete from posts; --",
    });

    expect(query.streamerId).toBeUndefined();
    expect(query.offset).toBe(0);
    expect(query.search).toBeUndefined();
    expect(query.period.preset).toBe(DEFAULT_PERIOD);
    expect(query.sort).toEqual(defaultSort);
  });

  it("takes the first value when a parameter is repeated", () => {
    expect(resolve({ period: ["today", "all"] }).period.preset).toBe("today");
  });

  it("caps an absurd offset instead of passing it to the database", () => {
    expect(resolve({ offset: "999999999999" }).offset).toBe(0);
  });

  /*
   * The game filter has four states and three of them are not a game id.
   * `undefined` and `ANY_GAME` are the pair most easily conflated, and doing so
   * is the expensive mistake: the default would start meaning "only registered
   * games" and every screen would drop its unattributed content silently.
   */
  describe("the game filter", () => {
    it("reads a game id", () => {
      expect(resolve({ gameId: "8a1b2c3d-4e5f-4a6b-9c8d-7e6f5a4b3c2d" }).gameId).toBe(
        "8a1b2c3d-4e5f-4a6b-9c8d-7e6f5a4b3c2d",
      );
    });

    it("keeps both set-valued sentinels, which are selections and not absences", () => {
      expect(resolve({ gameId: ANY_GAME }).gameId).toBe(ANY_GAME);
      expect(resolve({ gameId: UNFILED_GAME }).gameId).toBe(UNFILED_GAME);
    });

    it("substitutes the screen's default when the URL says nothing", () => {
      const withDefault = resolveBrowseQuery({
        raw: {},
        sortKeys,
        defaultSort,
        now: NOW,
        defaultGameId: ANY_GAME,
      });

      expect(withDefault.gameId).toBe(ANY_GAME);
      expect(withDefault.defaultGameId).toBe(ANY_GAME);
    });

    it("lets an explicit choice override the default, including the wide one", () => {
      const explicit = (gameId: string) =>
        resolveBrowseQuery({
          raw: { gameId },
          sortKeys,
          defaultSort,
          now: NOW,
          defaultGameId: ANY_GAME,
        }).gameId;

      // `ALL_CONTENT` exists precisely for this: with a filtering default,
      // "show me everything" has to be sayable, and absence no longer says it.
      expect(explicit(ALL_CONTENT)).toBe(ALL_CONTENT);
      expect(explicit(UNFILED_GAME)).toBe(UNFILED_GAME);
    });

    it("falls back to no filter when the screen has no default", () => {
      // What a workspace with no registered game gets. `ANY_GAME` would match
      // nothing there, so every screen would render empty.
      expect(resolve({}).gameId).toBeUndefined();
    });

    it("drops anything that is none of them", () => {
      expect(resolve({ gameId: "not-a-uuid" }).gameId).toBeUndefined();
      expect(resolve({ gameId: "every" }).gameId).toBeUndefined();
    });

    it("cannot collide with a real id", () => {
      // No sentinel is a uuid, so no game can be named `all`, `any` or `none`.
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const sentinels = [ALL_CONTENT, ANY_GAME, UNFILED_GAME];

      for (const sentinel of sentinels) expect(sentinel).not.toMatch(uuid);
      expect(new Set(sentinels).size).toBe(sentinels.length);
    });
  });
});

describe("href building", () => {
  const sortKeys = POST_SORT_KEYS;
  const defaultSort: SortState<PostSortKey> = { key: "createdTime", direction: "desc" };

  const query = resolveBrowseQuery({
    /*
     * A non-default period on purpose. `buildBrowseHref` omits anything equal
     * to the default, so asserting a preserved `period=` with the default
     * selected would assert the opposite of what the builder does — and would
     * silently start passing again the next time the default moves.
     */
    raw: { period: "30d", streamerId: "3f0a5b6c-1d2e-4f3a-8b9c-0d1e2f3a4b5c", search: "ranked" },
    sortKeys,
    defaultSort,
    now: NOW,
  });

  it("omits defaults so a clean URL is the same page as a verbose one", () => {
    const bare = resolveBrowseQuery({ raw: {}, sortKeys, defaultSort, now: NOW });
    expect(buildBrowseHref("/posts", bare, defaultSort, {})).toBe("/posts");
  });

  it("preserves every other filter when one changes", () => {
    const href = buildBrowseHref("/posts", query, defaultSort, { sort: "shares", dir: "asc" });

    expect(href).toContain("period=30d");
    expect(href).toContain("streamerId=3f0a5b6c-1d2e-4f3a-8b9c-0d1e2f3a4b5c");
    expect(href).toContain("search=ranked");
    expect(href).toContain("sort=shares");
    expect(href).toContain("dir=asc");
  });

  it("resets paging on a filter change but not on a page change", () => {
    const paged = resolveBrowseQuery({ raw: { offset: "75" }, sortKeys, defaultSort, now: NOW });

    expect(buildBrowseHref("/posts", paged, defaultSort, { search: "x" })).not.toContain("offset");
    expect(buildBrowseHref("/posts", paged, defaultSort, { offset: 100 })).toContain("offset=100");
  });

  it("clears a filter when given null", () => {
    const href = buildBrowseHref("/posts", query, defaultSort, { streamerId: null });
    expect(href).not.toContain("streamerId");
    expect(href).toContain("search=ranked");
  });

  it("carries custom dates only while the custom preset is selected", () => {
    const custom = resolveBrowseQuery({
      raw: { period: "custom", from: "2026-07-01", to: "2026-07-07" },
      sortKeys,
      defaultSort,
      now: NOW,
    });

    const kept = buildBrowseHref("/posts", custom, defaultSort, {});
    expect(kept).toContain("from=2026-07-01");
    expect(kept).toContain("to=2026-07-07");

    // Switching to a rolling preset drops them rather than leaving dead
    // parameters that would reappear on the next switch back.
    const rolled = buildBrowseHref("/posts", custom, defaultSort, { period: "7d" });
    expect(rolled).not.toContain("from=");
    expect(rolled).not.toContain("to=");
  });

  it("leaves the screen's default out of the link, and writes anything else in", () => {
    const onDefault = resolveBrowseQuery({
      raw: {},
      sortKeys,
      defaultSort,
      now: NOW,
      defaultGameId: ANY_GAME,
    });

    // Sitting on the default produces a clean URL, so `/posts` and the link
    // copied from it stay the same page.
    expect(buildBrowseHref("/posts", onDefault, defaultSort, {})).toBe("/posts");

    // Choosing the wider view is a departure from the default and must survive
    // the next navigation — the reason `ALL_CONTENT` is a token at all.
    expect(buildBrowseHref("/posts", onDefault, defaultSort, { gameId: ALL_CONTENT })).toContain(
      `gameId=${ALL_CONTENT}`,
    );
  });

  it("carries a game filter, and clears it when given null", () => {
    const withGame = resolveBrowseQuery({
      raw: { gameId: "8a1b2c3d-4e5f-4a6b-9c8d-7e6f5a4b3c2d" },
      sortKeys,
      defaultSort,
      now: NOW,
    });

    // Preserved across an unrelated change — this is what stops a sort header
    // from silently widening the selection the reader made.
    expect(buildBrowseHref("/posts", withGame, defaultSort, { sort: "shares" })).toContain(
      "gameId=8a1b2c3d-4e5f-4a6b-9c8d-7e6f5a4b3c2d",
    );
    expect(buildBrowseHref("/posts", withGame, defaultSort, { gameId: null })).not.toContain(
      "gameId",
    );

    // The sentinel survives the round trip too. It has to: a link to
    // "everything filed under no game" is one an admin shares.
    const unfiled = resolveBrowseQuery({
      raw: { gameId: UNFILED_GAME },
      sortKeys,
      defaultSort,
      now: NOW,
    });
    const href = buildBrowseHref("/posts", unfiled, defaultSort, {});
    const raw = Object.fromEntries(new URL(href, "https://example.test").searchParams);

    expect(resolveBrowseQuery({ raw, sortKeys, defaultSort, now: NOW }).gameId).toBe(UNFILED_GAME);
  });

  it("appends to a base path that already has a query string", () => {
    // The streamer tabs rely on this: sorting inside a tab must stay in the tab.
    const href = buildBrowseHref("/streamers/abc?tab=posts", query, defaultSort, {
      sort: "shares",
    });

    expect(href).toContain("/streamers/abc?tab=posts&");
    expect(href).toContain("sort=shares");
  });

  it("round-trips — a built href resolves back to the same query", () => {
    const href = buildBrowseHref("/posts", query, defaultSort, { sort: "shares", dir: "asc" });
    const raw = Object.fromEntries(new URL(href, "https://example.test").searchParams);
    const reparsed = resolveBrowseQuery({ raw, sortKeys, defaultSort, now: NOW });

    expect(reparsed.sort).toEqual({ key: "shares", direction: "asc" });
    expect(reparsed.streamerId).toBe(query.streamerId);
    expect(reparsed.search).toBe(query.search);
    expect(reparsed.period.from?.toISOString()).toBe(query.period.from?.toISOString());
    expect(reparsed.period.to?.toISOString()).toBe(query.period.to?.toISOString());
  });
});
