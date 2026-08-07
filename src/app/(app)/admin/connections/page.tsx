import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Users } from "lucide-react";

import { InviteForm, RevokeButton } from "@/app/(app)/admin/connections/invite-forms";
import { PageHeader } from "@/components/layout/page-header";
import { CardSkeleton, EmptyState } from "@/components/layout/states";
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
import {
  INVITATION_STATUS_LABELS,
  INVITATION_TTL_DAYS,
  effectiveStatus,
  type EffectiveStatus,
} from "@/lib/connect/invitations";
import { listInvitations } from "@/lib/repositories/page-connections";
import { listStreamerOptions } from "@/lib/repositories/streamers";
import { formatDateTime } from "@/lib/time/zone";

export const metadata: Metadata = { title: "Page connections" };
export const dynamic = "force-dynamic";

/**
 * Inviting streamers to connect their own Page, and watching who has.
 *
 * ## Why this exists
 *
 * The alternative is walking each streamer through Graph API Explorer and
 * asking them to paste a live credential into a chat message. Every step is a
 * place to go wrong, and the last one leaves a working credential in somebody's
 * message history. At thirty streamers that is thirty chances to send the wrong
 * token, or the right one to the wrong place.
 *
 * ## What the table is for
 *
 * "Who have I invited and who has actually done it" is the question that makes
 * a chase possible. Without it an admin reconstructs the answer from their own
 * sent messages, which is how three streamers stay unconnected for a month
 * because nobody remembered they were asked.
 */

function formatWhen(value: Date | null): string {
  if (!value) return "—";
  return formatDateTime(value);
}

function StatusBadge({ state }: { state: EffectiveStatus }) {
  const variant =
    state === "connected"
      ? "secondary"
      : state === "pending" || state === "opened"
        ? "default"
        : "outline";

  return <Badge variant={variant}>{INVITATION_STATUS_LABELS[state]}</Badge>;
}

async function Invitations() {
  const [invitations, streamers] = await Promise.all([listInvitations(), listStreamerOptions()]);

  const live = invitations.filter((row) => {
    const state = effectiveStatus(row);
    return state === "pending" || state === "opened";
  });
  const connected = invitations.filter((row) => effectiveStatus(row) === "connected");

  return (
    <>
      <InviteForm streamers={streamers} />

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="text-base">Invitations</CardTitle>
              <CardDescription>
                {invitations.length === 0
                  ? "None yet."
                  : `${connected.length} connected, ${live.length} still waiting. Links last ${INVITATION_TTL_DAYS} days.`}
              </CardDescription>
            </div>
            <Button asChild variant="outline" size="sm">
              <Link href="/admin/streamers">
                <Users className="size-4" aria-hidden />
                Streamers
              </Link>
            </Button>
          </div>
        </CardHeader>

        <CardContent className="px-0">
          {invitations.length === 0 ? (
            <EmptyState
              title="No invitations yet"
              description="Create one above, then send the link to the streamer."
            />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">Streamer</TableHead>
                    <TableHead scope="col">Status</TableHead>
                    <TableHead scope="col">Connected Page</TableHead>
                    <TableHead scope="col">Created</TableHead>
                    <TableHead scope="col" className="text-right">
                      Actions
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {invitations.map((row) => {
                    const state = effectiveStatus(row);

                    return (
                      <TableRow key={row.id}>
                        <TableCell>
                          <span className="block text-sm font-medium">{row.inviteeLabel}</span>
                          {row.inviteeEmail ? (
                            <span className="block text-xs text-muted-foreground">
                              {row.inviteeEmail}
                            </span>
                          ) : null}
                        </TableCell>

                        <TableCell>
                          <StatusBadge state={state} />
                          {/*
                           * The last failure, beside the status rather than
                           * hidden behind a detail view. A streamer who got
                           * halfway and hit a Meta error will not report it —
                           * they will simply stop, and this is the only place
                           * anyone would find out.
                           */}
                          {row.lastError ? (
                            <span className="mt-1 block max-w-xs text-xs text-muted-foreground">
                              {row.lastError}
                            </span>
                          ) : null}
                        </TableCell>

                        <TableCell className="text-sm">
                          {row.connectedPageName ? (
                            row.streamerId ? (
                              <Link
                                href={`/admin/streamers/${row.streamerId}`}
                                className="underline underline-offset-4"
                              >
                                {row.connectedPageName}
                              </Link>
                            ) : (
                              row.connectedPageName
                            )
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>

                        <TableCell className="text-xs whitespace-nowrap text-muted-foreground">
                          {formatWhen(row.createdAt)}
                        </TableCell>

                        <TableCell className="text-right">
                          {state === "pending" || state === "opened" ? (
                            <RevokeButton id={row.id} label={row.inviteeLabel} />
                          ) : null}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}

export default async function ConnectionsPage() {
  await requireAdmin();

  return (
    <>
      <PageHeader
        title="Page connections"
        description="Invite a streamer to connect their own Facebook Page. They approve a permission screen; nothing is copied or pasted, and no token is ever shown to anyone."
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">What the streamer sees</CardTitle>
          <CardDescription>
            A short page with your name on it, a plain-English list of what will be read, and one
            button. Facebook asks them to approve, they pick their Page from a list, and that is the
            end of it. The Page token is fetched server-side and stored encrypted — it never appears
            in a browser, a message, or a spreadsheet.
          </CardDescription>
        </CardHeader>
      </Card>

      <Suspense fallback={<CardSkeleton count={2} />}>
        <Invitations />
      </Suspense>
    </>
  );
}
