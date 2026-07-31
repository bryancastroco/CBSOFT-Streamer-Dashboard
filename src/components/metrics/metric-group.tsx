import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { MetricField, type MetricDisplay } from "@/components/metrics/metric-value";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  applicableMetrics,
  isThinCoverage,
  METRIC_GROUPS,
  type AggregatedMetric,
} from "@/lib/metrics/groups";
import { METRIC_REGISTRY, type CanonicalMetricKey, type ContentApplicability } from "@/lib/metrics/registry";
import { formatCount } from "@/lib/metrics/format";

/**
 * The three metric groups, rendered for one piece of content or for a roster.
 *
 * Two things this is careful about, both of which are easy to get wrong in a
 * way that looks fine:
 *
 * 1. **A group with nothing applicable is not rendered.** Showing "Video
 *    performance — not applicable ×2" on a text post is noise dressed as
 *    information.
 * 2. **An aggregate carries its denominator.** Views summed over 121 of 1,626
 *    posts is not the roster's views, and a bare total invites exactly that
 *    reading.
 */

export type ContentMetricValues = {
  values: Record<CanonicalMetricKey, number | null>;
  availability: Record<string, { status?: string; retained?: boolean } | undefined>;
  sourceMapping: Record<string, { metric?: string } | undefined>;
  interactionsIsCalculated: boolean;
};

/** Hints that explain a metric where the label alone would mislead. */
const HINTS: Partial<Record<CanonicalMetricKey, string>> = {
  views:
    "Meta counts a view at three seconds or longer, so this is also the three-second play count — one measurement, not two.",
  reels_plays:
    "Plays, not views. Meta measures a Reels play differently from a video view, so the two are never added together.",
  likes: "LIKE reactions only. Reactions counts every type — love, care, haha, wow, sad, angry.",
  interactions:
    "Meta's own activity total where it reported one. Where it did not, reactions plus comments plus shares, marked as calculated.",
  average_play_time: "Meta's own average per play. Never watch time divided by views.",
};

function toDisplay(
  key: CanonicalMetricKey,
  content: ContentMetricValues,
): MetricDisplay {
  const definition = METRIC_REGISTRY[key];
  const entry = content.availability[key];
  const status = entry?.status;

  return {
    label: definition.label,
    value: content.values[key],
    unit: definition.unit,
    availability:
      status === "available" ||
      status === "calculated" ||
      status === "not_applicable" ||
      status === "permission_error" ||
      status === "unsupported" ||
      status === "api_error"
        ? status
        : "unavailable",
    sourceMetricName: content.sourceMapping[key]?.metric ?? null,
    formula: definition.calculationFormula ?? null,
  };
}

export function ContentMetricGroups({
  metrics,
  applicability,
  showSource = false,
}: {
  metrics: ContentMetricValues;
  applicability: ContentApplicability;
  /** Admins see which Meta metric supplied each value. */
  showSource?: boolean;
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      {METRIC_GROUPS.map((group) => {
        const keys = applicableMetrics(group, applicability);
        // Nothing in this group can apply to this content. Say nothing.
        if (keys.length === 0) return null;

        return (
          <Card key={group.key} className="min-w-0">
            <CardHeader>
              <CardTitle className="text-base">{group.label}</CardTitle>
              <CardDescription>{group.description}</CardDescription>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-4">
              {keys.map((key) => (
                <MetricField
                  key={key}
                  metric={toDisplay(key, metrics)}
                  showSource={showSource}
                  {...(HINTS[key] ? { hint: HINTS[key] } : {})}
                />
              ))}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

/** An aggregate with its coverage stated underneath. */
function AggregateField({ metric }: { metric: AggregatedMetric }) {
  const definition = METRIC_REGISTRY[metric.key];

  const display: MetricDisplay = {
    label: definition.label,
    value: metric.value,
    unit: definition.unit,
    availability: metric.value === null ? "unavailable" : metric.calculated ? "calculated" : "available",
    formula:
      metric.key === "average_play_time"
        ? "each item's reported average, weighted by its views"
        : (definition.calculationFormula ?? null),
  };

  const thin = isThinCoverage(metric);

  return (
    <div className="space-y-1">
      <MetricField metric={display} {...(HINTS[metric.key] ? { hint: HINTS[metric.key] } : {})} />

      {metric.applicable > 0 ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <p
              className={
                thin
                  ? "cursor-help text-xs font-medium text-amber-600 dark:text-amber-500"
                  : "cursor-help text-xs text-muted-foreground"
              }
            >
              {formatCount(metric.reported)} of {formatCount(metric.applicable)} reported
            </p>
          </TooltipTrigger>
          <TooltipContent className="max-w-72">
            {thin
              ? `Meta reported this for under a fifth of the content it can apply to. The figure is a partial total, not the roster's ${definition.label.toLowerCase()}.`
              : `Summed across the ${formatCount(metric.reported)} item${metric.reported === 1 ? "" : "s"} Meta reported it for. Content where it was not reported is excluded rather than counted as zero.`}
          </TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  );
}

export function AggregateMetricGroups({
  metrics,
  withoutMetrics,
}: {
  metrics: Record<CanonicalMetricKey, AggregatedMetric>;
  /** Content in scope the rollup has not processed. */
  withoutMetrics: number;
}) {
  return (
    <div className="space-y-4">
      {withoutMetrics > 0 ? (
        /*
         * Stated plainly rather than left to be inferred from a low coverage
         * ratio. Content synced but not rolled up is absent from every figure
         * below, and a reader has no way to know that from the numbers.
         */
        <p className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-500">
          {formatCount(withoutMetrics)} item{withoutMetrics === 1 ? " has" : "s have"} been
          collected but not yet processed into metrics, and {withoutMetrics === 1 ? "is" : "are"}{" "}
          not counted below.
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        {METRIC_GROUPS.map((group) => (
          <Card key={group.key} className="min-w-0">
            <CardHeader>
              <CardTitle className="text-base">{group.label}</CardTitle>
              <CardDescription>{group.description}</CardDescription>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-4">
              {group.metrics.map((key) => (
                <AggregateField key={key} metric={metrics[key]} />
              ))}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
