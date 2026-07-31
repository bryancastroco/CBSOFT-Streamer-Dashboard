"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import * as React from "react";
import { ChevronRight, LogOut, Search, User as UserIcon } from "lucide-react";

import { StatusBadge } from "@/components/ui/status-badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { MobileNavDrawer } from "@/components/layout/nav";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { findNavItem } from "@/config/navigation";
import { ROLE_LABELS, type UserRole } from "@/lib/auth/roles";
import { useRelativeTime } from "@/lib/ui/use-now";
import { cn } from "@/lib/utils";

/**
 * Breadcrumb trail, derived from the path.
 *
 * Segments resolve through the navigation config so a crumb reads "Sync
 * history" rather than "sync-logs". An id segment keeps its raw value — the
 * page itself renames it once it knows what the record is called, and guessing
 * here would be worse than a short-lived identifier.
 */
export function Breadcrumbs({ className }: { className?: string }) {
  const pathname = usePathname();
  const segments = pathname.split("/").filter(Boolean);

  if (segments.length === 0) return null;

  /*
   * Record ids are dropped rather than shown.
   *
   * `/posts/<uuid>` used to render "Posts > Posts", because the nav lookup
   * matches on prefix and happily resolved the id segment back to its parent.
   * Showing the raw uuid instead would be worse — it is 36 characters of noise
   * that names nothing to a reader — and the page's own heading already says
   * which record this is. So the trail stops at the last segment that means
   * something.
   */
  const isRecordId = (segment: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment) ||
    /^\d{6,}$/.test(segment);

  const crumbs = segments
    .map((segment, index) => ({
      segment,
      href: `/${segments.slice(0, index + 1).join("/")}`,
    }))
    .filter(({ segment }) => !isRecordId(segment))
    .map(({ segment, href }) => ({
      href,
      // Exact match only. A prefix match is what produced the duplicate.
      label:
        findNavItem(href)?.href === href
          ? (findNavItem(href)?.title ?? segment)
          : segment.replace(/-/g, " "),
    }));

  if (crumbs.length === 0) return null;

  return (
    <nav aria-label="Breadcrumb" className={cn("min-w-0", className)}>
      <ol className="flex items-center gap-1 text-xs text-muted-foreground">
        {crumbs.map((crumb, index) => {
          const last = index === crumbs.length - 1;
          return (
            <li key={crumb.href} className="flex min-w-0 items-center gap-1">
              {index > 0 ? <ChevronRight className="size-3 shrink-0" aria-hidden /> : null}
              {last ? (
                <span
                  aria-current="page"
                  className="truncate font-medium text-foreground capitalize"
                >
                  {crumb.label}
                </span>
              ) : (
                <Link href={crumb.href} className="truncate capitalize hover:text-foreground">
                  {crumb.label}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export type SyncSummary = {
  status: string | null;
  finishedAt: string | null;
};

/**
 * Latest sync, as a control rather than an ornament.
 *
 * "When did data last arrive?" is the question this dashboard exists to
 * answer, so it sits in the header on every screen and links to the history
 * rather than merely reporting.
 */
function SyncStatusIndicator({ sync }: { sync: SyncSummary | null }) {
  /*
   * Null until the client has hydrated, because the relative phrasing depends
   * on the current time and the server's "now" is not the reader's. The badge
   * carries the status regardless; the age is an enhancement on top of it.
   */
  const relative = useRelativeTime(sync?.finishedAt);

  return (
    <Link
      href="/admin/sync-logs"
      className="hidden items-center gap-2 rounded-md px-2 py-1 outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring/50 sm:flex"
    >
      <StatusBadge domain="sync" status={sync?.status ?? "unknown"} />
      {relative ? (
        <span className="hidden text-xs text-muted-foreground lg:inline">{relative}</span>
      ) : null}
      <span className="sr-only">View synchronisation history</span>
    </Link>
  );
}

/**
 * Global search.
 *
 * Submits to the posts list, which is the only surface with a text index
 * today. It is deliberately a real form: a search box that looks live and
 * silently does nothing is worse than none at all.
 */
function GlobalSearch() {
  const router = useRouter();
  const [term, setTerm] = React.useState("");

  return (
    <form
      role="search"
      onSubmit={(event) => {
        event.preventDefault();
        const query = term.trim();
        if (query) router.push(`/posts?q=${encodeURIComponent(query)}`);
      }}
      className="hidden min-w-0 flex-1 justify-center md:flex"
    >
      <div className="relative w-full max-w-sm">
        <Search
          className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          type="search"
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          placeholder="Search posts…"
          aria-label="Search posts"
          className="h-9 pl-8"
        />
      </div>
    </form>
  );
}

function initialsOf(name: string | null, email: string): string {
  const source = name?.trim() || email;
  const parts = source.split(/[\s@.]+/).filter(Boolean);
  return (parts[0]?.[0] ?? "?").concat(parts[1]?.[0] ?? "").toUpperCase();
}

export function TopHeader({
  role,
  email,
  fullName,
  sync,
  onSignOut,
}: {
  role: UserRole;
  email: string;
  fullName: string | null;
  sync: SyncSummary | null;
  onSignOut: () => Promise<void>;
}) {
  return (
    <header className="sticky top-0 z-40 flex h-header items-center gap-2 border-b border-border bg-surface/95 px-3 backdrop-blur sm:gap-3 sm:px-4">
      <MobileNavDrawer role={role} />

      <Link
        href="/dashboard"
        className="flex shrink-0 items-center gap-2 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <span
          aria-hidden
          className="grid size-7 place-items-center rounded-md bg-brand text-xs font-bold text-brand-foreground"
        >
          CB
        </span>
        <span className="hidden text-sm font-semibold tracking-tight sm:inline">CBSOFT</span>
      </Link>

      <GlobalSearch />

      <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-2">
        <SyncStatusIndicator sync={sync} />
        <ThemeToggle />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Account menu" className="rounded-full">
              <span className="grid size-7 place-items-center rounded-full bg-brand-subtle text-xs font-semibold text-accent-foreground">
                {initialsOf(fullName, email)}
              </span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60">
            <DropdownMenuLabel className="flex flex-col gap-0.5">
              <span className="truncate text-sm font-medium">{fullName ?? email}</span>
              <span className="truncate text-xs font-normal text-muted-foreground">{email}</span>
              <span className="mt-1 text-xs font-normal text-muted-foreground">
                Role: {ROLE_LABELS[role]}
              </span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href="/settings">
                <UserIcon className="size-4" aria-hidden />
                Account settings
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild variant="destructive">
              {/*
               * Sign-out stays a form posting to a Server Action. A link would
               * make it a GET, which a link prefetcher can follow — signing
               * people out by hovering.
               */}
              <form action={onSignOut}>
                <button type="submit" className="flex w-full items-center gap-2">
                  <LogOut className="size-4" aria-hidden />
                  Sign out
                </button>
              </form>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
