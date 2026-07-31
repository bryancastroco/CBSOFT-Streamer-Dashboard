import { createHash } from "node:crypto";

import {
  METRIC_REGISTRY,
  CANONICAL_METRIC_KEYS,
  type CanonicalMetricKey,
  type CanonicalMetricResult,
  type ContentApplicability,
  type MetricAvailability,
  type MetricCandidate,
  type ValueExtractor,
} from "./registry";

/**
 * Turn what Meta actually returned into the canonical metrics.
 *
 * Pure: it takes raw insight rows and post fields, and returns results. No
 * database, no network, no clock beyond the timestamp it is handed. That is
 * what makes the whole mapping testable against fixtures rather than against a
 * live Page.
 *
 * ## The rule that governs every decision here
 *
 * A metric is null unless Meta supplied it. Not zero, not inferred from a
 * neighbouring metric, not carried over from a previous collection. Every
 * shortcut in the opposite direction produces a number that looks like a
 * measurement and is not one, and averages built on those are wrong in a way
 * no one can see from the dashboard.
 */

/** One raw insight row as stored, whatever endpoint it came from. */
export type RawInsight = {
  metricName: string;
  /** Meta's value: a number, or a breakdown object. */
  value: unknown;
  period?: string | null;
};

/** Counts that live on the content object rather than in insights. */
export type ContentFields = {
  reactionCount?: number | null;
  commentCount?: number | null;
  shareCount?: number | null;
};

export type ResolveInput = {
  applicability: ContentApplicability;
  postInsights?: readonly RawInsight[];
  videoInsights?: readonly RawInsight[];
  fields?: ContentFields;
  graphApiVersion: string;
  collectedAt: Date;
};

export type ResolvedMetrics = {
  results: Record<CanonicalMetricKey, CanonicalMetricResult>;
  /** Per-metric status, for `availability_json`. */
  availability: Record<string, unknown>;
  /** Which Meta name and endpoint supplied each value, for `source_mapping_json`. */
  sourceMapping: Record<string, unknown>;
  /** Deterministic over the values only, so snapshots deduplicate correctly. */
  metricHash: string;
  /** Conflicts worth logging: two candidates present and disagreeing. */
  warnings: string[];
};

