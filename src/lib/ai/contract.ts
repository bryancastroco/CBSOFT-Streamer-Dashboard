import { z } from "zod";

/**
 * The comment-analysis contract — a PURE module.
 *
 * Holds the Zod schema the model's output must satisfy, the JSON Schema handed
 * to the provider to constrain generation, and the prompt. Kept separate from
 * any provider so the contract is one artefact rather than something implied by
 * an implementation.
 *
 * Two layers of enforcement, deliberately:
 *
 *   1. **Structured outputs** — the provider is given a JSON Schema and
 *      constrains generation to it.
 *   2. **Zod validation** — the response is parsed again on arrival.
 *
 * The second is not redundant. A model can refuse, hit a token ceiling, or a
 * provider can change behaviour; the schema constrains a *successful*
 * generation, and Zod is what turns anything else into a clean `failed` status
 * rather than a malformed row.
 */

export const SENTIMENT_VALUES = [
  "positive",
  "mixed",
  "negative",
  "neutral",
  "no_comments",
] as const;

export type CommentSentiment = (typeof SENTIMENT_VALUES)[number];

/** Placeholder when a category genuinely has nothing in it. */
export const NO_SIGNIFICANT_FINDINGS = "No significant findings";

/** Placeholder when there was nothing analysable at all. */
export const NO_READABLE_COMMENTS = "No readable comments found";

const listItem = z.string().trim().min(1).max(500);

/** What a valid analysis looks like. Applied to every provider response. */
export const commentAnalysisSchema = z.object({
  summary: z.string().trim().min(1).max(2000),
  sentiment: z.enum(SENTIMENT_VALUES),
  positive_points: z.array(listItem).max(20),
  concerns: z.array(listItem).max(20),
  suggestions: z.array(listItem).max(20),
  questions: z.array(listItem).max(20),
  urgent_issues: z.array(listItem).max(20),
});

export type CommentAnalysis = z.infer<typeof commentAnalysisSchema>;

/**
 * JSON Schema handed to the provider to constrain generation.
 *
 * Written by hand rather than derived from the Zod schema: structured outputs
 * reject several JSON Schema keywords (`minLength`, `maxItems`, and other
 * numeric/string constraints), so a mechanical conversion of the Zod schema
 * above would be rejected. The two are kept deliberately aligned — the Zod
 * schema is the stricter of the pair and has the final say.
 */
export const COMMENT_ANALYSIS_JSON_SCHEMA = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description: "Two to four sentences summarising what the comments say.",
    },
    sentiment: {
      type: "string",
      enum: [...SENTIMENT_VALUES],
      description: "Overall tone of the comment set.",
    },
    positive_points: {
      type: "array",
      items: { type: "string" },
      description: "Specific things commenters praised.",
    },
    concerns: {
      type: "array",
      items: { type: "string" },
      description: "Specific complaints or worries commenters raised.",
    },
    suggestions: {
      type: "array",
      items: { type: "string" },
      description: "Concrete suggestions commenters made.",
    },
    questions: {
      type: "array",
      items: { type: "string" },
      description: "Questions commenters asked that went unanswered.",
    },
    urgent_issues: {
      type: "array",
      items: { type: "string" },
      description:
        "Anything needing prompt attention, such as a reported outage or a safety concern.",
    },
  },
  required: [
    "summary",
    "sentiment",
    "positive_points",
    "concerns",
    "suggestions",
    "questions",
    "urgent_issues",
  ],
  additionalProperties: false,
} as const;

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

/**
 * System prompt.
 *
 * The "do not expose personal names" rule is stated here *and* enforced by not
 * requesting the `from` field from Meta — the model never receives a commenter
 * identity to leak. The instruction covers names written inside comment text
 * (`@mentions`, "tell Sarah…"), which is the only way one can reach the model.
 */
export const COMMENT_ANALYSIS_SYSTEM_PROMPT = `You analyse Facebook comments for an internal CBSOFT gaming-community report.

Analyse only the comments supplied. They are the entire evidence base.

What to ignore:
- Spam, scams, and promotional content.
- Comments that are only tags or mentions of other people.
- Emoji-only comments with no meaningful context. An emoji accompanying real text is meaningful; a bare string of emoji is not.

Rules:
- Do not invent information. Every point you list must be traceable to something a commenter actually wrote.
- Do not expose personal names. If a comment names someone, describe the role or omit the name — never reproduce it.
- Do not quote comments verbatim at length. Summarise.
- Write for a colleague reading a weekly report: plain, specific, no filler.
- Write every field in English. The comments are mostly Tagalog, or Tagalog and English mixed, and gaming slang runs through both — carry the meaning across rather than repeating the original wording. Keep in-game proper nouns as they are written.

Placeholders:
- When a category has nothing worth reporting, return a single-item list containing exactly "${NO_SIGNIFICANT_FINDINGS}".
- When no comment is analysable — all spam, all emoji-only, or none supplied — set summary to exactly "${NO_READABLE_COMMENTS}", set sentiment to "no_comments", and use "${NO_SIGNIFICANT_FINDINGS}" for every list.

Sentiment:
- "positive" — clearly favourable overall.
- "negative" — clearly unfavourable overall.
- "mixed" — substantial amounts of both.
- "neutral" — largely factual, or no clear leaning.
- "no_comments" — nothing analysable.`;

/** Build the user turn. Comments are numbered so the model can be specific. */
export function buildCommentAnalysisPrompt(comments: readonly string[]): string {
  if (comments.length === 0) {
    return "No comments were supplied for this content.";
  }

  const numbered = comments
    .map((message, index) => `${index + 1}. ${message.replace(/\s+/g, " ").trim()}`)
    .join("\n");

  return `Analyse the following ${comments.length} Facebook comment${comments.length === 1 ? "" : "s"}.\n\n${numbered}`;
}

/** The analysis returned when there is nothing to analyse — no AI call needed. */
export function emptyAnalysis(): CommentAnalysis {
  return {
    summary: NO_READABLE_COMMENTS,
    sentiment: "no_comments",
    positive_points: [NO_SIGNIFICANT_FINDINGS],
    concerns: [NO_SIGNIFICANT_FINDINGS],
    suggestions: [NO_SIGNIFICANT_FINDINGS],
    questions: [NO_SIGNIFICANT_FINDINGS],
    urgent_issues: [NO_SIGNIFICANT_FINDINGS],
  };
}

/**
 * Normalise a validated analysis.
 *
 * A model that returns an empty list means "nothing here", which the
 * specification renders as the placeholder rather than as a blank section.
 */
export function applyPlaceholders(analysis: CommentAnalysis): CommentAnalysis {
  const fill = (list: string[]) => (list.length === 0 ? [NO_SIGNIFICANT_FINDINGS] : list);

  return {
    ...analysis,
    positive_points: fill(analysis.positive_points),
    concerns: fill(analysis.concerns),
    suggestions: fill(analysis.suggestions),
    questions: fill(analysis.questions),
    urgent_issues: fill(analysis.urgent_issues),
  };
}
