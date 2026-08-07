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
import { GameBadge } from "@/components/data/game-badge";
import { SortLink } from "@/components/data/sortable-header";
import { EmptyState } from "@/components/layout/states";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { ariaSortFor } from "@/lib/filters/sorting";
import type { BrowseQuery } from "@/lib/filters/browse";
import type { PostSortKey, SortState } from "@/lib/filters/sorting";
import type { PostTableItem } from "@/lib/repositories/posts";
import { formatDateTime } from "@/lib/time/zone";

/**
 * The posts table, used by `/posts` and by the Posts tab of a streamer.
 *
 * One implementation rather than two: the streamer tab is the same table with
 * the streamer column dropped, and duplicating it would guarantee that a fix to
 * one — a column, an accessible label, the missing-is-never-zero dash — silently
 * misses the other.
 *
 * ## Cards on a phone, a table on a desktop
 *
 * This used to stay a table at every width, hiding columns as it narrowed. It
 * still overflowed: even one column of message text plus the row's padding is
 * wider than a 390px viewport, so the page scrolled sideways — the one outcome
 * the responsive design was supposed to prevent. Below `md` each row is now a
 * card that reflows, which is what `DataTable`'s `mobileCard` exists for.
 *
 * Rows arrive as props. The component imports no repository, so it cannot widen
 * the query or reach a column the caller did not select.
 */

export const POSTS_DEFAULT_SORT: SortState<PostSortKey> = {
  key: "createdTime",
  direction: "desc",
};


