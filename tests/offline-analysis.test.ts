import { describe, expect, it } from "vitest";

import { commentAnalysisSchema, NO_SIGNIFICANT_FINDINGS } from "@/lib/ai/contract";
import { analyseOffline } from "@/lib/ai/offline";

/**
 * The analyser that runs when no provider will.
 *
 * Its job is not to rival a language model — it cannot, and the tests below say
 * so where it matters. Its job is to satisfy the same contract, never throw,
 * and never overstate what it knows. A hosted provider fails for reasons that
 * have nothing to do with the comments, and on those days this is the whole
 * feature.
 */

const PRAISE = [
  "This was great, thank you!",
  "Ang galing, best stream today",
  "love the content, awesome work",
  "Solid gameplay, enjoyed it",
];

const COMPLAINTS = [
  "the stream was so laggy",
  "terrible quality, very disappointed",
  "this is boring and slow",
  "bad audio, please fix",
];

describe("it always satisfies the contract", () => {
  it("produces a valid analysis for ordinary comments", () => {
    const result = analyseOffline(PRAISE);

    expect(commentAnalysisSchema.safeParse(result).success).toBe(true);
  });

  it("produces a valid analysis for an empty set", () => {
    const result = analyseOffline([]);

    expect(commentAnalysisSchema.safeParse(result).success).toBe(true);
    expect(result.sentiment).toBe("no_comments");
  });

  it("survives input a model would choke on", () => {
    const hostile = ["", "   ", "🎮🎮🎮", "?????", "a", "\n\n\n", "https://example.com/x?y=1"];

    const result = analyseOffline(hostile);

    // Never throws, and never emits a list item that fails the schema's
    // min-length rule — which blank comments would if passed straight through.
    expect(commentAnalysisSchema.safeParse(result).success).toBe(true);
  });

  it("caps every list, so one noisy post cannot produce a thousand findings", () => {
    const many = Array.from({ length: 400 }, (_, i) => `this is terrible and broken number ${i}?`);

    const result = analyseOffline(many);
    const parsed = commentAnalysisSchema.safeParse(result);

    expect(parsed.success).toBe(true);
  });
});

describe("tone", () => {
  it("reads praise as positive", () => {
    expect(analyseOffline(PRAISE).sentiment).toBe("positive");
  });

  it("reads complaints as negative", () => {
    expect(analyseOffline(COMPLAINTS).sentiment).toBe("negative");
  });

  it("reads a genuinely split set as mixed", () => {
    expect(analyseOffline([...PRAISE, ...COMPLAINTS]).sentiment).toBe("mixed");
  });

  it("does not call a set mixed over a single dissenter", () => {
    /*
     * One complaint among many compliments is a positive set containing a
     * complaint — which is what `concerns` is for. Calling it "mixed" would
     * overstate the disagreement.
     */
    const result = analyseOffline([...PRAISE, ...PRAISE, "this is bad"]);

    expect(result.sentiment).toBe("positive");
    expect(result.concerns.join(" ")).toContain("bad");
  });

  it("reads comments with no opinion words as neutral", () => {
    expect(analyseOffline(["what time is the next stream", "ok", "hello po"]).sentiment).toBe(
      "neutral",
    );
  });
});

describe("what it extracts", () => {
  it("finds questions by the punctuation that marks them", () => {
    const result = analyseOffline(["what time tomorrow?", "great stream", "how do I join?"]);

    expect(result.questions).toHaveLength(2);
    expect(result.questions.join(" ")).toContain("what time tomorrow?");
  });

  it("flags the words that mean somebody needs a human", () => {
    const result = analyseOffline(["I got scammed, I want a refund", "nice stream"]);

    expect(result.urgent_issues[0]).toContain("scammed");
  });

  it("does not flag ordinary annoyance as urgent", () => {
    /*
     * A flag that fires on every mildly cross comment is one nobody reads. The
     * urgent list is deliberately narrow.
     */
    const result = analyseOffline(["this is boring", "bad audio", "slow stream"]);

    expect(result.urgent_issues).toEqual([NO_SIGNIFICANT_FINDINGS]);
  });

  it("counts a repeated word once per commenter, not once per mention", () => {
    const result = analyseOffline([
      "lag lag lag lag lag lag",
      "the audio was fine",
      "audio issues here",
    ]);

    const themes = result.positive_points.join(" ") + result.concerns.join(" ");

    // "audio" appears in two comments; "lag" in one, however many times.
    expect(themes).toContain("audio (2 comments)");
    expect(themes).not.toContain("lag (6");
  });

  it("picks up suggestions by their markers", () => {
    const result = analyseOffline(["please add a schedule", "sana may replay", "great stream"]);

    expect(result.suggestions.length).toBeGreaterThanOrEqual(2);
  });
});

