import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ExternalLink } from "lucide-react";

import { VideoCommentActions } from "@/app/(app)/videos/[id]/comment-actions";
import { CommentAnalysis } from "@/components/admin/comment-analysis";
import { ContentMetricGroups } from "@/components/metrics/metric-group";
import { PageHeader, SectionHeader } from "@/components/layout/page-header";
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
import { requireUser } from "@/lib/auth/guards";
import { METRIC_NOT_AVAILABLE, describeInsights } from "@/lib/meta/insight-display";
import { formatDuration } from "@/lib/meta/videos";
import { applicabilityOf, getVideoMetrics } from "@/lib/repositories/canonical-metrics";
import { countCommentsForContent, getSummaryForVideo } from "@/lib/repositories/comments";
import { getVideoById } from "@/lib/repositories/videos";
import { videoIdSchema } from "@/lib/validation/videos";

export const metadata: Metadata = { title: "Video" };
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
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(value);
}

export default async function VideoDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();

  const { id } = await params;
  const parsed = videoIdSchema.safeParse(id);
  if (!parsed.success) notFound();

  const video = await getVideoById(parsed.data);
  if (!video) notFound();

  const content = { type: "video" as const, id: video.id };

  const [summary, commentCount, metrics] = await Promise.all([
    getSummaryForVideo(video.id),
    countCommentsForContent(content),
    getVideoMetrics(video.id),
  ]);

  const isAdmin = user.role === "admin";
  const insights = describeInsights(video.insights);
  const unavailableCount = insights.filter((i) => i.availability === "not_available").length;
  const duration = formatDuration(video.lengthSeconds);

  return (
    <>
      <PageHeader
        title={video.title ?? "Untitled video"}
        description={`${formatWhen(video.createdTime)} · ${video.streamerName} (${video.streamerCode})`}
        primaryAction={
          <div className="flex gap-2">
            {video.permalinkUrl ? (
              <Button asChild variant="outline" size="sm">
                <a href={video.permalinkUrl} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="size-4" aria-hidden />
                  On Facebook
                </a>
              </Button>
            ) : null}
            <Button asChild variant="outline" size="sm">
              <Link href="/videos">
                <ArrowLeft className="size-4" aria-hidden />
                Back
              </Link>
            </Button>
          </div>
        }
      />

      {metrics ? (
        <section className="space-y-3">
          <SectionHeader
            title="Performance"
            description={`Canonical metrics, resolved from what Meta returned. Collected ${formatWhen(metrics.lastCollectedAt)} on Graph ${metrics.graphApiVersion}.`}
          />
          <ContentMetricGroups
            metrics={metrics}
            applicability={applicabilityOf(metrics, "video")}
            showSource={isAdmin}
          />
        </section>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Performance</CardTitle>
            <CardDescription>
              This video has not been processed into canonical metrics yet. Its raw insights are
              below, exactly as Meta returned them.
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Details</CardTitle>
          <CardDescription className="font-mono text-xs">{video.facebookVideoId}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <dl className="grid gap-4 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-xs text-muted-foreground">Duration</dt>
              <dd className="font-mono">
                {duration ?? <span className="text-xs italic">Not reported by Meta</span>}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Comments collected</dt>
              <dd className="font-mono">{commentCount}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Last synced</dt>
              <dd>{formatWhen(video.lastSyncedAt)}</dd>
            </div>
          </dl>

          {video.description ? (
            <div>
              <p className="mb-1 text-xs text-muted-foreground">Description</p>
              <p className="text-sm whitespace-pre-wrap">{video.description}</p>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground italic">This video has no description.</p>
          )}
        </CardContent>
      </Card>

      {/* Comment analysis — the same component the post page uses, because the
          analysis pipeline is shared. */}
      <CommentAnalysis
        analysis={summary}
        contentLabel="video"
        actions={
          isAdmin ? <VideoCommentActions videoId={video.id} hasSummary={summary !== null} /> : null
        }
      />

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="text-base">Video insights</CardTitle>
              <CardDescription>
                Every metric Meta returned from <code>/video_insights</code>, stored exactly as
                received. Values may be numbers, strings, arrays or nested objects — no metric name
                is hard-coded, so new ones appear here automatically.
              </CardDescription>
            </div>
            {unavailableCount > 0 ? (
              <Badge variant="outline">{unavailableCount} without a value</Badge>
            ) : null}
          </div>
        </CardHeader>
        <CardContent className="px-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Metric</TableHead>
                  <TableHead>Period</TableHead>
                  <TableHead>End time</TableHead>
                  <TableHead className="text-right">Value</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {insights.map((insight) => (
                  <TableRow key={insight.id}>
                    <TableCell>
                      <div className="text-sm">{insight.label}</div>
                      <div className="font-mono text-xs text-muted-foreground">
                        {insight.metricName}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs">{insight.period ?? "—"}</TableCell>
                    <TableCell className="text-xs whitespace-nowrap text-muted-foreground">
                      {formatWhen(insight.endTime)}
                    </TableCell>
                    <TableCell className="text-right">
                      {insight.availability === "reported" ? (
                        <span className="font-mono text-sm">{insight.displayValue}</span>
                      ) : (
                        <span className="text-xs text-muted-foreground italic">
                          {METRIC_NOT_AVAILABLE}
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}

                {insights.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">
                      <span className="italic">{METRIC_NOT_AVAILABLE}</span>
                      <p className="mt-1 text-xs">
                        Meta returned no insights for this video. This is normal for very recent
                        uploads, and for tokens without <code>read_insights</code>.
                      </p>
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
