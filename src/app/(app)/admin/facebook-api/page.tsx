import type { Metadata } from "next";

import { PageHeader } from "@/components/layout/page-header";
import { PlaceholderState } from "@/components/layout/states";
import { requireAdmin } from "@/lib/auth/guards";

export const metadata: Metadata = { title: "Facebook API" };

/**
 * Facebook API — placeholder.
 *
 * The navigation structure for Phase 16 names this screen, so the route exists
 * and is guarded. It renders nothing that pretends to be data: a mock panel
 * here would be indistinguishable from a real one that had broken.
 *
 * `requireAdmin()` runs even though there is nothing to protect yet, so the
 * guard is already in place when the content arrives rather than being
 * remembered later.
 */
export default async function Page() {
  await requireAdmin();

  return (
    <>
      <PageHeader
        title="Facebook API"
        description="Meta app configuration and Page token health, in one place instead of spread across streamer records."
      />
      <PlaceholderState
        title="Not built yet"
        description="Meta app configuration and Page token health, in one place instead of spread across streamer records."
        arrivingIn="a later phase"
      />
    </>
  );
}
