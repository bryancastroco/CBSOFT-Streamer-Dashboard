import Link from "next/link";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";

import { TableHead } from "@/components/ui/table";
import { buildBrowseHref, type BrowseQuery } from "@/lib/filters/browse";
import {
  ariaSortFor,
  nextDirectionFor,
  type SortDirection,
  type SortState,
} from "@/lib/filters/sorting";
import { cn } from "@/lib/utils";

/**
 * A column header that sorts by navigating.
 *
 * Sorting is a link, not client state, which buys three things for free: the
 * sorted view is bookmarkable and shareable, the browser back button undoes a
 * sort, and the CSV export can be handed the identical query string and be
 * guaranteed to contain the rows the reader was looking at.
 *
 * `aria-sort` is set on the cell and the link names the action it will perform,
 * so a screen reader announces both the current ordering and what activating it
 * does — an icon alone conveys neither.
 *
 * ## Why the control is separate from the cell
 *
 * `SortLink` is the control; `SortableHeader` is that control inside its own
 * `<th>`. They are split because `DataTable` renders its own header cells, and
 * a component that insists on emitting a `<th>` cannot be used inside one. Two
 * copies of the sort logic would be the alternative, and the copies would
 * disagree the first time either was touched.
 */

type SortProps<K extends string> = {
  label: string;
  column: K;
  query: BrowseQuery<K>;
  basePath: string;
  defaultSort: SortState<K>;
  /** Direction used the first time this column is chosen. */
  naturalDirection?: SortDirection;
};

export function SortLink<K extends string>({
  label,
  column,
  query,
  basePath,
  defaultSort,
  naturalDirection = "desc",
}: SortProps<K>) {
  const active = query.sort.key === column;
  const direction = nextDirectionFor(column, query.sort, naturalDirection);
  const href = buildBrowseHref(basePath, query, defaultSort, {
    sort: column,
    dir: direction,
    resetOffset: true,
  });

  const Icon = !active ? ChevronsUpDown : query.sort.direction === "asc" ? ArrowUp : ArrowDown;

  return (
    <Link
      href={href}
      className={cn(
        "inline-flex items-center gap-1 rounded-sm underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        active ? "text-foreground" : undefined,
      )}
      aria-label={`${label}, sort ${direction === "asc" ? "ascending" : "descending"}`}
    >
      {/*
       * Label first, icon after — always, including in right-aligned columns.
       * Reversing the order there put the chevron on the far side of the
       * column from its label, which read as a stray glyph rather than as a
       * control belonging to that heading.
       */}
      {label}
      <Icon
        className={cn("size-3 shrink-0", active ? "text-foreground" : "text-muted-foreground/60")}
        aria-hidden
      />
    </Link>
  );
}

/** The sort control inside its own header cell, for hand-built tables. */
export function SortableHeader<K extends string>({
  align = "left",
  className,
  ...sort
}: SortProps<K> & {
  align?: "left" | "right";
  className?: string | undefined;
}) {
  return (
    <TableHead
      scope="col"
      aria-sort={ariaSortFor(sort.column, sort.query.sort)}
      className={cn(align === "right" && "text-right", className)}
    >
      <SortLink {...sort} />
    </TableHead>
  );
}
