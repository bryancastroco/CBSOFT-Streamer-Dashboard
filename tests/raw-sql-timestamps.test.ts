import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { tsParam } from "@/lib/db/params";

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
