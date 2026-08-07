import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Info } from "lucide-react";

import { ConfigurationBroken, SettingsCard } from "@/components/admin/settings-table";
import { MetricCard, MetricGrid } from "@/components/data/metric-card";
import { MetricCardSkeleton } from "@/components/data/states";
import { PageHeader, SectionHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireAdmin } from "@/lib/auth/guards";
import { describeConfiguration } from "@/lib/config/settings-view";
import { getAutomationHealth, getExportVolumes } from "@/lib/repositories/admin-health";
import { formatDateTime } from "@/lib/time/zone";

export const metadata: Metadata = { title: "General settings" };
export const dynamic = "force-dynamic";

/**
 * The ceilings a sweep runs to, and the volume they have produced.
 *
 * Every value is read-only here and says which environment variable it comes
 * from. That is a deliberate design choice rather than an unfinished feature:
 * configuration lives in the environment so that a deployment is reproducible
 * from its variables alone. An editable copy in the database would create a
 * second source of truth, and the interesting failure is not "which one wins"
 * but "which one was in effect three weeks ago when the numbers looked wrong".
 */

const numberFormat = new Intl.NumberFormat("en-GB");

function formatWhen(value: Date | null): string {
  if (!value) return "Never";
  return formatDateTime(value);
}

async function Volume() {
  const [volumes, automation] = await Promise.all([getExportVolumes(), getAutomationHealth()]);

  return (
    <div className="space-y-4">
      <MetricGrid>
        <MetricCard label="Streamers" value={numberFormat.format(volumes["streamers"] ?? 0)} />
        <MetricCard label="Posts" value={numberFormat.format(volumes["posts"] ?? 0)} />
        <MetricCard label="Videos" value={numberFormat.format(volumes["videos"] ?? 0)} />
        <MetricCard
          label="Insights stored"
          value={numberFormat.format(
            (volumes["post_insights"] ?? 0) + (volumes["video_insights"] ?? 0),
          )}
        />
      </MetricGrid>

      <p className="text-xs text-muted-foreground">
        Last automated run {formatWhen(automation.lastContactAt)} — {automation.runsLast7Days} in
        the past seven days.
      </p>
    </div>
  );
}

export default async function GeneralSettingsPage() {
  await requireAdmin();

  const config = describeConfiguration();

  return (
    <>
      <PageHeader
        title="General settings"
        description="Sync frequency, batch sizes and workspace defaults."
        primaryAction={
          <Button asChild variant="outline" size="sm">
            <Link href="/admin/sync-logs">Sync history</Link>
          </Button>
        }
      />

      {config.ok && config.general ? (
        <SettingsCard section={config.general} />
      ) : (
        <ConfigurationBroken missingKeys={config.missingKeys} />
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Info className="size-4" aria-hidden />
            Why these are read-only
          </CardTitle>
          <CardDescription>
            Configuration lives in the environment so a deployment is reproducible from its
            variables alone, and so a value cannot be changed without leaving a trace in Vercel. To
            change one: Vercel → Settings → Environment Variables, then redeploy. Each row above
            names the exact variable.
          </CardDescription>
        </CardHeader>
      </Card>

      <section className="space-y-3">
        <SectionHeader
          title="What has been collected"
          description="The volume those ceilings have produced so far."
        />
        <Suspense fallback={<MetricCardSkeleton />}>
          <Volume />
        </Suspense>
      </section>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">How the ceilings interact</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            A sweep is incremental. It asks Meta only for content published since the lookback
            window, because last night&apos;s run already has everything older — which is also what
            lets a run that has been failing for a few days catch up when it recovers.
          </p>
          <p>
            The per-streamer caps are safety valves rather than targets. They exist so one run
            cannot walk a Page&apos;s entire history and exhaust the function&apos;s time budget; an
            unbounded manual sync once walked seven years and 1,624 posts.
          </p>
          <p>
            Comment collection is capped far lower than content collection on purpose. Collecting a
            post is one row from a list; collecting its comments is a paginated walk of its own, and
            a changed comment set costs an AI call. Engagement on a Facebook post is heavily
            front-loaded, so refreshing comments for a hundred old posts a night spends both budgets
            on content nobody is still reading.
          </p>
        </CardContent>
      </Card>
    </>
  );
}
