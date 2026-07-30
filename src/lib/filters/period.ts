/**
 * Period selection — a PURE module, shared by pages, route handlers and tests.
 *
 * Every filterable screen resolves its date window through `resolvePeriod`, so
 * "Last 7 days" means the same thing on the dashboard, in a table and in a CSV
 * export. Two screens computing the window separately is how a report and the
 * dashboard it was supposed to match end up disagreeing.
 *
 * ## Why UTC
 *
 * Meta reports `created_time` in UTC and the database stores `timestamptz`. A
 * window computed in the viewer's local zone would put the same post inside
 * "today" for one person and outside it for another. The whole application
 * displays UTC (see the `formatWhen` helpers) and the boundaries match that.
 */

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

/** The default: broad enough to show something, narrow enough to stay fast. */
export const DEFAULT_PERIOD: PeriodPreset = "30d";

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

/** Midnight UTC on the day containing `instant`. */
export function startOfUtcDay(instant: Date): Date {
  return new Date(
    Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate(), 0, 0, 0, 0),
  );
}

/** The last representable millisecond of the day containing `instant`. */
export function endOfUtcDay(instant: Date): Date {
  return new Date(
    Date.UTC(
      instant.getUTCFullYear(),
      instant.getUTCMonth(),
      instant.getUTCDate(),
      23,
      59,
      59,
      999,
    ),
  );
}

/**
 * Parse a `YYYY-MM-DD` value from a date input.
 *
 * Deliberately strict: `new Date("2026-7-1")` and `new Date("last tuesday")`
 * behave differently across engines, and a filter that silently resolves to the
 * wrong window is worse than one that reports it could not read the input.
 */
export function parseIsoDate(value: string | null | undefined): Date | null {
  if (!value) return null;

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;

  const [, year, month, day] = match;
  const parsed = new Date(`${year}-${month}-${day}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return null;

  // Rejects 2026-02-31, which the Date constructor would roll over to March.
  if (parsed.getUTCMonth() + 1 !== Number(month) || parsed.getUTCDate() !== Number(day)) {
    return null;
  }

  return parsed;
}

/** Format a Date as the `YYYY-MM-DD` an `<input type="date">` expects. */
export function toIsoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
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
    from: new Date(startOfUtcDay(now).getTime() - (days - 1) * DAY_MS),
    to: endOfUtcDay(now),
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
          from: startOfUtcDay(to),
          to: endOfUtcDay(from),
          label: `${toIsoDate(to)} → ${toIsoDate(from)}`,
          warning: "The end date was before the start date, so the two were swapped.",
        };
      }

      const lower = from ? startOfUtcDay(from) : null;
      const upper = to ? endOfUtcDay(to) : null;

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
