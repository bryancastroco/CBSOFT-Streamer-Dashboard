import "server-only";

import { getServerEnvSafe } from "@/config/env";

/**
 * Configuration, described for a screen without leaking any of it.
 *
 * ## The rule this file exists to enforce
 *
 * An admin screen showing configuration is one `{value}` away from rendering a
 * secret into HTML. So a secret is never a value here — it is a **boolean**.
 * `TOKEN_ENCRYPTION_KEY` becomes `configured: true`, and there is no code path
 * that turns it back into a string.
 *
 * Values that are genuinely public do carry their value: the Meta app id is on
 * every Graph URL, the API version is in the docs, the model name is in
 * Anthropic's price list, and a numeric batch size is not a credential. Hiding
 * those would cost an operator the answer they came for and protect nothing.
 *
 * ## Why every row names its source
 *
 * Every value here comes from an environment variable, which is deliberate —
 * see `docs/ARCHITECTURE.md`. An admin looking at "Sync frequency: 6 hours" and
 * wanting 4 needs to know the answer is in Vercel, not in a field on this page
 * that does not exist. The `source` is what makes a read-only screen actionable
 * rather than merely informative.
 */

export type SettingKind = "value" | "secret" | "flag";

export type SettingRow = {
  label: string;
  /** Populated for public values. Always null for a secret. */
  value: string | null;
  /** For a secret: whether it is present. For a flag: whether it is on. */
  present?: boolean;
  kind: SettingKind;
  /** Where the value comes from, so a reader knows where to change it. */
  source: string;
  /** What it does, in one line. */
  hint?: string;
};

export type SettingsSection = {
  title: string;
  description: string;
  rows: SettingRow[];
};

const numberFormat = new Intl.NumberFormat("en-GB");

function value(
  label: string,
  raw: string | number | null | undefined,
  source: string,
  hint?: string,
): SettingRow {
  return {
    label,
    value:
      raw === null || raw === undefined
        ? null
        : typeof raw === "number"
          ? numberFormat.format(raw)
          : raw,
    kind: "value",
    source,
    ...(hint ? { hint } : {}),
  };
}

/** A credential. The value never travels; only whether one is set. */
function secret(label: string, raw: string | undefined | null, source: string, hint?: string): SettingRow {
  return {
    label,
    value: null,
    present: typeof raw === "string" && raw.length > 0,
    kind: "secret",
    source,
    ...(hint ? { hint } : {}),
  };
}

function flag(label: string, on: boolean, source: string, hint?: string): SettingRow {
  return {
    label,
    value: on ? "Enabled" : "Disabled",
    present: on,
    kind: "flag",
    source,
    ...(hint ? { hint } : {}),
  };
}

export type ConfigurationView = {
  ok: boolean;
  /** Env keys the schema rejected. Empty when configuration is valid. */
  missingKeys: string[];
  meta: SettingsSection | null;
  ai: SettingsSection | null;
  automation: SettingsSection | null;
  sheets: SettingsSection | null;
  general: SettingsSection | null;
};

/**
 * Read configuration once and shape it for all five admin screens.
 *
 * Uses the *safe* accessor deliberately. `getServerEnv()` throws when a key is
 * missing, and the screen whose entire job is to report configuration problems
 * is the worst possible place to crash on one.
 */
