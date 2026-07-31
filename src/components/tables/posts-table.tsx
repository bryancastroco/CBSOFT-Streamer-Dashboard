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
import type { PostSortKey, SortState } from "@/lib/filters/sorting";
import { formatCountShort } from "@/lib/meta/insight-display";
import type { PostTableItem } from "@/lib/repositories/posts";

/**
 * The posts table, used by `/posts` and by the Posts tab of a streamer.
 *
 * One implementation rather than two: the streamer tab is the same table with
 * the streamer column dropped, and duplicating it would guarantee that a fix to
 * one — a column, an accessible label, the missing-is-never-zero dash — silently
 * misses the other.
 *
 * Rows arrive as props. The component imports no repository, so it cannot widen
 * the query or reach a column the caller did not select.
 */

export const POSTS_DEFAULT_SORT: SortState<PostSortKey> = {
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

function excerpt(message: string | null, limit = 110): string {
  if (!message) return "Untitled post";
  const trimmed = message.replace(/\s+/g, " ").trim();
  if (trimmed.length === 0) return "Untitled post";
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

export function PostsTable({
  items,
  query,
  basePath,
  showStreamer = true,
  empty,
}: {
  items: readonly PostTableItem[];
  query: BrowseQuery<PostSortKey>;
  basePath: string;
  /** Dropped inside a streamer's own tab, where every row is that streamer. */
  showStreamer?: boolean;
  empty: { title: string; description: string; action?: { label: string; href: string } };
}) {
  const columnCount = showStreamer ? 9 : 8;

  const header = (label: string, column: PostSortKey, align?: "right", hideBelow?: string) => (
    <SortableHeader
      label={label}
      column={column}
      query={query}
      basePath={basePath}
      defaultSort={POSTS_DEFAULT_SORT}
      {...(align ? { align } : {})}
      {...(hideBelow ? { className: hideBelow } : {})}
      naturalDirection={column === "streamer" ? "asc" : "desc"}
    />
  );

  return (
    <div className="overflow-x-auto">
      <Table>
        <caption className="sr-only">
          Facebook Page posts with engagement counts and comment-analysis status. Sortable by
          column.
        </caption>
        <TableHeader>
          <TableRow>
            {header("Message", "createdTime")}
            {showStreamer
              ? header("Streamer", "streamer", undefined, "hidden md:table-cell")
              : null}
            {header("Reactions", "reactions", "right", "hidden md:table-cell")}
            {header("Comments", "comments", "right", "hidden md:table-cell")}
            {header("Shares", "shares", "right", "hidden lg:table-cell")}
            {header("Metrics", "metrics", "right", "hidden lg:table-cell")}
            {header("Sentiment", "sentiment", undefined, "hidden sm:table-cell")}
            {header("Summary", "summaryStatus", undefined, "hidden sm:table-cell")}
            <TableHead scope="col" className="text-right">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((post) => (
            <TableRow key={post.id}>
              {/*
               * The first cell carries everything a phone needs: the message,
               * who published it and when. The numeric columns are hidden below
               * `md` rather than reflowed, so one row stays one row.
               */}
              {/*
               * The width is constrained on the inner element, not the cell.
               * A `max-width` on a `td` is ignored under the automatic table
               * layout browsers use by default, so a long message simply grew
               * the column until it ran under the streamer beside it.
               */}
              <TableCell className="align-top">
                <Link
                  href={`/posts/${post.id}`}
                  className="block max-w-sm text-sm font-medium underline-offset-4 hover:underline"
                >
                  {/*
                   * The clamp goes on a block inside the link, not on the link
                   * itself. `line-clamp` sets `display: -webkit-box`, which on
                   * the anchor fought its own layout and clipped to a single
                   * line with no ellipsis instead of wrapping to two.
                   */}
                  <span className="line-clamp-2">{excerpt(post.message)}</span>
                </Link>
                <p className="mt-1 text-xs whitespace-nowrap text-muted-foreground">
                  {formatWhen(post.createdTime)}
                </p>
                <p className="mt-1 text-xs text-muted-foreground md:hidden">
                  {showStreamer ? `${post.streamerCode} · ` : ""}
                  {formatCountShort(post.reactionCount)} reactions ·{" "}
                  {formatCountShort(post.commentCount)} comments
                </p>
              </TableCell>

              {showStreamer ? (
                <TableCell className="hidden align-top md:table-cell">
                  <Link
                    href={`/streamers/${post.streamerId}`}
                    className="text-sm underline-offset-4 hover:underline"
                  >
                    {post.streamerName}
                  </Link>
                  <p className="font-mono text-xs text-muted-foreground">{post.streamerCode}</p>
                </TableCell>
              ) : null}

              <TableCell className="hidden text-right align-top font-mono text-xs md:table-cell">
                {formatCountShort(post.reactionCount)}
              </TableCell>
              <TableCell className="hidden text-right align-top font-mono text-xs md:table-cell">
                {formatCountShort(post.commentCount)}
              </TableCell>
              <TableCell className="hidden text-right align-top font-mono text-xs lg:table-cell">
                {formatCountShort(post.shareCount)}
              </TableCell>

              <TableCell className="hidden text-right align-top font-mono text-xs lg:table-cell">
                {post.metricCount > 0 ? (
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
                )}
              </TableCell>

              <TableCell className="hidden align-top sm:table-cell">
                <SentimentBadge sentiment={post.sentiment} />
              </TableCell>
              <TableCell className="hidden align-top sm:table-cell">
                <SummaryStatusBadge status={post.summaryStatus} />
              </TableCell>

              <TableCell className="text-right align-top whitespace-nowrap">
                <div className="inline-flex items-center gap-1">
                  <Button asChild variant="ghost" size="icon-sm">
                    <Link href={`/posts/${post.id}`} aria-label="View post details">
                      <Eye className="size-4" aria-hidden />
                    </Link>
                  </Button>
                  {post.permalinkUrl ? (
                    <Button asChild variant="ghost" size="icon-sm">
                      <a
                        href={post.permalinkUrl}
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
          ))}

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
