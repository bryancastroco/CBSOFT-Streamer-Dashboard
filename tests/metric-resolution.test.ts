import { describe, expect, it } from "vitest";

import { METRIC_REGISTRY, POST_INSIGHT_METRIC_NAMES } from "@/lib/metrics/registry";
import {
  hashMetrics,
  resolveMetrics,
  retainKnownValues,
  toColumns,
} from "@/lib/metrics/resolve";

/**
 * The canonical metric mapping, against the shapes Meta actually returns.
 *
 * Fixtures are copied from real responses recorded by
 * `scripts/probe-metrics.mts` on Graph v25.0, not invented — including the
 * millisecond magnitudes, which are the easiest thing to get subtly wrong and
 * the hardest to notice once wrong.
 *
 * The rule under test throughout: a metric is null unless Meta supplied it.
 * Never zero, never inferred from a neighbour.
 */

const AT = new Date("2026-07-31T04:00:00.000Z");

const base = { graphApiVersion: "v25.0", collectedAt: AT } as const;

/** A video post with everything Meta gave us for the probed content. */
const FULL_POST_INSIGHTS = [
  { metricName: "post_video_views", value: 2925, period: "lifetime" },
  { metricName: "post_video_views_unique", value: 2925, period: "lifetime" },
  { metricName: "post_video_view_time", value: 41_832_855, period: "lifetime" },
  { metricName: "post_video_avg_time_watched", value: 9476, period: "lifetime" },
  {
    metricName: "post_reactions_by_type_total",
    value: { like: 62, love: 70, haha: 2 },
    period: "lifetime",
  },
  {
    metricName: "post_activity_by_action_type",
    value: { share: 2, like: 33, comment: 4 },
    period: "lifetime",
  },
];

describe("a video post with the full metric set", () => {
  const resolved = resolveMetrics({
    applicability: "video_post",
    postInsights: FULL_POST_INSIGHTS,
    fields: { reactionCount: 134, commentCount: 4, shareCount: 2 },
    ...base,
  });

  it("maps views from Meta's own views metric", () => {
    expect(resolved.results.views.value).toBe(2925);
    expect(resolved.results.views.sourceMetricName).toBe("post_video_views");
  });

  it("maps viewers only from the metric Meta calls unique", () => {
    expect(resolved.results.viewers.value).toBe(2925);
    expect(resolved.results.viewers.sourceMetricName).toBe("post_video_views_unique");
  });

  it("keeps watch time in milliseconds as Meta returned it", () => {
    expect(resolved.results.watch_time.value).toBe(41_832_855);
    expect(resolved.results.watch_time.unit).toBe("milliseconds");
  });

  it("takes likes from the LIKE key, not the reaction total", () => {
    // 62 likes out of 134 reactions. Reporting 134 would overstate by 116%.
    expect(resolved.results.likes.value).toBe(62);
    expect(resolved.results.reactions.value).toBe(134);
    expect(resolved.results.likes.value).not.toBe(resolved.results.reactions.value);
  });

  it("prefers Meta's activity total over calculating interactions", () => {
    expect(resolved.results.interactions.availability).toBe("available");
    expect(resolved.results.interactions.value).toBe(39);
  });

  it("reads three-second views from post_video_views, which is that measurement", () => {
    /*
     * This asserted null for a while, on the reasoning that no metric named for
     * three seconds exists on v25 — true, and beside the point. Meta documents
     * `post_video_views` as plays of three seconds or longer, so the figure was
     * already collected. Reading it is not borrowing and not a derivation; it
     * is the same number under its other name.
     */
    expect(resolved.results.three_second_views.value).toBe(2925);
    expect(resolved.results.three_second_views.availability).toBe("available");
    expect(resolved.results.three_second_views.sourceMetricName).toBe("post_video_views");
  });

  it("keeps views and three-second views identical, because they are one metric", () => {
    expect(resolved.results.three_second_views.value).toBe(resolved.results.views.value);
    expect(resolved.results.views.sourceMetricName).toBe(
      resolved.results.three_second_views.sourceMetricName,
    );
  });

  it("records which Meta name supplied each value", () => {
    expect(resolved.sourceMapping["watch_time"]).toMatchObject({
      metric: "post_video_view_time",
      source: "post_insight",
    });
  });
});

