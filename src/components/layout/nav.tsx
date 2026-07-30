"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, PanelLeftClose, PanelLeftOpen } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { FOOTER_NAV, NAV_GROUPS, type NavItem } from "@/config/navigation";
import { can, type UserRole } from "@/lib/auth/roles";
import { cn } from "@/lib/utils";

/**
 * Sidebar and mobile drawer, sharing one link list.
 *
 * They render from the same `NavLinks` on purpose. The previous pair drifted —
 * the drawer was a flat dropdown while the sidebar was a list — and a link
 * that exists on one form factor but not the other is the kind of gap nobody
 * notices until someone on a phone cannot reach a page.
 */

/** Read by the server layout so the first paint has the right width. */
export const COLLAPSE_COOKIE = "cbsoft_sidebar_collapsed";

function isActivePath(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavLink({
  item,
  collapsed,
  onNavigate,
}: {
  item: NavItem;
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const active = isActivePath(pathname, item.href);
  const Icon = item.icon;

  const link = (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group/nav relative flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
        "outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        collapsed && "justify-center px-0",
        active
          ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
          : "text-sidebar-foreground/75 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground",
      )}
    >
      {/*
       * The active marker is a bar, not just a tint. Tint alone is a colour
       * cue, and it survives neither a high-contrast mode nor a greyscale
       * screenshot.
       */}
      {active ? (
        <span
          aria-hidden
          className="absolute inset-y-1 left-0 w-0.5 rounded-r bg-sidebar-primary"
        />
      ) : null}
      <Icon className="size-4 shrink-0" aria-hidden />
      {collapsed ? <span className="sr-only">{item.title}</span> : <span>{item.title}</span>}
      {item.placeholder && !collapsed ? (
        <span className="ml-auto rounded border border-border px-1 text-[10px] leading-4 text-muted-foreground">
          Soon
        </span>
      ) : null}
    </Link>
  );

  // A collapsed rail is icons only, so the name has to come from somewhere.
  if (!collapsed) return link;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right">
        {item.title}
        {item.placeholder ? " (coming soon)" : ""}
      </TooltipContent>
    </Tooltip>
  );
}

export function NavLinks({
  role,
  collapsed = false,
  onNavigate,
}: {
  role: UserRole;
  collapsed?: boolean;
  onNavigate?: () => void;
}) {
  const groups = NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => can(role, item.permission)),
  })).filter((group) => group.items.length > 0);

  const footer = FOOTER_NAV.filter((item) => can(role, item.permission));

  return (
    <div className="flex h-full flex-col gap-6">
      <nav aria-label="Main" className="flex flex-1 flex-col gap-5">
        {groups.map((group) => (
          <div key={group.label} className="flex flex-col gap-1">
            {/*
             * The heading is hidden visually when collapsed but kept for
             * screen readers — the grouping is still real, it just has no room
             * to be drawn.
             */}
            <h2
              className={cn(
                "px-3 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase",
                collapsed && "sr-only",
              )}
            >
              {group.label}
            </h2>
            {group.items.map((item) => (
              <NavLink key={item.href} item={item} collapsed={collapsed} onNavigate={onNavigate} />
            ))}
          </div>
        ))}
      </nav>

      {footer.length > 0 ? (
        <nav
          aria-label="Support"
          className="flex flex-col gap-1 border-t border-sidebar-border pt-3"
        >
          {footer.map((item) => (
            <NavLink key={item.href} item={item} collapsed={collapsed} onNavigate={onNavigate} />
          ))}
        </nav>
      ) : null}
    </div>
  );
}

/**
 * Desktop rail. Collapses to icons and remembers the choice.
 *
 * The preference lives in a cookie rather than localStorage so the server
 * already knows it and renders the correct width on the first paint. Reading
 * localStorage in an effect meant every collapsed user watched the rail slide
 * shut after hydration, and setting state from an effect body is a cascading
 * render besides. A cookie makes the state part of the request, which is what
 * it always was.
 */
export function DesktopSidebar({
  role,
  defaultCollapsed = false,
}: {
  role: UserRole;
  defaultCollapsed?: boolean;
}) {
  const [collapsed, setCollapsed] = React.useState(defaultCollapsed);

  function toggle() {
    const next = !collapsed;
    setCollapsed(next);
    // A year, path-wide, lax: a layout preference, not a credential.
    document.cookie = `${COLLAPSE_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
  }

  return (
    <aside
      data-collapsed={collapsed}
      className={cn(
        "sticky top-header hidden shrink-0 border-r border-sidebar-border bg-sidebar md:flex md:flex-col",
        "h-[calc(100svh-var(--header-height))]",
        "motion-safe:transition-[width] motion-safe:duration-200",
        collapsed ? "w-sidebar-collapsed" : "w-sidebar",
      )}
    >
      <div className="flex-1 overflow-y-auto px-3 py-4">
        <NavLinks role={role} collapsed={collapsed} />
      </div>

      <div className="border-t border-sidebar-border p-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={toggle}
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className={cn("w-full gap-2", collapsed && "justify-center px-0")}
        >
          {collapsed ? (
            <PanelLeftOpen className="size-4" aria-hidden />
          ) : (
            <PanelLeftClose className="size-4" aria-hidden />
          )}
          {collapsed ? null : <span>Collapse</span>}
        </Button>
      </div>
    </aside>
  );
}

/**
 * Mobile drawer.
 *
 * Built on the dialog primitive rather than a dropdown so it gets a focus
 * trap, escape-to-close and an inert background — a navigation panel that
 * leaks focus to the page behind it is unusable with a keyboard or a screen
 * reader. It closes on navigation, since the route change is the whole reason
 * it was opened.
 */
export function MobileNavDrawer({ role }: { role: UserRole }) {
  const [open, setOpen] = React.useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" className="md:hidden" aria-label="Open navigation">
          <Menu className="size-5" aria-hidden />
        </Button>
      </DialogTrigger>
      <DialogContent
        showCloseButton
        className={cn(
          "top-0 left-0 h-svh w-[17rem] max-w-[85vw] translate-x-0 translate-y-0 gap-0 rounded-none border-y-0 border-l-0 bg-sidebar p-0 sm:max-w-[85vw]",
          "data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left",
        )}
      >
        <DialogTitle className="flex h-header items-center border-b border-sidebar-border px-4 text-sm font-semibold">
          CBSOFT
        </DialogTitle>
        <div className="flex-1 overflow-y-auto px-3 py-4">
          <NavLinks role={role} onNavigate={() => setOpen(false)} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
