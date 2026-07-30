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
  searchParams: Promise<{ search?: string }>;
}) {
  await requireAdmin();

  const params = await searchParams;
  const search = params.search?.trim();

  const streamers = await listStreamers({
    includeDeleted: false,
    activeOnly: false,
    ...(search ? { search } : {}),
  });

  const needingAttention = streamers.filter((s) => tokenNeedsAttention(s.tokenStatus));

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

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Roster</CardTitle>
          <CardDescription>
            {streamers.length} streamer{streamers.length === 1 ? "" : "s"}. Tokens are stored
            encrypted and shown only as their last four characters.
          </CardDescription>
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
                      <Badge variant={streamer.active ? "secondary" : "outline"}>
                        {streamer.active ? "Active" : "Disabled"}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}

                {streamers.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                      {search
                        ? `No streamers match “${search}”.`
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