describe("only basic engagement available", () => {
  const resolved = resolveMetrics({
    applicability: "post",
    postInsights: [],
    fields: { reactionCount: 55, commentCount: 4, shareCount: null },
    ...base,
  });

  it("calculates interactions and says so", () => {
    expect(resolved.results.interactions.availability).toBe("calculated");
    // Shares were not reported, so they contribute nothing rather than zero.
    expect(resolved.results.interactions.value).toBe(59);
    expect(resolved.availability["interactions"]).toMatchObject({
      formula: "reactions + comments + shares",
    });
  });

  it("marks the calculated flag for the database", () => {
    expect(toColumns(resolved).interactionsIsCalculated).toBe(true);
  });

  it("leaves an unreported share count null, never zero", () => {
    expect(resolved.results.shares.value).toBeNull();
    expect(resolved.results.shares.availability).toBe("unavailable");
  });
});

describe("video metrics on a text post", () => {
  const resolved = resolveMetrics({
    applicability: "post",
    fields: { reactionCount: 10, commentCount: 2, shareCount: 0 },
    ...base,
  });

  it.each(["views", "viewers", "watch_time", "average_play_time", "three_second_views"] as const)(
    "%s is not applicable rather than unavailable",
    (key) => {
      expect(resolved.results[key].availability).toBe("not_applicable");
      expect(resolved.results[key].value).toBeNull();
    },
  );

  it("keeps a genuine zero distinct from a missing value", () => {
    // Meta returned 0 shares here; that is a measurement, not an absence.
    expect(resolved.results.shares.value).toBe(0);
    expect(resolved.results.shares.availability).toBe("available");
  });
});

describe("Meta returning zero", () => {
  it("preserves zero as a value", () => {
    const resolved = resolveMetrics({
      applicability: "video_post",
      postInsights: [{ metricName: "post_video_views", value: 0, period: "lifetime" }],
      ...base,
    });

    expect(resolved.results.views.value).toBe(0);
    expect(resolved.results.views.availability).toBe("available");
  });

  it("treats a breakdown without the LIKE key as zero likes, not unknown", () => {
    const resolved = resolveMetrics({
      applicability: "post",
      postInsights: [
        { metricName: "post_reactions_by_type_total", value: { love: 3 }, period: "lifetime" },
      ],
      ...base,
    });

    expect(resolved.results.likes.value).toBe(0);
    expect(resolved.results.reactions.value).toBe(3);
  });
});

describe("period selection", () => {
  it("prefers the lifetime reading over a daily one", () => {
    /*
     * Meta returns the same metric at several periods. Taking whichever came
     * first would mix a single day into a total that elsewhere holds lifetime,
     * producing a figure that is neither.
     */
    const resolved = resolveMetrics({
      applicability: "video_post",
      postInsights: [
        { metricName: "post_video_views", value: 12, period: "day" },
        { metricName: "post_video_views", value: 2854, period: "lifetime" },
      ],
      ...base,
    });

    expect(resolved.results.views.value).toBe(2854);
  });
});

describe("conflicting candidates", () => {
  it("uses the preferred source and records the disagreement", () => {
    const resolved = resolveMetrics({
      applicability: "video",
      videoInsights: [
        { metricName: "fb_reels_total_plays", value: 7278, period: "lifetime" },
        { metricName: "blue_reels_play_count", value: 4333, period: "lifetime" },
      ],
      ...base,
    });

    expect(resolved.results.reels_plays.value).toBe(7278);
    expect(resolved.warnings.join(" ")).toContain("reels_plays");
    // Never averaged or summed — that would invent a third number.
    expect(resolved.results.reels_plays.value).not.toBe(7278 + 4333);
  });
});

describe("Reels plays stay separate from views", () => {
  it("does not populate views from a Reels play count", () => {
    const resolved = resolveMetrics({
      applicability: "video",
      videoInsights: [{ metricName: "fb_reels_total_plays", value: 7278, period: "lifetime" }],
      ...base,
    });

    expect(resolved.results.reels_plays.value).toBe(7278);
    // `views` does not apply to the video object at all, and a play is not a view.
    expect(resolved.results.views.value).toBeNull();
  });
});

