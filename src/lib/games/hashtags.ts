/**
 * Reading hashtags out of post text — a PURE module.
 *
 * Kept free of I/O so the matching rules can be asserted directly. They are
 * fiddly in ways that only show up against real posts, and getting them wrong
 * misfiles content rather than failing loudly.
 */

/**
 * Facebook hashtag characters.
 *
 * Letters, digits and underscore. Not hyphens or full stops — Facebook ends a
 * tag there, so `#cabal-sea` is the tag `cabal` followed by text, and treating
 * the whole thing as one tag would never match anything.
 */
const HASHTAG_PATTERN = /#([A-Za-z0-9_]+)/g;

/**
 * Every hashtag in a piece of text, normalised and deduplicated.
 *
 * Lower-cased because Facebook treats tags case-insensitively: `#CabalSEA` and
 * `#cabalsea` are the same tag, and storing or matching both spellings would
 * make attribution depend on how somebody typed it.
 *
 * Order is preserved, because the first recognised tag in a post is the one
 * attribution uses — a post that opens `#CabalMobile` and later mentions
 * `#CabalSEA` in a list of channels is about the mobile game.
 */
export function extractHashtags(text: string | null | undefined): string[] {
  if (!text) return [];

  const seen = new Set<string>();
  const tags: string[] = [];

  for (const match of text.matchAll(HASHTAG_PATTERN)) {
    const tag = match[1]?.toLowerCase();
    if (!tag || seen.has(tag)) continue;

    seen.add(tag);
    tags.push(tag);
  }

  return tags;
}

/**
 * Normalise what somebody typed into an admin field.
 *
 * Accepts `#CabalSEA`, `CabalSEA`, ` cabalsea ` and returns `cabalsea`.
 * Returns null for anything that is not a usable tag, so a caller can reject it
 * rather than storing something that can never match.
 */
export function normaliseHashtag(input: string): string | null {
  const trimmed = input.trim().replace(/^#+/, "").toLowerCase();

  if (trimmed.length === 0) return null;
  if (!/^[a-z0-9_]+$/.test(trimmed)) return null;

  return trimmed;
}

/**
 * Split a textarea or comma-separated list into tags.
 *
 * Admins paste from a spreadsheet, a chat message or a content calendar, so
 * commas, newlines and spaces all have to work. Invalid entries are dropped
 * rather than failing the whole submission — one typo should not discard the
 * other nine tags somebody just pasted.
 */
export function parseHashtagList(input: string): { tags: string[]; rejected: string[] } {
  const tags: string[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();

  for (const piece of input.split(/[\s,]+/)) {
    if (piece.trim().length === 0) continue;

    const tag = normaliseHashtag(piece);

    if (!tag) {
      rejected.push(piece.trim());
      continue;
    }

    if (seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
  }

  return { tags, rejected };
}

/**
 * A URL-safe handle derived from a display name.
 *
 * Only a starting point — the admin form lets it be edited, because a generated
 * slug is a guess at what somebody wants in a link.
 */
export function slugifyGameName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    // Strip accents, so "Pokémon" becomes "pokemon" rather than "pokmon".
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/**
 * Which game a piece of content is about.
 *
 * A hashtag, or nothing. Content that names no registered game is left
 * unattributed and reachable through the "Not Registered Games" filter.
 *
 * ## Why the streamer's primary game no longer counts
 *
 * It used to: an untagged post inherited whatever title its streamer mainly
 * covers, on the reasoning that only about one post in sixteen carries a
 * hashtag and attribution by tag alone would leave most of the archive
 * unfilterable.
 *
 * That reasoning was about coverage, and it bought coverage by guessing. A
 * streamer's primary game is an assumption about their output in general; used
 * as a fallback it becomes an assertion about every individual post, including
 * the ones that are about something else. In production it labelled a Roblox
 * stream "Cabal: Infinite Combo SEA" — and worse, filtering for Cabal returned
 * that Roblox stream, which is the filter answering a question wrongly rather
 * than declining to answer it.
 *
 * The number made the problem invisible: 114 of 213 posts were filed by
 * assumption and 99 by evidence, so the archive looked comprehensively tagged
 * while roughly half of it was guesswork. An unfiled post is a visible gap
 * somebody can close by registering a game or adding a hashtag. A wrongly filed
 * one is a silent error inside a number people report on.
 *
 * The `source` field is kept, still typed to allow `"streamer"`, because stored
 * rows record which rule produced them and history should stay readable.
 */
export function resolveGameFor(params: {
  text: string | null | undefined;
  /** Normalised tag to game id. */
  hashtagToGame: ReadonlyMap<string, string>;
}): { gameId: string | null; source: "hashtag" | "streamer" | null } {
  for (const tag of extractHashtags(params.text)) {
    const gameId = params.hashtagToGame.get(tag);
    if (gameId) return { gameId, source: "hashtag" };
  }

  return { gameId: null, source: null };
}
