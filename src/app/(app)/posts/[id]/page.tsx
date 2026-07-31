import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ExternalLink } from "lucide-react";

import { PageHeader } from "@/components/layout/page-header";
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
import { CommentActions } from "@/app/(app)/posts/[id]/comment-actions";
import { CommentAnalysis } from "@/components/admin/comment-analysis";
import { requireUser } from "@/lib/auth/guards";
import { METRIC_NOT_AVAILABLE, describeInsights, formatCount } from "@/lib/meta/insight-display";
import { getSummaryForPost } from "@/lib/repositories/comments";
import { getPostById } from "@/lib/repositories/posts";
import { postIdSchema } from "@/lib/validation/posts";

export const metadata: Metadata = { title: "Post" };
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

/** One engagement figure, rendered so absence never reads as zero. */
function CountTile({ label, value }: { label: string; value: number | null }) {
  const { availability, display } = formatCount(value);

  return (
    <div className="rounded-md border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      {availability === "reported" ? (
        <p className="font-mono text-lg">{display}</p>
      ) : (
        <p className="mt-1 text-xs text-muted-foreground italic">{display}</p>
      )}
    </div>
  );
}

export default async function PostDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();

  const { id } = await params;
  const parsed = postIdSchema.safeParse(id);
  if (!parsed.success) notFound();

  const post = await getPostById(parsed.data);
  if (!post) notFound();

  const summary = await getSummaryForPost(post.id);
  const isAdmin = user.role === "admin";

  const insights = describeInsights(post.insights);
  const unavailableCount = insights.filter((i) => i.availability === "not_available").length;

  return (
    <>
      <PageHeader
        title={post.streamerName}
        description={`Published ${formatWhen(post.createdTime)} · ${post.streamerCode}`}
        primaryAction={
          <div className="flex gap-2">
            {post.permalinkUrl ? (
              <Button asChild variant="outline" size="sm">
                <a href={post.permalinkUrl} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="size-4" aria-hidden />
                  On Facebook
                </a>
              </Button>
            ) : null}
            <Button asChild variant="outline" size="sm">
              <Link href="/posts">
                <ArrowLeft className="size-4" aria-hidden />
                Back
              </Link>
            </Button>
          </div>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Message</CardTitle>
          <CardDescription className="font-mono text-xs">{post.facebookPostId}</CardDescription>
        </CardHeader>
        <CardContent>
          {post.message ? (
            <p className="text-sm whitespace-pre-wrap">{post.message}</p>
          ) : (
            <p className="text-sm text-muted-foreground italic">
              This post has no message text — it may be a photo or video post.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Engagement</CardTitle>
          <CardDescription>
            Summary counts from the post fetch. Last synced {formatWhen(post.lastSyncedAt)}.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-3">
            <CountTile label="Reactions" value={post.reactionCount} />
            <CountTile label="Comments" value={post.commentCount} />
            <CountTile label="Shares" value={post.shareCount} />
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Meta omits <code>shares</code> entirely for a post with none, so an unavailable share
            count is not the same as zero shares.
          </p>
        </CardContent>
      </Card>

      <CommentAnalysis
        analysis={summary}
        contentLabel="post"
        actions={isAdmin ? <CommentActions postId={post.id} hasSummary={summary !== null} /> : null}
      />

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="text-base">Insights</CardTitle>
              <CardDescription>
                Every metric Meta returned for this post, stored exactly as received. Metric names
                are not hard-coded, so new ones appear here automatically.
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
                        Meta returned no insights for this post. This is normal for very recent
                        posts, and for tokens without <code>read_insights</code>.
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