describe("snapshot deduplication", () => {
  const inputs = {
    applicability: "video_post" as const,
    postInsights: FULL_POST_INSIGHTS,
    fields: { reactionCount: 134, commentCount: 4, shareCount: 2 },
  };

  it("hashes identically when the numbers have not moved", () => {
    const first = resolveMetrics({ ...inputs, ...base });
    const later = resolveMetrics({
      ...inputs,
      graphApiVersion: "v25.0",
      collectedAt: new Date("2026-08-05T10:00:00.000Z"),
    });

    // Different collection time, same figures: no new snapshot should be written.
    expect(later.metricHash).toBe(first.metricHash);
  });

  it("hashes differently when a value changes", () => {
    const first = resolveMetrics({ ...inputs, ...base });
    const moved = resolveMetrics({
      ...inputs,
      postInsights: [
        ...FULL_POST_INSIGHTS.filter((row) => row.metricName !== "post_video_views"),
        { metricName: "post_video_views", value: 2926, period: "lifetime" },
      ],
      ...base,
    });

    expect(moved.metricHash).not.toBe(first.metricHash);
  });

  it("hashes differently when a metric stops being available", () => {
    /*
     * A metric going from available to unavailable is a real change, even
     * though the value is null either way — worth a snapshot so the gap is
     * visible in the history rather than looking like a collection that never
     * happened.
     */
    const withViews = resolveMetrics({ ...inputs, ...base });
    const withoutViews = resolveMetrics({
      ...inputs,
      postInsights: FULL_POST_INSIGHTS.filter((row) => row.metricName !== "post_video_views"),
      ...base,
    });

    expect(withoutViews.metricHash).not.toBe(withViews.metricHash);
  });

  it("is stable across calls with identical input", () => {
    const a = resolveMetrics({ ...inputs, ...base });
    expect(hashMetrics(a.results)).toBe(a.metricHash);
  });
});

describe("the registry itself", () => {
  it("pairs views and three-second views as one measurement, both ways", () => {
    /*
     * The link has to be symmetric or the UI merges in one direction and shows
     * a duplicate in the other, which is the exact failure the flag exists to
     * prevent.
     */
    expect(METRIC_REGISTRY.views.sameMeasurementAs).toBe("three_second_views");
    expect(METRIC_REGISTRY.three_second_views.sameMeasurementAs).toBe("views");
  });

  it("keeps the rejected three-second names on record", () => {
    // Five names probed individually on v25 and refused. Kept so nobody
    // rediscovers them hopefully and adds one to the live request.
    expect(METRIC_REGISTRY.three_second_views.rejectedOnV25?.length).toBeGreaterThan(0);
  });

  it("every sameMeasurementAs pair points back at itself", () => {
    for (const definition of Object.values(METRIC_REGISTRY)) {
      const partner = definition.sameMeasurementAs;
      if (!partner) continue;

      expect(METRIC_REGISTRY[partner].sameMeasurementAs).toBe(definition.key);
    }
  });

  it("resolves likes from the post field first, not the insight", () => {
    /*
     * Coverage is the reason: the insight arrived for 611 of 1,626 posts, the
     * field for every post probed. Order here is the whole decision.
     */
    expect(METRIC_REGISTRY.likes.candidates[0]).toMatchObject({
      metric: "like_reactions.summary.total_count",
      source: "post_field",
    });
  });

  it("only permits calculation for interactions", () => {
    const calculable = Object.values(METRIC_REGISTRY).filter((m) => m.calculationAllowed);

    expect(calculable.map((m) => m.key)).toEqual(["interactions"]);
  });

  it("derives the post-insight request from the candidates", () => {
    expect(POST_INSIGHT_METRIC_NAMES).toContain("post_video_views_unique");
    expect(POST_INSIGHT_METRIC_NAMES).toContain("post_video_view_time");
    // Video-edge candidates must not leak into the post request; one invalid
    // name there fails the whole call for every post.
    expect(POST_INSIGHT_METRIC_NAMES).not.toContain("post_impressions_unique");
  });

  it("has no duplicate metric names within one canonical key", () => {
    for (const definition of Object.values(METRIC_REGISTRY)) {
      const pairs = definition.candidates.map((c) => `${c.source}:${c.metric}`);
      expect(new Set(pairs).size, `${definition.key} repeats a candidate`).toBe(pairs.length);
    }
  });
});

describe("nothing leaks into the metric columns", () => {
  it("emits only numbers, booleans and the two metadata objects", () => {
    const columns = toColumns(
      resolveMetrics({ applicability: "video_post", postInsights: FULL_POST_INSIGHTS, ...base }),
    );

    for (const [key, value] of Object.entries(columns)) {
      if (key.endsWith("Json") || key === "metricHash") continue;
      expect(
        value === null || typeof value === "number" || typeof value === "boolean",
        `${key} is ${typeof value}`,
      ).toBe(true);
    }
  });
});

/**
 * Two mapping errors that only surfaced when the resolver was run against the
 * live database. Fixtures had not caught either, because both depended on what
 * Meta actually sends rather than on what the shapes allow.
 */
