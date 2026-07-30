import "server-only";

/**
 * Binding timestamps into raw `sql` fragments.
 *
 * ## The failure this exists to prevent
 *
 * The pool runs with `prepare: false`, which the Supabase transaction pooler
 * requires. On that path postgres.js will not serialise a `Date` handed to it
 * from inside a raw `sql` template, and the driver throws before Postgres ever
 * sees the statement:
 *
 *     ERR_INVALID_ARG_TYPE — The "string" argument must be of type string or
 *     an instance of Buffer or ArrayBuffer. Received an instance of Date
 *
 * The whole statement fails. That is how `post_insights` and `video_insights`
 * stayed empty through every sync while each run still reported success: the
 * counters record what the service intended to write, not what Postgres
 * accepted.
 *
 * Drizzle's own comparison helpers (`eq`, `gte`, `lte`, `between`) serialise
 * `Date` correctly because they know the column type. This is only a hazard in
 * a hand-written `sql` fragment, where there is no column type to consult.
 *
 * ## Using it
 *
 *     sql`${posts.createdTime} >= ${tsParam(from)}::timestamptz`
 *
 * Keep the `::timestamptz` cast. Without it Postgres has to infer the type of a
 * bare text parameter, and in a `null` comparison it cannot.
 */
export function tsParam(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}
