/**
 * The data shapes the dashboard's charts render.
 *
 * These live outside the repository so a Client Component never has to name a
 * `server-only` module, not even for a type. `tests/token-containment.test.ts`
 * enforces that, and it is right to: a type-only import is erased at build
 * time, but it is one careless edit away from becoming a value import that
 * drags the database client — and everything it can reach — towards the
 * browser bundle. Keeping the boundary at the import graph rather than at the
 * `type` keyword means the mistake cannot be made quietly.
 *
 * The repository re-exports these, so server code still has one place to look.
 */

export type TimeSeriesPoint = {
  /** ISO date, day resolution. */
  day: string;
  reactions: number;
  comments: number;
  shares: number;
  postCount: number;
  videoCount: number;
};

export type SentimentSlice = { sentiment: string; count: number };

/**
 * One streamer's totals across every metric the leaderboards rank on.
 *
 * A single row per streamer rather than seven ranked lists from the server: the
 * roster is small, the sorting is trivial, and seven queries that each pick
 * their own top few would disagree about who exists whenever a streamer scores
 * on one metric and not another.
 */
export type StreamerTotals = {
  streamerId: string;
  streamerName: string;
  streamerCode: string;
  /**
   * Net followers gained across the window, and the only figure here that can
   * be negative.
   *
   * Followers belong to the Page rather than to any piece of content, so unlike
   * every other total on this list the game and content filters cannot narrow
   * it. The board says so.
   */
  followerGrowth: number;
  postCount: number;
  videoCount: number;
  livestreamCount: number;
  /** From canonical metrics — the only source that spans posts and videos. */
  views: number;
  reactions: number;
  comments: number;
  shares: number;
};

/** Which metric a leaderboard ranks on. */
export type LeaderboardMetric = Exclude<keyof StreamerTotals, `streamer${string}`>;
