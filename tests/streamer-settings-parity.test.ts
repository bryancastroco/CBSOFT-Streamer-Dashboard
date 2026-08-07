import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The two places a streamer is administered offer the same things.
 *
 * `/admin/streamers/[id]` and the Settings tab of `/streamers/[id]` are both
 * admin-only, and the tab already reuses the admin components — the token
 * panels, the sync buttons, the removal card. It carried every control except
 * one: assigning the streamer's games.
 *
 * Nobody hunts for a second settings page while already looking at one called
 * Settings. They conclude the feature does not exist, which is exactly what
 * happened, and the cost was not cosmetic: untagged content inherits the
 * streamer's primary game, so with none set the game filter cannot reach it.
 * The archive sat almost entirely unattributed behind a control nobody could
 * find.
 *
 * This asserts the relationship rather than the contents. A card that belongs
 * on the streamer admin surface belongs on both, and the removal card — which
 * is already single-sourced — is the marker for "this is that surface".
 */

const SETTINGS_TAB = path.join(
  process.cwd(),
  "src",
  "app",
  "(app)",
  "streamers",
  "[id]",
  "page.tsx",
);

const ADMIN_PAGE = path.join(
  process.cwd(),
  "src",
  "app",
  "(app)",
  "admin",
  "streamers",
  "[id]",
  "page.tsx",
);

/** Cards that make a page a streamer admin surface. */
const SHARED_CARDS = ["StreamerGamesCard", "StreamerRemovalCard"] as const;

describe("both admin surfaces carry the same cards", () => {
  it("renders every shared card on the admin page", async () => {
    const source = await readFile(ADMIN_PAGE, "utf8");

    for (const card of SHARED_CARDS) {
      expect(source).toContain(`<${card}`);
    }
  });

  it("renders every shared card on the Settings tab", async () => {
    const source = await readFile(SETTINGS_TAB, "utf8");

    for (const card of SHARED_CARDS) {
      // The regression: `StreamerGamesCard` existed, was rendered by the admin
      // page, and was simply absent here — with nothing to notice it.
      expect(source).toContain(`<${card}`);
    }
  });

  it("loads the data those cards need on the Settings tab", async () => {
    const source = await readFile(SETTINGS_TAB, "utf8");

    // A rendered card with no data behind it is a different failure with the
    // same appearance — an empty control that looks broken rather than absent.
    expect(source).toContain("listGameOptions");
    expect(source).toContain("listStreamerGames");
  });

  it("imports the cards rather than rebuilding them", async () => {
    const source = await readFile(SETTINGS_TAB, "utf8");

    /*
     * The point of the whole file. Two copies of a card drift, and the copy
     * that drifts is the one somebody is reading when they make a decision.
     * See `tests/removal-ui-single-source.test.ts`, which is the same lesson
     * learned the expensive way.
     */
    for (const card of SHARED_CARDS) {
      expect(source).toMatch(
        new RegExp(`import\\s*\\{\\s*${card}\\s*\\}\\s*from "@/app/\\(app\\)/admin/streamers`),
      );
    }
  });
});
