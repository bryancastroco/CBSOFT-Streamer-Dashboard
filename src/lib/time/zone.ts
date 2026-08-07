/**
 * The one time zone this product is read in — a PURE module.
 *
 * No `server-only`: the same instant has to render identically in a Server
 * Component and in a client table, and two implementations is how those drift.
 *
 * ## Why a constant and not the viewer's browser zone
 *
 * `toLocaleString()` with no zone resolves to the server's zone during SSR
 * (UTC on Vercel) and the browser's zone after hydration, so the same row
 * renders two different times within a second of itself. Beyond the flicker it
 * makes reports uncomparable: two people looking at the same dashboard would
 * read different numbers into the same day boundary. CBSOFT operates in one
 * place, so the honest answer is to name that place once.
 *
 * ## Why not UTC, which is what this used to do
 *
 * It was defensible — Meta reports in UTC and the database stores `timestamptz`
 * — but it made every screen say a post went up at 09:00 when the person who
 * posted it remembers doing so at 17:00. A dashboard whose times disagree with
 * the phone of the person reading it gets distrusted, and correctly so.
 *
 * ## Changing it
 *
 * Change `DISPLAY_TIME_ZONE` and the label beside it. Everything else follows:
 * the formatters, the "Last 7 days" boundaries, and the day buckets the charts
 * group by all read this constant. Nothing stored changes — the database keeps
 * absolute instants, and this is only how they are shown and bucketed.
 */

/** An IANA zone name. Manila is a fixed +08:00 and has had no DST since 1978. */
export const DISPLAY_TIME_ZONE = "Asia/Manila";

/** How to name that zone to a reader. Shown where a time could be ambiguous. */
export const DISPLAY_TIME_ZONE_LABEL = "GMT+8";

/**
 * `en-GB` for the same reason the zone is fixed: an unpinned locale resolves
 * differently on the server and in the browser, and "07/08/2026" versus
 * "8/7/2026" is a genuine ambiguity rather than a cosmetic one.
 */
const LOCALE = "en-GB";

const dateTimeFormat = new Intl.DateTimeFormat(LOCALE, {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: DISPLAY_TIME_ZONE,
});

const dateFormat = new Intl.DateTimeFormat(LOCALE, {
  dateStyle: "medium",
  timeZone: DISPLAY_TIME_ZONE,
});

/**
 * Used to read an instant's wall-clock in the display zone. Second precision is
 * all a zone offset needs; milliseconds are carried separately where they
 * matter.
 */
const partsFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: DISPLAY_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

export type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function zonedParts(instant: Date): ZonedParts {
  const found: Record<string, number> = {};

  for (const part of partsFormat.formatToParts(instant)) {
    if (part.type !== "literal") found[part.type] = Number(part.value);
  }

  return {
    year: found["year"] ?? 0,
    month: found["month"] ?? 1,
    day: found["day"] ?? 1,
    hour: found["hour"] ?? 0,
    minute: found["minute"] ?? 0,
    second: found["second"] ?? 0,
  };
}

/** How far ahead of UTC the display zone is at `instant`, in milliseconds. */
function offsetMs(instant: Date): number {
  const parts = zonedParts(instant);
  const wallClock = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );

  // Floored to the second, because `partsFormat` cannot report milliseconds and
  // subtracting them would report an offset a fraction of a second off.
  return wallClock - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * The absolute instant at which the display zone's clock reads these values.
 *
 * Resolved twice. The first pass uses the offset at the *naive* timestamp,
 * which is wrong by the offset itself; the second uses the offset at the answer
 * the first pass gave. For a fixed-offset zone the two agree immediately, and
 * the second pass costs nothing. It is here so that pointing
 * `DISPLAY_TIME_ZONE` at a zone that observes DST does not silently produce
 * day boundaries an hour out twice a year.
 */
function instantAtWallClock(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  ms: number,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  const firstPass = naive - offsetMs(new Date(naive));
  return new Date(naive - offsetMs(new Date(firstPass)));
}

/**
 * Midnight, display zone, on a named calendar day.
 *
 * Takes the fields rather than an instant, because there is no instant that
 * identifies a calendar day in every zone: probing with noon UTC lands on the
 * next day at +14 and the previous one at -12. Callers holding a `YYYY-MM-DD`
 * should use this, not `startOfDisplayDay` on something they built from it.
 */
export function displayDayStart(year: number, month: number, day: number): Date {
  return instantAtWallClock(year, month, day, 0, 0, 0, 0);
}

/** Midnight, display zone, on the day containing `instant`. */
export function startOfDisplayDay(instant: Date): Date {
  const { year, month, day } = zonedParts(instant);
  return instantAtWallClock(year, month, day, 0, 0, 0, 0);
}

/** The last representable millisecond of the display-zone day containing `instant`. */
export function endOfDisplayDay(instant: Date): Date {
  const { year, month, day } = zonedParts(instant);
  return instantAtWallClock(year, month, day, 23, 59, 59, 999);
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * The `YYYY-MM-DD` an `<input type="date">` expects, as the display zone sees
 * it. `toISOString().slice(0, 10)` would answer the UTC day, which for the
 * eight hours after midnight here is yesterday.
 */
export function toDisplayIsoDate(instant: Date): string {
  const { year, month, day } = zonedParts(instant);
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** An instant, as a date and a time. The default across every screen. */
export function formatDateTime(value: Date): string {
  return dateTimeFormat.format(value);
}

/** An instant, as a date alone. */
export function formatDate(value: Date): string {
  return dateFormat.format(value);
}

const dayLabelFormat = new Intl.DateTimeFormat(LOCALE, {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

/**
 * A short label for an already-bucketed calendar day — `"2026-07-14"` → `"14 Jul"`.
 *
 * Formatted in UTC deliberately, and this is not an oversight. The input is a
 * calendar date, not an instant: the grouping already happened, in the display
 * zone, in SQL. Converting it a second time would shift every label one day
 * away from the bar it belongs to.
 */
export function formatDayLabel(isoDay: string): string {
  return dayLabelFormat.format(new Date(`${isoDay}T00:00:00Z`));
}
