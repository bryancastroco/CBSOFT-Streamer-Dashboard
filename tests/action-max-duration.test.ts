import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * A page hosting a long-running Server Action must declare `maxDuration`.
 *
 * Server Actions execute inside the function of the page that invokes them, so
 * the page's segment configuration is what governs them — not the action file's,
 * and not the `/api` route that happens to do the same work.
 *
 * Every sync route under `/api` already declared 300 seconds. The pages
 * declared nothing and inherited the platform default, which is shorter than a
 * real sync: recorded runs take between 7 and 25 seconds, and the roster only
 * grows from here.
 *
 * The failure was silent in the worst way. Nothing errored — the function was
 * simply killed mid-flight, so the action never returned, the button spun
 * forever, and the sync run it had already opened sat in `processing` with no
 * completion time. An abandoned run of that kind also holds the single-sweep
 * lock, so the next scheduled sweep is refused too.
 *
 * The rule checked here: if a page imports an actions module whose actions call
 * a synchronisation service, the page must set `maxDuration`.
 */

const SKIP = new Set(["node_modules", ".git", ".next", ".vercel", "dist", "coverage"]);

/** Services whose work routinely outlasts a default function timeout. */
const LONG_RUNNING = [
  "syncStreamerPosts",
  "syncStreamerVideos",
  "syncContentComments",
  "regenerateSummary",
  "runSyncAll",
];

function walk(directory: string, collected: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    if (SKIP.has(entry)) continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) walk(path, collected);
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) collected.push(path);
  }
  return collected;
}

const appDirectory = join(process.cwd(), "src", "app");
const files = walk(appDirectory);

/** Action modules that reach a long-running service. */
const heavyActionModules = files.filter((path) => {
  if (!path.endsWith(`${sep}actions.ts`)) return false;
  const source = readFileSync(path, "utf8");
  return LONG_RUNNING.some((name) => source.includes(name));
});

/** Pages sitting in the same segment as one of those action modules. */
const pagesNeedingDuration = heavyActionModules
  .map((actionPath) => join(dirname(actionPath), "page.tsx"))
  .filter((pagePath) => files.includes(pagePath));

describe("pages hosting long Server Actions declare maxDuration", () => {
  it("finds the pages to check, so an empty sweep cannot pass vacuously", () => {
    expect(pagesNeedingDuration.length).toBeGreaterThan(0);
  });

  it.each(pagesNeedingDuration.map((p) => relative(process.cwd(), p).split(sep).join("/")))(
    "%s",
    (relativePath) => {
      const source = readFileSync(join(process.cwd(), relativePath), "utf8");

      expect(
        /export const maxDuration = \d+;/.test(source),
        `${relativePath} hosts a Server Action that calls a synchronisation service but does ` +
          `not set maxDuration. The function will be killed mid-sync, leaving the run stuck ` +
          `in processing and the UI spinning with no error.`,
      ).toBe(true);
    },
  );

  it("declares it as a literal, which is the only form Next can read", () => {
    /*
     * Segment configuration is resolved by static analysis; an imported binding
     * is rejected outright and fails the build. Phase 15 shipped that mistake.
     */
    for (const path of pagesNeedingDuration) {
      const source = readFileSync(path, "utf8");
      const match = source.match(/export const maxDuration = ([^;]+);/);

      if (match) expect(match[1]?.trim()).toMatch(/^\d+$/);
    }
  });
});