describe("errors found by running against production data", () => {
  it("does not source interactions from post_video_social_actions", () => {
    /*
     * That metric returns {SHARE, COMMENT} — no reactions. Summing it as an
     * interactions total produced 6 on a real video whose likes alone were 28,
     * understating engagement by about eighty per cent.
     */
    const names = METRIC_REGISTRY.interactions.candidates.map((c) => c.metric);

    expect(names).not.toContain("post_video_social_actions");
  });

  it("still reaches an interactions figure for a video, by calculating it", () => {
    const resolved = resolveMetrics({
      applicability: "video",
      videoInsights: [
        {
          metricName: "post_video_likes_by_reaction_type",
          value: { REACTION_LIKE: 28, REACTION_LOVE: 8 },
          period: "lifetime",
        },
        {
          metricName: "post_video_social_actions",
          value: { SHARE: 2, COMMENT: 4 },
          period: "lifetime",
        },
      ],
      ...base,
    });

    // 36 reactions + 4 comments + 2 shares, and labelled as calculated.
    expect(resolved.results.interactions.value).toBe(42);
    expect(resolved.results.interactions.availability).toBe("calculated");
  });

  it("treats post_video_views of zero as a text post, not a silent video", () => {
    /*
     * Meta returns `post_video_views: 0` for ordinary posts rather than
     * omitting it. Testing for the metric's presence classified every post in
     * the roster as a video post, so video metrics read as "not reported"
     * instead of "not applicable" — a different and wrong claim.
     *
     * The check lives in the rollup service; this pins the consequence, which
     * is what a reader of the dashboard actually sees.
     */
    const asTextPost = resolveMetrics({
      applicability: "post",
      postInsights: [{ metricName: "post_video_views", value: 0, period: "lifetime" }],
      ...base,
    });

    expect(asTextPost.results.watch_time.availability).toBe("not_applicable");
    expect(asTextPost.results.views.availability).toBe("not_applicable");
  });
});

describe("retaining a value Meta stopped reporting", () => {
  /*
   * Resolution and persistence answer different questions. Resolution says
   * what one collection contained; retention says what the record should hold
   * afterwards. A figure Meta gave us last week is not invented, and nulling it
   * because one response came back thin destroys real data — so the pure rule
   * is pinned here, separately from the service that applies it.
   */
  const thin = () =>
    resolveMetrics({
      applicability: "video_post",
      postInsights: [{ metricName: "post_video_views", value: 2925, period: "lifetime" }],
      ...base,
    });

  it("keeps a previously measured value and says it was retained", () => {
    const merged = retainKnownValues(thin(), {
      values: { viewers: 2925 },
      availability: { viewers: { status: "available", sourceMetricName: "post_video_views_unique" } },
    });

    expect(merged.retained).toEqual(["viewers"]);
    expect(merged.resolved.results.viewers.value).toBe(2925);
    expect(merged.resolved.availability["viewers"]).toMatchObject({
      retained: true,
      notReportedThisRun: "unavailable",
    });
    // The provenance survives, so the value is still attributable to Meta.
    expect(merged.resolved.results.viewers.sourceMetricName).toBe("post_video_views_unique");
  });

  it("never overwrites a value Meta did report", () => {
    const merged = retainKnownValues(thin(), { values: { views: 11 } });

    expect(merged.resolved.results.views.value).toBe(2925);
    expect(merged.retained).not.toContain("views");
  });

  it("does not retain across a not_applicable verdict", () => {
    const asTextPost = resolveMetrics({
      applicability: "post",
      postInsights: [],
      ...base,
    });

    const merged = retainKnownValues(asTextPost, {
      values: { views: 500 },
      availability: { views: { status: "available" } },
    });

    // The content is not a video, so the stored figure was wrong about what it
    // measured. Keeping it would preserve an error rather than a reading.
    expect(merged.resolved.results.views.value).toBeNull();
    expect(merged.retained).toEqual([]);
  });

  it("refuses to retain a stored number whose own status was unavailable", () => {
    const merged = retainKnownValues(thin(), {
      values: { viewers: 999 },
      availability: { viewers: { status: "unavailable" } },
    });

    expect(merged.resolved.results.viewers.value).toBeNull();
  });

  it("rehashes over the merged values, so a retained row deduplicates", () => {
    const previous = {
      values: { viewers: 2925 },
      availability: { viewers: { status: "available" } },
    };

    const merged = retainKnownValues(thin(), previous);

    expect(merged.resolved.metricHash).not.toBe(thin().metricHash);
    // Stable: retaining the same value twice must not write a second snapshot.
    expect(retainKnownValues(thin(), previous).resolved.metricHash).toBe(
      merged.resolved.metricHash,
    );
  });

  it("is a no-op when there is nothing stored", () => {
    const merged = retainKnownValues(thin(), null);

    expect(merged.retained).toEqual([]);
    expect(merged.resolved.metricHash).toBe(thin().metricHash);
  });
});
