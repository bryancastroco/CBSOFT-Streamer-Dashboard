import type { LucideIcon } from "lucide-react";
import { Construction, Inbox, TriangleAlert } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * Empty, error and loading states, so every screen says the same kind of thing
 * in the same kind of way.
 *
 * The rule they share: name what happened, then offer the next action. A bare
 * "No results" leaves the reader to work out whether that means the filter is
 * too narrow, the sync has not run, or something is broken — three different
 * problems with three different fixes.
 */

export function EmptyState({
  icon: Icon = Inbox,
  title,
  description,
  actions,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn("border-dashed shadow-none", className)}>
      <CardContent className="flex flex-col items-center gap-3 px-6 py-12 text-center">
        <span className="grid size-11 place-items-center rounded-full bg-muted text-muted-foreground">
          <Icon className="size-5" aria-hidden />
        </span>
        <div className="space-y-1">
          <p className="font-medium">{title}</p>
          {description ? (
            <p className="mx-auto max-w-md text-sm text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="flex flex-wrap justify-center gap-2 pt-1">{actions}</div> : null}
      </CardContent>
    </Card>
  );
}

/**
 * A problem the reader can act on.
 *
 * Never renders a stack trace. `detail` is for a sanitised, human sentence —
 * an expired token, a missing permission — not for an exception message, which
 * tends to name internals and occasionally credentials.
 */
export function ErrorState({
  title,
  detail,
  actions,
  className,
}: {
  title: string;
  detail?: string;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn("border-danger/30 bg-danger-subtle/40 shadow-none", className)}>
      <CardContent className="flex flex-col gap-3 px-6 py-8 sm:flex-row sm:items-start">
        <span className="shrink-0 text-danger" aria-hidden>
          <TriangleAlert className="size-5" />
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <p className="font-medium">{title}</p>
          {detail ? <p className="text-sm text-muted-foreground">{detail}</p> : null}
          {actions ? <div className="flex flex-wrap gap-2 pt-2">{actions}</div> : null}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * A screen that is deliberately not built yet.
 *
 * Says so plainly, per the project rule that a placeholder must announce
 * itself. Nothing here pretends to be data — a mock chart on an unfinished
 * page is indistinguishable from a broken real one.
 */
export function PlaceholderState({
  title,
  description,
  arrivingIn,
}: {
  title: string;
  description: string;
  arrivingIn?: string;
}) {
  return (
    <EmptyState
      icon={Construction}
      title={title}
      description={
        arrivingIn ? `${description} This screen is planned for ${arrivingIn}.` : description
      }
    />
  );
}

/** Table skeleton. Mirrors the real row height so the page does not jump. */
export function TableSkeleton({ rows = 6, columns = 5 }: { rows?: number; columns?: number }) {
  return (
    <div className="space-y-2" aria-hidden>
      <Skeleton className="h-9 w-full" />
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <div key={rowIndex} className="flex gap-3">
          {Array.from({ length: columns }).map((_, columnIndex) => (
            <Skeleton
              key={columnIndex}
              className={cn("h-10", columnIndex === 0 ? "flex-[2]" : "flex-1")}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Metric-card skeleton row. */
export function CardSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" aria-hidden>
      {Array.from({ length: count }).map((_, index) => (
        <Skeleton key={index} className="h-24 rounded-xl" />
      ))}
    </div>
  );
}

/**
 * Whole-page skeleton.
 *
 * Announced politely rather than assertively: a loading state that interrupts
 * a screen reader mid-sentence is worse than one it reaches in its own time.
 */
export function PageSkeleton() {
  return (
    <div className="space-y-6" role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">Loading</span>
      <div className="space-y-2" aria-hidden>
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-7 w-64" />
      </div>
      <CardSkeleton />
      <TableSkeleton />
    </div>
  );
}
