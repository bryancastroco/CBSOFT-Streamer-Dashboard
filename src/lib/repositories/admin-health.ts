import "server-only";

import { and, desc, eq, isNotNull, sql } from "drizzle-orm";

import { getDb } from "@/lib/db";
import { commentSummaries, streamers, syncRuns } from "@/lib/db/schema";
import { tsParam, tsResult } from "@/lib/db/params";
import { hasUrgentIssue } from "@/lib/repositories/metrics";

/**
 * Live health for the administration screens.
 *
 * Configuration says what the system is *meant* to do; these queries say what
 * it has actually been doing. A screen with only the first half is how a
 * broken integration goes unnoticed for a week — every setting looks right,
 * and nothing has run since Tuesday.
 */

export type TokenHealthRow = {
  id: string;
  streamerCode: string;
  streamerName: string;
  pageId: string;
  pageName: string;
  tokenStatus: string;
  tokenExpiresAt: Date | null;
  tokenLastValidatedAt: Date | null;
  tokenValidationError: string | null;
  tokenScopes: string[];
  lastSuccessfulSyncAt: Date | null;
  active: boolean;
  hasToken: boolean;
};

/**
 * Token health for every streamer, worst first.
 *
 * Ordered by how much attention the row needs rather than by name: an expired
 * token is the reason someone opened this screen, and making them find it in an
 * alphabetical list is a small cruelty.
 */
export async function listTokenHealth(): Promise<TokenHealthRow[]> {
  const db = getDb();

  const rows = await db
    .select({
      id: streamers.id,
      streamerCode: streamers.streamerCode,
      streamerName: streamers.streamerName,
      pageId: streamers.pageId,
      pageName: streamers.pageName,
      tokenStatus: streamers.tokenStatus,
      tokenExpiresAt: streamers.tokenExpiresAt,
      tokenLastValidatedAt: streamers.tokenLastValidatedAt,
      tokenValidationError: streamers.tokenValidationError,
      tokenScopes: streamers.tokenScopes,
      lastSuccessfulSyncAt: streamers.lastSuccessfulSyncAt,
      active: streamers.active,
      lastFour: streamers.pageTokenLastFour,
    })
    .from(streamers)
    .where(sql`${streamers.deletedAt} is null`)
    .orderBy(
      /*
       * Severity, then code. `expiring` outranks `valid` because it is the one
       * state where acting today prevents an outage tomorrow — and once a token
       * expires, no server-side path can renew it.
       */
      sql`case ${streamers.tokenStatus}
            when 'invalid' then 0
            when 'expired' then 1
            when 'missing_permission' then 2
            when 'missing' then 3
            when 'expiring' then 4
            else 5 end`,
      streamers.streamerCode,
    );

  return rows.map(({ lastFour, ...row }) => ({ ...row, hasToken: lastFour !== null }));
}

export type AiHealth = {
  total: number;
  completed: number;
  /** Analysed, and the item genuinely had no comments. A result, not a failure. */
  noComments: number;
  failed: number;
  urgent: number;
  /**
   * Content that has comments but no usable analysis.
   *
   * The figure that makes a silent skip visible. When summarisation is switched
   * off the sweep collects comments, writes nothing, and reports no error — so
   * "0 generated" is indistinguishable from "nothing needed doing". This is the
   * number that tells them apart.
   */
  awaitingAnalysis: number;
  lastGeneratedAt: Date | null;
  /** Most recent failures, with the reason. Sanitised at write time. */
  recentFailures: { id: string; error: string | null; at: Date | null }[];
};

/**
 * What summarisation has actually produced.
 *
 * The failure list matters more than the totals. Summaries fail quietly by
 * design — a failed analysis must never break the page showing the content —
 * so this is the only place a persistent problem becomes visible.
 */
export async function getAiHealth(): Promise<AiHealth> {
  const db = getDb();

  const [totals] = await db
    .select({
      total: sql<number>`count(*)::int`,
      completed: sql<number>`count(*) filter (where ${commentSummaries.status} = 'completed')::int`,
      noComments: sql<number>`count(*) filter (where ${commentSummaries.status} = 'no_comments')::int`,
      failed: sql<number>`count(*) filter (where ${commentSummaries.status} = 'failed')::int`,
      /*
       * The shared predicate, not a fresh one.
       *
       * The model writes the placeholder "No significant findings" into an
       * otherwise empty list, so a non-empty array is not a finding — counting
       * array length reports every analysed item as urgent, which is what a
       * first pass here did. Two definitions of the same word on two screens is
       * how `succeeded` survived in three files after an enum was renamed.
       */
      urgent: sql<number>`count(*) filter (where ${hasUrgentIssue})::int`,
      lastGeneratedAt: sql<string | null>`max(${commentSummaries.generatedAt})`,
    })
    .from(commentSummaries);

  const recentFailures = await db
    .select({
      id: commentSummaries.id,
      error: commentSummaries.errorMessage,
      at: commentSummaries.generatedAt,
    })
    .from(commentSummaries)
    .where(eq(commentSummaries.status, "failed"))
    .orderBy(desc(commentSummaries.generatedAt))
    .limit(5);

  /*
   * Content holding comments with nothing usable to show for them: either no
   * summary row at all, or one whose last attempt failed. Counted from
   * `comments` rather than from `comment_summaries`, because the items that
   * were never attempted have no summary row to count.
   */
  const [waiting] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(
      sql`(
        select distinct coalesce(c.post_id::text, c.video_id::text) as content_key,
               c.post_id, c.video_id
          from comments c
      ) as with_comments`,
    )
    .where(
      sql`not exists (
        select 1 from comment_summaries s
         where (s.post_id = with_comments.post_id or s.video_id = with_comments.video_id)
           and s.status in ('completed', 'no_comments')
      )`,
    );

  return {
    total: totals?.total ?? 0,
    completed: totals?.completed ?? 0,
    noComments: totals?.noComments ?? 0,
    failed: totals?.failed ?? 0,
    urgent: totals?.urgent ?? 0,
    awaitingAnalysis: waiting?.n ?? 0,
    lastGeneratedAt: tsResult(totals?.lastGeneratedAt),
    recentFailures,
  };
}

