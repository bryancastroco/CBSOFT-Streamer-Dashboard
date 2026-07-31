import {
  CANONICAL_METRIC_KEYS,
  METRIC_REGISTRY,
  type CanonicalMetricKey,
  type ContentApplicability,
} from "./registry";

/**
 * How the eleven metrics are arranged for a reader.
 *
 * Grouping is not decoration. Reach, engagement and video performance answer
 * different questions — how many people saw it, what they did about it, how
 * long they stayed — and a flat grid of eleven numbers makes the reader do
 * that sorting themselves, every time.
 *
 * The order within a group runs from the widest measure to the narrowest, so
 * reading downwards narrows the funnel rather than jumping about it.
 */

export type MetricGroupKey = "reach_and_discovery" | "engagement" | "video_performance";

export type MetricGroupDefinition = {
  key: MetricGroupKey;
  label: string;
  /** One line, for the card. Explains what question the group answers. */
  description: string;
  metrics: readonly CanonicalMetricKey[];
};

export const METRIC_GROUPS: readonly MetricGroupDefinition[] = [
  {
    key: "reach_and_discovery",
    label: "Reach and discovery",
    description: "How many people the content reached, and how many of them watched.",
    /*
     * `three_second_views` is deliberately absent even though it belongs here.
     * It is the same Meta metric as `views` — see `sameMeasurementAs` — and
     * listing both would show one number twice. `views` carries the label that
     * names the measurement.
     */
    metrics: ["reach", "views", "viewers", "reels_plays"],
  },
  {
    key: "engagement",
    label: "Engagement",
    description: "What people did with the content once they saw it.",
    metrics: ["interactions", "reactions", "likes", "comments", "shares"],
  },
  {
    key: "video_performance",
    label: "Video performance",
    description: "How long people actually watched.",
    metrics: ["watch_time", "average_play_time"],
  },
] as const;

/**
 * Every metric appears in exactly one group, except the merged pair.
 *
 * Checked by a test rather than trusted: a metric added to the registry and
 * forgotten here would simply never be displayed, and nothing else would
 * notice.
 */
export function ungroupedMetrics(): CanonicalMetricKey[] {
  const grouped = new Set(METRIC_GROUPS.flatMap((group) => group.metrics));

  return CANONICAL_METRIC_KEYS.filter((key) => {
    if (grouped.has(key)) return false;

    // A metric merged into its partner is displayed through it, not missing.
    const partner = METRIC_REGISTRY[key].sameMeasurementAs;
    return !(partner && grouped.has(partner));
  });
}

/** The metrics of a group that can apply to this kind of content. */
export function applicableMetrics(
  group: MetricGroupDefinition,
  applicability: ContentApplicability,
): CanonicalMetricKey[] {
  return group.metrics.filter((key) => METRIC_REGISTRY[key].appliesTo.includes(applicability));
}

/**
 * How a metric combines across many pieces of content.
 *
 * The distinction that matters: a count adds up and an average does not. Summing
 * `average_play_time` across 121 videos produces a number in the hundreds of
 * thousands of milliseconds that looks like a duration and is meaningless.
 *
 * `weighted_mean` is the honest aggregate for an average: each content item's
 * reported average, weighted by the views it was averaged over. It is still a
 * derived figure and is labelled as calculated wherever it appears.
 *
 * `none` means the metric has no roster-level reading at all.
 */
export type AggregationRule = "sum" | "weighted_mean" | "none";

export const AGGREGATION: Record<CanonicalMetricKey, AggregationRule> = {
  reach: "sum",
  views: "sum",
  viewers: "sum",
  interactions: "sum",
  likes: "sum",
  reactions: "sum",
  comments: "sum",
  shares: "sum",
  watch_time: "sum",
  three_second_views: "sum",
  reels_plays: "sum",
  /*
   * Weighted by views, not a plain mean of the averages. A plain mean gives a
   * video with nine views the same say as one with ninety thousand, which
   * describes the roster's videos rather than its viewers.
   */
  average_play_time: "weighted_mean",
};

/**
 * A summed metric, and how much of the roster it actually covers.
 *
 * `reported` versus `total` is the point. Views summed over 121 of 1,626 posts
 * is not "the roster's views", and a bare total invites exactly that reading.
 * Every aggregate carries its own denominator so the UI can say so.
 */
export type AggregatedMetric = {
  key: CanonicalMetricKey;
  value: number | null;
  /** Content items where Meta reported this metric. */
  reported: number;
  /** Content items the metric could apply to at all. */
  applicable: number;
  /** True when the figure was derived rather than measured. */
  calculated: boolean;
};

/** Whether an aggregate covers so little of the roster that it misleads. */
export function isThinCoverage(metric: AggregatedMetric): boolean {
  if (metric.applicable === 0 || metric.reported === 0) return false;

  // Under a fifth of the applicable content is a partial figure, not a total.
  return metric.reported / metric.applicable < 0.2;
}
