/**
 * The canonical performance metrics, and the Meta names that supply them.
 *
 * ## One registry, not aliases scattered across files
 *
 * Every mapping from a Meta metric name to a business metric lives here. The
 * alternative — a name in the sync service, another in a repository, a third in
 * an export — is how `succeeded` survived in three files after the enum was
 * renamed, and why the Sync History page threw for weeks.
 *
 * ## Candidates are ordered, and every one was verified
 *
 * Meta does not guarantee a metric for any given Page, content type, format or
 * API version, and it renames them between versions. Each canonical metric
 * therefore lists candidates in preference order rather than one hard-coded
 * name, and the resolver takes the first that actually arrived.
 *
 * Every entry below was probed individually against a live Page on Graph v25.0
 * (2026-07-31) using `scripts/probe-metrics.mts`. Names recorded as unavailable
 * were rejected with `(#100) The value must be a valid insights metric` — they
 * are not guesses, and they are listed so nobody re-adds them hopefully.
 *
 * **Never add a candidate without probing it first.** A single invalid name in
 * a post-insights request fails the whole request, which would zero out every
 * metric for every post — the exact silent gap this design exists to prevent.
 */

export type CanonicalMetricKey =
  | "reach"
  | "views"
  | "viewers"
  | "interactions"
  | "likes"
  | "reactions"
  | "comments"
  | "shares"
  | "watch_time"
  | "average_play_time"
  | "three_second_views"
  | "reels_plays";

export type MetricUnit = "count" | "milliseconds" | "seconds" | "minutes";

export type MetricAvailability =
  | "available"
  | "calculated"
  | "unavailable"
  | "permission_error"
  | "unsupported"
  | "api_error"
  | "not_applicable";

export type MetricSource =
  "post_field" | "post_insight" | "video_field" | "video_insight" | "calculated" | "unknown";

export type ContentApplicability = "post" | "video_post" | "video";

export interface CanonicalMetricResult {
  key: CanonicalMetricKey;
  value: number | null;
  unit: MetricUnit;
  availability: MetricAvailability;
  source: MetricSource;
  /** The Meta metric or field that supplied it. Null when unavailable. */
  sourceMetricName: string | null;
  sourceEndpoint: string | null;
  collectedAt: string;
}

/** How to pull a number out of a Meta insight value that is not a plain number. */
export type ValueExtractor =
  | { kind: "number" }
  /** Sum every value in a breakdown object, e.g. reactions by type. */
  | { kind: "sum_object" }
  /** One key from a breakdown object, e.g. `like` or `COMMENT`. */
  | { kind: "object_key"; keys: readonly string[] };

export type MetricCandidate = {
  /** Exact name Meta returns. */
  metric: string;
  source: MetricSource;
  endpoint: string;
  extract: ValueExtractor;
  /** Absent means confirmed working; present explains why it is kept but unused. */
  note?: string;
};

export type CanonicalMetricDefinition = {
  key: CanonicalMetricKey;
  label: string;
  description: string;
  appliesTo: readonly ContentApplicability[];
  unit: MetricUnit;
  /** Ordered by preference. The first candidate present in the data wins. */
  candidates: readonly MetricCandidate[];
  /** Only `interactions` may be derived, and it says so when it is. */
  calculationAllowed: boolean;
  calculationFormula?: string;
  /** Names probed and rejected on v25, kept so nobody retries them blindly. */
  rejectedOnV25?: readonly string[];
};

const POST_INSIGHTS = "/{post-id}/insights";
const VIDEO_INSIGHTS = "/{video-id}/video_insights";
const POST_EDGE = "/{page-id}/published_posts";

