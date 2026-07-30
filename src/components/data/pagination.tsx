import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { buildBrowseHref, type BrowseQuery } from "@/lib/filters/browse";
import type { SortState } from "@/lib/filters/sorting";

const numberFormat = new Intl.NumberFormat("en-GB");

/**
 * Offset pagination as links.
 *
 * A disabled `<Button asChild>` still renders an anchor, and a disabled anchor
 * is still clickable — so the boundary cases render as plain text instead. This
 * is the difference between a control that looks inert and one that is.
 */
export function Pagination<K extends string>({
  query,
  basePath,
  defaultSort,
  total,
  shown,
  label,
}: {
  query: BrowseQuery<K>;
  basePath: string;
  defaultSort: SortState<K>;
  total: number;
  /** Rows on this page. */
  shown: number;
  /** Plural noun for the summary line, e.g. "posts". */
  label: string;
}) {
  const from = total === 0 ? 0 : query.offset + 1;
  const to = query.offset + shown;

  const hasPrevious = query.offset > 0;
  const hasNext = to < total;

  const href = (offset: number) =>
    buildBrowseHref(basePath, query, defaultSort, { offset, resetOffset: false });

  return (
    <nav
      aria-label={`${label} pagination`}
      className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
    >
      <p className="text-xs text-muted-foreground" aria-live="polite">
        {total === 0
          ? `No ${label}`
          : `Showing ${numberFormat.format(from)}–${numberFormat.format(to)} of ${numberFormat.format(total)} ${label}`}
      </p>

      <div className="flex gap-2">
        {hasPrevious ? (
          <Button asChild variant="outline" size="sm">
            <Link href={href(Math.max(0, query.offset - query.limit))} rel="prev">
              <ChevronLeft className="size-4" aria-hidden />
              Previous
            </Link>
          </Button>
        ) : (
          <Button variant="outline" size="sm" disabled>
            <ChevronLeft className="size-4" aria-hidden />
            Previous
          </Button>
        )}

        {hasNext ? (
          <Button asChild variant="outline" size="sm">
            <Link href={href(query.offset + query.limit)} rel="next">
              Next
              <ChevronRight className="size-4" aria-hidden />
            </Link>
          </Button>
        ) : (
          <Button variant="outline" size="sm" disabled>
            Next
            <ChevronRight className="size-4" aria-hidden />
          </Button>
        )}
      </div>
    </nav>
  );
}
