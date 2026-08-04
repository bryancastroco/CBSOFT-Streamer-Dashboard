import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { CircleAlert } from "lucide-react";

import { GeminiModelList } from "@/app/(app)/admin/ai/model-list";
import { AiTestButton } from "@/app/(app)/admin/ai/test-button";
import { ConfigurationBroken, SettingsCard } from "@/components/admin/settings-table";
import { MetricCard, MetricGrid } from "@/components/data/metric-card";
import { MetricCardSkeleton } from "@/components/data/states";
import { PageHeader, SectionHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireAdmin } from "@/lib/auth/guards";
import { describeConfiguration } from "@/lib/config/settings-view";
import { getAiHealth } from "@/lib/repositories/admin-health";

export const metadata: Metadata = { title: "AI settings" };
export const dynamic = "force-dynamic";

/**
 * Summarisation configuration, and what it has actually produced.
 *
 * The failure list is the part that earns the screen. A summary that fails is
 * deliberately non-fatal — a broken analysis must never take down the page
 * showing the post — which means a missing API key produces no visible symptom
 * anywhere except a quiet `failed` status on each attempt. This is where that
 * becomes obvious.
 */

const numberFormat = new Intl.NumberFormat("en-GB");

function formatWhen(value: Date | null): string {
  if (!value) return "Never";
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(value);
}

async function AiHealth({
  keyConfigured,
  enabled,
}: {
  keyConfigured: boolean;
  enabled: boolean;
}) {
  const health = await getAiHealth();

  const failing = health.failed > 0;

  return (
    <div className="space-y-4">
      {/*
       * The kill switch produces silence, not errors: the sweep collects
       * comments, writes nothing, and reports no failure. So "0 generated" is
       * indistinguishable from "nothing needed doing" unless this says
       * otherwise — which is exactly how a switched-off flag went unnoticed
       * while a rejected API key took the blame.
       */}
      {!enabled && health.awaitingAnalysis > 0 ? (
        <Card className="border-amber-500/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <CircleAlert className="size-4 text-amber-600 dark:text-amber-500" aria-hidden />
              Summarisation is switched off
            </CardTitle>
            <CardDescription>
              {numberFormat.format(health.awaitingAnalysis)} content item
              {health.awaitingAnalysis === 1 ? " has" : "s have"} comments waiting to be analysed.
              Nothing is being attempted and no error is raised, because the model is never called.
              Set <code>AI_SUMMARIZATION_ENABLED</code> to <code>true</code> in Vercel and redeploy
              — comments are already collected, so they will be analysed on the next sweep.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      <MetricGrid>
        <MetricCard label="Analyses stored" value={numberFormat.format(health.total)} />
        <MetricCard label="Completed" value={numberFormat.format(health.completed)} />
        <MetricCard
          label="No comments"
          value={numberFormat.format(health.noComments)}
          hint="Analysed; the item had none to summarise."
        />
        <MetricCard
          label="Failed"
          value={numberFormat.format(health.failed)}
          {...(failing ? { tone: "danger" as const } : {})}
        />
        <MetricCard label="Flagged urgent" value={numberFormat.format(health.urgent)} />
        <MetricCard
          label="Awaiting analysis"
          value={numberFormat.format(health.awaitingAnalysis)}
          hint="Has comments, no usable summary."
          {...(health.awaitingAnalysis > 0 ? { tone: "warning" as const } : {})}
        />
      </MetricGrid>

      <p className="text-xs text-muted-foreground">
        Last analysis generated {formatWhen(health.lastGeneratedAt)}. A summary is only regenerated
        when the comment set behind it has actually changed, so an unchanged item costs nothing.
      </p>

      {failing && !keyConfigured ? (
        <Card className="border-destructive/50">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base text-destructive">
              <CircleAlert className="size-4" aria-hidden />
              No API key is configured
            </CardTitle>
            <CardDescription>
              Every summarisation attempt will fail until <code>ANTHROPIC_API_KEY</code> is set in
              Vercel → Settings → Environment Variables. Comments are still collected and stored in
              the meantime, so nothing is lost — they simply go unanalysed.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      {health.recentFailures.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent failures</CardTitle>
            <CardDescription>
              The reason recorded at the time. Messages are sanitised before they are stored — no
              key material reaches this table.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {health.recentFailures.map((failure) => (
              <div key={failure.id} className="rounded-md border p-3">
                <p className="text-sm">{failure.error ?? "No reason recorded."}</p>
                {/* Null for a failure: nothing was ever generated, so a
                    "Never" timestamp would be noise rather than information. */}
                {failure.at ? (
                  <p className="mt-1 text-xs text-muted-foreground">{formatWhen(failure.at)}</p>
                ) : null}
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

export default async function AiSettingsPage() {
  await requireAdmin();

  const config = describeConfiguration();
  const keyConfigured = config.ai?.rows.find((row) => row.label === "API key")?.present ?? false;
  const enabled = config.ai?.rows.find((row) => row.label === "Summarisation")?.present ?? false;
  const provider = config.ai?.rows.find((row) => row.label === "Provider")?.value ?? null;

  return (
    <>
      <PageHeader
        title="AI settings"
        description="Comment summarisation provider, model and per-item limits."
        primaryAction={
          <Button asChild variant="outline" size="sm">
            <Link href="/comment-analysis">Open comment analysis</Link>
          </Button>
        }
      />

      {config.ok && config.ai ? (
        <SettingsCard section={config.ai} />
      ) : (
        <ConfigurationBroken missingKeys={config.missingKeys} />
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Test the connection</CardTitle>
          <CardDescription>
            Sends one short request through the same path production uses, and reports exactly what
            came back. &ldquo;Set&rdquo; above means a key exists, not that Anthropic accepts it —
            this is the difference.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <AiTestButton />
        </CardContent>
      </Card>

      {provider === "gemini" ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Available Gemini models</CardTitle>
            <CardDescription>
              Google retires model ids and restricts others to existing accounts, so which name is
              valid is a property of your key rather than something a default can encode. This asks
              the key directly.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <GeminiModelList />
          </CardContent>
        </Card>
      ) : null}

      <section className="space-y-3">
        <SectionHeader
          title="Summarisation health"
          description="What the configuration above has actually produced."
        />
        <Suspense fallback={<MetricCardSkeleton />}>
          <AiHealth keyConfigured={keyConfigured} enabled={enabled} />
        </Suspense>
      </section>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">What the model is given</CardTitle>
          <CardDescription>
            Comment text and nothing else. No Page token, no database credential and no personal
            data beyond what the commenter wrote publicly. The summary, its sentiment and any
            flagged issues are stored against the content item; the prompt is not retained.
          </CardDescription>
        </CardHeader>
      </Card>
    </>
  );
}
