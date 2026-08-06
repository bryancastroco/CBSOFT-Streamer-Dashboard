import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import {
  EditStreamerPanel,
  SyncPanel,
  TokenPanel,
} from "@/app/(app)/admin/streamers/[id]/panels";
import { StreamerGamesCard } from "@/app/(app)/admin/streamers/[id]/games-card";
import { StreamerRemovalCard } from "@/app/(app)/admin/streamers/[id]/removal-card";
import { SyncPostsPanel } from "@/app/(app)/admin/streamers/[id]/sync-posts-panel";
import { SyncVideosPanel } from "@/app/(app)/admin/streamers/[id]/sync-videos-panel";
import { PageHeader } from "@/components/layout/page-header";
import { TokenStatusBadge } from "@/components/admin/token-status-badge";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/ui/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { requireAdmin } from "@/lib/auth/guards";
import { EXPECTED_SCOPES } from "@/lib/meta/token-status";
import { listGameOptions, listStreamerGames } from "@/lib/repositories/games";
import { countPostsForStreamer } from "@/lib/repositories/posts";
import {
  getStreamerById,
  getStreamerRemovalView,
  listSyncRunsForStreamer,
} from "@/lib/repositories/streamers";
import { countVideosForStreamer } from "@/lib/repositories/videos";
import { streamerIdSchema } from "@/lib/validation/streamers";

export const metadata: Metadata = { title: "Streamer" };
export const dynamic = "force-dynamic";

/*
 * Server Actions run inside this page's function, so the page's segment
 * configuration is what governs them. Every /api route that performs a sync
 * already declares 300 seconds; pages declared nothing and inherited the
 * platform default, which is shorter than a real sync takes — historical runs
 * are 7 to 25 seconds and the roster will only grow.
 *
 * The consequence was not a visible error. The function was killed mid-flight,
 * so the action never returned, the button span forever, and the sync run it
 * had already opened stayed `processing` with no completion time — an
 * abandoned run that also holds the single-sweep lock.
 *
 * A literal, because Next reads segment configuration by static analysis and
 * rejects an imported binding.
 */
export const maxDuration = 300;

function formatWhen(value: Date | null): string {
  if (!value) return "Never";
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(value);
}

