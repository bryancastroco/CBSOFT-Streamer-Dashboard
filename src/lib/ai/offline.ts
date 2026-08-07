import {
  NO_READABLE_COMMENTS,
  NO_SIGNIFICANT_FINDINGS,
  type CommentAnalysis,
  type CommentSentiment,
} from "@/lib/ai/contract";

/**
 * Comment analysis without a model. Pure, offline, free, and unable to fail.
 *
 * ## What this is for
 *
 * Every hosted provider eventually says no — an empty balance, a rate limit, a
 * regional outage. Storing `failed` in those moments leaves the reader with
 * nothing at all, when the underlying comments were collected successfully and
 * plenty can be said about them without a language model.
 *
 * So this produces the same `CommentAnalysis` shape from arithmetic: a lexicon
 * for tone, term frequency for themes, punctuation for questions, and a
 * keyword list for anything urgent.
 *
 * ## What it is honestly worse at
 *
 * Everything a language model is for. It cannot read sarcasm, cannot tell
 * "this is sick" (praise) from "I am sick of this" (complaint), and cannot
 * write prose. Its `summary` is therefore a *statement of counts*, phrased so
 * no reader mistakes it for something written by a model — see
 * `describeQuantitatively`. Presenting a tallied summary as if it were
 * interpreted would be the dishonest option.
 *
 * The lexicons are deliberately small and general. A large one tuned on
 * English product reviews would score a Tagalog-English gaming audience worse
 * than a small one, while looking far more authoritative.
 */

const POSITIVE_TERMS = new Set([
  "good", "great", "nice", "love", "loved", "best", "awesome", "amazing", "excellent",
  "perfect", "thanks", "thank", "salamat", "galing", "ganda", "maganda", "astig", "solid",
  "congrats", "congratulations", "goodluck", "sana", "idol", "legend", "fire", "clean",
  "helpful", "enjoyed", "enjoy", "fun", "happy", "support", "supporting", "proud",
]);

const NEGATIVE_TERMS = new Set([
  "bad", "worst", "hate", "terrible", "awful", "poor", "boring", "slow", "lag", "lagging",
  "laggy", "broken", "bug", "bugged", "crash", "crashed", "scam", "fake", "cheat", "cheater",
  "cheating", "unfair", "expensive", "pricey", "disappointed", "disappointing", "sayang",
  "pangit", "bulok", "problema", "problem", "issue", "error", "failed", "wrong", "stop",
  "quit", "refund", "delayed", "late", "trash", "annoying",
]);

/**
 * Words that mean somebody needs a human, not a summary.
 *
 * Kept narrow on purpose. A broad list turns every mildly cross comment into an
 * urgent issue, and a flag that fires constantly is one nobody reads.
 */
const URGENT_TERMS = new Set([
  "scam", "scammed", "fraud", "stolen", "hacked", "hack", "refund", "chargeback",
  "lawsuit", "legal", "report", "reported", "banned", "ban", "unbanned", "suspended",
  "charged", "payment", "billing", "unauthorized", "unauthorised", "police", "sue",
]);

/** Terms that carry no signal but dominate any frequency count. */
const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "than", "so", "to", "of", "in", "on",
  "at", "for", "with", "is", "are", "was", "were", "be", "been", "am", "i", "you", "he",
  "she", "it", "we", "they", "me", "my", "your", "his", "her", "its", "our", "their", "this",
  "that", "these", "those", "there", "here", "what", "when", "where", "who", "why", "how",
  "not", "no", "yes", "do", "does", "did", "have", "has", "had", "can", "could", "will",
  "would", "should", "may", "might", "just", "very", "really", "too", "also", "all", "any",
  "some", "more", "most", "much", "many", "na", "ng", "sa", "ay", "si", "ni", "ko", "mo",
  "po", "yung", "ang", "mga", "lang", "din", "rin", "pa", "ba", "eh", "kasi", "pero",
]);

const SUGGESTION_MARKERS = ["please", "pwede", "sana", "suggest", "should", "wish", "hope", "add"];

