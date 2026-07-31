import { readFileSync, readdirSync, statSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path, { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

import { tsParam, tsResult } from "@/lib/db/params";

/** Every .ts/.tsx under a directory, for the structural guards below. */
function sourceFiles(directory: string, collected: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    if (["node_modules", ".next", ".git"].includes(entry)) continue;
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, collected);
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) collected.push(full);
  }
  return collected;
}

/**
 * A source guard against re-introducing a `Date` into a raw `sql` fragment.
 *
 * ## Why a source scan rather than a behavioural test
 *
 * The bug this prevents is driver-specific. Under `prepare: false` — which the
 * Supabase transaction pooler requires — postgres.js refuses to serialise a
 * `Date` interpolated into a hand-written `sql` template:
 *
 *     ERR_INVALID_ARG_TYPE — Received an instance of Date
 *
 * It cannot be reproduced in the PGlite suites, because PGlite is a different
 * driver that handles the value happily. So the only place to catch it before
 * production is the source, and the only honest way to say so is a scan.
 *
 * It cost `post_insights` and `video_insights` every row they should ever have
 * had: each sync reported success, because the counters record what the service
 * intended to write rather than what Postgres accepted.
 *
 * Drizzle's typed helpers — `eq`, `gte`, `lte`, `between` — are unaffected and
 * are always preferable. This guard only covers raw fragments.
 */

const SCAN_ROOTS = ["src/lib/repositories", "src/lib/services"];

/** Identifiers whose values are `Date` in this codebase. */
const DATE_IDENTIFIERS = [
  "collectedAt",
  "insight.endTime",
  "filters.from",
  "filters.to",
  "params.from",
  "params.to",
] as const;

async function collect(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await collect(full)));
    else if (entry.name.endsWith(".ts")) files.push(full);
  }

  return files;
}

const files = (await Promise.all(SCAN_ROOTS.map(collect))).flat();

const sources = await Promise.all(
  files.map(async (file) => ({
    name: path.relative(process.cwd(), file).replaceAll("\\", "/"),
    text: await readFile(file, "utf8"),
  })),
);

describe("tsParam", () => {
  it("renders a Date as an ISO 8601 string", () => {
    expect(tsParam(new Date("2026-07-27T07:00:00.000Z"))).toBe("2026-07-27T07:00:00.000Z");
  });

  it("preserves millisecond precision, which the watermark depends on", () => {
    expect(tsParam(new Date("2026-07-27T07:00:00.921Z"))).toBe("2026-07-27T07:00:00.921Z");
  });

  it("passes null and undefined through as null", () => {
    expect(tsParam(null)).toBeNull();
    expect(tsParam(undefined)).toBeNull();
  });

  it("never returns a Date, whatever it is given", () => {
    for (const input of [new Date(), null, undefined]) {
      expect(tsParam(input)).not.toBeInstanceOf(Date);
    }
  });
});

describe("no raw sql fragment binds a Date directly", () => {
  it("found files to scan", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(DATE_IDENTIFIERS)("does not interpolate %s bare", (identifier) => {
    /*
     * Matches `${collectedAt}` but not `${collectedAt.toISOString()}` and not
     * `${tsParam(collectedAt)}` — the two forms that are safe.
     */
    const bare = new RegExp(String.raw`\$\{\s*${identifier.replace(".", "\\.")}\s*\}`, "g");

    const offenders = sources.filter((file) => bare.test(file.text)).map((file) => file.name);

    expect(
      offenders,
      `${identifier} is bound directly in ${offenders.join(", ")} — wrap it in tsParam()`,
    ).toEqual([]);
  });

  it("keeps a ::timestamptz cast beside every tsParam binding", () => {
    /*
     * `tsParam` returns text. Without the cast Postgres must infer the type of
     * a bare parameter, and in `$1 is null or col >= $1` it cannot — the query
     * fails with "could not determine data type of parameter".
     */
    const uncast: string[] = [];

    for (const file of sources) {
      const matches = file.text.matchAll(/\$\{\s*tsParam\([^)]*\)\s*\}(::timestamptz)?/g);
      for (const match of matches) {
        if (!match[1]) uncast.push(`${file.name}: ${match[0]}`);
      }
    }

    expect(uncast, `missing ::timestamptz on ${uncast.join("; ")}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The other direction: timestamps coming OUT of a raw fragment
// ---------------------------------------------------------------------------

describe("reading a timestamp back out of a raw sql fragment", () => {
  /*
   * `tsParam` above covers binding a Date *into* a fragment. This covers the
   * mirror image, which cost a production outage of its own.
   *
   * Drizzle converts a driver value to a `Date` using the column's type. A
   * hand-written expression has no column to consult, so postgres.js's raw
   * value passes straight through — `max(created_time)` arrives as the string
   * "2026-07-27 14:07:32+00".
   *
   * `sql<Date | null>` looks like the fix and is not: the generic is an
   * assertion, so TypeScript believes a Date is present and typechecks every
   * consumer against a lie. The streamer detail page then died with
   * `RangeError: Invalid time value`, because Intl.DateTimeFormat coerces its
   * argument with ToNumber and a date string becomes NaN. A null check does not
   * save you — the value is a non-empty string.
   */

  it("converts the string postgres.js actually returns", () => {
    const value = tsResult("2026-07-27 14:07:32+00");

    expect(value).toBeInstanceOf(Date);
    expect(value?.toISOString()).toBe("2026-07-27T14:07:32.000Z");
  });

  it("produces something a formatter accepts, which the raw string is not", () => {
    const format = (value: unknown) =>
      new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "UTC" }).format(
        value as Date,
      );

    // The bug, pinned: the untouched driver value throws.
    expect(() => format("2026-07-27 14:07:32+00")).toThrow(/Invalid time value/);

    expect(() => format(tsResult("2026-07-27 14:07:32+00"))).not.toThrow();
  });

  it("passes a real Date through unchanged", () => {
    const date = new Date("2026-07-27T14:07:32.000Z");

    expect(tsResult(date)).toBe(date);
  });

  it("maps absent values to null", () => {
    expect(tsResult(null)).toBeNull();
    expect(tsResult(undefined)).toBeNull();
  });

  it("maps an unparseable value to null rather than an Invalid Date", () => {
    /*
     * Both mean "no timestamp", but only one of them detonates three layers
     * away inside a formatter that has no idea where the value came from.
     */
    expect(tsResult("not a date")).toBeNull();
    expect(tsResult(new Date("nonsense"))).toBeNull();
  });

  it("REGRESSION: no repository selects a raw fragment as sql<Date>", () => {
    /*
     * The structural guard. That shape is never honest — there is no code path
     * in which Drizzle turns a raw expression into a Date — so it is banned
     * outright rather than reviewed case by case.
     */
    const offenders: string[] = [];

    for (const file of sourceFiles(join(process.cwd(), "src"))) {
      /*
       * Code lines only. `db/params.ts` documents this exact rule at length and
       * quotes the banned shape to explain it — matching prose would flag the
       * one file whose job is to prevent the bug.
       */
      const offending = readFileSync(file, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter(
          (line) => !line.startsWith("*") && !line.startsWith("//") && !line.startsWith("/*"),
        )
        .filter((line) => line.includes("sql<Date"));

      if (offending.length > 0) offenders.push(relative(process.cwd(), file).split(sep).join("/"));
    }

    expect(
      offenders,
      "sql<Date…> asserts a type the driver does not produce. Declare the " +
        "fragment as sql<string | null> and convert with tsResult().",
    ).toEqual([]);
  });
});