export default async function StreamerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();

  const { id } = await params;
  const parsed = streamerIdSchema.safeParse(id);
  if (!parsed.success) notFound();

  const streamer = await getStreamerById(parsed.data);
  if (!streamer) notFound();

  const [syncRuns, postCount, videoCount, removal, gameOptions, streamerGames] = await Promise.all([
    listSyncRunsForStreamer(streamer.id, 5),
    countPostsForStreamer(streamer.id),
    countVideosForStreamer(streamer.id),
    getStreamerRemovalView(streamer.id),
    listGameOptions(),
    listStreamerGames(streamer.id),
  ]);
  const grantedScopes = new Set(streamer.tokenScopes);

  return (
    <>
      <PageHeader
        title={streamer.streamerName}
        description={`${streamer.streamerCode} · ${streamer.pageName} (${streamer.pageId})`}
        primaryAction={
          <Button asChild variant="outline" size="sm">
            <Link href="/admin/streamers">
              <ArrowLeft className="size-4" aria-hidden />
              Back
            </Link>
          </Button>
        }
      />

      {streamer.deletedAt ? (
        <Card className="border-destructive/50">
          <CardHeader>
            <CardTitle className="text-base">This streamer is deleted</CardTitle>
            <CardDescription>
              Deleted {formatWhen(streamer.deletedAt)}. The record is retained for sync history and
              is read-only.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      {/* ---------------------------------------------------------------- */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="text-base">Page token</CardTitle>
              <CardDescription>
                Stored as AES-256-GCM ciphertext. Only the last four characters are ever shown.
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <TokenStatusBadge status={streamer.tokenStatus} />
              <Badge variant={streamer.active ? "secondary" : "outline"}>
                {streamer.active ? "Active" : "Disabled"}
              </Badge>
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-6">
          <dl className="grid gap-4 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs text-muted-foreground">Stored token</dt>
              <dd className="font-mono">{streamer.hasToken ? streamer.maskedToken : "None"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Last validated</dt>
              <dd>{formatWhen(streamer.tokenLastValidatedAt)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Expires</dt>
              <dd>
                {streamer.tokenExpiresAt ? formatWhen(streamer.tokenExpiresAt) : "Does not expire"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Last successful sync</dt>
              <dd>{formatWhen(streamer.lastSuccessfulSyncAt)}</dd>
            </div>
          </dl>

          {streamer.tokenValidationError ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3">
              <p className="text-xs font-medium">Last validation result</p>
              <p className="mt-1 text-xs text-muted-foreground">{streamer.tokenValidationError}</p>
            </div>
          ) : null}

          {streamer.lastSyncError ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3">
              <p className="text-xs font-medium">Last sync error</p>
              <p className="mt-1 font-mono text-xs text-muted-foreground">
                {streamer.lastSyncError}
              </p>
            </div>
          ) : null}

          <div>
            <p className="mb-2 text-xs text-muted-foreground">Permissions</p>
            <div className="flex flex-wrap gap-2">
              {EXPECTED_SCOPES.map((scope) => (
                <Badge
                  key={scope}
                  variant={grantedScopes.has(scope) ? "secondary" : "outline"}
                  className="font-mono text-xs"
                >
                  {grantedScopes.has(scope) ? "✓" : "○"} {scope}
                </Badge>
              ))}
            </div>
          </div>

          {!streamer.deletedAt ? (
            <>
              <Separator />
              <TokenPanel streamerId={streamer.id} hasToken={streamer.hasToken} />
            </>
          ) : null}
        </CardContent>
      </Card>

      {/* ---------------------------------------------------------------- */}
      {!streamer.deletedAt ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Details</CardTitle>
            <CardDescription>
              Editing these does not touch the stored token. Replacing a token is a separate,
              separately audited action.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <EditStreamerPanel streamer={streamer} />
          </CardContent>
        </Card>
      ) : null}

      {/* ---------------------------------------------------------------- */}
      {!streamer.deletedAt ? (
        <StreamerGamesCard
          streamerId={streamer.id}
          options={gameOptions}
          assignments={streamerGames}
        />
      ) : null}

      {/* ---------------------------------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Synchronisation</CardTitle>
          <CardDescription>
            Syncing fetches from Meta directly and can take up to half a minute. Queue a manual run
            instead to hand it to the next automation sweep.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!streamer.deletedAt ? (
            <div className="flex flex-wrap items-start gap-6">
              <SyncPostsPanel
                streamerId={streamer.id}
                disabled={!streamer.hasToken}
                disabledReason={streamer.hasToken ? null : "Add a Page token before synchronising."}
              />
              <SyncVideosPanel
                streamerId={streamer.id}
                disabled={!streamer.hasToken}
                disabledReason={streamer.hasToken ? null : "Add a Page token before synchronising."}
              />
              <SyncPanel streamerId={streamer.id} disabled={!streamer.hasToken} />
            </div>
          ) : null}

          <p className="text-xs text-muted-foreground">
            {postCount} post{postCount === 1 ? "" : "s"} and {videoCount} video
            {videoCount === 1 ? "" : "s"} stored for this streamer.{" "}
            {videoCount > 0 ? (
              <>
                <Link
                  href={`/videos?streamerId=${streamer.id}`}
                  className="underline underline-offset-4"
                >
                  View videos
                </Link>
                {postCount > 0 ? " · " : null}
              </>
            ) : null}
            {postCount > 0 ? (
              <Link
                href={`/posts?streamerId=${streamer.id}`}
                className="underline underline-offset-4"
              >
                View posts
              </Link>
            ) : null}
          </p>

          {syncRuns.length > 0 ? (
            <ul className="divide-y text-sm">
              {syncRuns.map((run) => (
                <li key={run.id} className="flex items-center justify-between gap-3 py-2">
                  <span className="text-xs text-muted-foreground">{formatWhen(run.startedAt)}</span>
                  <span className="text-xs">{run.syncType}</span>
                  <StatusBadge domain="sync" status={run.status} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No sync runs recorded yet.</p>
          )}
        </CardContent>
      </Card>

      {removal ? <StreamerRemovalCard streamer={removal} /> : null}
    </>
  );
}
