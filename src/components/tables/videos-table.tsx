import Link from "next/link";
import { ExternalLink, Eye, Radio } from "lucide-react";

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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import type { BrowseQuery } from "@/lib/filters/browse";
import { ariaSortFor, type SortState, type VideoSortKey } from "@/lib/filters/sorting";
import { formatDuration } from "@/lib/meta/videos";
import type { VideoTableItem } from "@/lib/repositories/videos";
import { formatDateTime } from "@/lib/time/zone";

/**
 * The videos table, used by `/videos` and by the Videos tab of a streamer.
 * Same reasoning as `posts-table.tsx`: one implementation, rows as props, and
 * cards rather than a shrinking table below `md`.
 */

export const VIDEOS_DEFAULT_SORT: SortState<VideoSortKey> = {
  key: "createdTime",
  direction: "desc",
};


/**
 * What to call a video.
 *
 * Meta leaves `title` null on plenty of these — every one in the current data
 * set — so the description is usually the only text there is. Returning null
 * rather than a placeholder lets `ContentPreview` supply the "Untitled video"
 * wording, keeping that phrase in one place across the product.
 */
function videoLabel(title: string | null, description: string | null, limit = 120): string | null {
  const source = title ?? description;
  if (!source) return null;
  const trimmed = source.replace(/\s+/g, " ").trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

export function VideosTable({
  items,
  query,
  basePath,
  showStreamer = true,
  showGames = false,
  empty,
}: {
  items: readonly VideoTableItem[];
  query: BrowseQuery<VideoSortKey>;
  basePath: string;
  showStreamer?: boolean;
  /** Only once an admin has registered a game. See `GameBadge`. */
  showGames?: boolean;
  empty: { title: string; description: string; action?: { label: string; href: string } };
}) {
  const sortable = (label: string, column: VideoSortKey) => (
    <SortLink
      label={label}
      column={column}
      query={query}
      basePath={basePath}
      defaultSort={VIDEOS_DEFAULT_SORT}
      naturalDirection={column === "streamer" || column === "title" ? "asc" : "desc"}
    />
  );

  const sortState = (column: VideoSortKey) => ariaSortFor(column, query.sort);

  const actionsFor = (video: VideoTableItem) => (
    <>
      <DropdownMenuItem asChild>
        <Link href={`/videos/${video.id}`}>
          <Eye className="size-4" aria-hidden />
          View details
        </Link>
      </DropdownMenuItem>
      {video.permalinkUrl ? (
        <DropdownMenuItem asChild>
          <a href={video.permalinkUrl} target="_blank" rel="noopener noreferrer">
            <ExternalLink className="size-4" aria-hidden />
            Open on Facebook
          </a>
        </DropdownMenuItem>
      ) : null}
    </>
  );

  const columns: Column<VideoTableItem>[] = [
    {
      id: "title",
      header: sortable("Title", "title"),
      headerLabel: "Title",
      ariaSort: sortState("title"),
      cell: (video) => (
        <div className="min-w-0 space-y-1">
          <ContentPreview
            contentType="video"
            title={videoLabel(video.title, video.description)}
            permalinkUrl={video.permalinkUrl}
            href={`/videos/${video.id}`}
          />
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-xs whitespace-nowrap text-muted-foreground">
              {formatDateTime(video.createdTime)}
            </p>
            {/*
             * Which kind this is. Both arrive from the same Meta edge with the
             * same shape, so without saying so a two-hour broadcast and a
             * forty-second reel look identical in this list.
             */}
            {video.mediaKind === "livestream" ? (
              <Badge variant="outline" className="gap-1 text-xs font-normal">
                <Radio className="size-3" aria-hidden />
                Livestream
              </Badge>
            ) : null}
            <GameBadge name={video.gameName} source={video.gameSource} show={showGames} />
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
            cell: (video: VideoTableItem) => (
              <>
                <Link
                  href={`/streamers/${video.streamerId}`}
                  className="text-sm underline-offset-4 hover:underline"
                >
                  {video.streamerName}
                </Link>
                <p className="font-mono text-xs text-muted-foreground">{video.streamerCode}</p>
              </>
            ),
          },
        ]
      : []),
    {
      id: "length",
      header: sortable("Length", "length"),
      headerLabel: "Length",
      ariaSort: sortState("length"),
      align: "right",
      cell: (video) => {
        const duration = formatDuration(video.lengthSeconds);
        return duration ? (
          <span className="tabular-nums">{duration}</span>
        ) : (
          <span className="text-muted-foreground" title="Not available from Meta">
            —<span className="sr-only">Not available from Meta</span>
          </span>
        );
      },
    },
    {
      id: "metrics",
      header: sortable("Metrics", "metrics"),
      headerLabel: "Metrics",
      ariaSort: sortState("metrics"),
      align: "right",
      priority: "secondary",
      cell: (video) =>
        video.metricCount > 0 ? (
          <Link
            href={`/videos/${video.id}`}
            className="underline-offset-4 hover:underline"
            aria-label={`${video.metricCount} insight metrics available`}
          >
            {video.metricCount}
          </Link>
        ) : (
          <span className="text-muted-foreground" title="No insight metrics stored">
            —
          </span>
        ),
    },
    {
      id: "comments",
      header: sortable("Comments", "comments"),
      headerLabel: "Comments",
      ariaSort: sortState("comments"),
      align: "right",
      priority: "secondary",
      cell: (video) => <MetricCell value={video.storedCommentCount} />,
    },
    {
      id: "sentiment",
      header: sortable("Sentiment", "sentiment"),
      headerLabel: "Sentiment",
      ariaSort: sortState("sentiment"),
      cell: (video) => <SentimentBadge sentiment={video.sentiment} />,
    },
    {
      id: "summary",
      header: sortable("Summary", "summaryStatus"),
      headerLabel: "Summary",
      ariaSort: sortState("summaryStatus"),
      priority: "tertiary",
      cell: (video) => <SummaryStatusBadge status={video.summaryStatus} />,
    },
    {
      id: "actions",
      header: "Actions",
      headerLabel: "Actions",
      headerHidden: true,
      align: "right",
      cell: (video) => <ActionsMenu label="Video actions">{actionsFor(video)}</ActionsMenu>,
    },
  ];

  return (
    <DataTable
      rows={items}
      columns={columns}
      rowKey={(video) => video.id}
      caption="Page videos with duration, stored insight metrics and comment-analysis status. Sortable by column."
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
      mobileCard={(video) => (
        <MobileDataCard>
          <ContentPreview
            contentType="video"
            title={videoLabel(video.title, video.description)}
            subtitle={showStreamer ? video.streamerName : null}
            permalinkUrl={video.permalinkUrl}
            href={`/videos/${video.id}`}
          />

          <div className="flex flex-wrap items-center gap-2">
            <p className="text-xs text-muted-foreground">{formatDateTime(video.createdTime)}</p>
            <GameBadge name={video.gameName} source={video.gameSource} show={showGames} />
          </div>

          <dl className="grid grid-cols-3 gap-2 text-xs text-muted-foreground">
            <div>
              <dt>Length</dt>
              <dd className="text-foreground">{formatDuration(video.lengthSeconds) ?? "—"}</dd>
            </div>
            <div>
              <dt>Metrics</dt>
              <dd className="text-foreground">{video.metricCount || "—"}</dd>
            </div>
            <div>
              <dt>Comments</dt>
              <dd className="text-foreground">
                <MetricCell value={video.storedCommentCount} />
              </dd>
            </div>
          </dl>

          <div className="flex flex-wrap items-center gap-2">
            <SentimentBadge sentiment={video.sentiment} />
            <SummaryStatusBadge status={video.summaryStatus} />
            <div className="ml-auto">
              <ActionsMenu label="Video actions">{actionsFor(video)}</ActionsMenu>
            </div>
          </div>
        </MobileDataCard>
      )}
    />
  );
}
