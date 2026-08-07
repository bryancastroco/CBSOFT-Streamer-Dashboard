import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { CircleAlert, ShieldCheck } from "lucide-react";

import { ConfigurationBroken, SettingsCard } from "@/components/admin/settings-table";
import { MetricCard, MetricGrid } from "@/components/data/metric-card";
import { MetricCardSkeleton } from "@/components/data/states";
import { PageHeader, SectionHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { requireAdmin } from "@/lib/auth/guards";
import { resolveAppOrigin } from "@/lib/config/app-origin";
import { describeConfiguration } from "@/lib/config/settings-view";
import { getAutomationHealth } from "@/lib/repositories/admin-health";
import { formatDateTime } from "@/lib/time/zone";

export const metadata: Metadata = { title: "n8n integration" };
export const dynamic = "force-dynamic";

/**
 * The automation surface, and evidence of whether anything is using it.
 *
 * A workflow that has silently stopped calling looks identical to one that was
 * never configured — every setting reads correctly and no error is raised
 * anywhere, because nothing ran to raise one. "Last contact" is the figure that
 * distinguishes them, so it leads.
 */

const numberFormat = new Intl.NumberFormat("en-GB");

function formatWhen(value: Date | null): string {
  if (!value) return "Never";
  return formatDateTime(value);
}

function relative(value: Date | null): string {
  if (!value) return "no contact recorded";
  const seconds = Math.round((Date.now() - value.getTime()) / 1000);

  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86_400)} d ago`;
}

/**
 * The endpoints n8n is expected to call.
 *
 * Written out rather than derived from the filesystem: the route files are the
 * implementation, and this is the contract. A route that exists but is not
 * listed here is not part of what the workflow was built against.
 */
const ENDPOINTS: readonly {
  method: string;
  path: string;
  purpose: string;
  kind: "write" | "read";
}[] = [
  {
    method: "POST",
    path: "/api/automation/sync-all",
    purpose: "Start a sweep of every active streamer. Returns a run id immediately.",
    kind: "write",
  },
  {
    method: "GET",
    path: "/api/automation/sync-runs/{id}",
    purpose: "Poll a run until finished is true.",
    kind: "read",
  },
  {
    method: "POST",
    path: "/api/automation/sync-streamer/{id}",
    purpose: "Sync one streamer, for a targeted re-run.",
    kind: "write",
  },
  {
    method: "POST",
    path: "/api/automation/metrics/rollup",
    purpose: "Resolve stored insights into canonical metrics. Spends no Meta quota.",
    kind: "write",
  },
  {
    method: "POST",
    path: "/api/automation/comments/backfill",
    purpose:
      "Advance content towards a stored comment analysis. Repeat until finished is true. " +
      "Runs nightly on its own schedule; this is for driving it faster.",
    kind: "write",
  },
  {
    method: "GET",
    path: "/api/automation/exports/streamers",
    purpose: "Roster rows for the Streamers tab.",
    kind: "read",
  },
  {
    method: "GET",
    path: "/api/automation/exports/posts",
    purpose: "Post rows for the Posts tab.",
    kind: "read",
  },
  {
    method: "GET",
    path: "/api/automation/exports/post-insights",
    purpose: "Insight rows for the Post Insights tab.",
    kind: "read",
  },
  {
    method: "GET",
    path: "/api/automation/exports/videos",
    purpose: "Video rows for the Videos tab.",
    kind: "read",
  },
  {
    method: "GET",
    path: "/api/automation/exports/video-insights",
    purpose: "Insight rows for the Video Insights tab.",
    kind: "read",
  },
  {
    method: "GET",
    path: "/api/automation/exports/comment-summaries",
    purpose: "Analysis rows for the Comment Summaries tab.",
    kind: "read",
  },
  {
    method: "GET",
    path: "/api/automation/exports/sync-logs",
    purpose: "Run history for the Sync Logs tab.",
    kind: "read",
  },
  {
    method: "GET",
    path: "/api/automation/google-sheets/schema",
    purpose: "Every tab, column and match column, as JSON.",
    kind: "read",
  },
];

async function AutomationHealth() {
  const health = await getAutomationHealth();

  const quiet = health.runsLast7Days === 0;

  return (
    <div className="space-y-4">
      <MetricGrid>
        <MetricCard
          label="Last contact"
          value={relative(health.lastContactAt)}
          hint={formatWhen(health.lastContactAt)}
          {...(quiet ? { tone: "warning" as const } : {})}
        />
        <MetricCard label="Runs (7 days)" value={numberFormat.format(health.runsLast7Days)} />
        <MetricCard label="Runs (all time)" value={numberFormat.format(health.totalRuns)} />
        <MetricCard label="Last trigger" value={health.lastTriggerSource ?? "—"} />
      </MetricGrid>

      {quiet ? (
        <Card className="border-amber-500/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <CircleAlert className="size-4 text-amber-600 dark:text-amber-500" aria-hidden />
              Nothing has called the automation surface in seven days
            </CardTitle>
            <CardDescription>
              That is either a workflow that was never switched on, or one that has stopped. Both
              look the same from here — no error is raised, because nothing ran to raise one.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      {health.recent.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent automation runs</CardTitle>
            <CardDescription>
              Runs triggered by a machine rather than by a person in this interface.
            </CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">Started</TableHead>
                    <TableHead scope="col">Status</TableHead>
                    <TableHead scope="col">Trigger</TableHead>
                    <TableHead scope="col" className="text-right">
                      Posts
                    </TableHead>
                    <TableHead scope="col" className="text-right">
                      Videos
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {health.recent.map((run) => (
                    <TableRow key={run.id}>
                      <TableCell className="text-xs whitespace-nowrap">
                        {formatWhen(run.startedAt)}
                      </TableCell>
                      <TableCell>
                        <StatusBadge domain="sync" status={run.status} />
                      </TableCell>
                      <TableCell className="text-xs">{run.triggerSource ?? "—"}</TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {run.postsProcessed ?? 0}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {run.videosProcessed ?? 0}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

export default async function N8nPage() {
  await requireAdmin();

  const config = describeConfiguration();
  const origin = resolveAppOrigin();

  return (
    <>
      <PageHeader
        title="n8n integration"
        description="Automation endpoints, the bearer secret's health, and recent workflow calls."
        primaryAction={
          <Button asChild variant="outline" size="sm">
            <Link href="/admin/sync-logs">Sync history</Link>
          </Button>
        }
      />

      {config.ok && config.automation ? (
        <SettingsCard section={config.automation} />
      ) : (
        <ConfigurationBroken missingKeys={config.missingKeys} />
      )}

      <section className="space-y-3">
        <SectionHeader title="Activity" description="Whether the workflow is actually running." />
        <Suspense fallback={<MetricCardSkeleton />}>
          <AutomationHealth />
        </Suspense>
      </section>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="size-4" aria-hidden />
            What n8n is and is not given
          </CardTitle>
          <CardDescription>
            Every request carries <code className="font-mono text-xs">Authorization: Bearer</code>{" "}
            with the n8n secret, compared in constant time. n8n receives no database credential, no
            Supabase key and no Meta token — every Graph call happens on this server. A request that
            arrives carrying token material is refused outright with{" "}
            <code className="font-mono text-xs">400 token_material_refused</code>, because a
            workflow holding a Page token is a misconfiguration worth failing loudly.
          </CardDescription>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Endpoints</CardTitle>
          <CardDescription>
            Base URL <code className="font-mono text-xs">{origin}</code>. Writes are limited to 10
            requests a minute and reads to 120, keyed per endpoint class.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <div className="overflow-x-auto">
            <Table>
              <caption className="sr-only">
                The automation endpoints the documented workflow calls.
              </caption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Endpoint</TableHead>
                  <TableHead scope="col" className="hidden md:table-cell">
                    Purpose
                  </TableHead>
                  <TableHead scope="col" className="text-right">
                    Budget
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ENDPOINTS.map((endpoint) => (
                  <TableRow key={`${endpoint.method} ${endpoint.path}`}>
                    <TableCell className="align-top">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="font-mono text-[10px]">
                          {endpoint.method}
                        </Badge>
                        <code className="font-mono text-xs break-all">{endpoint.path}</code>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground md:hidden">
                        {endpoint.purpose}
                      </p>
                    </TableCell>
                    <TableCell className="hidden text-sm md:table-cell">
                      {endpoint.purpose}
                    </TableCell>
                    <TableCell className="text-right text-xs whitespace-nowrap text-muted-foreground">
                      {endpoint.kind === "write" ? "10 / min" : "120 / min"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </>
  );
}
