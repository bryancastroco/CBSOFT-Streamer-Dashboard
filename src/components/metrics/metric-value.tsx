import { Calculator, CircleHelp } from "lucide-react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AVAILABILITY_SHORT, AVAILABILITY_TEXT, formatMetric } from "@/lib/metrics/format";
import type { MetricAvailability, MetricUnit } from "@/lib/metrics/registry";
import { cn } from "@/lib/utils";

/**
 * One metric, rendered honestly.
 *
 * The distinction this exists to protect: a number, a number Meta did not give
 * us, and a number we worked out ourselves are three different claims, and the
 * reader has to be able to tell them apart without hovering anything.
 *
 * A calculated value carries a visible icon rather than only a tooltip, because
 * an engagement total assembled from three columns is a weaker statement than
 * one Meta measured, and presenting them identically would be dishonest even
 * if the arithmetic is right.
 */

export type MetricDisplay = {
  label: string;
  value: number | null;
  unit: MetricUnit;
  availability: MetricAvailability;
  /** Meta's own name for the metric. Shown to admins only. */
  sourceMetricName?: string | null;
  /** Formula, when the value was calculated. */
  formula?: string | null;
};

export function MetricValue({
  metric,
  showSource = false,
  className,
}: {
  metric: MetricDisplay;
  /** Admins see which Meta metric supplied the value. */
  showSource?: boolean;
  className?: string;
}) {
  if (metric.value === null) {
    const status = metric.availability as Exclude<MetricAvailability, "available" | "calculated">;
    const text = AVAILABILITY_TEXT[status] ?? AVAILABILITY_TEXT.unavailable;

    return (
      <span className={cn("text-sm text-muted-foreground", className)}>
        {text}
        {/*
         * Never a zero here. A missing metric rendered as 0 corrupts every
         * average computed downstream, and does so invisibly.
         */}
      </span>
    );
  }

  const { compact, exact } = formatMetric(metric.value, metric.unit, metric.label);
  const isCalculated = metric.availability === "calculated";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn("inline-flex cursor-help items-center gap-1.5 tabular-nums", className)}
        >
          {compact}
          {isCalculated ? (
            <Calculator className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          ) : null}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-72 space-y-1">
        <p>{exact}</p>
        {isCalculated ? (
          <p className="text-muted-foreground">
            Calculated from {metric.formula ?? "reactions, comments and shares"} because an official
            interaction metric was not available.
          </p>
        ) : null}
        {showSource && metric.sourceMetricName ? (
          <p className="font-mono text-[11px] text-muted-foreground">{metric.sourceMetricName}</p>
        ) : null}
      </TooltipContent>
    </Tooltip>
  );
}

/** Compact form for a dense table cell. */
export function MetricCell({ metric }: { metric: MetricDisplay }) {
  if (metric.value === null) {
    const status = metric.availability as Exclude<MetricAvailability, "available" | "calculated">;

    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="cursor-help text-xs text-muted-foreground">
            {AVAILABILITY_SHORT[status] ?? "—"}
          </span>
        </TooltipTrigger>
        <TooltipContent>
          {AVAILABILITY_TEXT[status] ?? AVAILABILITY_TEXT.unavailable}
        </TooltipContent>
      </Tooltip>
    );
  }

  return <MetricValue metric={metric} className="text-sm" />;
}

/** A labelled metric in a group: label above, value below, tooltip on both. */
export function MetricField({
  metric,
  showSource = false,
  hint,
}: {
  metric: MetricDisplay;
  showSource?: boolean;
  hint?: string;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
        {metric.label}
        {hint ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <CircleHelp className="size-3 shrink-0 cursor-help" aria-hidden />
            </TooltipTrigger>
            <TooltipContent className="max-w-64">{hint}</TooltipContent>
          </Tooltip>
        ) : null}
      </div>
      <div className="text-lg font-semibold">
        <MetricValue metric={metric} showSource={showSource} />
      </div>
    </div>
  );
}
