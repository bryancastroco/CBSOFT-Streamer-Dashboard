import type { Metadata } from "next";

import { VideoLibrary } from "@/app/(app)/videos/video-library";
import { requireUser } from "@/lib/auth/guards";
import type { RawParams } from "@/lib/filters/browse";
import { DISPLAY_TIME_ZONE_LABEL } from "@/lib/time/zone";

export const metadata: Metadata = { title: "Videos" };
export const dynamic = "force-dynamic";

/**
 * Uploads and reels — not broadcasts, which have their own screen.
 *
 * This listed both until livestreams were told apart, and the description said
 * so: "ended live broadcasts appear here as VODs". That was honest about a
 * screen mixing a two-hour stream with a forty-second reel, and the fix was to
 * stop mixing them rather than to keep explaining it.
 */
export default async function VideosPage({ searchParams }: { searchParams: Promise<RawParams> }) {
  await requireUser();

  return (
    <VideoLibrary
      searchParams={searchParams}
      scope="videos"
      basePath="/videos"
      title="Videos"
      description={`Uploads and reels published on connected Facebook Pages. Recorded livestreams have their own screen. All times are ${DISPLAY_TIME_ZONE_LABEL}.`}
      searchPlaceholder="Title, description, video id or streamer…"
      itemLabel="videos"
      empty={{
        title: "No videos match these filters",
        filtered: "Try widening the period, clearing the search, or choosing All streamers.",
        unfiltered: "An admin can collect videos from Admin → Streamers → Sync Videos.",
      }}
      csvBaseName="videos"
    />
  );
}
