import Link from "next/link";
import { AlertTriangle, Inbox } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { TableCell, TableRow } from "@/components/ui/table";

/**
 * Empty, loading and error presentation.
 *
 * Kept together because the three are one decision, not three: a screen that
 * has a polished table and an unstyled "no rows" message reads as broken, and
 * an empty state that does not say *why* it is empty leaves the reader with no
 * next action. Every empty state here takes an explicit action.
 */

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: { label: string; href: string } | undefined;
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
      <Inbox className="size-8 text-muted-foreground" aria-hidden />
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">{description}</p>
      </div>
      {action ? (
        <Button asChild variant="outline" size="sm">
          <Link href={action.href}>{action.label}</Link>
        </Button>
      ) : null}
    </div>
  );
}

/** An empty state that lives inside a table body, spanning every column. */
export function EmptyTableRow({
  colSpan,
  title,
  description,
  action,
}: {
  colSpan: number;
  title: string;
  description: string;
  action?: { label: string; href: string } | undefined;
}) {
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={colSpan} className="p-0">
        <EmptyState title={title} description={description} action={action} />
      </TableCell>
    </TableRow>
  );
}

/**
 * Skeleton rows sized to the real table.
 *
 * The column count is passed in so the placeholder has the same shape as what
 * replaces it — a skeleton of the wrong width causes a visible reflow, which
 * defeats the point of showing one.
 */
export function TableSkeleton({ columns, rows = 8 }: { columns: number; rows?: number }) {
  return (
    <div className="space-y-2 p-4" aria-hidden>
      {Array.from({ length: rows }, (_, rowIndex) => (
        <div key={rowIndex} className="flex gap-3">
          {Array.from({ length: columns }, (_, columnIndex) => (
            <Skeleton
              key={columnIndex}
              className="h-6 flex-1"
              style={{ maxWidth: columnIndex === 0 ? "8rem" : undefined }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Card-shaped skeleton, for the dashboard's metric grid. */
export function MetricCardSkeleton() {
  return (
    <Card className="h-full gap-2" aria-hidden>
      <CardContent className="space-y-3 pt-6">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-7 w-16" />
        <Skeleton className="h-3 w-32" />
      </CardContent>
    </Card>
  );
}

/**
 * A screen-level failure.
 *
 * Deliberately does not render the raw error: a database or Graph error message
 * can carry connection details, and this component is reachable by any signed-in
 * role. `digest` is the handle for correlating with server logs.
 */
export function ErrorState({
  title = "Something went wrong",
  description,
  digest,
  onRetry,
}: {
  title?: string;
  description: string;
  digest?: string | undefined;
  onRetry?: (() => void) | undefined;
}) {
  return (
    <Card className="border-destructive/40">
      <CardContent className="flex flex-col items-start gap-3 pt-6">
        <div className="flex items-center gap-2">
          <AlertTriangle className="size-5 text-destructive" aria-hidden />
          <p className="text-sm font-medium">{title}</p>
        </div>
        <p className="text-sm text-muted-foreground">{description}</p>
        {digest ? (
          <p className="font-mono text-xs text-muted-foreground">Reference: {digest}</p>
        ) : null}
        {onRetry ? (
          <Button variant="outline" size="sm" onClick={onRetry}>
            Try again
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}
