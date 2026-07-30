import type { Metadata } from "next";
import Link from "next/link";
import { FileText, MessagesSquare, Video } from "lucide-react";

import { CsvExportLink } from "@/components/data/csv-export-link";
import { FilterBar } from "@/components/data/filter-bar";
import { PageHeader } from "@/components/layout/page-header";
import { PhaseNotice } from "@/components/layout/phase-notice";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireUser } from "@/lib/auth/guards";
import { buildBrowseHref, resolveBrowseQuery, type RawParams } from "@/lib/filters/browse";
import { EXPORT_ROW_LIMIT } from "@/lib/export/columns";
import type { SortState } from "@/lib/filters/sorting";
import { listStreamerOptions } from "@/lib/repositories/streamers";

export const metadata: Metadata = { title: "Reports" };
export const dynamic = "force-dynamic";

const BASE_PATH = "/reports";
const SORT_KEYS = ["none"] as const;
type SortKey = (typeof SORT_KEYS)[number];
const DEFAULT_SORT: SortState<SortKey> = { key: "none", direction: "desc" };

const numberFormat = new Intl.NumberFormat("en-GB");

const EXPORTS = [
  {
    key: "posts",
    title: "Posts",
    icon: FileText,
    screen: "/posts",
    endpoint: "/api/export/posts",
    description:
      "One row per post: engagement counts, how many insight metrics Meta returned, and the comment-analysis verdict.",
  },
  {
    key: "videos",
    title: "Videos",
    icon: Video,
    screen: "/videos",
    endpoint: "/api/export/videos",
    description:
      "One row per video: duration in both seconds and readable form, available metrics, and the comment-analysis verdict.",
  },
  {
    key: "comment-analysis",
    title: "Comment analysis",
    icon: MessagesSquare,
    screen: "/comment-analysis",
    endpoint: "/api/export/comment-analysis",
    description:
      "One row per analysis across posts and videos: summary, sentiment, concerns, suggestions, questions and urgent issues.",
  },
] as const;

export default async function ReportsPage({ searchParams }: { searchParams: Promise<RawParams> }) {
  await requireUser();

  const params = await searchParams;
  const query = resolveBrowseQuery({
    raw: params,
    sortKeys: SORT_KEYS,
    defaultSort: DEFAULT_SORT,
  });
  const streamers = await listStreamerOptions();

  return (
    <>
      <PageHeader
        title="Reports"
        description="Download the current data as CSV. Set the filters once and every export below uses them."
      />

      <FilterBar
        query={query}
        basePath={BASE_PATH}
        defaultSort={DEFAULT_SORT}
        options={{ streamers, showSearch: false }}
      />

      <div className="grid gap-4 lg:grid-cols-3">
        {EXPORTS.map((item) => {
          const Icon = item.icon;

          return (
            <Card key={item.key} className="flex flex-col">
              <CardHeader>
                <div className="flex items-center gap-2">
                  <Icon className="size-4 text-muted-foreground" aria-hidden />
                  <CardTitle className="text-base">{item.title}</CardTitle>
                </div>
                <CardDescription>{item.description}</CardDescription>
              </CardHeader>
              <CardContent className="mt-auto flex flex-wrap items-center gap-2">
                <CsvExportLink
                  href={buildBrowseHref(item.endpoint, query, DEFAULT_SORT, {})}
                  label={`Download ${item.title.toLowerCase()}`}
                />
                <Button asChild variant="ghost" size="sm">
                  <Link href={buildBrowseHref(item.screen, query, DEFAULT_SORT, {})}>
                    View on screen
                  </Link>
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">What these files contain</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            Rows match the current filters ({query.period.label}), capped at{" "}
            {numberFormat.format(EXPORT_ROW_LIMIT)} rows per file. Narrow the period or pick a
            single streamer if an export reaches the cap.
          </p>
          <p>
            An empty cell means Meta did not report that figure. It is never written as zero — a
            post with no shares and a post whose share count was withheld are different facts.
          </p>
          <p>
            No Page token, token suffix or token status appears in any export. Neither does any
            commenter identity: none is collected, so there is none to export.
          </p>
        </CardContent>
      </Card>

      <PhaseNotice phase={8}>
        These are direct downloads. The scheduled Google Sheets pipeline — where n8n pulls rows from{" "}
        <code className="text-xs">/api/n8n/export</code> against the contract in{" "}
        <code className="text-xs">src/lib/google-sheets/export-contract.ts</code> — is a later
        phase.
      </PhaseNotice>
    </>
  );
}
