import { Activity, CircleAlert, CircleCheck, CircleDashed, TriangleAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { MetricCard, MetricGrid } from "@/components/data/metric-card";
import { EmptyTableRow } from "@/components/data/states";
import { PageHeader } from "@/components/layout/page-header";
import { StatusBadge } from "@/components/ui/status-badge";
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
import { getSyncLogTotals, listSyncLogs, type SyncLogRow } from "@/lib/repositories/sync-logs";

export const metadata: Metadata = { title: "Sync logs" };
export const dynamic = "force-dynamic";

function formatDateTime(value: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(value);
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

const SYNC_TYPE_LABELS: Record<string, string> = {
  automation: "Automation",
  manual: "Manual",
  scheduled: "Scheduled",
};

/**
 * The run a person asks about after a quiet morning.
 *
 * Lists top-level runs only — a roster sweep's per-streamer children live on
 * each streamer's page, and mixing them in here would bury the parent that
 * actually answers "did last night work?".
 */
export default async function AdminSyncLogsPage() {
  // Re-checked despite the admin layout: this reads run history including error
  // text, so it proves its own authority rather than inheriting it.
  await requireAdmin();

  const [runs, totals] = await Promise.all([listSyncLogs(50), getSyncLogTotals()]);

  return (
    <>
      <PageHeader
        title="Sync logs"
        description="Every synchronisation run, newest first. A run that reports partial finished with some streamers succeeding and others not — open the streamer to see which."
      />

      <MetricGrid>
        <MetricCard label="Total runs" value={String(totals.total)} icon={Activity} />
        <MetricCard
          label="Succeeded"
          value={String(totals.succeeded)}
          icon={CircleCheck}
          hint="Every streamer in the run completed."
        />
        <MetricCard
          label="Partial"
          value={String(totals.partial)}
          icon={TriangleAlert}
          tone={totals.partial > 0 ? "warning" : "muted"}
          hint="Some streamers succeeded, some did not."
        />
        <MetricCard
          label="Failed"
          value={String(totals.failed)}
          icon={CircleAlert}
          tone={totals.failed > 0 ? "danger" : "muted"}
          hint="No streamer in the run produced data."
        />
        <MetricCard
          label="Running"
          value={String(totals.running)}
          icon={CircleDashed}
          tone={totals.running > 0 ? "warning" : "muted"}
          hint="Still in progress, or advanced across invocations."
        />
      </MetricGrid>

      <Card>
        <CardHeader>
          <CardTitle>Recent runs</CardTitle>
          <CardDescription>
            The 50 most recent top-level runs. Counters are cumulative for the run, including any
            slice that resumed it.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Started (UTC)</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Scope</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Duration</TableHead>
                  <TableHead className="text-right">Posts</TableHead>
                  <TableHead className="text-right">Videos</TableHead>
                  <TableHead className="text-right">Comments</TableHead>
                  <TableHead className="text-right">Summaries</TableHead>
                  <TableHead>Message</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.length === 0 ? (
                  <EmptyTableRow
                    colSpan={10}
                    title="No synchronisation has run yet"
                    description="A run appears here once the schedule fires, n8n triggers a sweep, or an admin syncs a streamer by hand."
                  />
                ) : (
                  runs.map((run) => <SyncLogTableRow key={run.id} run={run} />)
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </>
  );
}

function SyncLogTableRow({ run }: { run: SyncLogRow }) {
  return (
    <TableRow>
      <TableCell className="font-mono text-xs whitespace-nowrap">
        {formatDateTime(run.startedAt)}
      </TableCell>
      <TableCell className="text-sm whitespace-nowrap">
        {SYNC_TYPE_LABELS[run.syncType] ?? run.syncType}
      </TableCell>
      <TableCell className="text-sm whitespace-nowrap">
        {run.streamerCode ? (
          <Link className="underline underline-offset-4" href={`/streamers/${run.streamerId}`}>
            {run.streamerCode}
          </Link>
        ) : (
          <span className="text-muted-foreground">
            Whole roster
            {run.childCount > 0
              ? ` · ${run.childCount} streamer${run.childCount === 1 ? "" : "s"}`
              : ""}
          </span>
        )}
      </TableCell>
      <TableCell>
        <StatusBadge domain="sync" status={run.status} />
      </TableCell>
      <TableCell className="text-right font-mono text-xs">
        {formatDuration(run.durationSeconds)}
      </TableCell>
      <TableCell className="text-right font-mono text-xs">{run.postsProcessed}</TableCell>
      <TableCell className="text-right font-mono text-xs">{run.videosProcessed}</TableCell>
      <TableCell className="text-right font-mono text-xs">{run.commentsProcessed}</TableCell>
      <TableCell className="text-right font-mono text-xs">{run.summariesGenerated}</TableCell>
      <TableCell className="max-w-md text-xs text-muted-foreground">
        {/*
         * Rendered as text by React, never as HTML. `error_message` is already
         * scrubbed and length-capped by `sanitiseMessage` before it is stored,
         * so a Meta payload cannot reach this cell with a token in it.
         */}
        {run.errorMessage ?? "—"}
      </TableCell>
    </TableRow>
  );
}
