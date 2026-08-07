/**
 * Period selection — a PURE module, shared by pages, route handlers and tests.
 *
 * Every filterable screen resolves its date window through `resolvePeriod`, so
 * "Last 7 days" means the same thing on the dashboard, in a table and in a CSV
 * export. Two screens computing the window separately is how a report and the
 * dashboard it was supposed to match end up disagreeing.
 *
 * ## Which day is "today"
 *
 * The display zone's day, not UTC's and not the viewer's browser's. All three
 * were candidates and only one is defensible: the viewer's browser would put
 * the same post inside "today" for one person and outside it for another, and
 * UTC would start "today" at 08:00 local — so at 07:00 in the morning, "Today"
 * showed yesterday's content and last night's posts had vanished from it.
 *
 * The rule is that the boundaries must agree with what the screens print. Both
 * read `lib/time/zone`, so changing the zone moves them together.
 */

import {
  displayDayStart,
  endOfDisplayDay,
  startOfDisplayDay,
  toDisplayIsoDate,
} from "@/lib/time/zone";

export const PERIOD_PRESETS = ["today", "7d", "30d", "custom", "all"] as const;

export type PeriodPreset = (typeof PERIOD_PRESETS)[number];

export function isPeriodPreset(value: unknown): value is PeriodPreset {
  return typeof value === "string" && (PERIOD_PRESETS as readonly string[]).includes(value);
}

export const PERIOD_LABELS: Record<PeriodPreset, string> = {
  today: "Today",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  custom: "Custom range",
  all: "All time",
};

/**
 * The default window every screen opens on.
 *
 * A week, because a performance dashboard is checked to see what changed
 * recently, and a month averages a bad week into a fine one.
 *
 * The trade-off is real and worth stating: on a roster that posts
 * infrequently, seven days can be genuinely empty — on 5 August 2026, with one
 * streamer, it was. That is the screen telling the truth about a quiet week
 * rather than a fault, and every other window is one click away. The figure
 * stops being awkward as soon as the roster is more than a couple of Pages.
 */
export const DEFAULT_PERIOD: PeriodPreset = "7d";

export type ResolvedPeriod = {
  preset: PeriodPreset;
  /** Inclusive lower bound, or null for an unbounded window. */
  from: Date | null;
  /** Inclusive upper bound, or null for an unbounded window. */
  to: Date | null;
  label: string;
  /**
   * Set when a `custom` range could not be used — an unparseable date, or a
   * range that ends before it starts. The caller falls back to the resolved
   * window and surfaces this to the reader rather than silently showing
   * something other than what was asked for.
   */
  warning: string | null;
};

const DAY_MS = 86_400_000;

/** Midnight, display zone, on the day containing `instant`. */
export const startOfDay = startOfDisplayDay;

/** The last representable millisecond of that same day. */
export const endOfDay = endOfDisplayDay;

/**
 * Parse a `YYYY-MM-DD` value from a date input.
 *
 * Deliberately strict: `new Date("2026-7-1")` and `new Date("last tuesday")`
 * behave differently across engines, and a filter that silently resolves to the
 * wrong window is worse than one that reports it could not read the input.
 *
 * Returns the instant that calendar day *begins* in the display zone, not UTC
 * midnight. Someone typing 7 August means their 7 August, and the difference is
 * the eight hours that would otherwise fall into the wrong end of the range.
 */
export function parseIsoDate(value: string | null | undefined): Date | null {
  if (!value) return null;

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;

  const [, year, month, day] = match;
  const probe = new Date(`${year}-${month}-${day}T00:00:00.000Z`);
  if (Number.isNaN(probe.getTime())) return null;

  // Rejects 2026-02-31, which the Date constructor would roll over to March.
  if (probe.getUTCMonth() + 1 !== Number(month) || probe.getUTCDate() !== Number(day)) {
    return null;
  }

  // Built from the validated fields rather than shifted from `probe`: no single
  // instant names a calendar day in every zone, so the fields are the input.
  return displayDayStart(Number(year), Number(month), Number(day));
}

