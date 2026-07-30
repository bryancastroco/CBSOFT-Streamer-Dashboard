import { describe, expect, it } from "vitest";

import {
  METRIC_NOT_AVAILABLE,
  describeInsight,
  formatCount,
  formatCountShort,
  formatInsightValue,
  humanizeMetricName,
} from "@/lib/meta/insight-display";
import { normalizeInsights, normalizePost, type RawInsight } from "@/lib/meta/posts";

/**
 * The rule under test throughout this file:
 *
 *   A metric Meta did not report is UNAVAILABLE, never zero.
 *
 * Zero is a measurement. Absence is not. Collapsing them would turn a
 * permission gap into a confident claim that engagement was nil.
 */

const BASE = {
  id: "102938475610293_555",
  created_time: "2026-07-20T10:30:00+0000",
  permalink_url: "https://facebook.com/102938475610293/posts/555",
};

describe("post normalization", () => {
  it("reads summary counts when Meta supplies them", () => {
    const post = normalizePost({
      ...BASE,
      message: "Live now!",
      reactions: { summary: { total_count: 42 } },
      comments: { summary: { total_count: 7 } },
      shares: { count: 3 },
    });

    expect(post).not.toBeNull();
    expect(post?.reactionCount).toBe(42);
    expect(post?.commentCount).toBe(7);
    expect(post?.shareCount).toBe(3);
  });

  it("preserves a genuine zero", () => {
    const post = normalizePost({
      ...BASE,
      reactions: { summary: { total_count: 0 } },
      comments: { summary: { total_count: 0 } },
      shares: { count: 0 },
    });

    // A reported zero is data and must survive as 0, not become null.
    expect(post?.reactionCount).toBe(0);
    expect(post?.commentCount).toBe(0);
    expect(post?.shareCount).toBe(0);
  });

  it("returns null — not zero — when `shares` is absent", () => {
    // Meta omits `shares` entirely for a post with none. Inferring 0 would be
    // guessing, and would be wrong whenever the field was withheld instead.
    const post = normalizePost({ ...BASE, reactions: { summary: { total_count: 5 } } });

    expect(post?.shareCount).toBeNull();
    expect(post?.shareCount).not.toBe(0);
  });

  it("returns null when a summary is missing entirely", () => {
    const post = normalizePost({ ...BASE, reactions: {}, comments: {} });

    expect(post?.reactionCount).toBeNull();
    expect(post?.commentCount).toBeNull();
  });

  it("treats an empty message as absent rather than empty string", () => {
    expect(normalizePost({ ...BASE, message: "" })?.message).toBeNull();
  });

  it("rejects a post with no id or no created_time", () => {
    expect(normalizePost({ id: "", created_time: BASE.created_time })).toBeNull();
    expect(normalizePost({ id: BASE.id })).toBeNull();
  });

  it("rejects an unparseable created_time rather than storing an invalid date", () => {
    expect(normalizePost({ id: BASE.id, created_time: "not-a-date" })).toBeNull();
  });

  it("keeps the raw payload for later re-derivation", () => {
    const raw = { ...BASE, message: "hi", unexpected_future_field: 1 } as never;
    expect(normalizePost(raw)?.raw).toBe(raw);
  });
});

