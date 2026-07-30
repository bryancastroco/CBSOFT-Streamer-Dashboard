/**
 * What a comment or summary is attached to — a PURE module.
 *
 * Posts and videos differ in their Graph edges and their metadata, but not in
 * how comments are collected, hashed, deduplicated, summarised or displayed.
 * This type is what lets that entire pipeline be written once: everything from
 * the repository down takes a `ContentRef` rather than a post id.
 *
 * The alternative — a parallel `sync-video-comments.ts` — would mean two
 * copies of the hash gate and two places for the privacy rules to drift.
 */

export const CONTENT_TYPES = ["post", "video"] as const;

export type ContentType = (typeof CONTENT_TYPES)[number];

export type ContentRef = {
  type: ContentType;
  /** Internal uuid of the post or video row. */
  id: string;
};

export function isContentType(value: unknown): value is ContentType {
  return typeof value === "string" && (CONTENT_TYPES as readonly string[]).includes(value);
}

export const CONTENT_TYPE_LABELS: Record<ContentType, string> = {
  post: "Post",
  video: "Video",
};

/** Where a content item lives in the UI. */
export function contentHref(content: ContentRef): string {
  return content.type === "post" ? `/posts/${content.id}` : `/videos/${content.id}`;
}
