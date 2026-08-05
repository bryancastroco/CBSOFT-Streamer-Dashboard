import {
  ActiveTogglePanel,
  DeletePanel,
  PurgePanel,
} from "@/app/(app)/admin/streamers/[id]/panels";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import type { StreamerRemovalView } from "@/lib/repositories/streamers";

/**
 * The three ways to stop using a streamer, in one place.
 *
 * ## Why this is a component and not markup on a page
 *
 * It was markup on a page — twice. `/admin/streamers/[id]` and the Settings tab
 * of `/streamers/[id]` each carried their own copy of a card labelled "Danger
 * zone", built from the same two panels. Adding a third, irreversible option to
 * one of them left the other showing two, under a description that no longer
 * matched what its buttons did. Nothing failed and no test broke; the screens
 * simply disagreed, and the only way to find out was for somebody to open the
 * one that had not been updated and ask what the difference was.
 *
 * Duplicated UI over a destructive action is worse than duplicated UI anywhere
 * else, because the copy that drifts is the one telling a person what they are
 * about to lose.
 *
 * ## Presentational, deliberately
 *
 * The data arrives as one object from `getStreamerRemovalView`. Fetching in
 * here would mean importing repositories into a component, which the
 * server-only lint rule refuses — it cannot tell a Server Component from a
 * Client one, so it goes by where the file sits. Keeping the query in one
 * repository function and the markup in one component gets the anti-drift
 * property twice over, without weakening a rule that exists to keep secrets out
 * of the browser bundle.
 *
 * ## Ordering
 *
 * Ascending cost, and each heading names what it costs. "Delete streamer" was
 * previously the label on something that deleted no data at all — the record
 * and every post, comment and analysis stayed. The wording is the feature here.
 */
export function StreamerRemovalCard({ streamer }: { streamer: StreamerRemovalView }) {
  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle className="text-base">Removing this streamer</CardTitle>
        <CardDescription>
          Three options, in order of what they cost. Only the last one destroys data.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {!streamer.deletedAt ? (
          <>
            <section className="space-y-2">
              <h3 className="text-sm font-medium">Disable — reversible</h3>
              <p className="text-xs text-muted-foreground">
                Synchronisation stops. Everything already collected stays, the token stays, and the
                streamer keeps appearing in reports. Enable it again at any time.
              </p>
              <ActiveTogglePanel streamerId={streamer.id} active={streamer.active} />
            </section>

            <Separator />

            <section className="space-y-2">
              <h3 className="text-sm font-medium">Remove from roster — data kept</h3>
              <p className="text-xs text-muted-foreground">
                For a streamer who has left. They disappear from the roster and stop syncing, but
                their {streamer.postCount} post{streamer.postCount === 1 ? "" : "s"} and{" "}
                {streamer.videoCount} video{streamer.videoCount === 1 ? "" : "s"} remain in the
                system and in historical reports. The stored Page token is destroyed.
              </p>
              <DeletePanel streamerId={streamer.id} streamerCode={streamer.streamerCode} />
            </section>

            <Separator />
          </>
        ) : (
          <p className="text-xs text-muted-foreground">
            This streamer has been removed from the roster. Its content is still stored and still
            counted in reports. Deleting permanently is the only remaining option.
          </p>
        )}

        <section className="space-y-2">
          <h3 className="text-sm font-medium text-destructive">
            Delete permanently — cannot be undone
          </h3>
          <p className="text-xs text-muted-foreground">
            Removes the streamer and every post, video, comment, analysis, metric and sync run
            belonging to it. Use this for a Page added by mistake, a test entry, or a deletion
            request — not for someone who has simply left.
          </p>
          <PurgePanel
            streamerId={streamer.id}
            streamerCode={streamer.streamerCode}
            footprint={streamer.footprint}
          />
        </section>
      </CardContent>
    </Card>
  );
}
