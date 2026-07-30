"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { mainNav } from "@/config/navigation";
import { can, type UserRole } from "@/lib/auth/roles";
import { cn } from "@/lib/utils";

/**
 * Sidebar links, filtered to what the role can actually reach.
 *
 * This is cosmetic. The role is passed from a Server Component that already
 * authenticated it, and every destination re-checks server-side.
 */
export function SidebarNav({ role }: { role: UserRole }) {
  const pathname = usePathname();

  const items = mainNav.filter((item) => can(role, item.permission));

  return (
    <nav aria-label="Main" className="flex flex-col gap-1">
      {items.map((item) => {
        const Icon = item.icon;
        const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`);

        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
              isActive
                ? "bg-accent font-medium text-accent-foreground"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
            )}
          >
            <Icon className="size-4 shrink-0" aria-hidden />
            {item.title}
          </Link>
        );
      })}
    </nav>
  );
}
