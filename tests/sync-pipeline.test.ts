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

/**
 * What a completed sweep does beyond collecting content.
 *
 * Both of these were reachable only from an admin screen, which meant they ran
 * when *configuration* changed and never when *data* did. Neither failure is
 * visible: the screens look healthy and the symptom is silence.
 */
describe("a finished sweep tidies up after itself", () => {
  const syncAll = () => readFile(path.join(process.cwd(), "src/lib/services/sync-all.ts"), "utf8");

  it("files newly collected content under a game", async () => {
    /*
     * The bug: attribution was triggered by editing a game and by nothing else.
     * Every night's posts arrived with `game_id` null and stayed that way until
     * somebody happened to change a hashtag, at which point months of backlog
     * would be filed at once. The games screen showed healthy counts throughout,
     * and the only symptom was that the newest content — the content people
     * actually look at — was missing from the filter.
     */
    const source = await syncAll();

    expect(source).toContain("resolveContentGames");
    // `onlyMissing`, because the nightly question is "file tonight's content".
    // The admin screen deliberately omits it: a changed hashtag has to re-file
    // rows that already have an answer.
    expect(source).toMatch(/resolveContentGames\(\{\s*onlyMissing:\s*true\s*\}\)/);
  });

  it("drops connect credentials whose hold has lapsed", async () => {
    /*
     * A streamer who signs in and then closes the tab leaves an encrypted user
     * token behind. It was cleared only when somebody tried to use it — which
     * never happens for the person who abandoned the flow, and abandoning is
     * exactly why it went stale.
     */
    const source = await syncAll();

    expect(source).toContain("clearExpiredUserTokens");
  });

  it("never lets either failure fail the sweep", async () => {
    // Content collected but unlabelled beats a sync reported as failed because
    // a housekeeping pass did not run.
    const source = await syncAll();

    expect(source).toContain("sync.all.games_resolve_failed");
    expect(source).toContain("sync.all.connect_cleanup_failed");
  });
});