export function describeConfiguration(): ConfigurationView {
  const parsed = getServerEnvSafe();

  if (!parsed.ok) {
    return {
      ok: false,
      missingKeys: parsed.missingKeys,
      meta: null,
      ai: null,
      automation: null,
      sheets: null,
      general: null,
    };
  }

  const env = parsed.env;
  const raw = process.env;

  return {
    ok: true,
    missingKeys: [],

    meta: {
      title: "Meta app",
      description:
        "The Facebook app every Graph call is made through. Page tokens are stored per streamer, encrypted, and never leave the server.",
      rows: [
        value("App ID", env.META_APP_ID, "META_APP_ID", "Public — it appears in every Graph request."),
        secret(
          "App secret",
          env.META_APP_SECRET,
          "META_APP_SECRET",
          "Used to build the app proof for token inspection. Never sent to the browser.",
        ),
        value(
          "Graph API version",
          env.META_GRAPH_API_VERSION,
          "META_GRAPH_API_VERSION",
          "Metric availability changes between versions — see the metric registry.",
        ),
        secret(
          "Token encryption key",
          env.TOKEN_ENCRYPTION_KEY,
          "TOKEN_ENCRYPTION_KEY",
          "AES-256-GCM key for Page tokens at rest. Rotating it invalidates every stored token.",
        ),
      ],
    },

    ai: {
      title: "Comment summarisation",
      description:
        "Summaries are generated only when a content item's comment set has actually changed, so an unchanged post costs nothing.",
      rows: [
        flag(
          "Summarisation",
          env.AI_SUMMARIZATION_ENABLED,
          "AI_SUMMARIZATION_ENABLED",
          "When disabled, comments are still collected but never sent to a model.",
        ),
        value("Provider", env.AI_PROVIDER, "AI_PROVIDER"),
        value(
          "Model",
          env.ANTHROPIC_MODEL,
          "ANTHROPIC_MODEL",
          "Change this to move between cost and capability tiers.",
        ),
        secret(
          "API key",
          env.ANTHROPIC_API_KEY,
          "ANTHROPIC_API_KEY",
          "Without it, summarisation fails and every analysis reports an error.",
        ),
        value(
          "Comments per item",
          env.MAX_COMMENTS_PER_CONTENT,
          "MAX_COMMENTS_PER_CONTENT",
          "The ceiling on how many comments are collected for one post or video.",
        ),
      ],
    },

    automation: {
      title: "Machine access",
      description:
        "n8n reaches this system only through authenticated /api/automation endpoints. It is given no database, Supabase or Meta credentials.",
      rows: [
        secret(
          "n8n bearer secret",
          raw["N8N_API_SECRET"],
          "N8N_API_SECRET",
          "Compared in constant time. Without it every automation endpoint answers 503.",
        ),
        secret(
          "Cron secret",
          env.CRON_SECRET,
          "CRON_SECRET",
          "Authenticates Vercel's scheduler against /api/cron/*.",
        ),
        value(
          "Streamers per sweep",
          env.MAX_STREAMERS_PER_SYNC,
          "MAX_STREAMERS_PER_SYNC",
          "How many streamers one invocation may process before handing back a cursor.",
        ),
      ],
    },

    sheets: {
      title: "Export",
      description:
        "Google Sheets is a destination, never a source. This application does not read from it and holds no Google credentials — writing the rows is n8n's job.",
      rows: [
        flag(
          "Sheets export",
          env.GOOGLE_SHEETS_EXPORT_ENABLED,
          "GOOGLE_SHEETS_EXPORT_ENABLED",
          "A hint to the workflow. The export endpoints answer either way.",
        ),
        value("Application URL", env.NEXT_PUBLIC_APP_URL, "NEXT_PUBLIC_APP_URL", "The base n8n calls."),
      ],
    },

    general: {
      title: "Synchronisation defaults",
      description:
        "The ceilings a scheduled sweep runs to. Each is a safety valve — a sweep is incremental by intent, and these stop one run from walking a Page's entire history.",
      rows: [
        value(
          "Sync frequency",
          `${env.SYNC_FREQUENCY_HOURS} hours`,
          "SYNC_FREQUENCY_HOURS",
          "How often the scheduled sweep is expected to run.",
        ),
        value(
          "Content lookback",
          `${env.CONTENT_SYNC_LOOKBACK_DAYS} days`,
          "CONTENT_SYNC_LOOKBACK_DAYS",
          "How far back a sweep asks for content when no explicit date is given.",
        ),
        value("Posts per streamer", env.MAX_POSTS_PER_STREAMER, "MAX_POSTS_PER_STREAMER"),
        value("Videos per streamer", env.MAX_VIDEOS_PER_STREAMER, "MAX_VIDEOS_PER_STREAMER"),
        value("Comments per item", env.MAX_COMMENTS_PER_CONTENT, "MAX_COMMENTS_PER_CONTENT"),
        value("Environment", env.NODE_ENV, "NODE_ENV"),
        value("Workspace name", env.NEXT_PUBLIC_APP_NAME, "NEXT_PUBLIC_APP_NAME"),
      ],
    },
  };
}