export type AutomationHealth = {
  /** Runs triggered by n8n or the scheduler, not by a person. */
  totalRuns: number;
  runsLast7Days: number;
  lastContactAt: Date | null;
  lastTriggerSource: string | null;
  recent: {
    id: string;
    status: string;
    triggerSource: string | null;
    startedAt: Date;
    completedAt: Date | null;
    postsProcessed: number | null;
    videosProcessed: number | null;
  }[];
};

/** Whether anything has actually been calling the automation surface. */
export async function getAutomationHealth(): Promise<AutomationHealth> {
  const db = getDb();

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);

  const [totals] = await db
    .select({
      totalRuns: sql<number>`count(*)::int`,
      lastContactAt: sql<string | null>`max(${syncRuns.startedAt})`,
    })
    .from(syncRuns)
    .where(eq(syncRuns.syncType, "automation"));

  const [recentWindow] = await db
    .select({ rows: sql<number>`count(*)::int` })
    .from(syncRuns)
    .where(
      and(
        eq(syncRuns.syncType, "automation"),
        sql`${syncRuns.startedAt} >= ${tsParam(sevenDaysAgo)}::timestamptz`,
      ),
    );

  const recent = await db
    .select({
      id: syncRuns.id,
      status: syncRuns.status,
      triggerSource: syncRuns.triggerSource,
      startedAt: syncRuns.startedAt,
      completedAt: syncRuns.completedAt,
      postsProcessed: syncRuns.postsProcessed,
      videosProcessed: syncRuns.videosProcessed,
    })
    .from(syncRuns)
    .where(and(eq(syncRuns.syncType, "automation"), isNotNull(syncRuns.startedAt)))
    .orderBy(desc(syncRuns.startedAt))
    .limit(8);

  return {
    totalRuns: totals?.totalRuns ?? 0,
    runsLast7Days: recentWindow?.rows ?? 0,
    lastContactAt: tsResult(totals?.lastContactAt),
    lastTriggerSource: recent[0]?.triggerSource ?? null,
    recent,
  };
}

/** Content volume, for the export screen's "what would be sent" figures. */
export async function getExportVolumes(): Promise<Record<string, number>> {
  const db = getDb();

  const [row] = await db
    .select({
      streamers: sql<number>`(select count(*) from streamers where deleted_at is null)::int`,
      posts: sql<number>`(select count(*) from posts)::int`,
      post_insights: sql<number>`(select count(*) from post_insights)::int`,
      videos: sql<number>`(select count(*) from videos)::int`,
      video_insights: sql<number>`(select count(*) from video_insights)::int`,
      comment_summaries: sql<number>`(select count(*) from comment_summaries)::int`,
      sync_logs: sql<number>`(select count(*) from sync_runs)::int`,
    })
    .from(sql`(select 1) as one`);

  return {
    streamers: row?.streamers ?? 0,
    posts: row?.posts ?? 0,
    post_insights: row?.post_insights ?? 0,
    videos: row?.videos ?? 0,
    video_insights: row?.video_insights ?? 0,
    comment_summaries: row?.comment_summaries ?? 0,
    sync_logs: row?.sync_logs ?? 0,
  };
}

/** Days until a token expires. Null when it has no expiry or none is stored. */
export function daysUntil(expiresAt: Date | null): number | null {
  if (!expiresAt) return null;
  return Math.floor((expiresAt.getTime() - Date.now()) / 86_400_000);
}

/** Kept for callers that only need the aggregate. */
export async function countTokensNeedingAttention(): Promise<number> {
  const db = getDb();

  const [row] = await db
    .select({ rows: sql<number>`count(*)::int` })
    .from(streamers)
    .where(
      and(
        sql`${streamers.deletedAt} is null`,
        sql`${streamers.tokenStatus} in ('missing', 'expired', 'invalid', 'missing_permission', 'expiring')`,
      ),
    );

  return row?.rows ?? 0;
}
