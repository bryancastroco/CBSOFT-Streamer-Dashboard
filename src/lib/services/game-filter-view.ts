import "server-only";

import { ANY_GAME } from "@/lib/filters/browse";
import { getGameFilterOptions } from "@/lib/repositories/app-settings";
import { listGameOptions } from "@/lib/repositories/games";
import type { GameOption } from "@/lib/ui/game-shapes";

/**
 * Everything a screen needs to render the Game control and resolve its default.
 *
 * One call rather than three, because the three answers have to agree. A page
 * that read the games list and the preference separately could offer an entry
 * its own `resolveBrowseQuery` default contradicts — and the symptom would be a
 * dropdown showing one thing while the table below it obeys another.
 */

export type GameFilterView = {
  /** Active games, in the order the control lists them. */
  games: GameOption[];
  /** Offer "All content". */
  showAllContent: boolean;
  /** Offer "Not registered games". */
  showUnregistered: boolean;
  /** What to select when the URL names no game. */
  defaultGameId: string | undefined;
};

/**
 * The default selection, given what exists.
 *
 * `ANY_GAME` once a game is registered — the point of the feature is that this
 * dashboard is about the catalogue, so the catalogue is what a reader lands on.
 *
 * **Undefined when no game is registered, and that is not negotiable.** With an
 * empty catalogue `ANY_GAME` matches nothing, so honouring it would render
 * every screen — dashboard, posts, videos, analysis — with zero rows and no
 * visible cause. Someone setting the product up for the first time would see an
 * empty product. That is a correctness property rather than a preference, which
 * is why it is decided here and not exposed as a checkbox.
 */
export function defaultGameSelection(gameCount: number): string | undefined {
  return gameCount > 0 ? ANY_GAME : undefined;
}

export async function getGameFilterView(): Promise<GameFilterView> {
  const [games, options] = await Promise.all([listGameOptions(), getGameFilterOptions()]);

  return {
    games,
    showAllContent: options.showAllContent,
    showUnregistered: options.showUnregistered,
    defaultGameId: defaultGameSelection(games.length),
  };
}
