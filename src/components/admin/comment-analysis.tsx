import { SentimentBadge, SummaryStatusBadge } from "@/components/data/analysis-badges";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NO_SIGNIFICANT_FINDINGS } from "@/lib/ai/contract";
import { hasRealFindings, toFindingList } from "@/lib/ai/presentation";
import { formatDateTime } from "@/lib/time/zone";

/**
 * Presentation of a stored comment analysis.
 *
 * Shows the analysis, never the comments themselves: the report is the
 * deliverable, and rendering individual comments would put third-party text on
 * screen for no analytical gain. No commenter identity exists to show — none is
 * ever collected.
 */

export type CommentAnalysisView = {
  summary: string | null;
  sentiment: string | null;
  positivePoints: unknown;
  concerns: unknown;
  suggestions: unknown;
  questions: unknown;
  urgentIssues: unknown;
  commentCount: number;
  status: string;
  errorMessage: string | null;
  model: string | null;
  aiProvider: string | null;
  generatedAt: Date | null;
};

function formatWhen(value: Date | null): string {
  if (!value) return "Never";
  return formatDateTime(value);
}

function FindingList({ title, items }: { title: string; items: string[] }) {
  const empty = items.length === 0 || (items.length === 1 && items[0] === NO_SIGNIFICANT_FINDINGS);

  return (
    <div>
      <p className="mb-2 text-xs font-medium">{title}</p>
      {empty ? (
        <p className="text-xs text-muted-foreground italic">{NO_SIGNIFICANT_FINDINGS}</p>
      ) : (
        <ul className="list-disc space-y-1 pl-4 text-sm">
          {items.map((item, index) => (
            <li key={`${title}-${index}`}>{item}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function CommentAnalysis({
  analysis,
  actions,
  contentLabel = "item",
}: {
  analysis: CommentAnalysisView | null;
  actions?: React.ReactNode;
  /** "post" or "video" — the same card serves both content types. */
  contentLabel?: string;
}) {
  if (!analysis) {
    return (
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="text-base">Comment analysis</CardTitle>
              <CardDescription>
                No comments have been collected for this {contentLabel} yet.
              </CardDescription>
            </div>
            {actions}
          </div>
        </CardHeader>
      </Card>
    );
  }

  const urgent = toFindingList(analysis.urgentIssues);
  const hasUrgent = hasRealFindings(analysis.urgentIssues);

  return (
    <Card className={hasUrgent ? "border-destructive/50" : undefined}>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">Comment analysis</CardTitle>
            <CardDescription>
              {analysis.commentCount} comment{analysis.commentCount === 1 ? "" : "s"} analysed
              {analysis.generatedAt ? ` · ${formatWhen(analysis.generatedAt)}` : ""}
              {analysis.model && analysis.model !== "none" ? ` · ${analysis.model}` : ""}
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <SentimentBadge sentiment={analysis.sentiment} />
            <SummaryStatusBadge status={analysis.status} />
            {actions}
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-6">
        {analysis.status === "failed" ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3">
            <p className="text-xs font-medium">Analysis failed</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {analysis.errorMessage ?? "No detail was recorded."}
            </p>
          </div>
        ) : null}

        {analysis.summary ? (
          <div>
            <p className="mb-1 text-xs font-medium">Summary</p>
            <p className="text-sm">{analysis.summary}</p>
          </div>
        ) : null}

        {analysis.status === "completed" || analysis.status === "no_comments" ? (
          <div className="grid gap-6 sm:grid-cols-2">
            <FindingList title="Positive points" items={toFindingList(analysis.positivePoints)} />
            <FindingList title="Concerns" items={toFindingList(analysis.concerns)} />
            <FindingList title="Suggestions" items={toFindingList(analysis.suggestions)} />
            <FindingList title="Questions" items={toFindingList(analysis.questions)} />
            <div className="sm:col-span-2">
              <FindingList title="Urgent issues" items={urgent} />
            </div>
          </div>
        ) : null}

        <p className="text-xs text-muted-foreground">
          Generated from comment text only. Commenter names are never collected, stored, or shown.
        </p>
      </CardContent>
    </Card>
  );
}