describe("insight normalization", () => {
  it("flattens a lifetime metric into one row", () => {
    const rows = normalizeInsights([
      {
        name: "post_impressions",
        period: "lifetime",
        values: [{ value: 1234 }],
      },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      metricName: "post_impressions",
      period: "lifetime",
      value: 1234,
    });
  });

  it("expands a periodic metric into one row per end_time, preserving the series", () => {
    const rows = normalizeInsights([
      {
        name: "post_impressions_unique",
        period: "day",
        values: [
          { value: 10, end_time: "2026-07-20T07:00:00+0000" },
          { value: 25, end_time: "2026-07-21T07:00:00+0000" },
        ],
      },
    ]);

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.value)).toEqual([10, 25]);
    expect(rows[0]?.endTime).toBeInstanceOf(Date);
  });

  it("records a metric with an empty values array as present but valueless", () => {
    // Meta acknowledged the metric and had nothing for it. That is different
    // from the metric not existing, and different again from zero.
    const rows = normalizeInsights([{ name: "post_clicks", period: "lifetime", values: [] }]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toBeNull();
    expect(rows[0]?.value).not.toBe(0);
  });

  it("normalizes an undefined value to null so absence round-trips through JSON", () => {
    const rows = normalizeInsights([{ name: "post_reactions_by_type_total", values: [{}] }]);
    expect(rows[0]?.value).toBeNull();
  });

  it("keeps a reported zero as zero", () => {
    const rows = normalizeInsights([{ name: "post_clicks", values: [{ value: 0 }] }]);
    expect(rows[0]?.value).toBe(0);
  });

  it("stores breakdown objects intact", () => {
    const breakdown = { like: 10, love: 4, wow: 1 };
    const rows = normalizeInsights([
      { name: "post_reactions_by_type_total", period: "lifetime", values: [{ value: breakdown }] },
    ]);

    expect(rows[0]?.value).toEqual(breakdown);
  });

  it("skips entries with no metric name", () => {
    expect(
      normalizeInsights([{ period: "lifetime", values: [{ value: 1 }] } as RawInsight]),
    ).toEqual([]);
  });

  it("accepts metric names it has never seen, because none are hard-coded", () => {
    const rows = normalizeInsights([
      { name: "a_metric_meta_invented_last_tuesday", period: "lifetime", values: [{ value: 9 }] },
    ]);

    expect(rows[0]?.metricName).toBe("a_metric_meta_invented_last_tuesday");
  });

  it("tolerates a null period", () => {
    const rows = normalizeInsights([{ name: "post_impressions", values: [{ value: 1 }] }]);
    expect(rows[0]?.period).toBeNull();
  });

  it("discards an unparseable end_time rather than storing an invalid date", () => {
    const rows = normalizeInsights([
      { name: "post_impressions", values: [{ value: 1, end_time: "nonsense" }] },
    ]);

    expect(rows[0]?.endTime).toBeNull();
  });
});

describe("display — absence is never zero", () => {
  it("shows the required message for a null value", () => {
    expect(formatInsightValue(null)).toBeNull();
    expect(formatInsightValue(undefined)).toBeNull();

    const described = describeInsight({
      id: "1",
      metricName: "post_clicks",
      period: "lifetime",
      value: null,
      endTime: null,
      collectedAt: new Date(),
    });

    expect(described.availability).toBe("not_available");
    expect(described.displayValue).toBe(METRIC_NOT_AVAILABLE);
    expect(described.displayValue).not.toBe("0");
  });

  it("shows a reported zero as 0, not as unavailable", () => {
    const described = describeInsight({
      id: "1",
      metricName: "post_clicks",
      period: "lifetime",
      value: 0,
      endTime: null,
      collectedAt: new Date(),
    });

    expect(described.availability).toBe("reported");
    expect(described.displayValue).toBe("0");
  });

  it("formats numbers, strings, booleans and breakdowns", () => {
    expect(formatInsightValue(1234567)).toBe("1,234,567");
    expect(formatInsightValue("42")).toBe("42");
    expect(formatInsightValue(true)).toBe("Yes");
    expect(formatInsightValue({ like: 10, love: 5 })).toBe("15 across 2 breakdowns");
  });

  it("treats empty containers as no value", () => {
    expect(formatInsightValue({})).toBeNull();
    expect(formatInsightValue([])).toBeNull();
    expect(formatInsightValue("   ")).toBeNull();
  });

  it("renders an absent engagement count as the required message", () => {
    expect(formatCount(null)).toEqual({
      availability: "not_available",
      display: METRIC_NOT_AVAILABLE,
    });

    expect(formatCount(0)).toEqual({ availability: "reported", display: "0" });
    expect(formatCount(1500)).toEqual({ availability: "reported", display: "1,500" });
  });

  it("uses a dash in compact table cells but never a zero", () => {
    expect(formatCountShort(null)).toBe("—");
    expect(formatCountShort(0)).toBe("0");
  });

  it("humanizes metric names without inventing a fixed list", () => {
    expect(humanizeMetricName("post_impressions_unique")).toBe("Post impressions unique");
    expect(humanizeMetricName("brand_new_metric")).toBe("Brand new metric");
  });
});
