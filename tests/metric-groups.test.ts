import { describe, expect, it } from "vitest";

import {
  AGGREGATION,
  applicableMetrics,
  isThinCoverage,
  METRIC_GROUPS,
  ungroupedMetrics,
  type AggregatedMetric,
} from "@/lib/metrics/groups";
import { CANONICAL_METRIC_KEYS, METRIC_REGISTRY } from "@/lib/metrics/registry";

/**
 * How the eleven metrics are arranged, and how they combine.
 *
 * Two failures this guards against, both silent:
 *
 * A metric added to the registry and forgotten in a group is simply never
 * rendered. Nothing errors, no test fails, and the number exists in the
 * database and nowhere on screen.
 *
 * A metric aggregated by the wrong rule produces a figure that looks
 * plausible. Summing `average_play_time` across 121 videos gives a number in
 * the hundreds of thousands of milliseconds — a duration-shaped value with no
 * meaning, which is far worse than a blank.
 */

describe("every metric has a home", () => {
  it("leaves nothing ungrouped", () => {
    expect(ungroupedMetrics()).toEqual([]);
  });

  it("shows a merged pair once, not twice", () => {
    const listed = METRIC_GROUPS.flatMap((group) => group.metrics);

    /*
     * `views` and `three_second_views` are one Meta metric. Listing both would
     * put an identical number in two slots and invite a reader to add them.
     */
    expect(listed).toContain("views");
    expect(listed).not.toContain("three_second_views");
  });

  it("never lists a metric in two groups", () => {
    const listed = METRIC_GROUPS.flatMap((group) => group.metrics);

    expect(new Set(listed).size).toBe(listed.length);
  });
});

describe("applicability filtering", () => {
  it("offers no video metrics on a text post", () => {
    const video = METRIC_GROUPS.find((group) => group.key === "video_performance")!;

    expect(applicableMetrics(video, "post")).toEqual([]);
  });

  it("offers watch time and average play time on a video post", () => {
    const video = METRIC_GROUPS.find((group) => group.key === "video_performance")!;

    expect(applicableMetrics(video, "video_post")).toEqual(["watch_time", "average_play_time"]);
  });

  it("offers reach and reels plays only on a video object", () => {
    const discovery = METRIC_GROUPS.find((group) => group.key === "reach_and_discovery")!;

    // Reach is rejected on the post edge in v25; Reels plays are a video metric.
    expect(applicableMetrics(discovery, "post")).toEqual([]);
    expect(applicableMetrics(discovery, "video")).toEqual(["reach", "reels_plays"]);
  });

  it("keeps engagement available on every content type", () => {
    const engagement = METRIC_GROUPS.find((group) => group.key === "engagement")!;

    for (const applicability of ["post", "video_post", "video"] as const) {
      expect(applicableMetrics(engagement, applicability).length).toBeGreaterThan(0);
    }
  });
});

describe("aggregation rules", () => {
  it("covers every canonical metric", () => {
    expect(Object.keys(AGGREGATION).sort()).toEqual([...CANONICAL_METRIC_KEYS].sort());
  });

  it("never sums an average", () => {
    /*
     * The rule that matters. Any metric whose unit is a duration *and* whose
     * label calls it an average must not be summed, whatever else changes.
     */
    for (const key of CANONICAL_METRIC_KEYS) {
      const definition = METRIC_REGISTRY[key];
      const isAverage = definition.label.toLowerCase().includes("average");

      if (isAverage) expect(AGGREGATION[key]).not.toBe("sum");
    }
  });

  it("weights average play time rather than taking a plain mean", () => {
    expect(AGGREGATION.average_play_time).toBe("weighted_mean");
  });

  it("sums the counts", () => {
    for (const key of ["reach", "views", "viewers", "likes", "comments", "shares"] as const) {
      expect(AGGREGATION[key]).toBe("sum");
    }
  });
});

describe("thin coverage", () => {
  const metric = (reported: number, applicable: number): AggregatedMetric => ({
    key: "views",
    value: 100,
    reported,
    applicable,
    calculated: false,
  });

  it("flags a total drawn from under a fifth of the content", () => {
    // 121 of 1,626 — the real shape of views on this roster.
    expect(isThinCoverage(metric(121, 1626))).toBe(true);
  });

  it("does not flag a total that covers most of the content", () => {
    expect(isThinCoverage(metric(1626, 1626))).toBe(false);
    expect(isThinCoverage(metric(400, 1626))).toBe(false);
  });

  it("does not flag a metric nothing reported, which reads as blank anyway", () => {
    expect(isThinCoverage(metric(0, 1626))).toBe(false);
  });

  it("does not divide by zero when nothing is applicable", () => {
    expect(isThinCoverage(metric(0, 0))).toBe(false);
  });
});
