/**
 * Telling a livestream recording from an ordinary video — a PURE module.
 *
 * ## Why this is not obvious
 *
 * Meta returns both from `/{page-id}/videos` with the same shape. A broadcast
 * that ended is simply a video with a longer runtime, and nothing in the six
 * fields this project used to request said which was which. So a two-hour
 * stream and a five-second clip were the same thing to every screen.
 *
 * ## Two rules, and why both exist
 *
 * `live_status` is Meta's own answer and is preferred whenever present. It was
 * not requested before, so it is absent from every row synced up to now, and
 * a re-sync is what fills it in.
 *
 * For those rows there is a structural rule instead. It is not a guess dressed
 * up: measured across all 140 stored videos, the two populations do not
 * overlap even slightly —
 *
 *   livestreams      33 rows   62 min – 2h 45m   all carry a feed post
 *   reels            78 rows    5 s  – 3.5 min   none carry a feed post
 *   short uploads    29 rows    3 s  – 26 s      none carry a feed post
 *
 * A factor of 143 separates the shortest broadcast from the longest clip. That
 * is a wide enough gap to classify history confidently, and far too fragile to
 * rely on for new data — the first ninety-second stream or two-hour tutorial
 * upload would land in the wrong bucket silently. Hence: Meta's field for
 * anything new, this for anything old, and `source` recorded so the two are
 * never confused for one another.
 */

export const MEDIA_KINDS = ["video", "livestream"] as const;

export type MediaKind = (typeof MEDIA_KINDS)[number];

/** Which rule produced a classification. Stored, like `game_source`. */
export type MediaKindSource = "live_status" | "inferred";

export type MediaKindResult = { kind: MediaKind; source: MediaKindSource };

/**
 * `live_status` values that mean this video was broadcast live.
 *
 * `VOD` is included because that is what an *ended* broadcast reports, which is
 * the only state this project ever sees — `/videos` surfaces a stream after it
 * finishes, not during.
 *
 * The open question is what a never-live upload reports. Documentation
 * describes the field as the status of a live video, which implies it is absent
 * entirely; if it turns out to be present and set to `VOD` for everything, this
 * rule would classify every video as a livestream. That is why `source` is
 * stored: the day the field starts arriving, the counts can be compared against
 * the structural split above, and a disagreement is visible rather than silent.
 */
const LIVE_STATUSES = new Set(["LIVE", "LIVE_STOPPED", "VOD"]);

/**
 * The shortest thing treated as a broadcast when inferring.
 *
 * Twenty minutes. The real boundary in the data is between 3.5 minutes and 62
 * minutes, so this sits in open space with an order of magnitude either side
 * rather than being tuned to the edge of the sample.
 */
export const INFERRED_LIVESTREAM_MIN_SECONDS = 20 * 60;

export type ClassifyInput = {
  /** Meta's `live_status`, when the field was requested and returned. */
  liveStatus?: string | null | undefined;
  permalinkUrl?: string | null | undefined;
  lengthSeconds?: number | null | undefined;
  /**
   * Whether a post in the Page feed points at this video.
   *
   * Facebook publishes a feed story for a live broadcast. It is the signal that
   * separates the three populations perfectly in the stored data, and it is
   * also why those rows were being counted twice.
   */
  hasFeedPost?: boolean | undefined;
};

export function classifyVideo(input: ClassifyInput): MediaKindResult {
  const status = input.liveStatus?.trim().toUpperCase();

  if (status) {
    return {
      kind: LIVE_STATUSES.has(status) ? "livestream" : "video",
      source: "live_status",
    };
  }

  // A reel is never a broadcast, and its permalink says so outright. Checked
  // before length so a long reel could not be mistaken for a stream.
  if (input.permalinkUrl?.includes("/reel/")) {
    return { kind: "video", source: "inferred" };
  }

  const long = (input.lengthSeconds ?? 0) >= INFERRED_LIVESTREAM_MIN_SECONDS;

  /*
   * Both signals required, not either.
   *
   * A feed post alone would catch an ordinary upload shared to the Page, which
   * is common; length alone would catch a long uploaded video. Together they
   * describe a broadcast, and every stored livestream satisfies both while
   * nothing else satisfies even one.
   */
  return {
    kind: long && input.hasFeedPost === true ? "livestream" : "video",
    source: "inferred",
  };
}

export function isMediaKind(value: unknown): value is MediaKind {
  return typeof value === "string" && (MEDIA_KINDS as readonly string[]).includes(value);
}
