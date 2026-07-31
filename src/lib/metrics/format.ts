import type { MetricAvailability, MetricUnit } from "./registry";

/**
 * How a metric is written for a reader.
 *
 * Pure and framework-free, so the same rules apply on a card, in a table cell,
 * in a tooltip and in a CSV. Duration is the reason this exists: Meta returns
 * watch time and average play time in milliseconds, and the product was
 * rendering `9,476` as a bare number where it meant 9.5 seconds — a figure that
 * looked like a count and was off by three orders of magnitude.
 *
 * Two renderings for every value. `compact` is what fits on a card; `exact` is
 * what belongs in the tooltip beside it. Precision is never lost — the
 * database and the exports always carry the raw number.
 */

const COMPACT = new Intl.NumberFormat("en-GB", { notation: "compact", maximumFractionDigits: 1 });
const FULL = new Intl.NumberFormat("en-GB");

/** 950, 1.2K, 1.4M. */
export function formatCount(value: number): string {
  // Below a thousand the compact form adds nothing and loses the exact figure.
  return value < 1000 ? FULL.format(value) : COMPACT.format(value);
}

/**
 * Total watch time, scaled to whatever unit keeps it readable.
 *
 * Under a minute reads in seconds, under an hour in minutes and seconds, and
 * above that in hours and minutes. A Page with real traffic reaches hundreds of
 * hours, and "40976323 ms" communicates nothing at any size.
 */
export function formatDurationMs(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);

  if (totalSeconds < 60) return `${totalSeconds}s`;

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;

  return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
}

/**
 * Average play time, in seconds with one decimal.
 *
 * Kept distinct from `formatDurationMs` deliberately. An average is typically
 * a few seconds, and rounding 9,476 ms to "9s" throws away the difference
 * between a video people leave immediately and one they nearly finish.
 */
export function formatPlayTimeMs(ms: number): string {
  const seconds = ms / 1000;

  return seconds < 10 ? `${seconds.toFixed(1)} sec` : `${Math.round(seconds)} sec`;
}

/** Video length: mm:ss, or hh:mm:ss once it runs past an hour. */
export function formatVideoLength(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.round(seconds % 60);

  const pad = (n: number) => String(n).padStart(2, "0");

  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
}

export type FormattedMetric = {
  /** For the card or cell. */
  compact: string;
  /** For the tooltip: the full figure with its unit named. */
  exact: string;
};

/** Format a value according to its unit. Callers handle null themselves. */
export function formatMetric(value: number, unit: MetricUnit, label: string): FormattedMetric {
  if (unit === "milliseconds") {
    const isAverage = label.toLowerCase().includes("average");

    return {
      compact: isAverage ? formatPlayTimeMs(value) : formatDurationMs(value),
      // The raw millisecond figure is named, so nobody has to guess the unit.
      exact: `${FULL.format(value)} ms`,
    };
  }

  if (unit === "seconds") {
    return { compact: formatVideoLength(value), exact: `${FULL.format(value)} seconds` };
  }

  return {
    compact: formatCount(value),
    exact: `${FULL.format(value)} ${label.toLowerCase()}`,
  };
}

/**
 * What to show when there is no number.
 *
 * Each status says something different, and collapsing them into one message
 * would hide the difference between "Meta will never report this", "Meta did
 * not report it this time" and "you lack the permission to see it" — three
 * problems with three different responses.
 */
export const AVAILABILITY_TEXT: Record<
  Exclude<MetricAvailability, "available" | "calculated">,
  string
> = {
  unavailable: "Not available from Meta",
  not_applicable: "Not applicable to this content type",
  permission_error: "Permission required",
  unsupported: "Not supported on this API version",
  api_error: "Temporarily unavailable",
};

/** The short form for a dense table cell, where the sentence will not fit. */
export const AVAILABILITY_SHORT: Record<
  Exclude<MetricAvailability, "available" | "calculated">,
  string
> = {
  unavailable: "Not available",
  not_applicable: "N/A",
  permission_error: "Permission",
  unsupported: "Unsupported",
  api_error: "Unavailable",
};
