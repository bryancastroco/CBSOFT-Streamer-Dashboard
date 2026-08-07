import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  COMMENT_ANALYSIS_JSON_SCHEMA,
  COMMENT_ANALYSIS_SYSTEM_PROMPT,
  NO_READABLE_COMMENTS,
  NO_SIGNIFICANT_FINDINGS,
  SENTIMENT_VALUES,
  applyPlaceholders,
  buildCommentAnalysisPrompt,
  commentAnalysisSchema,
  emptyAnalysis,
} from "@/lib/ai/contract";
import { COMMENT_FIELDS, dedupeComments, normalizeComment } from "@/lib/meta/comments";

/**
 * The AI response contract, and the guarantee that no commenter identity is
 * ever collected.
 */

const VALID = {
  summary: "Viewers enjoyed the stream and asked about the schedule.",
  sentiment: "positive" as const,
  positive_points: ["Praised the commentary"],
  concerns: [],
  suggestions: ["Asked for longer streams"],
  questions: ["When is the next stream?"],
  urgent_issues: [],
};

describe("response validation", () => {
  it("accepts a well-formed analysis", () => {
    expect(commentAnalysisSchema.safeParse(VALID).success).toBe(true);
  });

  it("rejects a missing field", () => {
    const { summary: _summary, ...incomplete } = VALID;
    expect(commentAnalysisSchema.safeParse(incomplete).success).toBe(false);
  });

  it("rejects an unknown sentiment", () => {
    const result = commentAnalysisSchema.safeParse({ ...VALID, sentiment: "furious" });
    expect(result.success).toBe(false);
  });

  it("accepts every declared sentiment value", () => {
    for (const sentiment of SENTIMENT_VALUES) {
      expect(commentAnalysisSchema.safeParse({ ...VALID, sentiment }).success).toBe(true);
    }
  });

  it("rejects an empty summary", () => {
    expect(commentAnalysisSchema.safeParse({ ...VALID, summary: "   " }).success).toBe(false);
  });

  it("rejects a non-array list", () => {
    expect(commentAnalysisSchema.safeParse({ ...VALID, concerns: "none" }).success).toBe(false);
  });

  it("rejects a list containing a non-string", () => {
    expect(commentAnalysisSchema.safeParse({ ...VALID, concerns: [42] }).success).toBe(false);
  });

  it("rejects an implausibly long list, so a runaway response cannot flood the UI", () => {
    const flood = Array.from({ length: 50 }, (_, i) => `item ${i}`);
    expect(commentAnalysisSchema.safeParse({ ...VALID, concerns: flood }).success).toBe(false);
  });

  it("rejects a completely wrong shape", () => {
    for (const bad of [null, undefined, "text", 42, []]) {
      expect(commentAnalysisSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("required placeholders", () => {
  it("uses the specified no-findings text for empty categories", () => {
    const filled = applyPlaceholders(VALID);

    expect(filled.concerns).toEqual([NO_SIGNIFICANT_FINDINGS]);
    expect(filled.urgent_issues).toEqual([NO_SIGNIFICANT_FINDINGS]);
  });

  it("leaves populated categories untouched", () => {
    const filled = applyPlaceholders(VALID);
    expect(filled.positive_points).toEqual(["Praised the commentary"]);
  });

  it("uses the specified no-comments text when nothing is analysable", () => {
    const empty = emptyAnalysis();

    expect(empty.summary).toBe(NO_READABLE_COMMENTS);
    expect(empty.sentiment).toBe("no_comments");
    expect(empty.concerns).toEqual([NO_SIGNIFICANT_FINDINGS]);
  });

  it("produces an analysis that satisfies its own schema", () => {
    expect(commentAnalysisSchema.safeParse(emptyAnalysis()).success).toBe(true);
  });

  it("states both placeholder strings verbatim in the prompt", () => {
    expect(COMMENT_ANALYSIS_SYSTEM_PROMPT).toContain(NO_SIGNIFICANT_FINDINGS);
    expect(COMMENT_ANALYSIS_SYSTEM_PROMPT).toContain(NO_READABLE_COMMENTS);
  });
});

describe("prompt", () => {
  it("instructs the model on every rule the specification lists", () => {
    const prompt = COMMENT_ANALYSIS_SYSTEM_PROMPT.toLowerCase();

    expect(prompt).toContain("spam");
    expect(prompt).toContain("tag");
    expect(prompt).toContain("emoji");
    expect(prompt).toContain("do not invent");
    expect(prompt).toContain("do not expose personal names");
  });

  it("names the output language, rather than hoping for it", () => {
    const prompt = COMMENT_ANALYSIS_SYSTEM_PROMPT.toLowerCase();

    /*
     * The audience comments in Tagalog and English mixed. A model handed that
     * will often answer in kind, and for a while this one did not only because
     * the rest of the prompt is English — which is a coincidence, not a
     * setting. The report is read in English, so the prompt says so.
     */
    expect(prompt).toContain("in english");
    expect(prompt).toContain("tagalog");
  });

  it("numbers comments so the model can be specific", () => {
    const built = buildCommentAnalysisPrompt(["first", "second"]);

    expect(built).toContain("1. first");
    expect(built).toContain("2. second");
  });

  it("collapses whitespace so formatting cannot smuggle in structure", () => {
    expect(buildCommentAnalysisPrompt(["a\n\n   b"])).toContain("1. a b");
  });

  it("handles an empty comment list without producing a malformed prompt", () => {
    expect(buildCommentAnalysisPrompt([])).toContain("No comments");
  });
});

describe("generation schema", () => {
  it("requires every field the Zod schema requires", () => {
    expect([...COMMENT_ANALYSIS_JSON_SCHEMA.required].sort()).toEqual(
      Object.keys(commentAnalysisSchema.shape).sort(),
    );
  });

  it("forbids extra properties, so the model cannot invent fields", () => {
    expect(COMMENT_ANALYSIS_JSON_SCHEMA.additionalProperties).toBe(false);
  });

  it("constrains sentiment to exactly the declared values", () => {
    expect([...COMMENT_ANALYSIS_JSON_SCHEMA.properties.sentiment.enum]).toEqual([
      ...SENTIMENT_VALUES,
    ]);
  });
});

describe("commenter identity is never collected", () => {
  it("requests only the five specified fields", () => {
    expect(COMMENT_FIELDS).toBe("id,message,created_time,like_count,comment_count");
  });

  it("never requests an author field", () => {
    // Meta returns author information only when asked. Not asking is the
    // enforcement — there is no name to discard later.
    for (const identityField of ["from", "username", "user", "profile", "author"]) {
      expect(COMMENT_FIELDS).not.toContain(identityField);
    }
  });

  it("has no author column anywhere in the comments table", async () => {
    const schema = await readFile(path.join(process.cwd(), "src/lib/db/schema.ts"), "utf8");

    const commentsTable = schema.slice(
      schema.indexOf("export const comments = pgTable("),
      schema.indexOf("export const commentSummaries"),
    );

    expect(commentsTable.length).toBeGreaterThan(0);
    for (const banned of ["author", "from_name", "from_id", "commenter", "user_name"]) {
      expect(commentsTable).not.toContain(banned);
    }
  });

  it("drops nothing but keeps no identity when normalising", () => {
    const normalized = normalizeComment({
      id: "100_1",
      message: "hi",
      created_time: "2026-07-20T10:00:00+0000",
      like_count: 3,
      comment_count: 1,
    });

    expect(normalized).not.toBeNull();
    expect(Object.keys(normalized ?? {}).sort()).toEqual([
      "createdTime",
      "facebookCommentId",
      "likeCount",
      "message",
      "replyCount",
    ]);
  });
});

describe("comment normalisation", () => {
  const base = { id: "100_1", created_time: "2026-07-20T10:00:00+0000" };

  it("maps Meta's comment_count onto reply_count", () => {
    expect(normalizeComment({ ...base, comment_count: 4 })?.replyCount).toBe(4);
  });

  it("keeps a reported zero rather than nulling it", () => {
    expect(normalizeComment({ ...base, like_count: 0 })?.likeCount).toBe(0);
  });

  it("returns null for an absent count rather than inventing a zero", () => {
    const normalized = normalizeComment(base);

    expect(normalized?.likeCount).toBeNull();
    expect(normalized?.replyCount).toBeNull();
  });

  it("rejects a comment with no id or an unparseable timestamp", () => {
    expect(normalizeComment({ created_time: base.created_time })).toBeNull();
    expect(normalizeComment({ id: "100_1", created_time: "nonsense" })).toBeNull();
  });

  it("treats an empty message as absent", () => {
    expect(normalizeComment({ ...base, message: "" })?.message).toBeNull();
  });
});

describe("duplicate comments", () => {
  it("keeps the first occurrence and drops repeats", () => {
    const one = {
      facebookCommentId: "100_1",
      message: "first",
      createdTime: new Date(),
      likeCount: null,
      replyCount: null,
    };
    const duplicate = { ...one, message: "second" };

    const deduped = dedupeComments([one, duplicate, one]);

    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.message).toBe("first");
  });

  it("preserves distinct comments", () => {
    const make = (id: string) => ({
      facebookCommentId: id,
      message: id,
      createdTime: new Date(),
      likeCount: null,
      replyCount: null,
    });

    expect(dedupeComments([make("a"), make("b"), make("c")])).toHaveLength(3);
  });
});

/**
 * What counts as urgent.
 *
 * A commenter mentioned that *another* streamer's microphone was broken during
 * their live, and it was raised under "Flagged as urgent". The model read the
 * comment correctly; the instruction was the problem, being broad enough to
 * cover any unfortunate event mentioned anywhere in the text.
 *
 * That is expensive in a specific way. The urgent list is the one thing on the
 * panel that claims somebody should act now, and a flag that fires on things
 * nobody can act on is one people learn to scroll past — taking the real ones
 * with it.
 */
describe("the urgent list is scoped to things CBSOFT can act on", () => {
  const description = () => {
    const schema = COMMENT_ANALYSIS_JSON_SCHEMA.properties.urgent_issues;
    return "description" in schema ? String(schema.description).toLowerCase() : "";
  };

  it("says it is about this Page rather than anything unfortunate", () => {
    expect(description()).toMatch(/this page|this streamer/);
  });

  it("names the categories that qualify", () => {
    const text = description();

    // Money, accusations, safety and law — the four that need a person today.
    expect(text).toMatch(/payment|account/);
    expect(text).toMatch(/fraud/);
    expect(text).toMatch(/safety/);
    expect(text).toMatch(/legal/);
  });

  it("excludes ordinary complaints and other people's problems", () => {
    const text = description();

    // Both exclusions matter, and the second is the one that was missing:
    // "someone else is having a problem" is not this Page's urgent issue.
    expect(text).toMatch(/not general negative feedback/);
    expect(text).toMatch(/someone else/);
  });
});
