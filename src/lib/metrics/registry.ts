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
  /**
   * Another key this metric is literally the same measurement as.
   *
   * Not a similarity hint — it means one number from one Meta metric, surfaced
   * under two names. The UI renders the pair once so the reader is never shown
   * an identical figure twice as though two things had been measured; the
   * export keeps both keys so a consumer asking for either still gets it, with
   * `source_mapping_json` naming the single metric underneath.
   */
  sameMeasurementAs?: CanonicalMetricKey;
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
     *
     * Re-probed 2026-07-31 against GM Blade on a video post *and* a text post,
     * with `post_video_views` and `post_reactions_by_type_total` answering
     * normally in the same run as controls. Every name below came back
     * `(#100) The value must be a valid insights metric` on both. The
     * documented retrieval map still lists these as the reach/views/interactions
     * sources; on v25 with this Page's permissions they do not exist.
     */
    rejectedOnV25: [
      "post_impressions (post edge)",
      "post_impressions_unique (post edge)",
      "post_impressions_organic",
      "post_impressions_organic_unique",
      "post_impressions_paid",
      "post_reach",
      "post_engaged_users",
    ],
  },

  views: {
    key: "views",
    label: "Views (3-second plays)",
    description:
      "Plays of three seconds or longer, which is how Meta defines a view at post level. Impressions are never substituted, and Reels plays are counted separately because Meta measures them differently.",
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
    // The same number as `three_second_views`, because it is the same metric.
    sameMeasurementAs: "three_second_views",
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
      /*
       * `post_video_social_actions` is deliberately absent. It returns
       * `{SHARE, COMMENT}` — shares and comments only — so summing it as an
       * interactions total omits every reaction. On a real video here that
       * produced 6 against 28 likes alone, understating engagement by around
       * eighty per cent. A video with no official total falls through to the
       * calculated formula instead, which at least says what it is.
       */
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
      /*
       * The post field wins, by decision on 2026-07-31.
       *
       * Two reasons. Coverage: `post_reactions_by_type_total` arrived for 611
       * of 1,626 posts, so the insight leaves Likes blank on the majority of
       * the roster while the field answers on every post probed. Robustness: a
       * field needs no `read_insights` and fails only itself, where one bad
       * metric name collapses an entire insights request.
       *
       * They do not always agree — on the probed post the field said 27 and the
       * insight said 29. The resolver records the disagreement as a warning
       * rather than averaging it, and the field is what the product means by
       * "Likes": the live count on the post right now.
       */
      {
        metric: "like_reactions.summary.total_count",
        source: "post_field",
        endpoint: POST_EDGE,
        extract: { kind: "number" },
      },
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
      "Plays of three seconds or longer. At post level this is the same measurement Meta reports as Views — one metric, two names — not a separate figure.",
    appliesTo: ["video_post", "video"],
    unit: "count",
    calculationAllowed: false,
    /*
     * `post_video_views` is the three-second measure.
     *
     * This was empty for a while, on the reasoning that no metric *named* for
     * three seconds exists on v25 — every such name was probed and rejected,
     * and approximating from a general views figure would have been a
     * fabrication. That reasoning missed the real answer: Meta documents
     * `post_video_views` as plays of three seconds or longer, so the figure
     * already collected *is* this metric. Reading it here is not a derivation.
     *
     * Which is why `sameMeasurementAs` exists. Populating both keys from one
     * source would otherwise put an identical number in two columns and invite
     * a reader to add them, or to believe two things were measured. The UI
     * shows the pair once; the export keeps both keys so nothing downstream
     * breaks, with the single source named in `source_mapping_json`.
     */
    candidates: [
      {
        metric: "post_video_views",
        source: "post_insight",
        endpoint: POST_INSIGHTS,
        extract: { kind: "number" },
      },
      {
        // Accepted on v25 — returned no data for the probed video, but the name
        // is valid, so it resolves for any video where Meta does report it.
        metric: "total_video_views",
        source: "video_insight",
        endpoint: VIDEO_INSIGHTS,
        extract: { kind: "number" },
      },
    ],
    sameMeasurementAs: "views",
    rejectedOnV25: [
      "post_video_views_3s",
      "post_video_3s_views",
      "post_video_views_10s",
      "total_video_3s_views",
      "total_video_3s_views_unique",
    ],
    /*
     * Open question, not a settled mapping. Meta documents `post_video_views`
     * as plays of three seconds or longer, which would make this metric and
     * `views` the same measurement rather than two. Pointing both at one source
     * would put an identical number in two columns, so it waits on a decision
     * about how the UI says they are the same. Until then: unavailable, which
     * is at least not a claim.
     */
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
