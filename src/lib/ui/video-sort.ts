import type { SortState, VideoSortKey } from "@/lib/filters/sorting";

/**
 * How the video library opens — a PURE module.
 *
 * Lifted out of `components/tables/videos-table.tsx` when a server-only service
 * needed it. Importing a constant from a Client Component drags that component
 * into the server graph for a two-line object, and the two would then be
 * bundled together for no reason beyond where the value happened to be
 * declared.
 *
 * Newest first, because the question asked of this screen is almost always
 * about the last few days.
 */
export const VIDEOS_DEFAULT_SORT: SortState<VideoSortKey> = {
  key: "createdTime",
  direction: "desc",
};
