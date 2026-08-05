import type { Metadata } from "next";
import Link from "next/link";
import { Plus, TriangleAlert } from "lucide-react";

import { PageHeader } from "@/components/layout/page-header";
import { TokenStatusBadge } from "@/components/admin/token-status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { requireAdmin } from "@/lib/auth/guards";
import { tokenNeedsAttention } from "@/lib/meta/token-status";
import { listStreamers } from "@/lib/repositories/streamers";

export const metadata: Metadata = { title: "Streamers" };
export const dynamic = "force-dynamic";

/*
 * This page hosts the create, validate and replace-token actions, each of
 * which calls Meta. Server Actions run in the invoking page's function, so the
 * limit has to be declared here rather than inherited from the /api route that
 * does the same work. A literal, because Next resolves segment configuration
 * by static analysis.
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

export default async function AdminStreamersPage({
  searchParams,
}: {
  searchParams: Promise<{ search?: string; removed?: string; purged?: string }>;
}) {
  await requireAdmin();

  const params = await searchParams;
  const search = params.search?.trim();
  /*
   * Removed streamers are hidden by default and reachable on request.
   *
   * Not merely a convenience: removal is reversible in the sense that the data
   * survives, but the row it lives on is invisible — so without this, deciding
   * later to delete one permanently, or checking what a departed streamer still
   * holds, would need database access.
   */
  const includeRemoved = params.removed === "1";

  const streamers = await listStreamers({
    includeDeleted: includeRemoved,
    activeOnly: false,
    ...(search ? { search } : {}),
  });

  const needingAttention = streamers.filter(
    (s) => s.deletedAt === null && tokenNeedsAttention(s.tokenStatus),
  );

  return (
    <>
      <PageHeader
        title="Streamers"
        description="Manage the roster, Facebook Page connections and Page token health."
        primaryAction={
          <Button asChild size="sm">
            <Link href="/admin/streamers/new">
              <Plus className="size-4" aria-hidden />
              Add streamer
            </Link>
          </Button>
        }
      />

      {needingAttention.length > 0 ? (
        <Card className="border-destructive/50">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <TriangleAlert className="size-4 text-destructive" aria-hidden />
              {needingAttention.length} Page token
              {needingAttention.length === 1 ? "" : "s"} need attention
            </CardTitle>
            <CardDescription>
              {needingAttention.map((s) => s.streamerCode).join(", ")} — synchronisation will fail
              for these until the token is replaced.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      {params.purged ? (
        <Card className="border-emerald-500/40">
          <CardHeader>
            <CardTitle className="text-base">{params.purged} was permanently deleted</CardTitle>
            <CardDescription>
              The streamer and all of its content are gone. The audit trail retains who did it, when
              and how much was destroyed — that entry is all that remains.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="text-base">Roster</CardTitle>
              <CardDescription>
                {streamers.length} streamer{streamers.length === 1 ? "" : "s"}. Tokens are stored
                encrypted and shown only as their last four characters.
              </CardDescription>
            </div>
            <Button asChild variant="outline" size="sm">
              <Link
                href={
                  includeRemoved
                    ? `/admin/streamers${search ? `?search=${encodeURIComponent(search)}` : ""}`
                    : `/admin/streamers?removed=1${search ? `&search=${encodeURIComponent(search)}` : ""}`
                }
              >
                {includeRemoved ? "Hide removed" : "Show removed"}
              </Link>
            </Button>
          </div>
        </CardHeader>
        <CardContent className="px-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Code</TableHead>
                  <TableHead>Streamer</TableHead>
                  <TableHead>Facebook Page</TableHead>
                  <TableHead>Token</TableHead>
                  <TableHead>Health</TableHead>
                  <TableHead>Last sync</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {streamers.map((streamer) => (
                  <TableRow key={streamer.id}>
                    <TableCell className="font-mono text-xs">
                      <Link
                        href={`/admin/streamers/${streamer.id}`}
                        className="font-medium underline-offset-4 hover:underline"
                      >
                        {streamer.streamerCode}
                      </Link>
                    </TableCell>
                    <TableCell>{streamer.streamerName}</TableCell>
                    <TableCell>
                      <div>{streamer.pageName}</div>
                      <div className="font-mono text-xs text-muted-foreground">
                        {streamer.pageId}
                      </div>
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {streamer.hasToken ? streamer.maskedToken : "—"}
                    </TableCell>
                    <TableCell>
                      <TokenStatusBadge status={streamer.tokenStatus} />
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatWhen(streamer.lastSuccessfulSyncAt)}
                      {streamer.lastSyncError ? (
                        <div className="text-destructive">Last run failed</div>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      {/* Removed outranks disabled: a removed streamer is
                          always inactive, so showing "Disabled" here would be
                          true and useless. */}
                      {streamer.deletedAt ? (
                        <Badge variant="outline" className="text-destructive">
                          Removed
                        </Badge>
                      ) : (
                        <Badge variant={streamer.active ? "secondary" : "outline"}>
                          {streamer.active ? "Active" : "Disabled"}
                        </Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))}

                {streamers.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                      {search
                        ? `No streamers match “${search}”.`
                        : includeRemoved
                          ? "No streamers, removed or otherwise."
                          : "No streamers yet. Add the first one to get started."}
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </>
  );
}
