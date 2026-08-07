import { describe, expect, it } from "vitest";

import {
  INFERRED_LIVESTREAM_MIN_SECONDS,
  classifyVideo,
  isMediaKind,
} from "@/lib/meta/media-kind";

/**
 * Which videos are recordings of a livestream.
 *
 * The numbers in these tests are the real ones. Across the 140 stored videos:
 * livestreams run 62 minutes to 2h45m and every one carries a feed post; reels
 * run 5 seconds to 3.5 minutes; short uploads run 3 to 26 seconds; neither of
 * the latter two carries a feed post.
 */

const LIVESTREAM = {
  permalinkUrl: "https://www.facebook.com/1359824723022116/videos/1022115970449398",
  lengthSeconds: 7851,
  hasFeedPost: true,
};

const REEL = {
  permalinkUrl: "https://www.facebook.com/reel/1234567890",
  lengthSeconds: 40,
  hasFeedPost: false,
};

const SHORT_UPLOAD = {
  permalinkUrl: "https://www.facebook.com/1359824723022116/videos/999",
  lengthSeconds: 13,
  hasFeedPost: false,
};

describe("Meta's own answer wins", () => {
  it("treats an ended broadcast as a livestream", () => {
    // `VOD` is the state this project actually sees: /videos surfaces a stream
    // after it finishes, never during.
    for (const liveStatus of ["VOD", "LIVE", "LIVE_STOPPED", "vod", " live_stopped "]) {
      expect(classifyVideo({ ...SHORT_UPLOAD, liveStatus })).toEqual({
        kind: "livestream",
        source: "live_status",
      });
    }
  });

  it("treats any other status as an ordinary video", () => {
    expect(classifyVideo({ ...LIVESTREAM, liveStatus: "UNPUBLISHED" })).toEqual({
      kind: "video",
      source: "live_status",
    });
  });

  it("overrides the structural rule in both directions", () => {
    // The whole point of requesting the field. A ninety-second broadcast and a
    // two-hour upload are exactly what the inference gets wrong, and exactly
    // what Meta answers correctly.
    const shortBroadcast = classifyVideo({
      permalinkUrl: "https://www.facebook.com/1/videos/2",
      lengthSeconds: 90,
      hasFeedPost: true,
      liveStatus: "VOD",
    });
    expect(shortBroadcast.kind).toBe("livestream");

    const longUpload = classifyVideo({
      permalinkUrl: "https://www.facebook.com/1/videos/3",
      lengthSeconds: 9000,
      hasFeedPost: true,
      liveStatus: "",
    });
    // Empty string is not an answer, so it falls through to inference.
    expect(longUpload.source).toBe("inferred");
  });
});

describe("classifying rows synced before the field was requested", () => {
  it("recognises a livestream by length and its feed post together", () => {
    expect(classifyVideo(LIVESTREAM)).toEqual({ kind: "livestream", source: "inferred" });
  });

  it("keeps reels as videos, however long", () => {
    expect(classifyVideo(REEL).kind).toBe("video");

    // Checked before length, so a reel that somehow ran an hour stays a video.
    expect(
      classifyVideo({ ...REEL, lengthSeconds: 9000, hasFeedPost: true }).kind,
    ).toBe("video");
  });

  it("keeps a short upload as a video", () => {
    expect(classifyVideo(SHORT_UPLOAD).kind).toBe("video");
  });

  it("requires both signals, not either", () => {
    // A long video nobody posted to the feed.
    expect(classifyVideo({ ...LIVESTREAM, hasFeedPost: false }).kind).toBe("video");

    // An ordinary upload shared to the Page — common, and the reason a feed
    // post on its own cannot mean "broadcast".
    expect(classifyVideo({ ...SHORT_UPLOAD, hasFeedPost: true }).kind).toBe("video");
  });

  it("sits the threshold in open space rather than at the edge of the sample", () => {
    // Shortest real broadcast 3,719s; longest real clip 210s. The threshold is
    // an order of magnitude clear of both.
    expect(INFERRED_LIVESTREAM_MIN_SECONDS).toBeLessThan(3719);
    expect(INFERRED_LIVESTREAM_MIN_SECONDS).toBeGreaterThan(210);
  });

  it("does not fall over on missing fields", () => {
    expect(classifyVideo({}).kind).toBe("video");
    expect(classifyVideo({ lengthSeconds: null, permalinkUrl: null }).kind).toBe("video");
  });
});

describe("the stored value", () => {
  it("accepts only the two kinds", () => {
    expect(isMediaKind("video")).toBe(true);
    expect(isMediaKind("livestream")).toBe(true);
    expect(isMediaKind("reel")).toBe(false);
    expect(isMediaKind("post")).toBe(false);
    expect(isMediaKind(null)).toBe(false);
  });

  it("always reports which rule decided", () => {
    expect(classifyVideo({ liveStatus: "VOD" }).source).toBe("live_status");
    expect(classifyVideo(LIVESTREAM).source).toBe("inferred");
  });
});