export const METRIC_REGISTRY: Record<CanonicalMetricKey, CanonicalMetricDefinition> = {
  reach: {
    key: "reach",
    label: "Reach",
    description:
      "Unique people Meta reports as having seen the content. Not impressions, and never derived from views.",
    appliesTo: ["video"],
    unit: "count",
    calculationAllowed: false,
    candidates: [
      {
        metric: "post_impressions_unique",
        source: "video_insight",
        endpoint: VIDEO_INSIGHTS,
        extract: { kind: "number" },
      },
    ],
    /*
     * Reach is unavailable for ordinary posts. The whole post_impressions
     * family is rejected on the post edge in v25 — it survives only on
     * video_insights, which is why `appliesTo` excludes plain posts rather
     * than reporting them as zero.
     */
    rejectedOnV25: ["post_impressions_unique (post edge)", "post_reach", "post_engaged_users"],
  },

  views: {
    key: "views",
    label: "Views",
    description:
      "Video views Meta explicitly reports as views. Impressions are never substituted, and Reels plays are kept separate.",
    appliesTo: ["video_post"],
    unit: "count",
    calculationAllowed: false,
    candidates: [
      {
        metric: "post_video_views",
        source: "post_insight",
        endpoint: POST_INSIGHTS,
        extract: { kind: "number" },
      },
    ],
  },

  viewers: {
    key: "viewers",
    label: "Viewers",
    description:
      "Unique people who viewed the video, as reported by Meta's own unique-viewer metric.",
    appliesTo: ["video_post"],
    unit: "count",
    calculationAllowed: false,
    candidates: [
      {
        /*
         * Found by probing, not by assumption — the initial audit reported
         * viewers as unavailable. Meta names this one "unique" itself, which
         * is the only basis on which a viewers figure may be populated.
         *
         * Worth knowing: on the probed post this returned exactly the same
         * value as `post_video_views` (2,925). That is plausible for content
         * where nobody watched twice, but it means the two must be resolved
         * independently and never assumed to differ.
         */
        metric: "post_video_views_unique",
        source: "post_insight",
        endpoint: POST_INSIGHTS,
        extract: { kind: "number" },
      },
    ],
  },

  interactions: {
    key: "interactions",
    label: "Interactions",
    description:
      "Meta's own activity total where available, otherwise reactions plus comments plus shares, labelled as calculated.",
    appliesTo: ["post", "video_post", "video"],
    unit: "count",
    calculationAllowed: true,
    calculationFormula: "reactions + comments + shares",
    candidates: [
      {
        metric: "post_activity_by_action_type",
        source: "post_insight",
        endpoint: POST_INSIGHTS,
        extract: { kind: "sum_object" },
      },
      {
        metric: "post_video_social_actions",
        source: "video_insight",
        endpoint: VIDEO_INSIGHTS,
        extract: { kind: "sum_object" },
      },
    ],
  },

  likes: {
    key: "likes",
    label: "Likes",
    description:
      "LIKE reactions only — a subset of total reactions, never the whole reaction count.",
    appliesTo: ["post", "video_post", "video"],
    unit: "count",
    calculationAllowed: false,
    candidates: [
      {
        metric: "post_reactions_by_type_total",
        source: "post_insight",
        endpoint: POST_INSIGHTS,
        extract: { kind: "object_key", keys: ["like", "LIKE"] },
      },
      {
        metric: "post_video_likes_by_reaction_type",
        source: "video_insight",
        endpoint: VIDEO_INSIGHTS,
        extract: { kind: "object_key", keys: ["REACTION_LIKE", "LIKE", "like"] },
      },
    ],
  },

  reactions: {
    key: "reactions",
    label: "Reactions",
    description: "All reaction types combined — like, love, care, haha, wow, sad, angry.",
    appliesTo: ["post", "video_post", "video"],
    unit: "count",
    calculationAllowed: false,
    candidates: [
      {
        metric: "reactions.summary.total_count",
        source: "post_field",
        endpoint: POST_EDGE,
        extract: { kind: "number" },
      },
      {
        metric: "post_reactions_by_type_total",
        source: "post_insight",
        endpoint: POST_INSIGHTS,
        extract: { kind: "sum_object" },
      },
      {
        metric: "post_video_likes_by_reaction_type",
        source: "video_insight",
        endpoint: VIDEO_INSIGHTS,
        extract: { kind: "sum_object" },
      },
    ],
  },

  comments: {
    key: "comments",
    label: "Comments",
    description:
      "Comment count as returned by Meta on the content object. Meta's summary count includes replies.",
    appliesTo: ["post", "video_post", "video"],
    unit: "count",
    calculationAllowed: false,
    candidates: [
      {
        metric: "comments.summary.total_count",
        source: "post_field",
        endpoint: POST_EDGE,
        extract: { kind: "number" },
      },
      {
        metric: "post_video_social_actions",
        source: "video_insight",
        endpoint: VIDEO_INSIGHTS,
        extract: { kind: "object_key", keys: ["COMMENT"] },
      },
    ],
  },

  shares: {
    key: "shares",
    label: "Shares",
    description: "Share count returned by Meta. Never counted from individual shared-post records.",
    appliesTo: ["post", "video_post", "video"],
    unit: "count",
    calculationAllowed: false,
    candidates: [
      {
        metric: "shares.count",
        source: "post_field",
        endpoint: POST_EDGE,
        extract: { kind: "number" },
      },
      {
        metric: "post_video_social_actions",
        source: "video_insight",
        endpoint: VIDEO_INSIGHTS,
        extract: { kind: "object_key", keys: ["SHARE"] },
      },
    ],
  },

  watch_time: {
    key: "watch_time",
    label: "Watch time",
    description:
      "Total time spent watching, in milliseconds as Meta returns it. Never estimated from views multiplied by length.",
    appliesTo: ["video_post", "video"],
    unit: "milliseconds",
    calculationAllowed: false,
    candidates: [
      {
        /*
         * Also found by probing. The audit had this as video-edge only; it is
         * available on the post edge too, which matters because most content
         * here is a video post rather than a bare video object.
         */
        metric: "post_video_view_time",
        source: "post_insight",
        endpoint: POST_INSIGHTS,
        extract: { kind: "number" },
      },
      {
        metric: "post_video_view_time",
        source: "video_insight",
        endpoint: VIDEO_INSIGHTS,
        extract: { kind: "number" },
      },
    ],
  },

  average_play_time: {
    key: "average_play_time",
    label: "Average play time",
    description:
      "Meta's own average time watched per play, in milliseconds. Never derived from watch time divided by views.",
    appliesTo: ["video_post", "video"],
    unit: "milliseconds",
    calculationAllowed: false,
    candidates: [
      {
        metric: "post_video_avg_time_watched",
        source: "post_insight",
        endpoint: POST_INSIGHTS,
        extract: { kind: "number" },
      },
      {
        metric: "post_video_avg_time_watched",
        source: "video_insight",
        endpoint: VIDEO_INSIGHTS,
        extract: { kind: "number" },
      },
    ],
  },

  three_second_views: {
    key: "three_second_views",
    label: "3-second views",
    description:
      "Views meeting Meta's three-second measurement. Distinct from total views and never derived from them.",
    appliesTo: ["video_post", "video"],
    unit: "count",
    calculationAllowed: false,
    /*
     * Deliberately empty. Every candidate below was probed individually on
     * v25 and rejected outright. The metric is therefore recorded as
     * unavailable rather than approximated from a general views figure, which
     * rule 9 forbids and which would understate or overstate depending on the
     * content.
     */
    candidates: [],
    rejectedOnV25: [
      "post_video_views_3s",
      "post_video_3s_views",
      "post_video_views_10s",
      "total_video_3s_views",
      "total_video_3s_views_unique",
    ],
  },

  reels_plays: {
    key: "reels_plays",
    label: "Reels plays",
    description:
      "Reels play count. A play is not a view — Meta measures them differently, so this is reported separately and never folded into views.",
    appliesTo: ["video"],
    unit: "count",
    calculationAllowed: false,
    candidates: [
      {
        metric: "fb_reels_total_plays",
        source: "video_insight",
        endpoint: VIDEO_INSIGHTS,
        extract: { kind: "number" },
      },
      {
        metric: "blue_reels_play_count",
        source: "video_insight",
        endpoint: VIDEO_INSIGHTS,
        extract: { kind: "number" },
      },
    ],
  },
};

export const CANONICAL_METRIC_KEYS = Object.keys(METRIC_REGISTRY) as CanonicalMetricKey[];

/**
 * Post-insight metric names to request.
 *
 * Derived from the registry rather than restated, so adding a probed candidate
 * updates the request automatically. Only post-edge insight candidates appear;
 * field values come from the post object and video insights need no `metric`
 * parameter at all.
 */
export const POST_INSIGHT_METRIC_NAMES: readonly string[] = [
  ...new Set(
    CANONICAL_METRIC_KEYS.flatMap((key) =>
      METRIC_REGISTRY[key].candidates
        .filter((candidate) => candidate.source === "post_insight")
        .map((candidate) => candidate.metric),
    ),
  ),
];

/** True when a metric cannot apply to this content at all. */
export function isApplicable(key: CanonicalMetricKey, content: ContentApplicability): boolean {
  return METRIC_REGISTRY[key].appliesTo.includes(content);
}
