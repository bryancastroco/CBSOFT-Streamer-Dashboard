import "server-only";

import { sql, type SQL } from "drizzle-orm";

import { NO_SIGNIFICANT_FINDINGS } from "@/lib/ai/contract";
import { getDb } from "@/lib/db";
import { gameClause } from "@/lib/db/game-filter";
import { pageOffset, pageSize, tsParam } from "@/lib/db/params";
import type { ContentType } from "@/lib/comments/content-ref";
import type { ContentScope } from "@/lib/filters/period";
import type { AnalysisSortKey, SortState } from "@/lib/filters/sorting";

/**
 * The comment-analysis reading list.
 *
 * `comment_summaries` is polymorphic — a summary hangs off a post or a video —
 * so a single reading list means a union. It is written as one SQL statement
 * rather than two round trips plus an in-memory merge, because sorting and
 * paginating across both content types only works if the database does it: a
 * "top 25 by urgency" assembled from two independently paginated halves is not
 * the top 25.
 *
 * ## Privacy
 *
 * The select list is explicit and contains no commenter field, because none
 * exists — `comments` has no author column at all. The individual comment rows
 * are never read here either: this list shows the analysis, which is the
 * deliverable.
 */

export type AnalysisListItem = {
  summaryId: string;
  contentType: ContentType;
  contentId: string;
  /** A post's message or a video's title, already excerpted by the caller. */
  contentTitle: string | null;
  permalinkUrl: string | null;
  contentCreatedAt: Date;
  streamerId: string;
  streamerCode: string;
  streamerName: string;
  commentCount: number;
  sentiment: string | null;
  summary: string | null;
  status: string;
  positivePoints: unknown;
  concerns: unknown;
  suggestions: unknown;
  questions: unknown;
  urgentIssues: unknown;
  /** Real urgent findings, with the "No significant findings" placeholder excluded. */
  urgentCount: number;
  generatedAt: Date | null;
};

export type ListAnalysesFilters = {
  streamerId?: string | undefined;
  /** A game id, or `UNFILED_GAME` for content attributed to nothing. */
  gameId?: string | undefined;
  search?: string | undefined;
  from?: Date | null;
  to?: Date | null;
  scope?: ContentScope;
  sort?: SortState<AnalysisSortKey>;
  limit: number;
  offset: number;
};

/**
 * Sort keys mapped to fixed SQL fragments.
 *
 * The map is the reason a sort parameter from the query string can never reach
 * `ORDER BY`: an unrecognised key cannot index into it, and the caller has
 * already resolved the key against the same allow-list in `lib/filters/sorting`.
 */
const SORT_COLUMNS: Record<AnalysisSortKey, SQL> = {
  generatedAt: sql`generated_at`,
  streamer: sql`streamer_code`,
  contentType: sql`content_type`,
  commentCount: sql`comment_count`,
  sentiment: sql`sentiment`,
  urgentCount: sql`urgent_count`,
};

const DEFAULT_SORT: SortState<AnalysisSortKey> = { key: "generatedAt", direction: "desc" };

/** Counts only real findings — the placeholder is not an urgent issue. */
const urgentCountExpression = sql`
  case
    when jsonb_typeof(cs.urgent_issues_json) = 'array' then (
      select count(*)::int
      from jsonb_array_elements_text(cs.urgent_issues_json) as issue
      where btrim(issue) <> '' and btrim(issue) <> ${NO_SIGNIFICANT_FINDINGS}
    )
    else 0
  end
`;

/**
 * The union, as a CTE body.
 *
 * Both halves project an identical column list so the union is stable if a
 * column is added to one branch and forgotten in the other — Postgres rejects
 * the mismatch rather than silently shifting values between columns.
 */
