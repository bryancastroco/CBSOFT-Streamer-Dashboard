import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Users } from "lucide-react";

import { GamesManager } from "@/app/(app)/admin/games/game-forms";
import { PageHeader } from "@/components/layout/page-header";
import { CardSkeleton } from "@/components/layout/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireAdmin } from "@/lib/auth/guards";
import { countUnattributedContent, listGames } from "@/lib/repositories/games";

export const metadata: Metadata = { title: "Games" };
export const dynamic = "force-dynamic";

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
  const [games, unattributed] = await Promise.all([listGames(), countUnattributedContent()]);

  return (
    <>
      {games.length > 0 && unattributed > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {unattributed.toLocaleString("en-GB")} item
              {unattributed === 1 ? "" : "s"} filed under no game
            </CardTitle>
            <CardDescription>
              Posts and videos with no matching hashtag, published by a streamer with no primary
              game. They still appear everywhere they did before — they simply cannot be reached by
              a game filter. Setting a primary game on those streamers is usually the fastest fix.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline" size="sm">
              <Link href="/posts?gameId=none">Show them</Link>
            </Button>
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
