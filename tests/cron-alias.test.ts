import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * The two cron paths must stay one behaviour.
 *
 * `/api/cron/facebook-sync` is an alias of `/api/cron/daily-sync`: the handler
 * is re-exported, so it cannot drift. Segment configuration cannot be
 * re-exported — Next resolves it by static analysis and rejects an imported
 * binding — so `maxDuration` is duplicated as a literal in both files, and a
 * duplicated constant is exactly the kind that goes stale silently.
 *
 * This reads the source rather than importing it, because importing gives the
 * evaluated value and would pass even if the literal were unanalysable. The
 * build failure being guarded against was a *static analysis* failure.
 */

function segmentConfig(path: string) {
  const source = readFileSync(path, "utf8");
  const found: Record<string, string> = {};

  for (const match of source.matchAll(/^export const (runtime|dynamic|maxDuration) = ([^;]+);/gm)) {
    const key = match[1];
    const value = match[2];
    if (key && value) found[key] = value.trim();
  }

  return found;
}

const daily = segmentConfig("src/app/api/cron/daily-sync/route.ts");
const alias = segmentConfig("src/app/api/cron/facebook-sync/route.ts");

describe("the two cron routes agree", () => {
  it.each(["runtime", "dynamic", "maxDuration"])("%s matches", (key) => {
    expect(alias[key], `${key} missing from one of the routes`).toBeDefined();
    expect(alias[key]).toBe(daily[key]);
  });
});

describe("segment configuration is statically analysable", () => {
  /*
   * A literal, not an identifier. This is the assertion that would have caught
   * the Vercel build failure: the value must be something the build can read
   * without running the module.
   */
  it.each([
    ["daily-sync", daily],
    ["facebook-sync", alias],
  ])("%s exports literals only", (_name, config) => {
    expect(config.maxDuration).toMatch(/^\d+$/);
    expect(config.runtime).toMatch(/^"[a-z]+"$/);
    expect(config.dynamic).toMatch(/^"[a-z-]+"$/);
  });
});
