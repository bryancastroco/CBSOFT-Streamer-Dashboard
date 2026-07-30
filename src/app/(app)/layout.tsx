import { cookies } from "next/headers";

import { signOutAction } from "@/app/(auth)/login/actions";
import { COLLAPSE_COOKIE, DesktopSidebar } from "@/components/layout/nav";
import { TopHeader, type SyncSummary } from "@/components/layout/top-header";
import { Toaster } from "@/components/ui/sonner";
import { requireUser } from "@/lib/auth/guards";
import { listSyncLogs } from "@/lib/repositories/sync-logs";

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
 * Latest run, for the header indicator.
 *
 * Failing quietly is deliberate here. This runs on every authenticated screen,
 * and a database hiccup while reading a status badge must not take down the
 * page the reader actually came for — the indicator falls back to "unknown".
 */
async function latestSync(): Promise<SyncSummary | null> {
  try {
    const [latest] = await listSyncLogs(1);
    if (!latest) return null;

    return {
      status: latest.status,
      finishedAt: latest.completedAt ? latest.completedAt.toISOString() : null,
    };
  } catch {
    return null;
  }
}

/**
 * Shell for every authenticated screen.
 *
 * `requireUser()` runs on the server for every request under this layout. The
 * proxy has already made the same check, but this one cannot be bypassed by a
 * matcher change or a rewrite — and it is what supplies the role the
 * navigation filters on.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const sync = await latestSync();

  // Read here so the rail renders at its stored width on the first paint.
  const collapsed = (await cookies()).get(COLLAPSE_COOKIE)?.value === "true";

  return (
    <div className="flex min-h-svh flex-col">
      {/*
       * Skip link. The sidebar is a long list, and without this a keyboard
       * user tabs through all of it on every page to reach the content.
       * Visible only while focused.
       */}
      <a
        href="#main-content"
        className="sr-only bg-brand text-brand-foreground focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:px-3 focus:py-2 focus:text-sm focus:ring-2 focus:ring-ring"
      >
        Skip to content
      </a>

      <TopHeader
        role={user.role}
        email={user.email}
        fullName={user.fullName}
        sync={sync}
        onSignOut={signOutAction}
      />

      <div className="flex flex-1">
        <DesktopSidebar role={user.role} defaultCollapsed={collapsed} />

        <main
          id="main-content"
          tabIndex={-1}
          className="mx-auto w-full max-w-content min-w-0 flex-1 space-y-6 px-4 py-6 outline-none sm:px-6 sm:py-8"
        >
          {children}
        </main>
      </div>

      <Toaster />
    </div>
  );
}
