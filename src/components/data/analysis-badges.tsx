import { StatusBadge } from "@/components/ui/status-badge";
import { NOT_ANALYSED, sentimentLabel, summaryStatusLabel } from "@/lib/ai/presentation";

/**
 * Sentiment and summary-status badges.
 *
 * These now delegate to `StatusBadge`, which is the single place a status
 * becomes a colour. They previously rendered their own `Badge` with their own
 * tone mapping, so the same sentiment looked one way here and another way on
 * the dashboard — and neither carried an icon, leaving colour as the only
 * signal for anyone who could not read the wording alone.
 *
 * They survive as named wrappers rather than being deleted because the call
 * sites read better for it: `<SentimentBadge sentiment={…} />` says what it is
 * at a glance, and the domain argument cannot be got wrong.
 *
 * Both still render "Not analysed" as plain text for a null. An empty cell
 * reads as a rendering fault, and the difference between *not analysed* and
 * *analysed and found neutral* is one the reader needs.
 */

export function SentimentBadge({ sentiment }: { sentiment: string | null | undefined }) {
  if (sentimentLabel(sentiment) === NOT_ANALYSED) {
    return <span className="text-xs text-muted-foreground">{NOT_ANALYSED}</span>;
  }

  return <StatusBadge domain="sentiment" status={sentiment} />;
}

export function SummaryStatusBadge({ status }: { status: string | null | undefined }) {
  if (summaryStatusLabel(status) === NOT_ANALYSED) {
    return <span className="text-xs text-muted-foreground">{NOT_ANALYSED}</span>;
  }

  return <StatusBadge domain="ai" status={status} />;
}
