import { cn } from "@/lib/utils";
import { describeStatus, type StatusDomain, type StatusTone } from "@/lib/ui/status";

/**
 * The one badge that renders a status.
 *
 * Three signals every time — wording, glyph, tone — because colour alone
 * excludes anyone who cannot separate the hues and vanishes in a printed
 * report or a pasted screenshot. `src/lib/ui/status.ts` decides what a status
 * means; this decides only how it looks.
 */

const TONE_CLASSES: Record<StatusTone, string> = {
  success: "bg-success-subtle text-success-foreground border-success/25",
  warning: "bg-warning-subtle text-warning-foreground border-warning/30",
  danger: "bg-danger-subtle text-danger-foreground border-danger/25",
  info: "bg-info-subtle text-info-foreground border-info/25",
  neutral: "bg-neutral-status-subtle text-neutral-status-foreground border-border-strong/60",
};

type StatusBadgeProps = {
  domain: StatusDomain;
  status: string | null | undefined;
  /** Icon-only, for a dense table cell. The label stays for screen readers. */
  compact?: boolean;
  className?: string;
};

export function StatusBadge({ domain, status, compact = false, className }: StatusBadgeProps) {
  const { label, tone, icon: Icon, srHint, busy } = describeStatus(domain, status);

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border font-medium whitespace-nowrap",
        compact ? "size-6 justify-center p-0" : "px-2 py-0.5 text-xs",
        TONE_CLASSES[tone],
        className,
      )}
    >
      <Icon aria-hidden className={cn("size-3.5 shrink-0", busy && "motion-safe:animate-spin")} />
      {compact ? <span className="sr-only">{label}</span> : label}
      {/*
       * The hint is never shown. It exists so a screen reader gets the meaning
       * the tone carries for a sighted reader — that "completed with errors"
       * still produced usable data, for instance.
       */}
      {srHint ? <span className="sr-only">. {srHint}</span> : null}
    </span>
  );
}

/** Sync status, named for the common case so call sites read plainly. */
export function SyncStatusBadge(props: Omit<StatusBadgeProps, "domain">) {
  return <StatusBadge domain="sync" {...props} />;
}

export function TokenStatusBadge(props: Omit<StatusBadgeProps, "domain">) {
  return <StatusBadge domain="token" {...props} />;
}

export function AiStatusBadge(props: Omit<StatusBadgeProps, "domain">) {
  return <StatusBadge domain="ai" {...props} />;
}

export function SentimentBadge(props: Omit<StatusBadgeProps, "domain">) {
  return <StatusBadge domain="sentiment" {...props} />;
}
