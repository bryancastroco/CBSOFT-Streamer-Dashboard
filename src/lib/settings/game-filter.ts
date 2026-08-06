import { z } from "zod";

/**
 * What the Game control offers — a PURE module.
 *
 * ## The two entries this governs
 *
 * The Game filter can express four things: all content, every registered game,
 * one game, or content no game reaches. Only the middle two are always useful
 * to a reader. The outer two are the ones an admin decides about:
 *
 *   showAllContent    an escape hatch back to the unfiltered view
 *   showUnregistered  the pile nothing has classified yet
 *
 * Both are off by default, so the control reads as a list of games and the
 * default selection is the registered catalogue. That is the point of the
 * feature: this dashboard is about games, and content outside the catalogue is
 * a configuration problem rather than something to browse.
 *
 * ## Why they are settings rather than a decision
 *
 * Turning both off is right for a configured workspace and wrong for one mid
 * setup, where most of the archive is still unattributed and the numbers on
 * every screen are a fraction of the truth. Which of those a workspace is in is
 * not something the code can tell — so it is the admin's to say, and reversible
 * from the interface rather than a redeploy.
 *
 * ## What is NOT configurable here
 *
 * Whether the default applies at all. With no game registered, "every
 * registered game" selects nothing, and honouring it would render every screen
 * empty on a fresh workspace with nothing on screen resembling a cause. That
 * fallback is a correctness property, not a preference — see
 * `defaultGameSelection`.
 */

export const GAME_FILTER_OPTIONS_KEY = "game_filter.options";

export type GameFilterOptions = {
  /** Offer "All content" — the unfiltered view. */
  showAllContent: boolean;
  /** Offer "Not registered games" — content no game reaches. */
  showUnregistered: boolean;
};

export const GAME_FILTER_OPTIONS_DEFAULT: GameFilterOptions = {
  showAllContent: false,
  showUnregistered: false,
};

/**
 * Parses a stored row, falling back rather than throwing.
 *
 * `.catch()` on the whole object, not per field: a row written by an older or
 * newer version of this code is a preference we cannot read, and the safe
 * reading of an unreadable preference is the default. A dropdown is not worth
 * a 500.
 */
export const gameFilterOptionsSchema = z
  .object({
    showAllContent: z.boolean().catch(GAME_FILTER_OPTIONS_DEFAULT.showAllContent),
    showUnregistered: z.boolean().catch(GAME_FILTER_OPTIONS_DEFAULT.showUnregistered),
  })
  .catch(GAME_FILTER_OPTIONS_DEFAULT);

export function parseGameFilterOptions(value: unknown): GameFilterOptions {
  return gameFilterOptionsSchema.parse(value);
}