/** Pull a number out of a raw Meta value according to the candidate's rule. */
function extract(value: unknown, rule: ValueExtractor): number | null {
  if (rule.kind === "number") {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;

  if (rule.kind === "object_key") {
    for (const key of rule.keys) {
      const found = record[key];
      if (typeof found === "number" && Number.isFinite(found)) return found;
    }
    /*
     * A breakdown that exists but lacks the key is a real answer, not a
     * missing one: Meta returns `{love: 3}` when nobody pressed Like, and the
     * honest reading of that is zero likes rather than "unknown".
     */
    return 0;
  }

  // sum_object
  let total = 0;
  let sawNumber = false;
  for (const entry of Object.values(record)) {
    if (typeof entry === "number" && Number.isFinite(entry)) {
      total += entry;
      sawNumber = true;
    }
  }
  return sawNumber ? total : null;
}

function findRaw(
  candidate: MetricCandidate,
  postInsights: readonly RawInsight[],
  videoInsights: readonly RawInsight[],
  fields: ContentFields,
): { value: number | null; present: boolean } {
  if (candidate.source === "post_field") {
    const value =
      candidate.metric === "reactions.summary.total_count"
        ? (fields.reactionCount ?? null)
        : candidate.metric === "comments.summary.total_count"
          ? (fields.commentCount ?? null)
          : candidate.metric === "shares.count"
            ? (fields.shareCount ?? null)
            : null;

    return { value, present: value !== null };
  }

  const pool = candidate.source === "video_insight" ? videoInsights : postInsights;

  /*
   * Prefer a lifetime reading. Meta returns the same metric at several
   * periods; mixing a `day` value into a total that elsewhere holds `lifetime`
   * produces a figure that is neither.
   */
  const matches = pool.filter((row) => row.metricName === candidate.metric);
  if (matches.length === 0) return { value: null, present: false };

  const chosen = matches.find((row) => row.period === "lifetime") ?? matches[0]!;
  const value = extract(chosen.value, candidate.extract);

  return { value, present: value !== null };
}

function unavailable(
  key: CanonicalMetricKey,
  availability: MetricAvailability,
  collectedAt: string,
): CanonicalMetricResult {
  return {
    key,
    value: null,
    unit: METRIC_REGISTRY[key].unit,
    availability,
    source: "unknown",
    sourceMetricName: null,
    sourceEndpoint: null,
    collectedAt,
  };
}

export function resolveMetrics(input: ResolveInput): ResolvedMetrics {
  const postInsights = input.postInsights ?? [];
  const videoInsights = input.videoInsights ?? [];
  const fields = input.fields ?? {};
  const collectedAt = input.collectedAt.toISOString();

  const results = {} as Record<CanonicalMetricKey, CanonicalMetricResult>;
  const availability: Record<string, unknown> = {};
  const sourceMapping: Record<string, unknown> = {};
  const warnings: string[] = [];

  for (const key of CANONICAL_METRIC_KEYS) {
    const definition = METRIC_REGISTRY[key];

    // A video metric on a text post is not missing data; it cannot apply.
    if (!definition.appliesTo.includes(input.applicability)) {
      results[key] = unavailable(key, "not_applicable", collectedAt);
      availability[key] = {
        status: "not_applicable",
        reason: `Not applicable to ${input.applicability.replace("_", " ")} content`,
      };
      continue;
    }

    const hits = definition.candidates
      .map((candidate) => ({
        candidate,
        ...findRaw(candidate, postInsights, videoInsights, fields),
      }))
      .filter((hit) => hit.present);

    if (hits.length === 0) {
      results[key] = unavailable(key, "unavailable", collectedAt);
      availability[key] = {
        status: "unavailable",
        reason:
          definition.candidates.length === 0
            ? "No metric for this exists on the current Graph API version"
            : "Metric was not returned by Meta",
      };
      continue;
    }

    const winner = hits[0]!;

    /*
     * Two candidates present and disagreeing is worth saying out loud. The
     * preferred one still wins — silently combining them would invent a third
     * number belonging to neither source — but the disagreement is recorded so
     * it can be investigated rather than absorbed.
     */
    for (const other of hits.slice(1)) {
      if (other.value !== winner.value) {
        warnings.push(
          `${key}: ${winner.candidate.metric}=${winner.value} but ${other.candidate.metric}=${other.value}; used ${winner.candidate.metric}`,
        );
      }
    }

    results[key] = {
      key,
      value: winner.value,
      unit: definition.unit,
      availability: "available",
      source: winner.candidate.source,
      sourceMetricName: winner.candidate.metric,
      sourceEndpoint: winner.candidate.endpoint,
      collectedAt,
    };
    availability[key] = {
      status: "available",
      source: winner.candidate.source,
      sourceMetricName: winner.candidate.metric,
    };
    sourceMapping[key] = {
      metric: winner.candidate.metric,
      endpoint: winner.candidate.endpoint,
      source: winner.candidate.source,
    };
  }

  /*
   * Interactions is the one metric allowed a fallback, and only when Meta
   * offered nothing official. It is labelled `calculated` so the UI can say so
   * — an engagement total assembled here is a different claim from one Meta
   * measured, and presenting them identically would be dishonest.
   */
  if (results.interactions.availability === "unavailable") {
    const parts = [results.reactions.value, results.comments.value, results.shares.value];

    if (parts.some((part) => part !== null)) {
      const total = parts.reduce<number>((sum, part) => sum + (part ?? 0), 0);

      results.interactions = {
        key: "interactions",
        value: total,
        unit: "count",
        availability: "calculated",
        source: "calculated",
        sourceMetricName: null,
        sourceEndpoint: null,
        collectedAt,
      };
      availability["interactions"] = {
        status: "calculated",
        formula: METRIC_REGISTRY.interactions.calculationFormula,
        /*
         * Named so a reader can tell a total built from all three from one
         * that quietly skipped a component Meta never reported.
         */
        componentsUsed: {
          reactions: results.reactions.value,
          comments: results.comments.value,
          shares: results.shares.value,
        },
      };
    }
  }

  return {
    results,
    availability,
    sourceMapping,
    metricHash: hashMetrics(results),
    warnings,
  };
}

/**
 * A hash over the metric values only.
 *
 * Deliberately excludes timestamps, endpoints and the API version. A snapshot
 * should be written when the numbers move, not when the same numbers are
 * collected again six hours later — otherwise a quiet week produces
 * twenty-eight identical rows and the trend chart is noise.
 *
 * Availability is included because a metric going from available to
 * unavailable is a real change worth recording, even though the value is null
 * either way.
 */
export function hashMetrics(results: Record<CanonicalMetricKey, CanonicalMetricResult>): string {
  const canonical = CANONICAL_METRIC_KEYS.map(
    (key) => `${key}=${results[key].value ?? "null"}:${results[key].availability}`,
  ).join("|");

  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

/** The metric values as database columns. */
export function toColumns(resolved: ResolvedMetrics) {
  const value = (key: CanonicalMetricKey) => resolved.results[key].value;

  return {
    reach: value("reach"),
    views: value("views"),
    viewers: value("viewers"),
    interactions: value("interactions"),
    interactionsIsCalculated: resolved.results.interactions.availability === "calculated",
    likes: value("likes"),
    reactions: value("reactions"),
    comments: value("comments"),
    shares: value("shares"),
    watchTimeMs: value("watch_time"),
    averagePlayTimeMs: value("average_play_time"),
    threeSecondViews: value("three_second_views"),
    reelsPlays: value("reels_plays"),
    availabilityJson: resolved.availability,
    sourceMappingJson: resolved.sourceMapping,
    metricHash: resolved.metricHash,
  };
}
