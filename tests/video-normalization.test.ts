import { describe, expect, it } from "vitest";

import { CONTENT_TYPES, contentHref, isContentType } from "@/lib/comments/content-ref";
import { formatInsightValue } from "@/lib/meta/insight-display";
import { normalizeInsights } from "@/lib/meta/posts";
import { VIDEO_FIELDS, formatDuration, normalizeVideo, absolutePermalink } from "@/lib/meta/videos";

const BASE = {
  id: "102938475610293_9001",
  created_time: "2026-07-21T18:00:00+0000",
  permalink_url: "https://facebook.com/watch/?v=9001",
};

describe("video field selection", () => {
  it("requests exactly the six specified fields", () => {
    expect(VIDEO_FIELDS).toBe("id,title,description,created_time,permalink_url,length");
  });

  it("reads the general videos edge, not live_videos", () => {
    // /live_videos can require separate Meta App Review; ended broadcasts show
    // up on /videos as VODs, so the general edge keeps the integration inside
    // the permissions the Page token already carries.
    expect(VIDEO_FIELDS).not.toContain("live");
  });
});

describe("video normalization", () => {
  it("reads a complete video", () => {
    const video = normalizeVideo({
      ...BASE,
      title: "Friday night ranked",
      description: "Climbing to diamond",
      length: 7325.5,
    });

    expect(video).not.toBeNull();
    expect(video?.facebookVideoId).toBe(BASE.id);
    expect(video?.title).toBe("Friday night ranked");
    expect(video?.lengthSeconds).toBe(7325.5);
  });

  it("keeps fractional length rather than rounding at ingestion", () => {
    // Meta reports fractional seconds; rounding would discard precision the
    // source actually provided.
    expect(normalizeVideo({ ...BASE, length: 61.75 })?.lengthSeconds).toBe(61.75);
  });

  it("returns null length when Meta did not report one", () => {
    expect(normalizeVideo(BASE)?.lengthSeconds).toBeNull();
  });

  it("preserves a genuine zero length", () => {
    expect(normalizeVideo({ ...BASE, length: 0 })?.lengthSeconds).toBe(0);
  });

  it("rejects a non-finite or negative length as not a measurement", () => {
    expect(normalizeVideo({ ...BASE, length: Number.NaN })?.lengthSeconds).toBeNull();
    expect(normalizeVideo({ ...BASE, length: Number.POSITIVE_INFINITY })?.lengthSeconds).toBeNull();
    expect(normalizeVideo({ ...BASE, length: -5 })?.lengthSeconds).toBeNull();
  });

  it("treats empty title and description as absent", () => {
    const video = normalizeVideo({ ...BASE, title: "", description: "" });

    expect(video?.title).toBeNull();
    expect(video?.description).toBeNull();
  });

  it("rejects a video with no id or an unparseable created_time", () => {
    expect(normalizeVideo({ created_time: BASE.created_time })).toBeNull();
    expect(normalizeVideo({ id: BASE.id })).toBeNull();
    expect(normalizeVideo({ id: BASE.id, created_time: "nonsense" })).toBeNull();
  });

  it("keeps the raw payload for later re-derivation", () => {
    const raw = { ...BASE, unexpected_future_field: 1 } as never;
    expect(normalizeVideo(raw)?.raw).toBe(raw);
  });
});

describe("duration formatting", () => {
  it("renders hours, minutes and seconds", () => {
    expect(formatDuration(7325)).toBe("2h 2m 05s");
    expect(formatDuration(125)).toBe("2m 05s");
    expect(formatDuration(9)).toBe("9s");
  });

  it("truncates fractional seconds for display without touching stored precision", () => {
    expect(formatDuration(61.75)).toBe("1m 01s");
  });

  it("returns null when no length was reported, so the UI can say so", () => {
    expect(formatDuration(null)).toBeNull();
    expect(formatDuration(undefined)).toBeNull();
    expect(formatDuration(Number.NaN)).toBeNull();
  });

  it("renders a genuine zero as 0s rather than as unavailable", () => {
    expect(formatDuration(0)).toBe("0s");
  });
});

