import type { LucideIcon } from "lucide-react";
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  CircleDashed,
  CircleHelp,
  CircleMinus,
  Clock,
  KeyRound,
  Loader2,
  MessageSquareOff,
  Minus,
  ShieldAlert,
  ThumbsDown,
  ThumbsUp,
  TriangleAlert,
  XCircle,
} from "lucide-react";

/**
 * Every status in the product, described once.
 *
 * ## Why this exists
 *
 * Before this, a status became a colour in twenty-two separate places: an
 * inline `variant="destructive"` here, a `Record` in the sync-logs page there,
 * two bespoke badge components elsewhere. Nothing was wrong individually and
 * nothing agreed — `failed` was destructive in one table and secondary in
 * another, and several rendered colour with no icon or wording at all.
 *
 * A status has exactly three presentational facts: what to call it, what tone
 * it carries, and which glyph stands for it. They live here, keyed by the
 * database enum value, so a new enum member is a compile error at this table
 * rather than an unstyled badge discovered in production.
 *
 * ## Why an icon is not optional
 *
 * Colour alone excludes anyone who cannot distinguish the hues, and it
 * disappears entirely in a printed report or a screenshot pasted into a chat.
 * Every entry therefore carries a label *and* an icon; the tone is the third
 * signal, never the only one.
 *
 * Pure and framework-free: it maps values to descriptions and renders nothing.
 * `StatusBadge` does the rendering.
 */

/** The visual weight a status carries. Maps to the semantic colour tokens. */
export type StatusTone = "success" | "warning" | "danger" | "info" | "neutral";

export type StatusDescriptor = {
  /** Sentence-case, written for a reader rather than a database. */
  label: string;
  tone: StatusTone;
  icon: LucideIcon;
  /**
   * Expanded wording for screen readers, where the tone conveys nothing.
   * Only set where the label alone understates the situation.
   */
  srHint?: string;
  /** True while work is ongoing, so the badge can spin its icon. */
  busy?: boolean;
};

/** Health of a stored Facebook Page token. */
export const TOKEN_STATUS: Record<string, StatusDescriptor> = {
  valid: { label: "Valid", tone: "success", icon: CheckCircle2 },
  expiring: {
    label: "Expiring",
    tone: "warning",
    icon: Clock,
    srHint: "Valid now, but due to expire. Replace it before the next sync.",
  },
  expired: {
    label: "Expired",
    tone: "danger",
    icon: XCircle,
    srHint: "No longer accepted by Meta. This streamer will not sync.",
  },
  invalid: {
    label: "Invalid",
    tone: "danger",
    icon: ShieldAlert,
    srHint: "Rejected by Meta. The token may have been revoked.",
  },
  missing_permission: {
    label: "Missing permission",
    tone: "warning",
    icon: KeyRound,
    srHint: "The token works but lacks a permission this system needs.",
  },
  missing: {
    label: "Not connected",
    tone: "neutral",
    icon: CircleMinus,
    srHint: "No token has been supplied for this streamer yet.",
  },
  unknown: {
    label: "Unknown",
    tone: "neutral",
    icon: CircleHelp,
    srHint: "Not checked yet. Validate the token to find out.",
  },
};

/** Lifecycle of a synchronisation run. */
export const SYNC_STATUS: Record<string, StatusDescriptor> = {
  queued: { label: "Queued", tone: "neutral", icon: CircleDashed },
  processing: { label: "Processing", tone: "info", icon: Loader2, busy: true },
  completed: { label: "Completed", tone: "success", icon: CheckCircle2 },
  completed_with_errors: {
    label: "Completed with errors",
    tone: "warning",
    icon: TriangleAlert,
    /*
     * The distinction that matters operationally. Partial data is usable and
     * was exported; treating this as a plain failure would have people
     * discarding a run that mostly worked.
     */
    srHint: "Some streamers succeeded and some did not. The data that arrived was kept.",
  },
  failed: {
    label: "Failed",
    tone: "danger",
    icon: XCircle,
    srHint: "Nothing usable was produced by this run.",
  },
  cancelled: {
    label: "Cancelled",
    tone: "neutral",
    icon: Ban,
    srHint: "Stopped deliberately rather than by an error.",
  },
};

/** Lifecycle of an AI summarisation attempt. */
export const AI_STATUS: Record<string, StatusDescriptor> = {
  pending: { label: "Pending", tone: "neutral", icon: CircleDashed },
  processing: { label: "Processing", tone: "info", icon: Loader2, busy: true },
  completed: { label: "Completed", tone: "success", icon: CheckCircle2 },
  no_comments: {
    label: "No comments",
    tone: "neutral",
    icon: MessageSquareOff,
    /*
     * Not a failure, and the reason this is its own value: "nobody commented"
     * and "we could not summarise" are different facts about the content.
     */
    srHint: "There was nothing to summarise, which is not a failure.",
  },
  failed: { label: "Failed", tone: "danger", icon: AlertTriangle },
};

/**
 * Sentiment of a comment set.
 *
 * Deliberately not reusing the status tones for their own sake: negative
 * sentiment is a finding about an audience, not a fault in the system, so it
 * draws on the sentiment tokens rather than the error colour.
 */
export const SENTIMENT_STATUS: Record<string, StatusDescriptor> = {
  positive: { label: "Positive", tone: "success", icon: ThumbsUp },
  mixed: { label: "Mixed", tone: "warning", icon: Minus },
  neutral: { label: "Neutral", tone: "neutral", icon: Minus },
  negative: { label: "Negative", tone: "danger", icon: ThumbsDown },
  no_comments: { label: "No comments", tone: "neutral", icon: MessageSquareOff },
};

/**
 * Outcome of a dataset export run.
 *
 * Its own domain rather than a reuse of the sync statuses: `export_status` is a
 * two-value enum with no in-flight state, and borrowing the sync table would
 * offer a caller four labels this column can never hold.
 */
export const EXPORT_STATUS: Record<string, StatusDescriptor> = {
  succeeded: { label: "Succeeded", tone: "success", icon: CheckCircle2 },
  failed: { label: "Failed", tone: "danger", icon: XCircle },
};

/** The domains, so a caller names one rather than importing a table. */
export const STATUS_DOMAINS = {
  token: TOKEN_STATUS,
  sync: SYNC_STATUS,
  ai: AI_STATUS,
  sentiment: SENTIMENT_STATUS,
  export: EXPORT_STATUS,
} as const;

export type StatusDomain = keyof typeof STATUS_DOMAINS;

/**
 * Look up a status, tolerating a value the table has not seen.
 *
 * An unrecognised value renders as itself with a neutral tone rather than
 * throwing or rendering nothing. A migration that adds an enum member should
 * be caught by the tests, but a half-deployed one must not blank a page.
 */
export function describeStatus(domain: StatusDomain, value: string | null | undefined) {
  if (!value) {
    return { label: "Unknown", tone: "neutral", icon: CircleHelp } satisfies StatusDescriptor;
  }

  return (
    STATUS_DOMAINS[domain][value] ?? {
      label: value.replace(/_/g, " "),
      tone: "neutral" as const,
      icon: CircleHelp,
    }
  );
}
