import { MessageSquareText, TriangleAlert } from "lucide-react";

import { EmptyState } from "@/components/layout/states";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NO_SIGNIFICANT_FINDINGS } from "@/lib/ai/contract";
import type { CommentOverview } from "@/lib/repositories/comment-overview";

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
function realFindings(items: readonly string[]): string[] {
  return items.filter((item) => item !== NO_SIGNIFICANT_FINDINGS && item.trim().length > 0);
}

function FindingList({ title, items }: { title: string; items: readonly string[] }) {
  const findings = realFindings(items);
  if (findings.length === 0) return null;

  return (
    <div className="space-y-2">
      <h4 className="text-xs font-medium text-muted-foreground">{title}</h4>
      <ul className="space-y-1.5">
        {findings.map((item, index) => (
          <li key={`${title}-${index}`} className="text-sm leading-snug">
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

const SENTIMENT_TONE: Record<string, string> = {
  positive: "text-emerald-600 dark:text-emerald-500",
  negative: "text-destructive",
  mixed: "text-amber-600 dark:text-amber-500",
  neutral: "text-muted-foreground",
};

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
                  {numberFormat.format(overview.contentInScope)} posts and videos
                </>
              ) : (
                <>
                  {numberFormat.format(overview.contentInScope)} post
                  {overview.contentInScope === 1 ? "" : "s"} and video
                  {overview.contentInScope === 1 ? "" : "s"}
                </>
              )}
              .
            </CardDescription>
          </div>

          <Badge variant="outline" className={SENTIMENT_TONE[analysis.sentiment] ?? ""}>
            {analysis.sentiment}
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="space-y-5">
        <p className="text-sm leading-relaxed">{analysis.summary}</p>

        {sentimentTotal > 0 ? (
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
            <span>
              <span className="font-medium text-emerald-600 dark:text-emerald-500">
                {numberFormat.format(sentiment.positive)}
              </span>{" "}
              positive
            </span>
            <span>
              <span className="font-medium text-amber-600 dark:text-amber-500">
                {numberFormat.format(sentiment.mixed)}
              </span>{" "}
              mixed
            </span>
            <span>
              <span className="font-medium">{numberFormat.format(sentiment.neutral)}</span> neutral
            </span>
            <span>
              <span className="font-medium text-destructive">
                {numberFormat.format(sentiment.negative)}
              </span>{" "}
              negative
            </span>
            <span className="text-muted-foreground/70">
              — per post, from stored analyses
            </span>
          </div>
        ) : null}

        {urgent.length > 0 ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3">
            <h4 className="flex items-center gap-2 text-xs font-medium text-destructive">
              <TriangleAlert className="size-3.5" aria-hidden />
              Flagged as urgent
            </h4>
            <ul className="mt-2 space-y-1.5">
              {urgent.map((item, index) => (
                <li key={`urgent-${index}`} className="text-sm leading-snug">
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
