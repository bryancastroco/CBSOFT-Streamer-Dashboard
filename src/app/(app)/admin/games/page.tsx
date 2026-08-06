import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Users } from "lucide-react";

import { GameFilterOptionsCard } from "@/app/(app)/admin/games/filter-options-card";
import { GamesManager } from "@/app/(app)/admin/games/game-forms";
import { PageHeader } from "@/components/layout/page-header";
import { CardSkeleton } from "@/components/layout/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireAdmin } from "@/lib/auth/guards";
import { UNFILED_GAME } from "@/lib/filters/browse";
import { getGameFilterOptions } from "@/lib/repositories/app-settings";
import { countUnattributedContent, listGames } from "@/lib/repositories/games";

export const metadata: Metadata = { title: "Games" };
export const dynamic = "force-dynamic";

/*
 * Saving a game re-resolves attribution across the whole archive — deliberately,
 * because editing a hashtag has to re-file the posts that already mention it,
 * so this call cannot use the `onlyMissing` shortcut the nightly sweep does.
 *
 * That is a scan of every post and video, and it grows with the roster. Fast at
 * 1,600 posts; not obviously fast at thirty streamers' worth. Giving it room
 * costs nothing when it finishes quickly.
 */
export const maxDuration = 120;

/**
 * The games registry.
 *
 * ## How a post reaches a game
 *
 * Two routes, in this order:
 *
 *  1. A hashtag in the post's own text names a game. This wins, always — a
 *     streamer who covers three titles is telling you which one this post is
 *     about, and no default should override that.
 *  2. Otherwise the post inherits its streamer's primary game.
 *
 * Rule 2 is what makes the feature usable on the data that already exists.
 * Measured on this project's own posts, 102 of 1,624 carry any hashtag at all —
 * hashtag matching alone would leave 94% of the archive unattributed, and a
 * filter that hides most of the content is not a filter anyone would use.
 *
 * Attribution is recomputed on every save rather than nightly, because an admin
 * who adds a tag and sees nothing change reasonably concludes it is broken.
 */

async function Registry() {
  const [games, unattributed, filterOptions] = await Promise.all([
    listGames(),
    countUnattributedContent(),
    getGameFilterOptions(),
  ]);

  return (
    <>
      {/*
       * Above the registry, because it governs what every other screen shows
       * and is the first thing to check when the numbers look small.
       */}
      {games.length > 0 ? (
        <GameFilterOptionsCard options={filterOptions} unattributed={unattributed} />
      ) : null}

      {games.length > 0 && unattributed > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {unattributed.toLocaleString("en-GB")} item
              {unattributed === 1 ? "" : "s"} under no registered game
            </CardTitle>
            <CardDescription>
              Posts and videos with no matching hashtag, published by a streamer with no primary
              game. They still appear everywhere they did before — they simply cannot be reached by
              a game filter. Setting a primary game on those streamers is usually the fastest fix.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {/*
             * The only way into that view. The filter bar does not offer it —
             * it answers a configuration question, not a reading one — so these
             * links are the door, and they sit beside the count that gives
             * someone a reason to open it.
             */}
            <div className="flex flex-wrap gap-2">
              <Button asChild variant="outline" size="sm">
                <Link href={`/posts?gameId=${UNFILED_GAME}`}>Review the posts</Link>
              </Button>
              <Button asChild variant="outline" size="sm">
                <Link href={`/videos?gameId=${UNFILED_GAME}`}>Review the videos</Link>
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              These open the Game filter on a setting it does not otherwise offer. Clearing the
              filter returns the screen to normal.
            </p>
          </CardContent>
        </Card>
      ) : null}

      <GamesManager games={games} />
    </>
  );
}

export default async function GamesPage() {
  await requireAdmin();

  return (
    <>
      <PageHeader
        title="Games"
        description="Register the titles your streamers cover and the hashtags that identify them. Posts and videos are filed automatically, and every screen gains a Game filter."
        primaryAction={
          <Button asChild variant="outline" size="sm">
            <Link href="/admin/streamers">
              <Users className="size-4" aria-hidden />
              Assign to streamers
            </Link>
          </Button>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">How content is filed</CardTitle>
          <CardDescription>
            A hashtag in the post&apos;s own text wins — a streamer covering several titles is
            telling you which one that post is about. Anything without a matching hashtag falls back
            to the streamer&apos;s primary game, which is what makes the archive filterable at all:
            only about one post in sixteen carries a hashtag. Content matching neither is left
            unattributed rather than guessed at.
          </CardDescription>
        </CardHeader>
      </Card>

      <Suspense fallback={<CardSkeleton count={3} />}>
        <Registry />
      </Suspense>
    </>
  );
}
