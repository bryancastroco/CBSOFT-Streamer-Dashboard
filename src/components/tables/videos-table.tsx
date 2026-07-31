import Link from "next/link";
import { Eye, ExternalLink } from "lucide-react";

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
import type { BrowseQuery } from "@/lib/filters/browse";
import type { SortState, VideoSortKey } from "@/lib/filters/sorting";
import { formatDuration } from "@/lib/meta/videos";
import type { VideoTableItem } from "@/lib/repositories/videos";

/**
 * The videos table, used by `/videos` and by the Videos tab of a streamer.
 * Same reasoning as `posts-table.tsx`: one implementation, rows as props.
 */

export const VIDEOS_DEFAULT_SORT: SortState<VideoSortKey> = {
  key: "createdTime",
  direction: "desc",
};

function formatWhen(value: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(value);
}

function videoLabel(title: string | null, description: string | null, limit = 100): string {
  const source = title ?? description;
  if (!source) return "Untitled video";
  const trimmed = source.replace(/\s+/g, " ").trim();
  if (trimmed.length === 0) return "Untitled video";
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

export function VideosTable({
  items,
  query,
  basePath,
  showStreamer = true,
  empty,
}: {
  items: readonly VideoTableItem[];
  query: BrowseQuery<VideoSortKey>;
  basePath: string;
  showStreamer?: boolean;
  empty: { title: string; description: string; action?: { label: string; href: string } };
}) {
  const columnCount = showStreamer ? 8 : 7;

  const header = (label: string, column: VideoSortKey, align?: "right", hideBelow?: string) => (
    <SortableHeader
      label={label}
      column={column}
      query={query}
      basePath={basePath}
      defaultSort={VIDEOS_DEFAULT_SORT}
      {...(align ? { align } : {})}
      {...(hideBelow ? { className: hideBelow } : {})}
      naturalDirection={column === "streamer" || column === "title" ? "asc" : "desc"}
    />
  );

  return (
    <div className="overflow-x-auto">
      <Table>
        <caption className="sr-only">
          Facebook Page videos with duration, available insight metrics and comment-analysis status.
          Sortable by column.
        </caption>
        <TableHeader>
          <TableRow>
            {header("Title", "title")}
            {showStreamer
              ? header("Streamer", "streamer", undefined, "hidden md:table-cell")
              : null}
            {header("Length", "length", "right", "hidden md:table-cell")}
            {header("Metrics", "metrics", "right", "hidden lg:table-cell")}
            {header("Comments", "comments", "right", "hidden lg:table-cell")}
            {header("Sentiment", "sentiment", undefined, "hidden sm:table-cell")}
            {header("Summary", "summaryStatus", undefined, "hidden sm:table-cell")}
            <TableHead scope="col" className="text-right">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((video) => {
            const duration = formatDuration(video.lengthSeconds);

            return (
              <TableRow key={video.id}>
                {/*
                 * Constrained on the inner element: a `max-width` on a `td` is
                 * ignored under the automatic table layout, so long titles grew
                 * the column and ran under the one beside it.
                 */}
                <TableCell className="align-top">
                  <Link
                    href={`/videos/${video.id}`}
                    className="block max-w-[calc(100vw-5rem)] text-sm font-medium underline-offset-4 hover:underline sm:max-w-sm"
                  >
                    <span className="line-clamp-2">
                      {videoLabel(video.title, video.description)}
                    </span>
                  </Link>
                  <p className="mt-1 text-xs whitespace-nowrap text-muted-foreground">
                    {formatWhen(video.createdTime)}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground md:hidden">
                    {showStreamer ? video.streamerCode : ""}
                    {duration ? `${showStreamer ? " · " : ""}${duration}` : ""}
                  </p>
                </TableCell>

                {showStreamer ? (
                  <TableCell className="hidden align-top md:table-cell">
                    <Link
                      href={`/streamers/${video.streamerId}`}
                      className="text-sm underline-offset-4 hover:underline"
                    >
                      {video.streamerName}
                    </Link>
                    <p className="font-mono text-xs text-muted-foreground">{video.streamerCode}</p>
                  </TableCell>
                ) : null}

                <TableCell className="hidden text-right align-top font-mono text-xs md:table-cell">
                  {/* A null length is reported as unavailable, never as 0s. */}
                  {duration ?? (
                    <span className="text-muted-foreground" title="Length not reported by Meta">
                      —
                    </span>
                  )}
                </TableCell>

                <TableCell className="hidden text-right align-top font-mono text-xs lg:table-cell">
                  {video.metricCount > 0 ? (
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
                  )}
                </TableCell>

                <TableCell className="hidden text-right align-top font-mono text-xs lg:table-cell">
                  {video.storedCommentCount ?? (
                    <span className="text-muted-foreground" title="No comments collected yet">
                      —
                    </span>
                  )}
                </TableCell>

                <TableCell className="hidden align-top sm:table-cell">
                  <SentimentBadge sentiment={video.sentiment} />
                </TableCell>
                <TableCell className="hidden align-top sm:table-cell">
                  <SummaryStatusBadge status={video.summaryStatus} />
                </TableCell>

                <TableCell className="text-right align-top whitespace-nowrap">
                  <div className="inline-flex items-center gap-1">
                    <Button asChild variant="ghost" size="icon-sm">
                      <Link href={`/videos/${video.id}`} aria-label="View video details">
                        <Eye className="size-4" aria-hidden />
                      </Link>
                    </Button>
                    {video.permalinkUrl ? (
                      <Button asChild variant="ghost" size="icon-sm">
                        <a
                          href={video.permalinkUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label="Open on Facebook"
                        >
                          <ExternalLink className="size-4" aria-hidden />
                        </a>
                      </Button>
                    ) : null}
                  </div>
                </TableCell>
              </TableRow>
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
