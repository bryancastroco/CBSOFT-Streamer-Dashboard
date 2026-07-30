import Link from "next/link";

import { cn } from "@/lib/utils";

/**
 * Tabs built from links rather than from client state.
 *
 * Each tab is its own URL, which means it is bookmarkable, shareable and
 * server-rendered — a tab holding a large table does not have to be fetched and
 * held in memory just because a sibling tab is open. The trade is that switching
 * tabs is a navigation; on a dashboard where each tab is a distinct query, that
 * is the right trade.
 *
 * Marked up as a `nav` with `aria-current`, not `role="tablist"`: these are
 * links, and claiming the tab pattern would promise a keyboard model (arrow
 * keys move between tabs) that links do not implement.
 */

export type TabItem = {
  key: string;
  label: string;
  href: string;
  /** Optional count shown beside the label. */
  badge?: number | undefined;
};

export function TabNav({
  items,
  active,
  label = "Sections",
}: {
  items: readonly TabItem[];
  active: string;
  label?: string;
}) {
  return (
    <nav aria-label={label} className="-mx-1 overflow-x-auto">
      <ul className="flex min-w-max items-center gap-1 border-b px-1">
        {items.map((item) => {
          const isActive = item.key === active;

          return (
            <li key={item.key}>
              <Link
                href={item.href}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "-mb-px inline-flex items-center gap-2 rounded-t-md border-b-2 px-3 py-2 text-sm whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                  isActive
                    ? "border-foreground font-medium text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {item.label}
                {item.badge !== undefined ? (
                  <span className="rounded-full bg-muted px-1.5 py-0.5 text-xs text-muted-foreground tabular-nums">
                    {item.badge}
                  </span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
