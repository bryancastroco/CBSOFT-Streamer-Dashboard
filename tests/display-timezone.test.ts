import { describe, expect, it } from "vitest";

import {
  DISPLAY_TIME_ZONE,
  displayDayStart,
  endOfDisplayDay,
  formatDateTime,
  formatDayLabel,
  startOfDisplayDay,
  toDisplayIsoDate,
} from "@/lib/time/zone";

/**
 * The display zone.
 *
 * These assertions are written against Manila deliberately rather than against
 * `DISPLAY_TIME_ZONE` computed back into itself — a test that derives its
 * expectation from the same constant it is checking proves only that the
 * arithmetic is self-consistent, and would keep passing if the zone silently
 * reverted to UTC. Changing the zone is meant to fail here.
 */

describe("the display zone constant", () => {
  it("is Manila", () => {
    expect(DISPLAY_TIME_ZONE).toBe("Asia/Manila");
  });
});

describe("formatting an instant", () => {
  it("shows a UTC morning as a Manila afternoon", () => {
    // 09:00 UTC is 17:00 in Manila — the eight hours that made every screen
    // disagree with the phone of the person reading it.
    expect(formatDateTime(new Date("2026-08-06T09:00:57Z"))).toBe("6 Aug 2026, 17:00");
  });

  it("rolls the date forward for an instant late in the UTC day", () => {
    expect(formatDateTime(new Date("2026-08-06T17:30:00Z"))).toBe("7 Aug 2026, 01:30");
  });

  it("is stable regardless of the machine's own zone", () => {
    // Pinned rather than locale-resolved, so a Server Component and a client
    // table cannot render the same instant two different ways.
    const instant = new Date("2026-01-01T00:00:00Z");
    expect(formatDateTime(instant)).toBe(formatDateTime(new Date(instant.getTime())));
    expect(formatDateTime(instant)).toBe("1 Jan 2026, 08:00");
  });
});

describe("day boundaries", () => {
  it("starts the day at 16:00 the previous UTC day", () => {
    const start = startOfDisplayDay(new Date("2026-08-06T09:00:00Z"));
    expect(start.toISOString()).toBe("2026-08-05T16:00:00.000Z");
  });

  it("ends the day on the last millisecond before the next one begins", () => {
    const end = endOfDisplayDay(new Date("2026-08-06T09:00:00Z"));
    expect(end.toISOString()).toBe("2026-08-06T15:59:59.999Z");
  });

  it("puts an instant just after local midnight on the new day, not the old one", () => {
    // 16:30 UTC is 00:30 the next morning here. Bucketed by UTC this content
    // would have been counted under the previous day.
    const instant = new Date("2026-08-06T16:30:00Z");
    expect(toDisplayIsoDate(instant)).toBe("2026-08-07");
    expect(startOfDisplayDay(instant).toISOString()).toBe("2026-08-06T16:00:00.000Z");
  });

  it("leaves no gap or overlap between one day's end and the next day's start", () => {
    const end = endOfDisplayDay(new Date("2026-08-06T09:00:00Z"));
    const nextStart = startOfDisplayDay(new Date("2026-08-07T09:00:00Z"));

    expect(nextStart.getTime() - end.getTime()).toBe(1);
  });

  it("builds a day from its fields without probing an instant", () => {
    // `displayDayStart` exists because no single instant names a calendar day
    // in every zone — noon UTC lands on the next day at +14.
    expect(displayDayStart(2026, 8, 7).toISOString()).toBe("2026-08-06T16:00:00.000Z");
    expect(toDisplayIsoDate(displayDayStart(2026, 8, 7))).toBe("2026-08-07");
  });

  it("round-trips every day of a month", () => {
    for (let day = 1; day <= 31; day += 1) {
      const start = displayDayStart(2026, 1, day);
      expect(toDisplayIsoDate(start)).toBe(`2026-01-${String(day).padStart(2, "0")}`);
      expect(startOfDisplayDay(start).getTime()).toBe(start.getTime());
    }
  });

  it("crosses a year boundary", () => {
    expect(toDisplayIsoDate(new Date("2025-12-31T16:00:00Z"))).toBe("2026-01-01");
    expect(toDisplayIsoDate(new Date("2025-12-31T15:59:59Z"))).toBe("2025-12-31");
  });
});

describe("day labels", () => {
  it("prints a bucketed calendar day as given", () => {
    // Not converted. The grouping already happened in the display zone, in
    // SQL; shifting again would move every label off its own bar.
    expect(formatDayLabel("2026-07-14")).toBe("14 Jul");
    expect(formatDayLabel("2026-01-01")).toBe("1 Jan");
  });
});
