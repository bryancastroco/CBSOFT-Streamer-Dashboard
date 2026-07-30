import { MoreHorizontal } from "lucide-react";

import { Breadcrumbs } from "@/components/layout/top-header";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/**
 * The header every page opens with.
 *
 * Three action slots, deliberately: one primary, one secondary, one overflow.
 * Pages that grew five equally-weighted buttons taught the reader nothing
 * about which one they wanted — a hierarchy of one, one and a menu forces that
 * decision at the call site rather than in the reader's head.
 *
 * `description` is optional now. Requiring it produced filler on pages whose
 * title already said everything.
 */
type PageHeaderProps = {
  title: string;
  description?: string;
  /** The single most likely action. Rendered solid. */
  primaryAction?: React.ReactNode;
  /** Common but secondary. Rendered outlined. */
  secondaryAction?: React.ReactNode;
  /** Rarely used: export, refresh, documentation. */
  overflow?: React.ReactNode;
  /** Suppress the trail on a top-level page where it would only repeat. */
  showBreadcrumbs?: boolean;
  className?: string;
};

export function PageHeader({
  title,
  description,
  primaryAction,
  secondaryAction,
  overflow,
  showBreadcrumbs = true,
  className,
}: PageHeaderProps) {
  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {showBreadcrumbs ? <Breadcrumbs /> : null}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <h1 className="truncate text-xl font-semibold tracking-tight sm:text-2xl">{title}</h1>
          {description ? (
            <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>
          ) : null}
        </div>

        {primaryAction || secondaryAction || overflow ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {secondaryAction}
            {primaryAction}
            {overflow ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="icon" aria-label="More actions">
                    <MoreHorizontal className="size-4" aria-hidden />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52">
                  {overflow}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function SectionHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 space-y-0.5">
        <h2 className="text-base font-semibold tracking-tight">{title}</h2>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** A titled band within a page, grouping related content under one idea. */
export function PageSection({
  title,
  description,
  actions,
  children,
  className,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("space-y-3", className)}>
      <SectionHeader title={title} description={description} actions={actions} />
      {children}
    </section>
  );
}
