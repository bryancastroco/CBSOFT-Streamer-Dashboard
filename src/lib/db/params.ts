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

/**
 * Reading timestamps back out of a raw `sql` fragment.
 *
 * The mirror image of `tsParam`, and the same blind spot in the other
 * direction. Drizzle converts a driver value into a `Date` using the *column's*
 * type, so a selected column arrives as a `Date`. A hand-written expression has
 * no column to consult, and whatever postgres.js returns is passed through
 * untouched — for `max(created_time)` that is the string
 * `2026-07-27 14:07:32+00`.
 *
 * The trap is that `sql<Date | null>` looks like it fixes this. It does not:
 * the generic is an assertion, so TypeScript believes a `Date` is there and
 * every consumer is typechecked against a lie. It surfaced as a production
 * crash on the streamer detail page —
 *
 *     RangeError: Invalid time value
 *
 * — because `Intl.DateTimeFormat.format()` coerces its argument with
 * `ToNumber`, a date string becomes `NaN`, and the whole page fails to render.
 * A `null` check does not help; the value is a non-empty string and passes it.
 *
 * ## Using it
 *
 * Declare the fragment as the `string` it actually is, then convert here:
 *
 *     latest: sql<string | null>`max(${posts.createdTime})`
 *     ...
 *     return { latest: tsResult(row?.latest) };
 *
 * `tests/raw-sql-timestamps.test.ts` fails the build on a `sql<Date…>`
 * selection, because that shape is never honest.
 */
export function tsResult(value: string | Date | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;

  const parsed = new Date(value);

  /*
   * An unparseable string becomes null rather than an Invalid Date. Both are
   * "we do not have a timestamp", but only one of them detonates three layers
   * away inside a formatter.
   */
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
