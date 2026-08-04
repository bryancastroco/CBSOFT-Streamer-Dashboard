import "server-only";

import { z } from "zod";

/**
 * Server-side environment contract.
 *
 * This module is `server-only`. It is the single place where secrets are read.
 * Nothing here may ever be imported from a Client Component — doing so is a
 * build error, which is exactly the guard rail we want around
 * `SUPABASE_SERVICE_ROLE_KEY`, `META_APP_SECRET` and `TOKEN_ENCRYPTION_KEY`.
 *
 * Public values live in `src/config/public-env.ts` and are the only values
 * allowed to reach the browser.
 */

const nonEmpty = (name: string) => z.string().min(1, `${name} is required`);

/** A 32-byte key, provided as 64 hex chars or 44-char standard base64. */
const encryptionKeySchema = nonEmpty("TOKEN_ENCRYPTION_KEY").refine((value) => {
  if (/^[0-9a-fA-F]{64}$/.test(value)) return true;
  if (/^[A-Za-z0-9+/]{43}=$/.test(value)) return true;
  return false;
}, "TOKEN_ENCRYPTION_KEY must be a 32-byte key encoded as 64 hex characters or 44-character base64");

const serverEnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

    // Supabase
    NEXT_PUBLIC_SUPABASE_URL: nonEmpty("NEXT_PUBLIC_SUPABASE_URL").pipe(z.url()),
    NEXT_PUBLIC_SUPABASE_ANON_KEY: nonEmpty("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    SUPABASE_SERVICE_ROLE_KEY: nonEmpty("SUPABASE_SERVICE_ROLE_KEY"),

    // ---------------------------------------------------------------------------
    // Application identity — browser-visible, and deliberately so
    // ---------------------------------------------------------------------------

    NEXT_PUBLIC_APP_NAME: z.string().min(1).default("CBSOFT Streamer Performance Dashboard"),

    /**
     * The canonical production origin, e.g. `https://cbsoft.example.com`.
     *
     * Optional, and optional on purpose. A preview deployment has no stable
     * hostname — Vercel mints a new one per commit — so requiring this would
     * either fail every preview or force one preview's URL to be baked in as the
     * canonical one, which is worse than having none. `resolveAppOrigin()` in
     * `src/lib/config/app-origin.ts` falls back to `VERCEL_URL` for previews and
     * localhost for development.
     *
     * Trailing slash is rejected rather than trimmed: a value that round-trips
     * differently from what was typed is a bug waiting to be debugged at 2am.
     */
    NEXT_PUBLIC_APP_URL: z
      .string()
      .pipe(z.url())
      .refine((value) => !value.endsWith("/"), "NEXT_PUBLIC_APP_URL must not end with a slash")
      .optional(),

    // Database (Drizzle / direct Postgres access)
    DATABASE_URL: nonEmpty("DATABASE_URL").startsWith("postgres"),

    // Meta Graph API — server-side use only
    META_APP_ID: nonEmpty("META_APP_ID"),
    META_APP_SECRET: nonEmpty("META_APP_SECRET"),
    META_GRAPH_API_VERSION: z
      .string()
      .regex(/^v\d+\.\d+$/, "META_GRAPH_API_VERSION must look like v25.0")
      .default("v25.0"),

    // Page-token encryption at rest
    TOKEN_ENCRYPTION_KEY: encryptionKeySchema,

    /**
     * AI — comment summarisation.
     *
     * Optional here, and required conditionally below: the key is only needed
     * when `AI_SUMMARIZATION_ENABLED` is true. Making it unconditionally required
     * meant a deployment that had deliberately switched AI off still refused to
     * start without a credential it would never use — so the kill switch could
     * not actually be used to run without Anthropic, which was its entire point.
     */
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    AI_PROVIDER: z.enum(["anthropic", "gemini", "offline"]).default("anthropic"),
    /**
     * Overridable so a model can be changed without a deploy. Defaults to the
     * current Opus — summarising a few hundred comments into themes is a
     * judgement task, not an extraction one.
     */
    ANTHROPIC_MODEL: z.string().min(1).default("claude-opus-5"),

    /** Gemini. Free tier, which is why it exists as an option here. */
    GEMINI_API_KEY: z.string().min(1).optional(),
    /*
     * An alias, not a pinned id, and deliberately so.
     *
     * Google retires model ids and restricts others to existing accounts, so a
     * pinned name is a default with an expiry date — `gemini-2.5-flash` was
     * correct when written and rejected weeks later. `gemini-flash-latest`
     * tracks the current flash variant, which is the right tier for comment
     * analysis: short inputs, high volume, structured output, no reasoning
     * requirement.
     *
     * If even this is unusable for a given key, the provider discovers a
     * working model from the API rather than failing.
     */
    GEMINI_MODEL: z.string().min(1).default("gemini-flash-latest"),

    /**
     * Fall back to in-process analysis when the provider cannot answer.
     *
     * A rate limit or an empty balance then costs the prose summary rather than
     * the whole analysis. Off means a provider failure is stored as a failure.
     */
    AI_OFFLINE_FALLBACK: z.coerce.boolean().default(true),

    // -------------------------------------------------------------------------
    // Synchronisation defaults
    //
    // Every one of these is a ceiling on how much a single sweep will do. They
    // exist because the two scarce resources — Meta's per-app rate limit and
    // Anthropic tokens — are both spent by this system on a schedule nobody
    // watches. A sweep with no bounds is one misconfiguration away from
    // exhausting either.
    // -------------------------------------------------------------------------

    /**
     * How far back a scheduled sweep looks for content.
     *
     * A sweep is incremental by intent: last night's run already collected
     * everything older. The window exists so a run that has been failing for a
     * few days catches up when it recovers, rather than walking a Page's entire
     * history every night.
     */
    CONTENT_SYNC_LOOKBACK_DAYS: z.coerce.number().int().min(1).max(365).default(30),

    /** Posts collected per streamer per sweep. */
    MAX_POSTS_PER_STREAMER: z.coerce.number().int().min(1).max(1000).default(100),

    /** Videos collected per streamer per sweep. */
    MAX_VIDEOS_PER_STREAMER: z.coerce.number().int().min(1).max(1000).default(100),

    /**
     * Ceiling on comments fetched per post or video. Meta pages 25–100 at a
     * time; without a cap a viral post could pull tens of thousands of comments
     * into one AI request.
     */
    MAX_COMMENTS_PER_CONTENT: z.coerce.number().int().min(1).max(5000).default(500),

    /**
     * How often the scheduled sweep is expected to run.
     *
     * Not a scheduler — Vercel Cron and n8n own the timing. This is the
     * application's view of the cadence, used to decide whether a cron
     * invocation is too soon after the last one, and to tell an operator on the
     * Settings page when the next run is due.
     */
    /**
     * Streamers one sweep invocation may process before handing back.
     *
     * The ceiling that keeps a roster-wide sweep inside a single serverless
     * function window. Vercel kills a function at `maxDuration`, and work handed
     * to `after()` is bounded by the same limit — so a roster larger than one
     * window must be advanced across several invocations rather than attempted in
     * one. n8n (or the cron route) calls the sweep again with the same run id
     * until `remaining` reaches zero.
     *
     * Raise it only if a slice reliably finishes well inside the function limit.
     */
    MAX_STREAMERS_PER_SYNC: z.coerce.number().int().min(1).max(200).default(5),

    SYNC_FREQUENCY_HOURS: z.coerce.number().int().min(1).max(168).default(6),

    /**
     * The kill switch for AI spend.
     *
     * When false, comments are still collected and stored — that costs only Meta
     * quota — but no summary is generated and no Anthropic call is made. Set it
     * false to keep the pipeline running while a billing problem is sorted out,
     * rather than disabling the whole sweep.
     */
    AI_SUMMARIZATION_ENABLED: z
      .enum(["true", "false"])
      .default("true")
      .transform((value) => value === "true"),

    // Machine-to-machine callers
    CRON_SECRET: nonEmpty("CRON_SECRET").min(32, "CRON_SECRET must be at least 32 characters"),
    N8N_API_SECRET: nonEmpty("N8N_API_SECRET").min(
      32,
      "N8N_API_SECRET must be at least 32 characters",
    ),

    // Feature flags
    GOOGLE_SHEETS_EXPORT_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
  })
  .superRefine((env, ctx) => {
    /*
     * Cross-field rule, expressible only once both fields are parsed.
     *
     * The message names the key and never touches a value — the same rule the
     * rest of this module follows, and the reason `getServerEnvSafe` can report
     * what is missing without publishing anything.
     */
    /*
     * Which key is required depends on which provider is selected. Demanding
     * an Anthropic key on a deployment configured for Gemini would refuse to
     * boot over a credential it will never use.
     *
     * `offline` needs no key at all — that is the entire point of it.
     */
    if (env.AI_SUMMARIZATION_ENABLED && env.AI_PROVIDER === "anthropic" && !env.ANTHROPIC_API_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["ANTHROPIC_API_KEY"],
        message:
          "ANTHROPIC_API_KEY is required while AI_SUMMARIZATION_ENABLED is true and " +
          "AI_PROVIDER is anthropic. Set the key, switch AI_PROVIDER to gemini or offline, " +
          "or set AI_SUMMARIZATION_ENABLED=false to run without AI.",
      });
    }

    if (env.AI_SUMMARIZATION_ENABLED && env.AI_PROVIDER === "gemini" && !env.GEMINI_API_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["GEMINI_API_KEY"],
        message:
          "GEMINI_API_KEY is required while AI_SUMMARIZATION_ENABLED is true and " +
          "AI_PROVIDER is gemini. Create one free at aistudio.google.com, or switch " +
          "AI_PROVIDER to offline to analyse comments without a provider.",
      });
    }
  });

export type ServerEnv = z.infer<typeof serverEnvSchema>;

let cached: ServerEnv | null = null;

/**
 * Parse and cache the server environment.
 *
 * Deliberately lazy: importing this module must not crash a build that has no
 * secrets available (Vercel build step, CI type-check, `next build` locally).
 * Call it from the request path instead, where a missing secret is a real fault.
 */
export function getServerEnv(): ServerEnv {
  if (cached) return cached;

  const parsed = serverEnvSchema.safeParse(process.env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");

    // Never interpolate values — only keys and messages.
    throw new Error(`Invalid server environment configuration:\n${issues}`);
  }

  cached = parsed.data;
  return cached;
}

/**
 * Non-throwing variant, for health checks and the settings page, which want to
 * report "misconfigured" rather than crash the render.
 */
export function getServerEnvSafe():
  { ok: true; env: ServerEnv } | { ok: false; missingKeys: string[] } {
  const parsed = serverEnvSchema.safeParse(process.env);

  if (parsed.success) {
    cached = parsed.data;
    return { ok: true, env: parsed.data };
  }

  const missingKeys = [
    ...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || "(root)")),
  ];

  return { ok: false, missingKeys };
}
