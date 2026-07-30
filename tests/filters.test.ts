import { describe, expect, it } from "vitest";

import { buildBrowseHref, resolveBrowseQuery } from "@/lib/filters/browse";
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
  it("bounds Today to that whole UTC day, not the last 24 hours", () => {
    const period = resolvePeriod({ preset: "today", now: NOW });

    expect(period.from?.toISOString()).toBe("2026-07-15T00:00:00.000Z");
    expect(period.to?.toISOString()).toBe("2026-07-15T23:59:59.999Z");
  });

  it("counts the last 7 days inclusive of today", () => {
    // Today plus the six days before it — not 168 hours back from 13:47.
    const period = resolvePeriod({ preset: "7d", now: NOW });

    expect(period.from?.toISOString()).toBe("2026-07-09T00:00:00.000Z");
    expect(period.to?.toISOString()).toBe("2026-07-15T23:59:59.999Z");
  });

  it("counts the last 30 days inclusive of today", () => {
    const period = resolvePeriod({ preset: "30d", now: NOW });

    expect(period.from?.toISOString()).toBe("2026-06-16T00:00:00.000Z");
    expect(period.to?.toISOString()).toBe("2026-07-15T23:59:59.999Z");
  });

  it("crosses a month boundary correctly", () => {
    const period = resolvePeriod({ preset: "7d", now: new Date("2026-03-02T09:00:00Z") });

    // February 2026 has 28 days.
    expect(period.from?.toISOString()).toBe("2026-02-24T00:00:00.000Z");
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
  it("expands the given dates to whole UTC days", () => {
    const period = resolvePeriod({
      preset: "custom",
      from: "2026-07-01",
      to: "2026-07-07",
      now: NOW,
    });

    expect(period.from?.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    // Inclusive of the end date, or a report for "1st to 7th" would omit the 7th.
    expect(period.to?.toISOString()).toBe("2026-07-07T23:59:59.999Z");
    expect(period.warning).toBeNull();
  });

  it("accepts an open-ended range", () => {
    const fromOnly = resolvePeriod({ preset: "custom", from: "2026-07-01", now: NOW });
    expect(fromOnly.from?.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(fromOnly.to).toBeNull();

    const toOnly = resolvePeriod({ preset: "custom", to: "2026-07-01", now: NOW });
    expect(toOnly.from).toBeNull();
    expect(toOnly.to?.toISOString()).toBe("2026-07-01T23:59:59.999Z");
  });

  it("swaps a reversed range and says so, rather than showing nothing", () => {
    const period = resolvePeriod({
      preset: "custom",
      from: "2026-07-07",
      to: "2026-07-01",
      now: NOW,
    });

    expect(period.from?.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(period.to?.toISOString()).toBe("2026-07-07T23:59:59.999Z");
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
    expect(parseIsoDate("2026-07-15")?.toISOString()).toBe("2026-07-15T00:00:00.000Z");

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
});

describe("href building", () => {
  const sortKeys = POST_SORT_KEYS;
  const defaultSort: SortState<PostSortKey> = { key: "createdTime", direction: "desc" };

  const query = resolveBrowseQuery({
    raw: { period: "7d", streamerId: "3f0a5b6c-1d2e-4f3a-8b9c-0d1e2f3a4b5c", search: "ranked" },
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

    expect(href).toContain("period=7d");
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
