import type { Metadata } from "next";

import { PageHeader } from "@/components/layout/page-header";
import { PlaceholderState } from "@/components/layout/states";
import { requireUser } from "@/lib/auth/guards";

export const metadata: Metadata = { title: "Help and documentation" };

/**
 * Help — placeholder.
 *
 * The documentation it will surface already exists in `docs/`; this screen is
 * the in-product way in, and it is not written yet. Saying so beats linking to
 * a page that does not answer the question.
 */
export default async function Page() {
  await requireUser();

  return (
    <>
      <PageHeader
        title="Help and documentation"
        description="Setup guides, troubleshooting and secret rotation."
      />
      <PlaceholderState
        title="Not built yet"
        description="In the meantime the full documentation lives in the docs directory of the repository."
        arrivingIn="a later phase"
      />
    </>
  );
}
