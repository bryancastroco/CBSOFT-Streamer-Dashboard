import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { ExternalLink, FileText, MoreHorizontal, Video } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/**
 * The table every list page uses.
 *
 * Three near-identical tables existed before this — posts, videos and analysis
 * — each with its own header markup, its own empty row and its own idea of
 * what happens on a narrow screen (the answer was always sideways scrolling).
 * They differed only in which columns they declared, so that is the only thing
 * a caller declares here.
 *
 * ## Priority, not breakpoints
 *
 * A column says how important it is, not which breakpoint hides it. `primary`
 * is always visible, `secondary` drops below `lg`, `tertiary` below `xl`.
 * Spelling that as a priority means the answer to "what goes when it gets
 * tight?" lives in one place rather than being re-argued per table with
 * hand-picked `hidden md:table-cell` strings.
 */

export type ColumnPriority = "primary" | "secondary" | "tertiary";

export type Column<Row> = {
  /** Stable key, also used for the React key. */
  id: string;
  header: string;
  /** Hidden header text for an actions column. */
  headerHidden?: boolean;
  priority?: ColumnPriority;
  align?: "left" | "right";
  cell: (row: Row) => React.ReactNode;
};

const PRIORITY_CLASS: Record<ColumnPriority, string> = {
  primary: "",
  secondary: "hidden lg:table-cell",
  tertiary: "hidden xl:table-cell",
};

export function DataTable<Row>({
  rows,
  columns,
  rowKey,
  caption,
  empty,
  /** Card renderer for narrow screens. Without it the table simply stacks. */
  mobileCard,
}: {
  rows: readonly Row[];
  columns: readonly Column<Row>[];
  rowKey: (row: Row) => string;
  caption: string;
  empty: React.ReactNode;
  mobileCard?: (row: Row) => React.ReactNode;
}) {
  if (rows.length === 0) return <>{empty}</>;

  return (
    <>
      {mobileCard ? (
        <ul className="space-y-3 md:hidden">
          {rows.map((row) => (
            <li key={rowKey(row)}>{mobileCard(row)}</li>
          ))}
        </ul>
      ) : null}

      <div className={cn(mobileCard ? "hidden md:block" : "block")}>
        <table className="w-full text-sm">
          {/* Named for screen readers; the visible heading is the section's. */}
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              {columns.map((column) => (
                <th
                  key={column.id}
                  scope="col"
                  className={cn(
                    "px-3 py-2 font-medium first:pl-0 last:pr-0",
                    column.align === "right" && "text-right",
                    PRIORITY_CLASS[column.priority ?? "primary"],
                  )}
                >
                  {column.headerHidden ? (
                    <span className="sr-only">{column.header}</span>
                  ) : (
                    column.header
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={rowKey(row)} className="border-b last:border-0 hover:bg-muted/40">
                {columns.map((column) => (
                  <td
                    key={column.id}
                    className={cn(
                      "px-3 py-3 first:pl-0 last:pr-0",
                      column.align === "right" && "text-right tabular-nums",
                      PRIORITY_CLASS[column.priority ?? "primary"],
                    )}
                  >
                    {column.cell(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** Card shell for the mobile half of a list. */
export function MobileDataCard({ children }: { children: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="space-y-3 p-4">{children}</CardContent>
    </Card>
  );
}

/**
 * One overflow menu instead of a row of buttons.
 *
 * A row with six visible actions makes every one of them look equally likely,
 * which is a way of telling the reader nothing. The caller passes menu items;
 * the trigger is uniform so it sits in the same place on every row.
 */
export function ActionsMenu({
  label = "Row actions",
  children,
}: {
  label?: string;
  children: React.ReactNode;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={label}>
          <MoreHorizontal className="size-4" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * A metric Meta may or may not have reported.
 *
 * The distinction this preserves is the one that quietly corrupts reports: a
 * genuine `0` means nobody engaged, while a missing value means Meta declined
 * to say. Rendering both as "0" produces averages that are wrong in a way
 * nobody can see. Absent renders as an explanation, not a number.
 */
export function MetricValue({
  value,
  className,
}: {
  value: number | null | undefined;
  className?: string;
}) {
  if (value === null || value === undefined) {
    return (
      <span className={cn("text-xs text-muted-foreground", className)}>
        Not available from Meta
      </span>
    );
  }

  return <span className={cn("tabular-nums", className)}>{value.toLocaleString()}</span>;
}

/** Compact variant for a dense table cell, where the sentence will not fit. */
export function MetricCell({ value }: { value: number | null | undefined }) {
  if (value === null || value === undefined) {
    return (
      <span className="text-muted-foreground" title="Not available from Meta">
        —<span className="sr-only">Not available from Meta</span>
      </span>
    );
  }

  return <span className="tabular-nums">{value.toLocaleString()}</span>;
}

/**
 * A piece of content, shown the same way wherever it appears.
 *
 * Posts carry a message and videos a title; both render identically so a mixed
 * list reads as one list, with the icon carrying the distinction. The Facebook
 * link is deliberately separate from the detail link — they lead to different
 * places, and collapsing them into one loses whichever the reader wanted.
 */
export function ContentPreview({
  contentType,
  title,
  subtitle,
  permalinkUrl,
  href,
}: {
  contentType: "post" | "video";
  title: string | null;
  subtitle?: string | null;
  permalinkUrl?: string | null;
  /** Detail page. When given, the text itself becomes the link. */
  href?: string;
}) {
  const Icon: LucideIcon = contentType === "video" ? Video : FileText;
  const text = title?.trim();

  const body = text ? (
    <span className="line-clamp-2">{text}</span>
  ) : (
    <span className="text-muted-foreground italic">
      {contentType === "video" ? "Untitled video" : "No message"}
    </span>
  );

  return (
    <div className="flex min-w-0 items-start gap-2">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 space-y-0.5">
        <p className="text-sm">
          {href ? (
            <Link href={href} className="hover:underline">
              {body}
            </Link>
          ) : (
            body
          )}
        </p>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {subtitle ? <span className="truncate">{subtitle}</span> : null}
          {permalinkUrl ? (
            <a
              href={permalinkUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 hover:text-foreground"
            >
              Facebook
              <ExternalLink className="size-3" aria-hidden />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Identity cell for a streamer: initials, name, internal code.
 *
 * No Page thumbnail. Meta serves those from its own CDN, and `img-src` is
 * deliberately `'self' data: blob:` with no remote host — an avatar is not
 * worth reopening an exfiltration channel that CSP currently closes. Initials
 * carry the same recognition at no cost.
 */
export function StreamerCell({ name, code, href }: { name: string; code: string; href?: string }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");

  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <span
        aria-hidden
        className="grid size-8 shrink-0 place-items-center rounded-full bg-brand-subtle text-xs font-semibold text-accent-foreground"
      >
        {initials || "?"}
      </span>
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">
          {href ? (
            <Link href={href} className="hover:underline">
              {name}
            </Link>
          ) : (
            name
          )}
        </p>
        <p className="truncate font-mono text-xs text-muted-foreground">{code}</p>
      </div>
    </div>
  );
}