function unifiedSource(filters: ListAnalysesFilters): SQL {
  const scope = filters.scope ?? "all";
  const includePosts = scope === "all" || scope === "posts";
  const includeVideos = scope === "all" || scope === "videos";

  const search = filters.search ? `%${filters.search}%` : null;

  const postConditions: SQL[] = [sql`cs.post_id is not null`];
  const videoConditions: SQL[] = [sql`cs.video_id is not null`];

  if (filters.streamerId) {
    postConditions.push(sql`s.id = ${filters.streamerId}::uuid`);
    videoConditions.push(sql`s.id = ${filters.streamerId}::uuid`);
  }

  const postGame = gameClause(sql`p.game_id`, filters.gameId);
  const videoGame = gameClause(sql`v.game_id`, filters.gameId);
  if (postGame) postConditions.push(postGame);
  if (videoGame) videoConditions.push(videoGame);

  if (filters.from) {
    postConditions.push(sql`p.created_time >= ${tsParam(filters.from)}::timestamptz`);
    videoConditions.push(sql`v.created_time >= ${tsParam(filters.from)}::timestamptz`);
  }
  if (filters.to) {
    postConditions.push(sql`p.created_time <= ${tsParam(filters.to)}::timestamptz`);
    videoConditions.push(sql`v.created_time <= ${tsParam(filters.to)}::timestamptz`);
  }
  if (search) {
    postConditions.push(
      sql`(p.message ilike ${search} or cs.summary ilike ${search}
        or s.streamer_name ilike ${search} or s.streamer_code ilike ${search})`,
    );
    videoConditions.push(
      sql`(v.title ilike ${search} or v.description ilike ${search} or cs.summary ilike ${search}
        or s.streamer_name ilike ${search} or s.streamer_code ilike ${search})`,
    );
  }

  const postBranch = sql`
    select
      cs.id                  as summary_id,
      'post'::text           as content_type,
      p.id                   as content_id,
      p.message              as content_title,
      p.permalink_url        as permalink_url,
      p.created_time         as content_created_at,
      s.id                   as streamer_id,
      s.streamer_code        as streamer_code,
      s.streamer_name        as streamer_name,
      cs.comment_count       as comment_count,
      cs.sentiment::text     as sentiment,
      cs.summary             as summary,
      cs.status::text        as status,
      cs.positive_points_json as positive_points,
      cs.concerns_json       as concerns,
      cs.suggestions_json    as suggestions,
      cs.questions_json      as questions,
      cs.urgent_issues_json  as urgent_issues,
      ${urgentCountExpression} as urgent_count,
      cs.generated_at        as generated_at
    from comment_summaries cs
    join posts p      on p.id = cs.post_id
    join streamers s  on s.id = p.streamer_id
    where ${sql.join(postConditions, sql` and `)}
  `;

  const videoBranch = sql`
    select
      cs.id                  as summary_id,
      'video'::text          as content_type,
      v.id                   as content_id,
      coalesce(v.title, v.description) as content_title,
      v.permalink_url        as permalink_url,
      v.created_time         as content_created_at,
      s.id                   as streamer_id,
      s.streamer_code        as streamer_code,
      s.streamer_name        as streamer_name,
      cs.comment_count       as comment_count,
      cs.sentiment::text     as sentiment,
      cs.summary             as summary,
      cs.status::text        as status,
      cs.positive_points_json as positive_points,
      cs.concerns_json       as concerns,
      cs.suggestions_json    as suggestions,
      cs.questions_json      as questions,
      cs.urgent_issues_json  as urgent_issues,
      ${urgentCountExpression} as urgent_count,
      cs.generated_at        as generated_at
    from comment_summaries cs
    join videos v     on v.id = cs.video_id
    join streamers s  on s.id = v.streamer_id
    where ${sql.join(videoConditions, sql` and `)}
  `;

  if (includePosts && includeVideos) {
    return sql`${postBranch} union all ${videoBranch}`;
  }
  if (includePosts) return postBranch;
  if (includeVideos) return videoBranch;

  // Unreachable while ContentScope has three members, but a scope that matches
  // nothing must return nothing rather than everything.
  return sql`select * from (${postBranch}) as no_scope where false`;
}

type AnalysisRow = {
  summary_id: string;
  content_type: string;
  content_id: string;
  content_title: string | null;
  permalink_url: string | null;
  content_created_at: Date;
  streamer_id: string;
  streamer_code: string;
  streamer_name: string;
  comment_count: number;
  sentiment: string | null;
  summary: string | null;
  status: string;
  positive_points: unknown;
  concerns: unknown;
  suggestions: unknown;
  questions: unknown;
  urgent_issues: unknown;
  urgent_count: number;
  generated_at: Date | null;
};

export async function listCommentAnalyses(
  filters: ListAnalysesFilters,
): Promise<{ items: AnalysisListItem[]; total: number }> {
  const db = getDb();
  const source = unifiedSource(filters);
  const sort = filters.sort ?? DEFAULT_SORT;

  const direction = sort.direction === "asc" ? sql`asc` : sql`desc`;
  const column = SORT_COLUMNS[sort.key] ?? SORT_COLUMNS.generatedAt;

  // `nulls last` in both directions: a summary that has never been generated is
  // the least useful row on the page either way, and it should not head the
  // list just because ascending order puts nulls first.
  const [rows, totals] = await Promise.all([
    db.execute<AnalysisRow>(sql`
      with unified as (${source})
      select * from unified
      order by ${column} ${direction} nulls last, content_created_at desc, summary_id asc
      limit ${pageSize(filters.limit)} offset ${pageOffset(filters.offset)}
    `),
    db.execute<{ value: number }>(sql`
      with unified as (${source})
      select count(*)::int as value from unified
    `),
  ]);

  return {
    items: [...rows].map(toItem),
    total: [...totals][0]?.value ?? 0,
  };
}

function toItem(row: AnalysisRow): AnalysisListItem {
  return {
    summaryId: row.summary_id,
    contentType: row.content_type === "video" ? "video" : "post",
    contentId: row.content_id,
    contentTitle: row.content_title,
    permalinkUrl: row.permalink_url,
    contentCreatedAt: new Date(row.content_created_at),
    streamerId: row.streamer_id,
    streamerCode: row.streamer_code,
    streamerName: row.streamer_name,
    commentCount: Number(row.comment_count ?? 0),
    sentiment: row.sentiment,
    summary: row.summary,
    status: row.status,
    positivePoints: row.positive_points,
    concerns: row.concerns,
    suggestions: row.suggestions,
    questions: row.questions,
    urgentIssues: row.urgent_issues,
    urgentCount: Number(row.urgent_count ?? 0),
    generatedAt: row.generated_at ? new Date(row.generated_at) : null,
  };
}
