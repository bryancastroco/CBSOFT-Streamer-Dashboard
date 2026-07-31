import Link from "next/link";
import { ExternalLink, Eye } from "lucide-react";

import { SentimentBadge, SummaryStatusBadge } from "@/components/data/analysis-badges";
import {
  ActionsMenu,
  ContentPreview,
  DataTable,
  MetricCell,
  MobileDataCard,
  type Column,
} from "@/components/data/data-table";
import { SortLink } from "@/components/data/sortable-header";
import { EmptyState } from "@/components/layout/states";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { realFindings } from "@/lib/ai/presentation";
import type { BrowseQuery } from "@/lib/filters/browse";
import { ariaSortFor, type AnalysisSortKey, type SortState } from "@/lib/filters/sorting";
import type { AnalysisListItem } from "@/lib/repositories/analysis";

/**
 * AI comment analyses across posts and videos.
 *
 * ## Why the findings no longer sit under every row
 *
 * Each row used to be followed by a second row showing four finding lists —
 * concerns, suggestions, questions, urgent issues — rendered whether or not
 * anything had been found. A page of clean analyses became a wall of "No
 * significant findings" repeated twenty times, with the urgent heading in alarm
 * colour on every one of them. The original reasoning was that fixed positions
 * are easier to scan; in practice the opposite happened, because a genuinely
 * urgent row looked exactly like a quiet one.
 *
 * Findings now appear only when there are some, so a row with nothing to report
 * stays one line and the rows that matter stand out by being the only tall
 * ones. The full breakdown lives on the content's own page, which is where
 * anyone acting on a finding is going next anyway.
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

function contentLabel(item: AnalysisListItem, limit = 120): string | null {
  if (!item.contentTitle) return null;
  const trimmed = item.contentTitle.replace(/\s+/g, " ").trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

/**
 * A one-line tally of what was found, or nothing at all.
 *
 * Urgent findings come first and carry the only colour, so a row needing
 * attention is distinguishable at a glance from one that merely had
 * suggestions.
 */
