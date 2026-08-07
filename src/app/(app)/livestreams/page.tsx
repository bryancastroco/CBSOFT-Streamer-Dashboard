import type { Metadata } from "next";

import { VideoLibrary } from "@/app/(app)/videos/video-library";
import { requireUser } from "@/lib/auth/guards";
import type { RawParams } from "@/lib/filters/browse";
import { DISPLAY_TIME_ZONE_LABEL } from "@/lib/time/zone";

export const metadata: Metadata = { title: "Livestreams" };
export const dynamic = "force-dynamic";

/**
 * Recorded broadcasts.
 *
 * The same table and the same screen as Videos, narrowed to `media_kind =
 * 'livestream'` — see `videos/video-library`. Its own route because a
 * broadcast is the streamer's main event and nobody wants it filed among
 * forty-second clips, and because "how did last night's stream go" is a
 * question people arrive with rather than filter their way to.
 *
 * Permission is `videos.view`: these are video rows, and a role allowed to read
 * one kind has no reason to be refused the other.
 */
export default async function LivestreamsPage({
  searchParams,
}: {
  searchParams: Promise<RawParams>;
}) {
  await requireUser();

  return (
    <VideoLibrary
      searchParams={searchParams}
      scope="livestreams"
      basePath="/livestreams"
      title="Livestreams"
      description={`Recorded broadcasts from connected Facebook Pages, as Meta returns them once a stream ends. All times are ${DISPLAY_TIME_ZONE_LABEL}.`}
      searchPlaceholder="Title, description, video id or streamer…"
      itemLabel="livestreams"
      empty={{
        title: "No livestreams match these filters",
        filtered: "Try widening the period, clearing the search, or choosing All streamers.",
        unfiltered:
          "A broadcast appears here after it ends and the next sync collects it. An admin can run one from Admin → Streamers → Sync Videos.",
      }}
      csvBaseName="videos"
    />
  );
}
