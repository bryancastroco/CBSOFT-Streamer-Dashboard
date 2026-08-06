/**
 * The shapes the games UI renders — a PURE module, importable from a Client
 * Component.
 *
 * They live here rather than beside the queries that produce them because
 * `repositories/games.ts` imports `server-only`, and a `"use client"` file that
 * reaches into `@/lib/repositories/*` is refused by `token-containment.test.ts`
 * — correctly, even for a type-only import. The rule is textual on purpose: an
 * import that is safe today is one edit away from pulling a query, and a
 * secret, into a browser bundle.
 *
 * So the type is declared here and the repository re-exports it. One
 * definition, and the boundary stays checkable by reading the import list.
 */

export type GameRow = {
  id: string;
  name: string;
  slug: string;
  active: boolean;
  notes: string | null;
  hashtags: string[];
  /** How many streamers have declared they cover this. */
  streamerCount: number;
  /** Content currently attributed to it, either way. */
  postCount: number;
  videoCount: number;
};

export type StreamerGameAssignment = {
  gameId: string;
  name: string;
  slug: string;
  isPrimary: boolean;
};

/** A game as offered in a filter or an assignment list. */
export type GameOption = {
  id: string;
  name: string;
  slug: string;
};