function FindingsSummary({ item }: { item: AnalysisListItem }) {
  const urgent = realFindings(item.urgentIssues);
  const concerns = realFindings(item.concerns);
  const suggestions = realFindings(item.suggestions);
  const questions = realFindings(item.questions);

  if (
    urgent.length === 0 &&
    concerns.length === 0 &&
    suggestions.length === 0 &&
    questions.length === 0
  ) {
    return null;
  }

  const parts = [
    concerns.length > 0 ? `${concerns.length} concern${concerns.length === 1 ? "" : "s"}` : null,
    suggestions.length > 0
      ? `${suggestions.length} suggestion${suggestions.length === 1 ? "" : "s"}`
      : null,
    questions.length > 0
      ? `${questions.length} question${questions.length === 1 ? "" : "s"}`
      : null,
  ].filter(Boolean);

  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      {urgent.length > 0 ? (
        <span className="rounded border border-danger/25 bg-danger-subtle px-1.5 py-0.5 font-medium text-danger-foreground">
          {urgent.length} urgent
        </span>
      ) : null}
      {parts.length > 0 ? <span className="text-muted-foreground">{parts.join(" · ")}</span> : null}
    </p>
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
  const sortable = (label: string, column: AnalysisSortKey) => (
    <SortLink
      label={label}
      column={column}
      query={query}
      basePath={basePath}
      defaultSort={ANALYSIS_DEFAULT_SORT}
      naturalDirection={
        column === "streamer" || column === "contentType" || column === "sentiment" ? "asc" : "desc"
      }
    />
  );

  const sortState = (column: AnalysisSortKey) => ariaSortFor(column, query.sort);

  const hrefFor = (item: AnalysisListItem) =>
    `/${item.contentType === "video" ? "videos" : "posts"}/${item.contentId}`;

  const actionsFor = (item: AnalysisListItem) => (
    <>
      <DropdownMenuItem asChild>
        <Link href={hrefFor(item)}>
          <Eye className="size-4" aria-hidden />
          View details
        </Link>
      </DropdownMenuItem>
      {item.permalinkUrl ? (
        <DropdownMenuItem asChild>
          <a href={item.permalinkUrl} target="_blank" rel="noopener noreferrer">
            <ExternalLink className="size-4" aria-hidden />
            Open on Facebook
          </a>
        </DropdownMenuItem>
      ) : null}
    </>
  );

  const columns: Column<AnalysisListItem>[] = [
    {
      id: "content",
      header: sortable("Content", "contentType"),
      headerLabel: "Content",
      ariaSort: sortState("contentType"),
      cell: (item) => (
        <div className="min-w-0 space-y-1">
          <ContentPreview
            contentType={item.contentType === "video" ? "video" : "post"}
            title={contentLabel(item)}
            subtitle={showStreamer ? item.streamerName : null}
            permalinkUrl={item.permalinkUrl}
            href={hrefFor(item)}
          />
          {item.summary ? (
            <p className="line-clamp-2 max-w-prose text-xs text-muted-foreground">{item.summary}</p>
          ) : null}
          <FindingsSummary item={item} />
        </div>
      ),
    },
    {
      id: "comments",
      header: sortable("Comments", "commentCount"),
      headerLabel: "Comments",
      ariaSort: sortState("commentCount"),
      align: "right",
      cell: (item) => <MetricCell value={item.commentCount} />,
    },
    {
      id: "sentiment",
      header: sortable("Sentiment", "sentiment"),
      headerLabel: "Sentiment",
      ariaSort: sortState("sentiment"),
      cell: (item) => <SentimentBadge sentiment={item.sentiment} />,
    },
    {
      id: "urgent",
      header: sortable("Urgent", "urgentCount"),
      headerLabel: "Urgent",
      ariaSort: sortState("urgentCount"),
      align: "right",
      priority: "secondary",
      cell: (item) =>
        item.urgentCount > 0 ? (
          <span className="font-medium text-danger-foreground">{item.urgentCount}</span>
        ) : (
          <span className="text-muted-foreground">0</span>
        ),
    },
    {
      id: "status",
      header: "Status",
      cell: (item) => <SummaryStatusBadge status={item.status} />,
    },
    {
      id: "generated",
      header: sortable("Generated", "generatedAt"),
      headerLabel: "Generated",
      ariaSort: sortState("generatedAt"),
      priority: "tertiary",
      cell: (item) => (
        <span className="text-xs whitespace-nowrap text-muted-foreground">
          {formatWhen(item.generatedAt)}
        </span>
      ),
    },
    {
      id: "actions",
      header: "Actions",
      headerLabel: "Actions",
      headerHidden: true,
      align: "right",
      cell: (item) => <ActionsMenu label="Analysis actions">{actionsFor(item)}</ActionsMenu>,
    },
  ];

  return (
    <DataTable
      rows={items}
      columns={columns}
      rowKey={(item) => item.summaryId}
      caption="AI comment analyses across posts and videos, with sentiment and any findings. Sortable by column."
      empty={
        <EmptyState
          title={empty.title}
          description={empty.description}
          actions={
            empty.action ? (
              <Button asChild variant="outline" size="sm">
                <Link href={empty.action.href}>{empty.action.label}</Link>
              </Button>
            ) : undefined
          }
        />
      }
      mobileCard={(item) => (
        <MobileDataCard>
          <ContentPreview
            contentType={item.contentType === "video" ? "video" : "post"}
            title={contentLabel(item)}
            subtitle={showStreamer ? item.streamerName : null}
            permalinkUrl={item.permalinkUrl}
            href={hrefFor(item)}
          />

          {item.summary ? (
            <p className="line-clamp-3 text-xs text-muted-foreground">{item.summary}</p>
          ) : null}

          <FindingsSummary item={item} />

          <div className="flex flex-wrap items-center gap-2">
            <SentimentBadge sentiment={item.sentiment} />
            <SummaryStatusBadge status={item.status} />
            <span className="text-xs text-muted-foreground">
              {item.commentCount} comment{item.commentCount === 1 ? "" : "s"}
            </span>
            <div className="ml-auto">
              <ActionsMenu label="Analysis actions">{actionsFor(item)}</ActionsMenu>
            </div>
          </div>
        </MobileDataCard>
      )}
    />
  );
}
