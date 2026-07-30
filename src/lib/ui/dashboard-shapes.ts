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

export type TopStreamer = {
  streamerId: string;
  streamerName: string;
  streamerCode: string;
  reactions: number;
  comments: number;
  shares: number;
  postCount: number;
};

export type SentimentSlice = { sentiment: string; count: number };
