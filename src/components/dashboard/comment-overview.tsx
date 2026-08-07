import { MessageSquareText, TriangleAlert } from "lucide-react";

import { EmptyState } from "@/components/layout/states";
import { Badge } from "@/components/ui/badge";
import { SentimentBadge } from "@/components/ui/status-badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NO_SIGNIFICANT_FINDINGS } from "@/lib/ai/contract";
import type { CommentOverview } from "@/lib/repositories/comment-overview";
import { describeStatus } from "@/lib/ui/status";

/** Rendered in a fixed order so the row reads the same on every screen. */
const SENTIMENT_ORDER = ["positive", "mixed", "neutral", "negative"] as const;

/**
 * What everyone is saying, across the current filter selection.
 *
 * ## Why the placeholders are stripped rather than rendered
 *
 * `analyseOffline` fills every list, using "No significant findings" where it
 * found nothing, because the per-item contract wants a complete shape. Repeated
 * five times down a dashboard panel that reads as a broken feature rather than
 * as an empty one, so a list with nothing in it is omitted entirely and the
 * card says so once.
 */

const numberFormat = new Intl.NumberFormat("en-GB");

/** Entries that are the analyser's "nothing here" marker rather than findings. */
/**
 * What the reading actually covered, named.
 *
 * This caption said "posts and videos" regardless of the Content filter. With
 * Content set to Posts it was claiming coverage the reading did not have — and
 * a caption's whole job here is to let somebody check where a finding could
 * have come from, which is exactly the question asked when one looks wrong.
 */
function scopeNoun(overview: CommentOverview): string {
  const plural = overview.contentInScope === 1 ? "" : "s";

  if (overview.scope === "posts") return `post${plural}`;
  if (overview.scope === "videos") return `video${plural}`;
  return `post${plural} and video${plural}`;
}

function realFindings(items: readonly string[]): string[] {
  return items.filter((item) => item !== NO_SIGNIFICANT_FINDINGS && item.trim().length > 0);
}

function FindingList({ title, items }: { title: string; items: readonly string[] }) {
  const findings = realFindings(items);
  if (findings.length === 0) return null;

  return (
    <div className="space-y-2">
      <h4 className="text-xs font-medium text-muted-foreground">{title}</h4>
      {/*
       * `list-disc pl-4` matches the per-post analysis card exactly. Tailwind's
       * reset strips list markers, so a bare `<ul>` renders as unmarked lines —
       * which reads as prose that happens to be wrapped oddly rather than as a
       * list of distinct findings, and looked like the model had failed to
       * separate them.
       */}
      <ul className="list-disc space-y-1 pl-4 text-sm">
        {findings.map((item, index) => (
          <li key={`${title}-${index}`} className="leading-snug">
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function CommentOverviewPanel({ overview }: { overview: CommentOverview }) {
  if (overview.analysed === 0) {
    return (
      <EmptyState
        title="No comments in this selection"
        description="Widen the period, or choose a different streamer or content type."
      />
    );
  }

  const { analysis, sentiment } = overview;
  const urgent = realFindings(analysis.urgent_issues);

  const sentimentTotal =
    sentiment.positive + sentiment.neutral + sentiment.negative + sentiment.mixed;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2 text-base">
              <MessageSquareText className="size-4" aria-hidden />
              Across everything selected
            </CardTitle>
            <CardDescription>
              {numberFormat.format(overview.analysed)} comment
              {overview.analysed === 1 ? "" : "s"} from{" "}
              {/*
               * Truncation is stated, never hidden. A reading that silently
               * covers a fifth of its stated scope is worse than one that says
               * so, because nothing on screen would give the reader a clue.
               */}
              {overview.truncated ? (
                <>
                  the {numberFormat.format(overview.contentSampled)} most recent of{" "}
                  {numberFormat.format(overview.contentInScope)} {scopeNoun(overview)}
                </>
              ) : (
                <>
                  {numberFormat.format(overview.contentInScope)} {scopeNoun(overview)}
                </>
              )}
              .
            </CardDescription>
          </div>

          <div className="flex items-center gap-2">
            {/*
             * The system's own badge, not a hand-rolled one. It carries three
             * signals — wording, glyph and tone — where the ad-hoc version this
             * replaces carried colour alone, and it read as a different product
             * from every other status on the page.
             */}
            <SentimentBadge status={analysis.sentiment} />
            <Badge variant="outline" className="font-normal">
              {overview.provider === "offline" ? "counted" : overview.provider}
            </Badge>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-5">
        <p className="text-sm leading-relaxed">{analysis.summary}</p>

        {sentimentTotal > 0 ? (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            {SENTIMENT_ORDER.map((key) => (
              <span key={key} className="inline-flex items-center gap-1.5 text-xs">
                {/* The same variables the sentiment pie fills its slices with,
                    so the two readings of the same data cannot disagree. */}
                <span
                  aria-hidden
                  className="size-2.5 rounded-full"
                  style={{ background: `var(--sentiment-${key})` }}
                />
                <span className="font-medium">{numberFormat.format(sentiment[key])}</span>
                <span className="text-muted-foreground">
                  {describeStatus("sentiment", key).label}
                </span>
              </span>
            ))}
            <span className="text-xs text-muted-foreground">per post, from stored analyses</span>
          </div>
        ) : null}

        {/* `danger-subtle` and `danger-foreground` are the tokens the status
            badges use. The Tailwind palette classes this replaces were a
            second, slightly different red on the same screen. */}
        {urgent.length > 0 ? (
          <div className="rounded-md border border-danger/25 bg-danger-subtle p-3">
            <h4 className="flex items-center gap-2 text-xs font-medium text-danger-foreground">
              <TriangleAlert className="size-3.5" aria-hidden />
              Flagged as urgent
            </h4>
            <ul className="mt-2 list-disc space-y-1 pl-4 text-sm">
              {urgent.map((item, index) => (
                <li key={`urgent-${index}`} className="leading-snug">
                  {item}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="grid gap-5 sm:grid-cols-2">
          <FindingList title="What is being talked about" items={analysis.positive_points} />
          <FindingList title="Concerns" items={analysis.concerns} />
          <FindingList title="Questions being asked" items={analysis.questions} />
          <FindingList title="Suggestions" items={analysis.suggestions} />
        </div>
      </CardContent>
    </Card>
  );
}