/**
 * Format a Date as the `YYYY-MM-DD` an `<input type="date">` expects — the day
 * the reader is looking at, which is the display zone's day.
 */
export function toIsoDate(value: Date): string {
  return toDisplayIsoDate(value);
}

export type PeriodInput = {
  preset?: string | null | undefined;
  from?: string | null | undefined;
  to?: string | null | undefined;
  /** Injected so the resolution is deterministic in tests. */
  now?: Date;
};

/**
 * Turn a preset (plus optional custom bounds) into a concrete window.
 *
 * The rolling presets are **whole days** counted back from today inclusive:
 * "Last 7 days" is today plus the six days before it, not the last 168 hours.
 * A manager comparing two weekly reports needs the boundaries to line up with
 * days, not with the moment they happened to open the page.
 */
export function resolvePeriod(input: PeriodInput = {}): ResolvedPeriod {
  const now = input.now ?? new Date();
  const preset = isPeriodPreset(input.preset) ? input.preset : DEFAULT_PERIOD;

  const rolling = (days: number): ResolvedPeriod => ({
    preset,
    // Snapped back to midnight after the arithmetic. Subtracting fixed 24-hour
    // blocks from one midnight lands on the next only in a zone without DST;
    // re-normalising costs nothing and keeps this honest if the zone changes.
    from: startOfDay(new Date(startOfDay(now).getTime() - (days - 1) * DAY_MS)),
    to: endOfDay(now),
    label: PERIOD_LABELS[preset],
    warning: null,
  });

  switch (preset) {
    case "today":
      return rolling(1);
    case "7d":
      return rolling(7);
    case "30d":
      return rolling(30);
    case "all":
      return { preset, from: null, to: null, label: PERIOD_LABELS.all, warning: null };
    case "custom": {
      const from = parseIsoDate(input.from);
      const to = parseIsoDate(input.to);

      // Unreadable input is reported before the "nothing was given" case: a
      // value that was supplied and could not be read is a different situation
      // from no value at all, and collapsing the two would tell the reader
      // their dates were missing when in fact they were rejected.
      if (input.from && !from) {
        return {
          ...rolling(30),
          preset,
          warning: `Start date "${input.from}" is not a valid date. Showing the last 30 days.`,
        };
      }
      if (input.to && !to) {
        return {
          ...rolling(30),
          preset,
          warning: `End date "${input.to}" is not a valid date. Showing the last 30 days.`,
        };
      }

      if (!from && !to) {
        return {
          preset,
          from: null,
          to: null,
          label: PERIOD_LABELS.all,
          warning: "No custom dates were given, so all time is shown.",
        };
      }

      if (from && to && from.getTime() > to.getTime()) {
        // Swapping is friendlier than an empty table, but the reader is told.
        return {
          preset,
          from: startOfDay(to),
          to: endOfDay(from),
          label: `${toIsoDate(to)} → ${toIsoDate(from)}`,
          warning: "The end date was before the start date, so the two were swapped.",
        };
      }

      const lower = from ? startOfDay(from) : null;
      const upper = to ? endOfDay(to) : null;

      return {
        preset,
        from: lower,
        to: upper,
        label: `${lower ? toIsoDate(lower) : "Any"} → ${upper ? toIsoDate(upper) : "Any"}`,
        warning: null,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Content-type filter
// ---------------------------------------------------------------------------

/**
 * Which content a screen is scoped to. `all` is not the same as the
 * `ContentType` union in `lib/comments/content-ref`, which names a single
 * stored row — this is a filter value.
 */
export const CONTENT_SCOPES = ["all", "posts", "videos"] as const;

export type ContentScope = (typeof CONTENT_SCOPES)[number];

export function isContentScope(value: unknown): value is ContentScope {
  return typeof value === "string" && (CONTENT_SCOPES as readonly string[]).includes(value);
}

export const CONTENT_SCOPE_LABELS: Record<ContentScope, string> = {
  all: "Posts and videos",
  posts: "Posts",
  videos: "Videos",
};

export function resolveContentScope(value: unknown): ContentScope {
  return isContentScope(value) ? value : "all";
}
