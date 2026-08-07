import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { AlertTriangle, Eye } from "lucide-react";

import { FilterBar } from "@/components/data/filter-bar";
import { EmptyTableRow, TableSkeleton } from "@/components/data/states";
import { PageHeader } from "@/components/layout/page-header";
import { TokenStatusBadge } from "@/components/admin/token-status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { requireUser } from "@/lib/auth/guards";
import { isAdmin } from "@/lib/auth/roles";
import { buildBrowseHref, resolveBrowseQuery, type RawParams } from "@/lib/filters/browse";
import type { SortState } from "@/lib/filters/sorting";
import { isTokenStatus } from "@/lib/meta/token-status";
import { listStreamerRoster } from "@/lib/repositories/metrics";
import { listStreamerOptions } from "@/lib/repositories/streamers";
import { formatDateTime } from "@/lib/time/zone";
import { DISPLAY_TIME_ZONE_LABEL } from "@/lib/time/zone";

export const metadata: Metadata = { title: "Streamers" };
export const dynamic = "force-dynamic";

const BASE_PATH = "/streamers";

/**
 * The roster is ordered by streamer code, not by a sortable column: it is a
 * roster, and an operator looking for `CBS-014` should find it in the same place
 * every time. The content counts respond to the period filter.
 */
const SORT_KEYS = ["none"] as const;
type SortKey = (typeof SORT_KEYS)[number];
const DEFAULT_SORT: SortState<SortKey> = { key: "none", direction: "asc" };

function formatWhen(value: Date | null): string {
  if (!value) return "Never";
  return formatDateTime(value);
}

async function RosterTable({ params, showTokens }: { params: RawParams; showTokens: boolean }) {
  const query = resolveBrowseQuery({
    raw: params,
    sortKeys: SORT_KEYS,
    defaultSort: DEFAULT_SORT,
  });

  const rows = await listStreamerRoster({
    from: query.period.from,
    to: query.period.to,
    search: query.search,
  });

  const columnCount = showTokens ? 8 : 7;

  return (
    <Card>
      <CardContent className="px-0">
        <div className="overflow-x-auto">
          <Table>
            <caption className="sr-only">
              CBSOFT streamers and the Facebook Pages connected to each, with content collected in
              the selected period.
            </caption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Streamer</TableHead>
                <TableHead scope="col" className="hidden md:table-cell">
                  Facebook Page
                </TableHead>
                <TableHead scope="col">Status</TableHead>
                {showTokens ? (
                  <TableHead scope="col" className="hidden lg:table-cell">
                    Token
                  </TableHead>
                ) : null}
                <TableHead scope="col" className="text-right">
                  Posts
                </TableHead>
                <TableHead scope="col" className="text-right">
                  Videos
                </TableHead>
                <TableHead scope="col" className="hidden text-right lg:table-cell">
                  Analyses
                </TableHead>
                <TableHead scope="col" className="text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="align-top">
                    <Link
                      href={`/streamers/${row.id}`}
                      className="text-sm font-medium underline-offset-4 hover:underline"
                    >
                      {row.streamerName}
                    </Link>
                    <p className="font-mono text-xs text-muted-foreground">{row.streamerCode}</p>
                    <p className="mt-1 text-xs text-muted-foreground md:hidden">{row.pageName}</p>
                  </TableCell>

                  <TableCell className="hidden align-top md:table-cell">
                    <p className="text-sm">{row.pageName}</p>
                    <p className="font-mono text-xs text-muted-foreground">{row.pageId}</p>
                  </TableCell>

                  <TableCell className="align-top">
                    <Badge variant={row.active ? "secondary" : "outline"}>
                      {row.active ? "Active" : "Disabled"}
                    </Badge>
                    <p className="mt-1 text-xs whitespace-nowrap text-muted-foreground">
                      Synced {formatWhen(row.lastSuccessfulSyncAt)}
                    </p>
                  </TableCell>

                  {/*
                   * Token health is admin-only. Phase 2 grants viewers
                   * `streamers.view` and explicitly withholds anything about
                   * tokens — even the health enum, which tells a viewer nothing
                   * they can act on.
                   */}
                  {showTokens ? (
                    <TableCell className="hidden align-top lg:table-cell">
                      {isTokenStatus(row.tokenStatus) ? (
                        <TokenStatusBadge status={row.tokenStatus} />
                      ) : (
                        <span className="text-xs text-muted-foreground">{row.tokenStatus}</span>
                      )}
                    </TableCell>
                  ) : null}

                  <TableCell className="text-right align-top font-mono text-xs">
                    {row.postCount > 0 ? (
                      <Link
                        href={`/posts?streamerId=${row.id}`}
                        className="underline-offset-4 hover:underline"
                      >
                        {row.postCount}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">0</span>
                    )}
                  </TableCell>

                  <TableCell className="text-right align-top font-mono text-xs">
                    {row.videoCount > 0 ? (
                      <Link
                        href={`/videos?streamerId=${row.id}`}
                        className="underline-offset-4 hover:underline"
                      >
                        {row.videoCount}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">0</span>
                    )}
                  </TableCell>

                  <TableCell className="hidden text-right align-top font-mono text-xs lg:table-cell">
                    <span>{row.summaryCount}</span>
                    {row.urgentCount > 0 ? (
                      <span
                        className="ml-2 inline-flex items-center gap-1 font-medium text-destructive"
                        title={`${row.urgentCount} analyses report an urgent issue`}
                      >
                        <AlertTriangle className="size-3.5" aria-hidden />
                        {row.urgentCount}
                      </span>
                    ) : null}
                  </TableCell>

                  <TableCell className="text-right align-top">
                    <Button asChild variant="ghost" size="icon-sm">
                      <Link
                        href={`/streamers/${row.id}`}
                        aria-label={`View ${row.streamerName} details`}
                      >
                        <Eye className="size-4" aria-hidden />
                      </Link>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}

              {rows.length === 0 ? (
                <EmptyTableRow
                  colSpan={columnCount}
                  title="No streamers match these filters"
                  description={
                    query.search
                      ? "No streamer matches that search. Clear it to see the whole roster."
                      : "The roster is empty. An admin can add a streamer from Admin → Streamers."
                  }
                  {...(query.search
                    ? { action: { label: "Clear search", href: BASE_PATH } }
                    : { action: { label: "Go to Admin", href: "/admin/streamers" } })}
                />
              ) : null}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

export default async function StreamersPage({
  searchParams,
}: {
  searchParams: Promise<RawParams>;
}) {
  const user = await requireUser();

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
        title="Streamers"
        description={`CBSOFT streamers and the Facebook Pages connected to each. Personal profiles are not supported. All times are ${DISPLAY_TIME_ZONE_LABEL}.`}
      />

      <FilterBar
        query={query}
        basePath={BASE_PATH}
        defaultSort={DEFAULT_SORT}
        options={{
          streamers,
          showScope: false,
          searchPlaceholder: "Name, code, Page name or Page id…",
        }}
      />

      <Suspense
        key={JSON.stringify(params)}
        fallback={
          <Card>
            <CardContent className="px-0">
              <TableSkeleton columns={5} rows={6} />
            </CardContent>
          </Card>
        }
      >
        <RosterTable params={params} showTokens={isAdmin(user.role)} />
      </Suspense>

      <p className="text-xs text-muted-foreground">
        Content counts cover the selected period ({query.period.label}).{" "}
        <Link
          href={buildBrowseHref("/dashboard", query, DEFAULT_SORT, {})}
          className="underline underline-offset-4"
        >
          See the roster totals on the dashboard
        </Link>
        .
      </p>
    </>
  );
}