function excerpt(message: string | null, limit = 140): string | null {
  if (!message) return null;
  const trimmed = message.replace(/\s+/g, " ").trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

export function PostsTable({
  items,
  query,
  basePath,
  showStreamer = true,
  showGames = false,
  empty,
}: {
  items: readonly PostTableItem[];
  query: BrowseQuery<PostSortKey>;
  basePath: string;
  /** Dropped inside a streamer's own tab, where every row is that streamer. */
  showStreamer?: boolean;
  /** Only once an admin has registered a game. See `GameBadge`. */
  showGames?: boolean;
  empty: { title: string; description: string; action?: { label: string; href: string } };
}) {
  const sortable = (label: string, column: PostSortKey) => (
    <SortLink
      label={label}
      column={column}
      query={query}
      basePath={basePath}
      defaultSort={POSTS_DEFAULT_SORT}
      naturalDirection={column === "streamer" ? "asc" : "desc"}
    />
  );

  const sortState = (column: PostSortKey) => ariaSortFor(column, query.sort);

  const actionsFor = (post: PostTableItem) => (
    <>
      <DropdownMenuItem asChild>
        <Link href={`/posts/${post.id}`}>
          <Eye className="size-4" aria-hidden />
          View details
        </Link>
      </DropdownMenuItem>
      {post.permalinkUrl ? (
        <DropdownMenuItem asChild>
          <a href={post.permalinkUrl} target="_blank" rel="noopener noreferrer">
            <ExternalLink className="size-4" aria-hidden />
            Open on Facebook
          </a>
        </DropdownMenuItem>
      ) : null}
    </>
  );

  const columns: Column<PostTableItem>[] = [
    {
      id: "message",
      header: sortable("Message", "createdTime"),
      headerLabel: "Message",
      ariaSort: sortState("createdTime"),
      cell: (post) => (
        <div className="min-w-0 space-y-1">
          <ContentPreview
            contentType="post"
            title={excerpt(post.message)}
            permalinkUrl={post.permalinkUrl}
            href={`/posts/${post.id}`}
          />
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-xs whitespace-nowrap text-muted-foreground">
              {formatDateTime(post.createdTime)}
            </p>
            <GameBadge name={post.gameName} source={post.gameSource} show={showGames} />
          </div>
        </div>
      ),
    },
    ...(showStreamer
      ? [
          {
            id: "streamer",
            header: sortable("Streamer", "streamer"),
            headerLabel: "Streamer",
            ariaSort: sortState("streamer"),
            priority: "secondary" as const,
            cell: (post: PostTableItem) => (
              <>
                <Link
                  href={`/streamers/${post.streamerId}`}
                  className="text-sm underline-offset-4 hover:underline"
                >
                  {post.streamerName}
                </Link>
                <p className="font-mono text-xs text-muted-foreground">{post.streamerCode}</p>
              </>
            ),
          },
        ]
      : []),
    {
      id: "reactions",
      header: sortable("Reactions", "reactions"),
      headerLabel: "Reactions",
      ariaSort: sortState("reactions"),
      align: "right",
      cell: (post) => <MetricCell value={post.reactionCount} />,
    },
    {
      id: "comments",
      header: sortable("Comments", "comments"),
      headerLabel: "Comments",
      ariaSort: sortState("comments"),
      align: "right",
      cell: (post) => <MetricCell value={post.commentCount} />,
    },
    {
      id: "shares",
      header: sortable("Shares", "shares"),
      headerLabel: "Shares",
      ariaSort: sortState("shares"),
      align: "right",
      priority: "secondary",
      cell: (post) => <MetricCell value={post.shareCount} />,
    },
    {
      id: "metrics",
      header: sortable("Metrics", "metrics"),
      headerLabel: "Metrics",
      ariaSort: sortState("metrics"),
      align: "right",
      priority: "tertiary",
      cell: (post) =>
        post.metricCount > 0 ? (
          <Link
            href={`/posts/${post.id}`}
            className="underline-offset-4 hover:underline"
            aria-label={`${post.metricCount} insight metrics available`}
          >
            {post.metricCount}
          </Link>
        ) : (
          <span className="text-muted-foreground" title="No insight metrics stored">
            —
          </span>
        ),
    },
    {
      id: "sentiment",
      header: sortable("Sentiment", "sentiment"),
      headerLabel: "Sentiment",
      ariaSort: sortState("sentiment"),
      cell: (post) => <SentimentBadge sentiment={post.sentiment} />,
    },
    {
      id: "summary",
      header: sortable("Summary", "summaryStatus"),
      headerLabel: "Summary",
      ariaSort: sortState("summaryStatus"),
      priority: "secondary",
      cell: (post) => <SummaryStatusBadge status={post.summaryStatus} />,
    },
    {
      id: "actions",
      header: "Actions",
      headerLabel: "Actions",
      headerHidden: true,
      align: "right",
      cell: (post) => <ActionsMenu label="Post actions">{actionsFor(post)}</ActionsMenu>,
    },
  ];

  return (
    <DataTable
      rows={items}
      columns={columns}
      rowKey={(post) => post.id}
      caption="Facebook Page posts with engagement counts and comment-analysis status. Sortable by column."
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
      mobileCard={(post) => (
        <MobileDataCard>
          <ContentPreview
            contentType="post"
            title={excerpt(post.message)}
            subtitle={showStreamer ? post.streamerName : null}
            permalinkUrl={post.permalinkUrl}
            href={`/posts/${post.id}`}
          />

          <div className="flex flex-wrap items-center gap-2">
            <p className="text-xs text-muted-foreground">{formatDateTime(post.createdTime)}</p>
            <GameBadge name={post.gameName} source={post.gameSource} show={showGames} />
          </div>

          {/*
           * Three figures, labelled. A phone has room for the numbers that
           * matter and no room for a header row, so each carries its own name.
           */}
          <dl className="grid grid-cols-3 gap-2 text-xs text-muted-foreground">
            <div>
              <dt>Reactions</dt>
              <dd className="text-foreground">
                <MetricCell value={post.reactionCount} />
              </dd>
            </div>
            <div>
              <dt>Comments</dt>
              <dd className="text-foreground">
                <MetricCell value={post.commentCount} />
              </dd>
            </div>
            <div>
              <dt>Shares</dt>
              <dd className="text-foreground">
                <MetricCell value={post.shareCount} />
              </dd>
            </div>
          </dl>

          <div className="flex flex-wrap items-center gap-2">
            <SentimentBadge sentiment={post.sentiment} />
            <SummaryStatusBadge status={post.summaryStatus} />
            <div className="ml-auto">
              <ActionsMenu label="Post actions">{actionsFor(post)}</ActionsMenu>
            </div>
          </div>
        </MobileDataCard>
      )}
    />
  );
}
