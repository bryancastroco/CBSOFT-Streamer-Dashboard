import { Badge } from "@/components/ui/badge";
import {
  NOT_ANALYSED,
  sentimentLabel,
  sentimentTone,
  summaryStatusLabel,
  summaryStatusTone,
} from "@/lib/ai/presentation";

/**
 * Sentiment and summary-status badges.
 *
 * Both render "Not analysed" for a null rather than nothing at all: an empty
 * cell reads as a rendering bug, while the distinction between *not analysed*
 * and *analysed and found neutral* is one a reader needs.
 */

export function SentimentBadge({ sentiment }: { sentiment: string | null | undefined }) {
  const label = sentimentLabel(sentiment);

  if (label === NOT_ANALYSED) {
    return <span className="text-xs text-muted-foreground">{NOT_ANALYSED}</span>;
  }

  return (
    <Badge variant={sentimentTone(sentiment)} className="whitespace-nowrap">
      {label}
    </Badge>
  );
}

export function SummaryStatusBadge({ status }: { status: string | null | undefined }) {
  const label = summaryStatusLabel(status);

  if (label === NOT_ANALYSED) {
    return <span className="text-xs text-muted-foreground">{NOT_ANALYSED}</span>;
  }

  return (
    <Badge variant={summaryStatusTone(status)} className="whitespace-nowrap">
      {label}
    </Badge>
  );
}
