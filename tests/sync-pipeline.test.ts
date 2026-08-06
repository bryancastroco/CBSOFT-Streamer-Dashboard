import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The dashboard's Sync all button.
 *
 * ## What it replaced
 *
 * A `<Link>` labelled "Sync all" that navigated to the roster and synced
 * nothing. That is worse than having no button: somebody clicking it and
 * landing on a list of streamers would reasonably conclude a sweep had started,
 * and would only discover otherwise by noticing the data never changed.
 *
 * These read the source rather than invoking the action, which needs a live
 * database and the Graph API. What is worth protecting is structural — that the
 * button submits real work, and that the page is configured to survive it.
 */
describe("the dashboard can sweep every streamer", () => {
  const dashboard = (file: string) =>
    readFile(path.join(process.cwd(), "src/app/(app)/dashboard", file), "utf8");

  it("runs the sweep instead of navigating to the roster", async () => {
    const source = await dashboard("page.tsx");

    expect(source).toContain("SyncAllButton");
    // The regression: a link wearing the label of an action.
    expect(source).not.toMatch(/<Link href="\/admin\/streamers">Sync all<\/Link>/);
  });

  it("uses the same sweep as the cron, recorded as an admin action", async () => {
    const source = await dashboard("actions.ts");

    // Not a private reimplementation — one sweep, so a manual run and a
    // scheduled one cannot drift in what they collect.
    expect(source).toContain("openSyncAllRun");
    expect(source).toContain("runSyncAll");
    expect(source).toMatch(/openSyncAllRun\("admin"\)/);
  });

  it("refuses rather than stacking a second concurrent sweep", async () => {
    const source = await dashboard("actions.ts");

    expect(source).toContain("SweepAlreadyRunningError");
  });

  it("gives the page a duration budget the sweep can finish inside", async () => {
    /*
     * Load-bearing. A Server Action runs in its page's function, so without
     * this the sweep inherits the platform default and is killed mid-flight:
     * the button spins forever and the run it opened holds the single-sweep
     * lock for twenty minutes, refusing the nightly cron in the meantime.
     *
     * Asserted as a literal because Next resolves segment config by static
     * analysis — an imported constant would typecheck and not apply.
     */
    const source = await dashboard("page.tsx");

    expect(source).toMatch(/export const maxDuration = 300;/);
  });

  it("says when a sweep finished only part of the roster", async () => {
    // `runSyncAll` processes what fits its time budget. Reporting a partial
    // result as a complete one is how a roster silently stops being synced.
    const source = await dashboard("actions.ts");

    expect(source).toContain("result.finished");
    expect(source).toContain("result.remaining");
  });
});
