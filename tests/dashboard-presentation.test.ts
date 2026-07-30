import { describe, expect, it } from "vitest";

import {
  resolveStreamerTab,
  STREAMER_TABS,
  STREAMER_TAB_LABELS,
  VIEWER_TABS,
  isStreamerTab,
  tabsFor,
} from "@/app/(app)/streamers/[id]/tabs";
import { NO_SIGNIFICANT_FINDINGS, NO_READABLE_COMMENTS } from "@/lib/ai/contract";
import {
  NOT_ANALYSED,
  hasRealFindings,
  realFindings,
  sentimentLabel,
  sentimentTone,
  summariseFindings,
  summaryStatusLabel,
  summaryStatusTone,
  toFindingList,
} from "@/lib/ai/presentation";

describe("streamer tabs", () => {
  it("declares the six tabs the specification names, in order", () => {
    expect([...STREAMER_TABS]).toEqual([
      "overview",
      "posts",
      "videos",
      "analysis",
      "sync",
      "settings",
    ]);
  });

  it("labels every tab", () => {
    for (const tab of STREAMER_TABS) {
      expect(STREAMER_TAB_LABELS[tab]).toBeTruthy();
    }
  });

  it("recognises valid tabs and rejects anything else", () => {
    expect(isStreamerTab("overview")).toBe(true);
    expect(isStreamerTab("tokens")).toBe(false);
    expect(isStreamerTab(null)).toBe(false);
  });

  it("withholds Settings from a viewer", () => {
    // Settings is administration, not reporting. Phase 2 gives viewers no
    // management capability, and the tab list reflects that.
    expect(VIEWER_TABS).not.toContain("settings");
    expect(tabsFor(false)).not.toContain("settings");
    expect(tabsFor(true)).toContain("settings");
  });

  it("sends a viewer who asks for Settings to Overview rather than erroring", () => {
    expect(resolveStreamerTab("settings", false)).toBe("overview");
    expect(resolveStreamerTab("settings", true)).toBe("settings");
  });

  it("falls back to Overview for an unrecognised tab", () => {
    expect(resolveStreamerTab("nonsense", true)).toBe("overview");
    expect(resolveStreamerTab(undefined, true)).toBe("overview");
  });
});

describe("sentiment presentation", () => {
  it("labels every sentiment the contract allows", () => {
    expect(sentimentLabel("positive")).toBe("Positive");
    expect(sentimentLabel("mixed")).toBe("Mixed");
    expect(sentimentLabel("negative")).toBe("Negative");
    expect(sentimentLabel("neutral")).toBe("Neutral");
    expect(sentimentLabel("no_comments")).toBe("No comments");
  });

  it("distinguishes never-analysed from analysed-and-neutral", () => {
    // An empty cell would read as a rendering bug, and "Neutral" would be a
    // claim about content nobody has looked at.
    expect(sentimentLabel(null)).toBe(NOT_ANALYSED);
    expect(sentimentLabel(undefined)).toBe(NOT_ANALYSED);
    expect(sentimentLabel("neutral")).not.toBe(NOT_ANALYSED);
  });

  it("passes through an unknown value rather than hiding it", () => {
    expect(sentimentLabel("euphoric")).toBe("euphoric");
  });

  it("uses the destructive tone only for negative", () => {
    expect(sentimentTone("negative")).toBe("destructive");
    expect(sentimentTone("positive")).not.toBe("destructive");
    expect(sentimentTone(null)).not.toBe("destructive");
  });
});

describe("summary status presentation", () => {
  it("labels every status", () => {
    expect(summaryStatusLabel("pending")).toBe("Pending");
    expect(summaryStatusLabel("processing")).toBe("Analysing…");
    expect(summaryStatusLabel("completed")).toBe("Completed");
    expect(summaryStatusLabel("no_comments")).toBe("No comments");
    expect(summaryStatusLabel("failed")).toBe("Failed");
  });

  it("reports a missing summary as not analysed", () => {
    expect(summaryStatusLabel(null)).toBe(NOT_ANALYSED);
  });

  it("flags a failure visually", () => {
    expect(summaryStatusTone("failed")).toBe("destructive");
    expect(summaryStatusTone("completed")).not.toBe("destructive");
  });
});

describe("finding lists", () => {
  it("tolerates any stored JSON shape", () => {
    // The column is jsonb, so it can hold anything a past version wrote.
    expect(toFindingList(["a", "b"])).toEqual(["a", "b"]);
    expect(toFindingList(null)).toEqual([]);
    expect(toFindingList("a string")).toEqual([]);
    expect(toFindingList({ items: ["a"] })).toEqual([]);
    expect(toFindingList([1, 2, null, "a", ""])).toEqual(["a"]);
  });

  it("treats the placeholder as absence, not as a finding", () => {
    // The model writes this into an otherwise empty list. Counting length would
    // mark every analysed item as having concerns.
    expect(hasRealFindings([NO_SIGNIFICANT_FINDINGS])).toBe(false);
    expect(realFindings([NO_SIGNIFICANT_FINDINGS])).toEqual([]);

    expect(hasRealFindings(["Audio dropped"])).toBe(true);
    expect(realFindings([NO_SIGNIFICANT_FINDINGS, "Audio dropped"])).toEqual(["Audio dropped"]);
  });

  it("ignores whitespace-only entries", () => {
    expect(hasRealFindings(["   "])).toBe(false);
    expect(hasRealFindings([`  ${NO_SIGNIFICANT_FINDINGS}  `])).toBe(false);
  });

  it("does not mistake the no-readable-comments placeholder for a finding list", () => {
    // That placeholder belongs in `summary`, not in a findings array, and it is
    // real text if it ever appears in one.
    expect(realFindings([NO_READABLE_COMMENTS])).toEqual([NO_READABLE_COMMENTS]);
  });

  it("summarises a long list without dropping the count", () => {
    expect(summariseFindings([])).toBe(NO_SIGNIFICANT_FINDINGS);
    expect(summariseFindings(["a"])).toBe("a");
    expect(summariseFindings(["a", "b"])).toBe("a · b");
    expect(summariseFindings(["a", "b", "c", "d"])).toBe("a · b (+2 more)");
  });
});
