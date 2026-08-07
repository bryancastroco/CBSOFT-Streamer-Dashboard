import { z } from "zod";

/**
 * The query contract shared by every export endpoint — a PURE module.
 *
 * One parser for all seven datasets, so `updated_after` means the same thing
 * everywhere and a workflow written against one export works against the next.
 *
 * Unlike the browser-facing filters in `lib/filters/browse.ts`, this parser
 * **rejects** bad input rather than falling back. A person mistyping a date in a
 * URL bar should still see a page; a scheduled workflow silently receiving the
 * wrong window would write wrong rows into a spreadsheet every night, and nobody
 * would notice until the numbers were questioned. Failing loudly is the whole
 * point of a machine interface.
 */

export const EXPORT_DEFAULT_LIMIT = 500;
export const EXPORT_MAX_LIMIT = 1000;

/**
 * Accepts a full ISO 8601 instant or a bare `YYYY-MM-DD`.
 *
 * A date alone is interpreted as midnight UTC, which is what somebody typing
 * `2026-07-01` into an n8n parameter means. The transform is explicit so the
 * interpretation is visible rather than an accident of `new Date()`.
 */
const instant = z
  .string()
  .trim()
  .min(1)
  .transform((value, ctx) => {
    const normalised = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value;
    const parsed = new Date(normalised);

    if (Number.isNaN(parsed.getTime())) {
      ctx.addIssue({
        code: "custom",
        message: `"${value}" is not a valid ISO 8601 timestamp or YYYY-MM-DD date.`,
      });
      return z.NEVER;
    }

    return parsed;
  });

/**
 * The incremental checkpoint, kept as **text**.
 *
 * This one is deliberately not turned into a `Date`. Postgres stores
 * `timestamptz` at microsecond precision, and a JavaScript `Date` holds only
 * milliseconds — so parsing `…:50.921456Z` into a `Date` and binding that would
 * compare against `…:50.921000`, and the boundary rows would come back on every
 * single run.
 *
 * Worse than a cosmetic off-by-one: a bulk upsert stamps every row it writes
 * with the same transaction timestamp, so re-delivering "the boundary row"
 * means re-delivering the whole of the previous batch, and the incremental
 * filter stops doing anything useful.
 *
 * So the string is validated here and handed to Postgres as `$1::timestamptz`,
 * which parses it at full precision — the same precision it stored.
 */
const instantText = z
  .string()
  .trim()
  .min(1)
  .transform((value, ctx) => {
    const normalised = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value;

    // Validated by parsing, but the ORIGINAL text is what is returned.
    if (Number.isNaN(new Date(normalised).getTime())) {
      ctx.addIssue({
        code: "custom",
        message: `"${value}" is not a valid ISO 8601 timestamp or YYYY-MM-DD date.`,
      });
      return z.NEVER;
    }

    return normalised;
  });

export const exportQuerySchema = z
  .object({
    /**
     * Incremental checkpoint. Rows whose watermark is strictly greater are
     * returned — strictly, not inclusively, so feeding back the previous run's
     * `max_watermark` cannot re-deliver the boundary rows.
     */
    updated_after: instantText.optional(),
    /**
     * Inclusive content-date window. Filters on when the content happened.
     *
     * A bare `YYYY-MM-DD` is read as **midnight UTC**, deliberately, and does
     * not follow the dashboard's display zone. The screens moved to GMT+8
     * because a person reads them; this is a machine contract with a documented
     * meaning that n8n workflows already depend on, and silently reinterpreting
     * a parameter by eight hours would shift the boundary of every incremental
     * export without anything failing. Changing it is a contract change, and
     * belongs in `docs/N8N-AUTOMATION.md` first.
     */
    from: instant.optional(),
    to: instant.optional(),
    streamer_id: z.uuid("streamer_id must be a UUID.").optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(EXPORT_MAX_LIMIT, `limit cannot exceed ${EXPORT_MAX_LIMIT}.`)
      .default(EXPORT_DEFAULT_LIMIT),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .refine((query) => !query.from || !query.to || query.from.getTime() <= query.to.getTime(), {
    message: "`from` must not be later than `to`.",
    path: ["from"],
  });

export type ExportQuery = z.infer<typeof exportQuerySchema>;

export type ExportQueryResult =
  { ok: true; query: ExportQuery } | { ok: false; issues: { field: string; message: string }[] };

/**
 * Parse the query string of an export request.
 *
 * Unknown parameters are ignored rather than rejected: n8n adds its own on
 * occasion, and a workflow should not break because a transport appended
 * something harmless.
 */
export function parseExportQuery(url: URL): ExportQueryResult {
  const raw = Object.fromEntries(url.searchParams);
  const parsed = exportQuerySchema.safeParse(raw);

  if (parsed.success) return { ok: true, query: parsed.data };

  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => ({
      field: issue.path.join(".") || "(query)",
      message: issue.message,
    })),
  };
}

/** The filter block echoed back in the envelope, so a caller can see what was applied. */
export function describeFilters(query: ExportQuery) {
  return {
    // Echoed verbatim rather than round-tripped through a Date, so a
    // microsecond-precise checkpoint appears exactly as it was applied.
    updated_after: query.updated_after ?? null,
    from: query.from?.toISOString() ?? null,
    to: query.to?.toISOString() ?? null,
    streamer_id: query.streamer_id ?? null,
  };
}