describe("honesty about what it is", () => {
  it("says the summary was counted, not written", () => {
    const result = analyseOffline(PRAISE);

    /*
     * The one thing this must never do is read like a model wrote it. A fluent
     * paragraph produced by arithmetic is a more useful-looking lie than a
     * blunt tally, so the wording is asserted rather than left to drift.
     */
    expect(result.summary).toContain("without a language model");
    expect(result.summary).toContain("tally, not an interpretation");
  });

  it("reports the counts it actually used", () => {
    const result = analyseOffline([...PRAISE, ...COMPLAINTS]);

    expect(result.summary).toContain("8 comments");
    expect(result.summary).toContain("4 leaning positive");
    expect(result.summary).toContain("4 leaning negative");
  });

  it("uses the placeholder rather than inventing findings", () => {
    const result = analyseOffline(["ok", "sige", "noted"]);

    // Nothing to say is said as nothing, not padded.
    expect(result.urgent_issues).toEqual([NO_SIGNIFICANT_FINDINGS]);
    expect(result.questions).toEqual([NO_SIGNIFICANT_FINDINGS]);
  });
});

/**
 * Spam, links and repetition.
 *
 * All three of these were visible on one screen at once, from a Page whose
 * comments included the same download link posted eleven times:
 *
 *   Most mentioned: com (11 comments), download (11), https (11), playcbm (11)
 *   Questions being asked: [the same advert, seven times]
 *
 * Neither list was wrong about its arithmetic. They were counting a URL as
 * vocabulary and a query string as a question, and doing it eleven times over
 * for one comment — so the loudest thing in the room was a bot.
 */
describe("links, duplicates and adverts", () => {
  const ADVERT =
    "Download link: https://playcbm.com/dl-dopey Register here: https://playcbm.com/register-DOPEY https://www.facebook.com/dopeyninins/subscribenow?surface=pinned_post";

  it("does not treat a URL query string as a question", () => {
    // The `?` in `?surface=pinned_post` is why seven copies of an advert were
    // listed under "Questions being asked".
    const result = analyseOffline([ADVERT, "ano oras ang stream?"]);

    expect(result.questions).toEqual(["ano oras ang stream?"]);
  });

  it("does not report URL fragments as what people are talking about", () => {
    const result = analyseOffline([
      "check https://playcbm.com/dl-dopey for the download",
      "another https://playcbm.com/register-DOPEY link here",
      "https://playcbm.com/dl-dopey again",
    ]);

    const themes = result.positive_points.join(" ");

    for (const fragment of ["https", "playcbm", "com"]) {
      expect(themes).not.toContain(fragment);
    }
  });

  it("counts a comment repeated eleven times as one comment", () => {
    const result = analyseOffline([...Array(11).fill("same thing said again"), "a real comment"]);

    expect(result.summary).toContain("2 comments");
    expect(result.summary).toContain("10 repeated");
  });

  it("sets aside a comment that is only a link", () => {
    const result = analyseOffline([ADVERT, "maganda ang stream kanina"]);

    expect(result.summary).toContain("1 link-only");
    // And it is nowhere in the findings.
    const everything = [
      ...result.positive_points,
      ...result.concerns,
      ...result.suggestions,
      ...result.questions,
    ].join(" ");
    expect(everything).not.toContain("playcbm");
  });

  it("keeps a comment that shares a link and says something about it", () => {
    // The distinction that matters: a person linking something and commenting
    // on it is a contribution; the advert is the link and nothing else.
    const result = analyseOffline([
      "grabe ang ganda ng update na to, sobrang solid talaga https://playcbm.com/patch",
    ]);

    expect(result.summary).toContain("1 comment ");
    expect(result.summary).not.toContain("link-only");
  });

  it("reports nothing readable when every comment is an advert", () => {
    const result = analyseOffline([ADVERT, ADVERT, ADVERT]);

    expect(result.sentiment).toBe("no_comments");
  });
});
