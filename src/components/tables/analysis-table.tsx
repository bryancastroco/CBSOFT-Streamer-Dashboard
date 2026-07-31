import { Fragment } from "react";
import Link from "next/link";
import { AlertTriangle, Eye, ExternalLink, FileText, Video } from "lucide-react";

import { SentimentBadge, SummaryStatusBadge } from "@/components/data/analysis-badges";
import { SortableHeader } from "@/components/data/sortable-header";
import { EmptyTableRow } from "@/components/data/states";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { NO_SIGNIFICANT_FINDINGS } from "@/lib/ai/contract";
import { realFindings } from "@/lib/ai/presentation";
import { contentHref } from "@/lib/comments/content-ref";
import type { BrowseQuery } from "@/lib/filters/browse";
import type { AnalysisSortKey, SortState } from "@/lib/filters/sorting";
import type { AnalysisListItem } from "@/lib/repositories/analysis";

/**
 * The comment-analysis table, used by `/comment-analysis` and by the Comment
 * Analysis tab of a streamer.
 *
 * Each analysis occupies two rows: a scannable, sortable row of facts, and a
 * full-width detail row holding the summary and the four finding lists. A
 * summary plus four lists does not fit in table cells at any useful width, and
 * truncating them would hide the part of the report people actually read.
 *
 * Nothing here renders a comment. The analysis is the deliverable, and no
 * commenter identity exists to show — none is ever collected.
 */

export const ANALYSIS_DEFAULT_SORT: SortState<AnalysisSortKey> = {
  key: "generatedAt",
  direction: "desc",
};

function formatWhen(value: Date | null): string {
  if (!value) return "Never";
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(value);
}

