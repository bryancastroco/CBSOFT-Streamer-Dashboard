"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { mainNav } from "@/config/navigation";
import { can, type UserRole } from "@/lib/auth/roles";

/**
 * Navigation for narrow viewports, where the sidebar is hidden.
 *
 * Same source of truth and same role filtering as `SidebarNav` — the two must
 * never diverge, or a link would exist on one form factor and not the other.
 */
export function MobileNav({ role }: { role: UserRole }) {
  const pathname = usePathname();
  const items = mainNav.filter((item) => can(role, item.permission));

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="md:hidden" aria-label="Open navigation">
          <Menu className="size-4" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel>Navigate</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {items.map((item) => {
          const Icon = item.icon;
          const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`);

          return (
            <DropdownMenuItem key={item.href} asChild>
              <Link href={item.href} aria-current={isActive ? "page" : undefined}>
                <Icon className="size-4" aria-hidden />
                {item.title}
              </Link>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