/**
 * Links, removed before anything else looks at the text.
 *
 * Three separate failures came from not doing this, all of them on one screen:
 *
 *  - `tokenise` strips punctuation, so `https://playcbm.com/dl-dopey` became the
 *    words `https`, `playcbm`, `com`, `dl`. "Most mentioned" then read
 *    "com (11 comments), download (11), https (11), playcbm (11)" — a list of
 *    URL fragments presented as what the audience is talking about.
 *
 *  - Question detection is `includes("?")`, and a query string contains one.
 *    `…/subscribenow?surface=pinned` was counted as somebody asking something,
 *    which is how seven copies of a download link came to be listed under
 *    "Questions being asked".
 *
 *  - A link carries no tone, so scoring it is noise either way.
 *
 * Not global, because a global regex carries `lastIndex` between calls and a
 * shared one used for `.test()` alternates between true and false on identical
 * input. `replace` gets its own.
 */
const URL_ANYWHERE = /\bhttps?:\/\/\S+|\bwww\.\S+/i;

function stripUrls(text: string): string {
  return text.replace(/\bhttps?:\/\/\S+|\bwww\.\S+/gi, " ");
}

/** Letters and digits only, for comparing two comments as the same thing. */
function normaliseForComparison(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * A comment that is essentially a link.
 *
 * The model is told to ignore spam and promotional content. Nothing told this,
 * so a bot posting the same download link eleven times dominated every list —
 * the terms, the questions, and the count the summary opens with.
 *
 * The test is "remove the links and see what is left" rather than a keyword
 * list, because the giveaway is structural: a person sharing a link says
 * something about it, and an advert is the link.
 *
 * Measured in words rather than characters. Characters were tried first at a
 * threshold of twenty and let the real advert through — "Download link:
 * Register here:" is twenty-four characters of pure scaffolding, and no
 * character count separates that from a short genuine remark without also
 * catching one. Four words of label around three URLs is a promotion; five or
 * more words is somebody talking.
 */
const OWN_WORDS_REQUIRED = 5;

function isLinkOnly(text: string): boolean {
  if (!URL_ANYWHERE.test(text)) return false;

  const ownWords = stripUrls(text)
    .split(/[^\p{L}\p{N}']+/u)
    .filter((word) => word.length > 0);

  return ownWords.length < OWN_WORDS_REQUIRED;
}

function tokenise(text: string): string[] {
  return stripUrls(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length > 1);
}

/** One comment, trimmed for display in a findings list. */
function excerpt(text: string, limit = 160): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= limit ? clean : `${clean.slice(0, limit - 1)}…`;
}

type Scored = { text: string; positive: number; negative: number; urgent: boolean };

function score(text: string): Scored {
  const words = tokenise(text);
  let positive = 0;
  let negative = 0;
  let urgent = false;

  for (const word of words) {
    if (POSITIVE_TERMS.has(word)) positive += 1;
    if (NEGATIVE_TERMS.has(word)) negative += 1;
    if (URGENT_TERMS.has(word)) urgent = true;
  }

  return { text, positive, negative, urgent };
}

/**
 * Overall tone from the balance of scored comments.
 *
 * `mixed` requires both sides to have real presence rather than one stray word,
 * because a single complaint among fifty compliments is a positive set with a
 * complaint in it — which is what the `concerns` list is for.
 */
function overallSentiment(scored: Scored[]): CommentSentiment {
  const positive = scored.filter((item) => item.positive > item.negative).length;
  const negative = scored.filter((item) => item.negative > item.positive).length;
  const opinionated = positive + negative;

  if (opinionated === 0) return "neutral";

  const positiveShare = positive / opinionated;
  const negativeShare = negative / opinionated;
  const minorityShare = Math.min(positiveShare, negativeShare);

  // Both sides meaningfully represented, and enough comments for that to mean
  // something rather than being two people disagreeing.
  if (minorityShare >= 0.3 && opinionated >= 4) return "mixed";
  if (positiveShare > negativeShare) return "positive";
  if (negativeShare > positiveShare) return "negative";

  return "neutral";
}

function topTerms(comments: readonly string[], limit: number): string[] {
  const counts = new Map<string, number>();

  for (const comment of comments) {
    // Per comment, not per occurrence: one person saying "lag" nine times is
    // one person with a lag problem, not nine.
    for (const word of new Set(tokenise(comment))) {
      if (STOP_WORDS.has(word) || word.length < 3) continue;
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([word, count]) => `${word} (${count} comments)`);
}

/**
 * A summary that reads as counted rather than understood.
 *
 * Phrased flatly and factually on purpose. The reader has to be able to tell at
 * a glance that no model wrote this — a fluent paragraph produced by arithmetic
 * would be a more useful-looking lie.
 */
function describeQuantitatively(
  total: number,
  scored: Scored[],
  sentiment: CommentSentiment,
  questions: number,
  setAside: { duplicates: number; links: number },
): string {
  const positive = scored.filter((item) => item.positive > item.negative).length;
  const negative = scored.filter((item) => item.negative > item.positive).length;
  const neutral = total - positive - negative;

  const parts = [
    `Counted without a language model: ${total} comment${total === 1 ? "" : "s"} —`,
    `${positive} leaning positive, ${negative} leaning negative, ${neutral} neither.`,
    `Overall tone reads as ${sentiment}.`,
  ];

  if (questions > 0) {
    parts.push(`${questions} contain${questions === 1 ? "s" : ""} a question.`);
  }

  /*
   * Stated, not silently dropped. A count that shrinks with no explanation
   * looks like data loss, and "12 comments" meaning eleven copies of one advert
   * was the reason this reads honestly now.
   */
  const removed: string[] = [];
  if (setAside.duplicates > 0) removed.push(`${setAside.duplicates} repeated`);
  if (setAside.links > 0) removed.push(`${setAside.links} link-only`);

  if (removed.length > 0) {
    parts.push(`Set aside: ${removed.join(", ")}.`);
  }

  parts.push("No written summary — this is a tally, not an interpretation.");

  return parts.join(" ");
}

/**
 * Analyse a comment set with no provider and no network.
 *
 * Never throws and never returns a failure: the worst case is a set with
 * nothing readable, which is a legitimate result rather than an error.
 */
export function analyseOffline(messages: readonly string[]): CommentAnalysis {
  const trimmed = messages.map((message) => message.trim()).filter((message) => message.length > 0);

  /*
   * Deduplicated before anything counts them.
   *
   * The same comment posted eleven times is one thing said once, not eleven
   * findings — and every list here slices its first few, so without this a
   * single repeated advert fills all of them and nothing else is visible. The
   * first occurrence wins so the text stays exactly as somebody wrote it.
   */
  const seen = new Set<string>();
  const unique: string[] = [];
  let duplicates = 0;

  for (const message of trimmed) {
    const key = normaliseForComparison(message);
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);
    unique.push(message);
  }

  const links = unique.filter(isLinkOnly).length;
  const comments = unique.filter((message) => !isLinkOnly(message));

  if (comments.length === 0) {
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

  const scored = comments.map(score);
  const sentiment = overallSentiment(scored);

  // Against the text with links removed: a query string contains a `?` and is
  // not a question. That alone produced seven identical "questions".
  const questions = comments.filter((comment) => stripUrls(comment).includes("?")).slice(0, 10);

  const urgent = scored
    .filter((item) => item.urgent)
    .slice(0, 10)
    .map((item) => excerpt(item.text));

  const positivePoints = scored
    .filter((item) => item.positive > item.negative)
    .sort((a, b) => b.positive - a.positive)
    .slice(0, 5)
    .map((item) => excerpt(item.text));

  const concerns = scored
    .filter((item) => item.negative > item.positive)
    .sort((a, b) => b.negative - a.negative)
    .slice(0, 5)
    .map((item) => excerpt(item.text));

  const suggestions = comments
    .filter((comment) => {
      const lower = comment.toLowerCase();
      return SUGGESTION_MARKERS.some((marker) => lower.includes(marker));
    })
    .slice(0, 5)
    .map((comment) => excerpt(comment));

  const themes = topTerms(comments, 8);

  const orPlaceholder = (items: string[]): string[] =>
    items.length > 0 ? items : [NO_SIGNIFICANT_FINDINGS];

  return {
    summary: describeQuantitatively(comments.length, scored, sentiment, questions.length, {
      duplicates,
      links,
    }),
    sentiment,
    // Themes ride along with the positives: they are the closest this can get
    // to "what is being talked about", and they are labelled as counts.
    positive_points: orPlaceholder([
      ...positivePoints,
      ...(themes.length > 0 ? [`Most mentioned: ${themes.join(", ")}`] : []),
    ]),
    concerns: orPlaceholder(concerns),
    suggestions: orPlaceholder(suggestions),
    questions: orPlaceholder(questions.map((comment) => excerpt(comment))),
    urgent_issues: orPlaceholder(urgent),
  };
}
