/**
 * The six tabs of a streamer's detail screen — a PURE module.
 *
 * Kept separate from the page so the tab list, its labels and the resolution of
 * a `?tab=` parameter can be unit tested, and so the page and any link builder
 * agree on what a valid tab is. An unrecognised value resolves to Overview
 * rather than rendering nothing.
 */

export const STREAMER_TABS = [
  "overview",
  "posts",
  "videos",
  "analysis",
  "sync",
  "settings",
] as const;

export type StreamerTab = (typeof STREAMER_TABS)[number];

export const STREAMER_TAB_LABELS: Record<StreamerTab, string> = {
  overview: "Overview",
  posts: "Posts",
  videos: "Videos",
  analysis: "Comment Analysis",
  sync: "Sync History",
  settings: "Settings",
};

/** Tabs a viewer may open. Settings is administration, not reporting. */
export const VIEWER_TABS: readonly StreamerTab[] = [
  "overview",
  "posts",
  "videos",
  "analysis",
  "sync",
];

export function isStreamerTab(value: unknown): value is StreamerTab {
  return typeof value === "string" && (STREAMER_TABS as readonly string[]).includes(value);
}

/**
 * Resolve the requested tab against what this role may see.
 *
 * A viewer who lands on `?tab=settings` — from a shared link, say — gets
 * Overview rather than an error. The tab holds no secrets either way; the
 * controls inside it re-check the role server-side.
 */
export function resolveStreamerTab(value: unknown, isAdmin: boolean): StreamerTab {
  if (!isStreamerTab(value)) return "overview";
  if (!isAdmin && !VIEWER_TABS.includes(value)) return "overview";
  return value;
}

export function tabsFor(isAdmin: boolean): readonly StreamerTab[] {
  return isAdmin ? STREAMER_TABS : VIEWER_TABS;
}
