/**
 * Insight presentation — a PURE module, shared by the API and the UI.
 *
 * The single rule this file exists to enforce:
 *
 *   **A metric Meta did not report is shown as unavailable, never as zero.**
 *
 * Zero is a real measurement — "nobody engaged". Absence is the absence of a
 * measurement. Collapsing the two would turn a Meta permission gap or a
 * retired metric into a confident, wrong claim that engagement was nil, and
 * every average computed downstream would be silently dragged toward zero.
 */

export const METRIC_NOT_AVAILABLE = "Metric not available from Meta";

export type MetricAvailability = "reported" | "not_available";

export type DescribedInsight = {
  id: string;
  metricName: string;
  /** Human-friendly rendering of `metric_name`, e.g. "Post impressions". */
  label: string;
  period: string | null;
  endTime: Date | null;
  collectedAt: Date;
  availability: MetricAvailability;
  /** Ready to render. Equals `METRIC_NOT_AVAILABLE` when unavailable. */
  displayValue: string;
  /** The stored value, untouched, for callers that want to compute. */
  value: unknown;
};

type StoredInsight = {
  id: string;
  metricName: string;
  period: string | null;
  value: unknown;
  endTime: Date | null;
  collectedAt: Date;
};

/** `post_impressions_unique` → `Post impressions unique`. */
export function humanizeMetricName(name: string): string {
  const spaced = name.replace(/_/g, " ").trim();
  if (spaced.length === 0) return name;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const numberFormat = new Intl.NumberFormat("en-GB");

/**
 * Render a stored insight value.
 *
 * Returns `null` when there is nothing to show — the caller substitutes
 * `METRIC_NOT_AVAILABLE`. Note that `0` returns `"0"`: a reported zero is a
 * measurement and must display as one.
 */
export function formatInsightValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;

  if (typeof value === "number") {
    return Number.isFinite(value) ? numberFormat.format(value) : null;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    // Meta sometimes returns numerics as strings.
    const asNumber = Number(trimmed);
    return Number.isFinite(asNumber) && trimmed !== "" ? numberFormat.format(asNumber) : trimmed;
  }

  if (typeof value === "boolean") return value ? "Yes" : "No";

  if (Array.isArray(value)) {
    return value.length === 0 ? null : `${value.length} entries`;
  }

  if (typeof value === "object") {
    // Breakdown objects, e.g. { like: 12, love: 3 }. Summed where every value
    // is numeric, otherwise reported by key count.
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return null;

    const allNumeric = entries.every(([, entry]) => typeof entry === "number");
    if (allNumeric) {
      const total = entries.reduce((sum, [, entry]) => sum + (entry as number), 0);
      return `${numberFormat.format(total)} across ${entries.length} breakdowns`;
    }

    return `${entries.length} breakdowns`;
  }

  return null;
}

export function describeInsight(insight: StoredInsight): DescribedInsight {
  const formatted = formatInsightValue(insight.value);

  return {
    id: insight.id,
    metricName: insight.metricName,
    label: humanizeMetricName(insight.metricName),
    period: insight.period,
    endTime: insight.endTime,
    collectedAt: insight.collectedAt,
    availability: formatted === null ? "not_available" : "reported",
    displayValue: formatted ?? METRIC_NOT_AVAILABLE,
    value: insight.value,
  };
}

export function describeInsights(insights: StoredInsight[]): DescribedInsight[] {
  return insights.map(describeInsight);
}

/**
 * Render an engagement count from the post row.
 *
 * `null` means Meta did not report the field — most commonly `shares`, which
 * Meta omits entirely rather than sending zero. It is reported as unavailable,
 * not as 0.
 */
export function formatCount(value: number | null | undefined): {
  availability: MetricAvailability;
  display: string;
} {
  if (value === null || value === undefined) {
    return { availability: "not_available", display: METRIC_NOT_AVAILABLE };
  }
  return { availability: "reported", display: numberFormat.format(value) };
}

/** Compact variant for table cells, where the full sentence would not fit. */
export function formatCountShort(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return numberFormat.format(value);
}
