import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Every refusal on the connect path leaves a record.
 *
 * Six invitations sat at `opened` with `last_error` empty, which reads as
 * "never got past Facebook". Two of them had got past Facebook and then run out
 * of the fifteen-minute hold — the single most likely way this flow fails, and
 * the one path that returned its refusal bare instead of recording it.
 *
 * An admin cannot tell those apart from the outside, and the streamer is not
 * going to file a report. The row is the only witness.
 */

const SOURCE = path.join(process.cwd(), "src", "lib", "services", "connect-page.ts");

/** Source with comments stripped — the prose names the paths being discussed. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("a refused connection is written down", () => {
  it("records an expired hold rather than returning it bare", async () => {
    const source = code(await readFile(SOURCE, "utf8"));

    /*
     * The regression, exactly as it was: `if (!held.ok) return held;`. It reads
     * as correct — the caller does get the message — and it is the reason the
     * table could not distinguish "expired" from "never arrived".
     */
    expect(source).not.toMatch(/if\s*\(\s*!held\.ok\s*\)\s*return\s+held\s*;/);

    // Both readers of the held token: listing the Pages, and spending it.
    const guards = source.match(/if\s*\(\s*!held\.ok\s*\)\s*\{[\s\S]{0,200}?\}/g) ?? [];
    expect(guards).toHaveLength(2);

    for (const guard of guards) {
      expect(guard).toContain("recordError");
    }
  });

  it("records a Page that the account does not manage", async () => {
    const source = code(await readFile(SOURCE, "utf8"));

    const guard = source.match(/if\s*\(\s*!chosen\s*\)\s*\{[\s\S]{0,300}?\n  \}/)?.[0];

    expect(guard).toBeDefined();
    expect(guard).toContain("recordError");
  });

  it("still records the failures that already were recorded", async () => {
    const source = code(await readFile(SOURCE, "utf8"));

    // A count, so that adding a fifth refusal path without a record shows up
    // here rather than in production three weeks later.
    const calls = source.match(/await recordError\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(6);
  });
});
