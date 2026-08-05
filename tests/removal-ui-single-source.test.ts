import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * There is exactly one place that offers to remove a streamer.
 *
 * ## The bug this exists to prevent, which already happened
 *
 * The removal controls were markup on a page — twice. `/admin/streamers/[id]`
 * and the Settings tab of `/streamers/[id]` each carried their own card
 * labelled "Danger zone", built from the same two panels.
 *
 * Adding a third, irreversible option to one of them left the other showing
 * two, under a description that no longer matched what its buttons did. Nothing
 * failed. No test broke. The screens simply disagreed, and the only way to find
 * out was for somebody to open the one that had not been updated and ask what
 * the difference was.
 *
 * Duplicated UI over a destructive action is worse than duplicated UI anywhere
 * else, because the copy that drifts is the one telling a person what they are
 * about to lose. So this asserts the structural property rather than the
 * wording: the panels are reachable from exactly one component, and any page
 * wanting them renders that.
 */

const APP_DIR = path.join(process.cwd(), "src", "app");
const REMOVAL_CARD = path.join(
  "src",
  "app",
  "(app)",
  "admin",
  "streamers",
  "[id]",
  "removal-card.tsx",
);

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });

  const files = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return entry.name.endsWith(".tsx") ? [full] : [];
    }),
  );

  return files.flat();
}

const files = await walk(APP_DIR);

/** Files whose JSX renders `<Symbol`, repo-relative and slash-normalised. */
async function filesRendering(symbol: string): Promise<string[]> {
  const matches: string[] = [];

  for (const file of files) {
    const source = await readFile(file, "utf8");
    if (source.includes(`<${symbol}`)) {
      matches.push(path.relative(process.cwd(), file));
    }
  }

  return matches.sort();
}

describe("the destructive panels have one owner", () => {
  it.each(["PurgePanel", "DeletePanel", "ActiveTogglePanel"])(
    "%s is rendered only by the shared removal card",
    async (symbol) => {
      /*
       * The exact pairing that drifted: a page rendering `DeletePanel` without
       * `PurgePanel` is a page offering "remove" and silently hiding "delete".
       * Requiring all three to travel together is what makes that impossible
       * rather than merely unlikely.
       */
      expect(await filesRendering(symbol)).toEqual([REMOVAL_CARD]);
    },
  );

  it("no page still calls its removal section a Danger zone", async () => {
    /*
     * The old heading sat above a button labelled "Delete streamer" that
     * deleted nothing. Both are gone; this keeps them gone, because the wording
     * is the entire safeguard on an action with no undo.
     */
    const offenders: string[] = [];

    for (const file of files) {
      const source = await readFile(file, "utf8");
      // Comments explaining the history are fine; a rendered heading is not.
      if (/<CardTitle[^>]*>\s*Danger zone/.test(source)) {
        offenders.push(path.relative(process.cwd(), file));
      }
    }

    expect(offenders).toEqual([]);
  });

  it("both streamer detail screens offer removal", async () => {
    // The reverse of the drift: extracting the card must not have dropped it
    // from the screen an operator actually reaches from the roster.
    const rendering = (await filesRendering("StreamerRemovalCard")).map((file) =>
      file.replaceAll("\\", "/"),
    );

    expect(rendering).toEqual([
      "src/app/(app)/admin/streamers/[id]/page.tsx",
      "src/app/(app)/streamers/[id]/page.tsx",
    ]);
  });
});

describe("the confirmation wording", () => {
  it("never labels a reversible removal as a deletion", async () => {
    /*
     * "Delete streamer" was the label on something that kept every post,
     * comment and analysis. A person reading it had no way to know that.
     */
    const panels = await readFile(
      path.join(process.cwd(), "src", "app", "(app)", "admin", "streamers", "[id]", "panels.tsx"),
      "utf8",
    );

    expect(panels).toContain("Remove from roster");
    expect(panels).toContain("Permanently delete everything");
    expect(panels).not.toContain("Delete streamer");
  });
});