function contentLabel(item: AnalysisListItem, limit = 90): string {
  const fallback = item.contentType === "video" ? "Untitled video" : "Untitled post";
  if (!item.contentTitle) return fallback;

  const trimmed = item.contentTitle.replace(/\s+/g, " ").trim();
  if (trimmed.length === 0) return fallback;
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

/**
 * One finding list.
 *
 * Always rendered, even when empty, so the four categories stay in the same
 * place from row to row — a reader scanning for concerns should not have to work
 * out which columns collapsed on this particular analysis.
 */
function FindingColumn({
  heading,
  items,
  tone = "default",
}: {
  heading: string;
  items: readonly string[];
  tone?: "default" | "danger";
}) {
  return (
    <div>
      <p
        className={
          tone === "danger"
            ? "mb-1 text-xs font-medium text-destructive"
            : "mb-1 text-xs font-medium"
        }
      >
        {heading}
        {items.length > 0 ? (
          <span className="ml-1 font-normal text-muted-foreground">({items.length})</span>
        ) : null}
      </p>
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">{NO_SIGNIFICANT_FINDINGS}</p>
      ) : (
        <ul className="list-disc space-y-0.5 pl-4 text-xs">
          {items.map((item, index) => (
            <li key={`${heading}-${index}`}>{item}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function AnalysisTable({
  items,
  query,
  basePath,
  showStreamer = true,
  empty,
}: {
  items: readonly AnalysisListItem[];
  query: BrowseQuery<AnalysisSortKey>;
  basePath: string;
  showStreamer?: boolean;
  empty: { title: string; description: string; action?: { label: string; href: string } };
}) {
  const columnCount = showStreamer ? 8 : 7;

  const header = (label: string, column: AnalysisSortKey, align?: "right") => (
    <SortableHeader
      label={label}
      column={column}
      query={query}
      basePath={basePath}
      defaultSort={ANALYSIS_DEFAULT_SORT}
      {...(align ? { align } : {})}
      naturalDirection={column === "streamer" || column === "contentType" ? "asc" : "desc"}
    />
  );

  return (
    <div className="overflow-x-auto">
      <Table>
        <caption className="sr-only">
          AI comment analyses. Each result is followed by a detail row listing its concerns,
          suggestions, questions and urgent issues.
        </caption>
        <TableHeader>
          <TableRow>
            {showStreamer ? header("Streamer", "streamer") : null}
            {header("Type", "contentType")}
            <TableHead scope="col">Content</TableHead>
            {header("Comments", "commentCount", "right")}
            {header("Sentiment", "sentiment")}
            <TableHead scope="col">Status</TableHead>
            {header("Urgent", "urgentCount", "right")}
            {header("Generated", "generatedAt")}
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item) => {
            const urgent = realFindings(item.urgentIssues);
            const href = contentHref({ type: item.contentType, id: item.contentId });

            return (
              <Fragment key={item.summaryId}>
                <TableRow className="border-b-0">
                  {showStreamer ? (
                    <TableCell className="align-top">
                      <Link
                        href={`/streamers/${item.streamerId}`}
                        className="text-sm underline-offset-4 hover:underline"
                      >
                        {item.streamerName}
                      </Link>
                      <p className="font-mono text-xs text-muted-foreground">{item.streamerCode}</p>
                    </TableCell>
                  ) : null}

                  <TableCell className="align-top">
                    <span className="inline-flex items-center gap-1 text-xs whitespace-nowrap text-muted-foreground">
                      {item.contentType === "video" ? (
                        <Video className="size-3.5" aria-hidden />
                      ) : (
                        <FileText className="size-3.5" aria-hidden />
                      )}
                      {item.contentType === "video" ? "Video" : "Post"}
                    </span>
                  </TableCell>

                  {/*
                   * Constrained on the inner element: a `max-width` on a `td`
                   * is ignored under the automatic table layout.
                   */}
                  <TableCell className="align-top">
                    <Link
                      href={href}
                      className="block max-w-[calc(100vw-5rem)] text-sm font-medium underline-offset-4 hover:underline sm:max-w-sm"
                    >
                      <span className="line-clamp-2">{contentLabel(item)}</span>
                    </Link>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Published {formatWhen(item.contentCreatedAt)}
                    </p>
                  </TableCell>

                  <TableCell className="text-right align-top font-mono text-xs">
                    {item.commentCount}
                  </TableCell>

                  <TableCell className="align-top">
                    <SentimentBadge sentiment={item.sentiment} />
                  </TableCell>
                  <TableCell className="align-top">
                    <SummaryStatusBadge status={item.status} />
                  </TableCell>

                  <TableCell className="text-right align-top">
                    {urgent.length > 0 ? (
                      <span className="inline-flex items-center gap-1 font-mono text-xs font-medium text-destructive">
                        <AlertTriangle className="size-3.5" aria-hidden />
                        {urgent.length}
                      </span>
                    ) : (
                      <span className="font-mono text-xs text-muted-foreground">0</span>
                    )}
                  </TableCell>

                  <TableCell className="align-top">
                    <p className="text-xs whitespace-nowrap text-muted-foreground">
                      {formatWhen(item.generatedAt)}
                    </p>
                    <div className="mt-1 inline-flex items-center gap-1">
                      <Button asChild variant="ghost" size="icon-xs">
                        <Link href={href} aria-label={`View ${item.contentType} details`}>
                          <Eye className="size-3.5" aria-hidden />
                        </Link>
                      </Button>
                      {item.permalinkUrl ? (
                        <Button asChild variant="ghost" size="icon-xs">
                          <a
                            href={item.permalinkUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            aria-label="Open on Facebook"
                          >
                            <ExternalLink className="size-3.5" aria-hidden />
                          </a>
                        </Button>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>

                <TableRow className="bg-muted/30 hover:bg-muted/30">
                  <TableCell colSpan={columnCount} className="space-y-3 pt-0 pb-4">
                    {item.summary ? (
                      <p className="max-w-4xl text-sm">{item.summary}</p>
                    ) : (
                      <p className="text-xs text-muted-foreground italic">
                        No summary has been generated for this content yet.
                      </p>
                    )}

                    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                      <FindingColumn heading="Concerns" items={realFindings(item.concerns)} />
                      <FindingColumn heading="Suggestions" items={realFindings(item.suggestions)} />
                      <FindingColumn heading="Questions" items={realFindings(item.questions)} />
                      <FindingColumn heading="Urgent issues" items={urgent} tone="danger" />
                    </div>
                  </TableCell>
                </TableRow>
              </Fragment>
            );
          })}

          {items.length === 0 ? (
            <EmptyTableRow
              colSpan={columnCount}
              title={empty.title}
              description={empty.description}
              {...(empty.action ? { action: empty.action } : {})}
            />
          ) : null}
        </TableBody>
      </Table>
    </div>
  );
}