describe("video insight values of every JSON shape", () => {
  // The specification calls out that video metric values may be numbers,
  // strings, arrays, objects, or nested JSON. All of them must survive
  // normalisation into a jsonb column intact.
  it("preserves a scalar number", () => {
    const rows = normalizeInsights([
      { name: "total_video_views", period: "lifetime", values: [{ value: 12345 }] },
    ]);

    expect(rows[0]?.value).toBe(12345);
  });

  it("preserves a string value", () => {
    const rows = normalizeInsights([
      { name: "video_status", period: "lifetime", values: [{ value: "published" }] },
    ]);

    expect(rows[0]?.value).toBe("published");
  });

  it("preserves an array value", () => {
    const series = [1, 2, 3, 5, 8];
    const rows = normalizeInsights([
      { name: "video_retention_curve", period: "lifetime", values: [{ value: series }] },
    ]);

    expect(rows[0]?.value).toEqual(series);
  });

  it("preserves a flat breakdown object", () => {
    const breakdown = { like: 40, love: 12, wow: 3 };
    const rows = normalizeInsights([
      { name: "total_video_reactions_by_type_total", values: [{ value: breakdown }] },
    ]);

    expect(rows[0]?.value).toEqual(breakdown);
  });

  it("preserves deeply nested JSON without flattening it", () => {
    const nested = {
      audience: {
        age: { "18-24": { male: 120, female: 95 }, "25-34": { male: 300, female: 210 } },
        country: { PH: 480, US: 120 },
      },
      totals: [1, 2, 3],
    };

    const rows = normalizeInsights([
      { name: "video_view_demographics", period: "lifetime", values: [{ value: nested }] },
    ]);

    expect(rows[0]?.value).toEqual(nested);
    // Round-trips through JSON exactly as stored in jsonb.
    expect(JSON.parse(JSON.stringify(rows[0]?.value))).toEqual(nested);
  });

  it("still distinguishes an absent value from zero", () => {
    const rows = normalizeInsights([{ name: "video_avg_time_watched", values: [] }]);

    expect(rows[0]?.value).toBeNull();
    expect(rows[0]?.value).not.toBe(0);
  });

  it("accepts a video metric name it has never seen", () => {
    const rows = normalizeInsights([
      { name: "some_metric_meta_added_yesterday", values: [{ value: 1 }] },
    ]);

    expect(rows[0]?.metricName).toBe("some_metric_meta_added_yesterday");
  });

  it("renders every shape for display without throwing", () => {
    expect(formatInsightValue(12345)).toBe("12,345");
    expect(formatInsightValue("published")).toBe("published");
    expect(formatInsightValue([1, 2, 3])).toBe("3 entries");
    expect(formatInsightValue({ like: 40, love: 12 })).toBe("52 across 2 breakdowns");
    expect(formatInsightValue({ audience: { age: {} } })).toBe("1 breakdowns");
  });
});

describe("content refs", () => {
  it("declares exactly the two content types the schema supports", () => {
    expect([...CONTENT_TYPES]).toEqual(["post", "video"]);
  });

  it("recognises valid content types and rejects anything else", () => {
    expect(isContentType("post")).toBe(true);
    expect(isContentType("video")).toBe(true);

    expect(isContentType("reel")).toBe(false);
    expect(isContentType("")).toBe(false);
    expect(isContentType(null)).toBe(false);
  });

  it("routes each content type to its own screen", () => {
    expect(contentHref({ type: "post", id: "abc" })).toBe("/posts/abc");
    expect(contentHref({ type: "video", id: "abc" })).toBe("/videos/abc");
  });
});

describe("absolutePermalink", () => {
  it("roots a relative reel path on facebook.com", () => {
    /*
     * `/{page}/videos` returns a relative `permalink_url` while
     * `/{page}/published_posts` returns an absolute one. Storing the relative
     * form verbatim failed the export contract with `Invalid URL` and took the
     * whole videos dataset down with it, once real reels arrived.
     */
    expect(absolutePermalink("/reel/1379961884346781/")).toBe(
      "https://www.facebook.com/reel/1379961884346781/",
    );
  });

  it("leaves an already absolute URL untouched", () => {
    const url = "https://www.facebook.com/reel/908103708519430/";
    expect(absolutePermalink(url)).toBe(url);
  });

  it("adds the missing slash on a path that lacks one", () => {
    expect(absolutePermalink("GMBlade/videos/123/")).toBe(
      "https://www.facebook.com/GMBlade/videos/123/",
    );
  });

  it("treats absent, empty and non-string values as null", () => {
    expect(absolutePermalink(null)).toBeNull();
    expect(absolutePermalink(undefined)).toBeNull();
    expect(absolutePermalink("")).toBeNull();
    expect(absolutePermalink(42)).toBeNull();
  });

  it("does not mangle http, only schemeless paths", () => {
    expect(absolutePermalink("http://fb.me/x")).toBe("http://fb.me/x");
  });
});
