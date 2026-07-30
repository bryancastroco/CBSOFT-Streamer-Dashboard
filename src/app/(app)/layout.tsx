import Link from "next/link";

import { MobileNav } from "@/components/layout/mobile-nav";
import { SidebarNav } from "@/components/layout/sidebar-nav";
import { SignOutButton } from "@/components/layout/sign-out-button";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Toaster } from "@/components/ui/sonner";
import { requireUser } from "@/lib/auth/guards";
import { ROLE_LABELS } from "@/lib/auth/roles";

/**
 * Applies to every route in this segment.
 *
 * Authenticated pages are per-user by definition: prerendering one at build
 * time would bake one person's view into a shared static asset. Marking the
 * layout dynamic makes that impossible for the whole group at once, rather
 * than relying on each page to remember.
 */
export const dynamic = "force-dynamic";

/**
 * Shell for every authenticated screen.
 *
 * `requireUser()` runs on the server for every request under this layout.
 * Middleware has already made the same check, but this one cannot be bypassed
 * by a matcher change or a rewrite — and it is what supplies the role the
 * sidebar filters on.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();

  return (
    <div className="flex min-h-full flex-col">
      <header className="border-b">
        <div className="mx-auto flex h-14 w-full max-w-7xl items-center gap-2 px-4 sm:gap-3">
          <MobileNav role={user.role} />
          <Link href="/dashboard" className="font-semibold tracking-tight">
            CBSOFT
          </Link>
          <Separator orientation="vertical" className="hidden h-5 sm:block" />
          <span className="hidden text-sm text-muted-foreground sm:inline">
            Streamer Performance Dashboard
          </span>

          <div className="ml-auto flex items-center gap-2 sm:gap-3">
            <div className="hidden text-right lg:block">
              <p className="text-xs leading-tight font-medium">{user.fullName ?? user.email}</p>
              <p className="text-xs leading-tight text-muted-foreground">{user.email}</p>
            </div>
            <Badge variant={user.role === "admin" ? "default" : "secondary"}>
              {ROLE_LABELS[user.role]}
            </Badge>
            <ThemeToggle />
            <SignOutButton showIcon />
          </div>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-7xl flex-1 gap-8 px-4 py-6 sm:py-8">
        <aside className="hidden w-56 shrink-0 md:block">
          <SidebarNav role={user.role} />
        </aside>
        <main className="min-w-0 flex-1 space-y-6">{children}</main>
      </div>

      <Toaster />
    </div>
  );
}
