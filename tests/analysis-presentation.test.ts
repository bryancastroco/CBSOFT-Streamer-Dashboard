import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The two panels that render a comment analysis look like the same product.
 *
 * ## Why this is worth asserting
 *
 * There are two: the per-post card (`admin/comment-analysis.tsx`) and the
 * roster-level overview (`dashboard/comment-overview.tsx`). They show the same
 * shape of thing — a summary, then lists of concerns, questions, suggestions —
 * and the second one drifted from the first twice in a single sitting:
 *
 *   1. sentiment rendered with Tailwind palette classes instead of the
 *      `--sentiment-*` tokens and the shared `StatusBadge`
 *   2. finding lists rendered with no list marker at all, because Tailwind's
 *      reset strips them and `list-disc` was never added back
 *
 * Neither broke anything. Both were spotted by a person looking at the screen
 * and asking why it looked wrong — the second one read as the model having
 * failed to separate its findings, which sent the question to entirely the
 * wrong place.
 *
 * These assertions are deliberately about shared vocabulary rather than exact
 * markup. A panel is free to lay itself out differently; it is not free to
 * invent a second visual language for the same data.
 */

const source = (file: string) => path.join(process.cwd(), "src", "components", file);

const PANELS = [
  ["per-post card", "admin/comment-analysis.tsx"],
  ["dashboard overview", "dashboard/comment-overview.tsx"],
] as const;

describe("both analysis panels", () => {
  it.each(PANELS)("%s marks its finding lists", async (_label, file) => {
    const text = await readFile(source(file), "utf8");

    // Tailwind's reset removes list markers, so a bare <ul> renders as
    // unmarked lines — prose that wrapped oddly, rather than distinct findings.
    expect(text).toContain("list-disc");
  });

  it.each(PANELS)("%s uses the shared status vocabulary, not a private one", async (_l, file) => {
    const text = await readFile(source(file), "utf8");

    // Either the badge component or the design tokens. What is banned is a
    // hand-picked hue that only this file knows about.
    const usesSystem = /StatusBadge|SentimentBadge|--sentiment-|describeStatus/.test(text);
    expect(usesSystem).toBe(true);
  });

  it.each(PANELS)("%s does not hand-roll a palette colour", async (_label, file) => {
    const text = await readFile(source(file), "utf8");

    /*
     * `text-emerald-600 dark:text-emerald-500` and friends. The design system
     * has `success`/`warning`/`danger` and `--sentiment-*` for exactly this,
     * and a second green on the same screen is how one panel starts looking
     * like a different application.
     */
    const palette = text.match(
      /\b(?:text|bg|border)-(?:emerald|amber|rose|sky|lime|teal|fuchsia|violet)-\d{2,3}\b/g,
    );

    expect(palette ?? []).toEqual([]);
  });
});
