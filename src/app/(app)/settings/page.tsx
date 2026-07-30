import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import {
  CircleAlert,
  CircleCheck,
  CircleSlash,
  Download,
  ExternalLink,
  PlugZap,
  Table2,
} from "lucide-react";

import { MetricCard, MetricGrid } from "@/components/data/metric-card";
import { MetricCardSkeleton } from "@/components/data/states";
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
import { getServerEnvSafe } from "@/config/env";
import { requireUser } from "@/lib/auth/guards";
import { isAdmin } from "@/lib/auth/roles";
import { resolveAppOrigin } from "@/lib/config/app-origin";
import { SHEET_TABS, branchLetterFor } from "@/lib/google-sheets/sheet-schema";
import { getExportStatus, N8N_CONTACT_WINDOW_HOURS } from "@/lib/repositories/export-runs";

export const metadata: Metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

const numberFormat = new Intl.NumberFormat("en-GB");

function formatWhen(value: Date | null): string {
  if (!value) return "Never";
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(value);
}

/** "3 hours ago", for the figures where recency is the point. */
function relative(value: Date | null): string {
  if (!value) return "";
  const seconds = Math.round((Date.now() - value.getTime()) / 1000);

  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86_400)} d ago`;
}

const CONNECTION_LABELS = {
  connected: "Connected",
  stale: "No recent contact",
  never_connected: "Never connected",
} as const;

/**
 * Live export status.
 *
 * Its own Suspense boundary so the configuration card — which reads no database
 * — paints immediately. On a deployment where the database is unreachable, that
 * card is the one an operator most needs to see.
 */
async function ExportStatus({ sheetsEnabled }: { sheetsEnabled: boolean }) {
  const status = await getExportStatus();

  const connectionTone =
    status.connection === "connected"
      ? "default"
      : status.connection === "stale"
        ? "warning"
        : "muted";

  return (
    <>
      <MetricGrid>
        <MetricCard
          label="Google Sheets export"
          value={sheetsEnabled ? "Enabled" : "Disabled"}
          hint={
            sheetsEnabled
              ? "GOOGLE_SHEETS_EXPORT_ENABLED is true. n8n may pull export rows."
              : "GOOGLE_SHEETS_EXPORT_ENABLED is false. Set it to true to turn the pipeline on."
          }
          icon={Table2}
          tone={sheetsEnabled ? "default" : "muted"}
        />
        <MetricCard
          label="n8n connection"
          value={CONNECTION_LABELS[status.connection]}
          hint={
            status.lastAutomationContactAt
              ? `Last contact ${formatWhen(status.lastAutomationContactAt)} (${relative(status.lastAutomationContactAt)}).`
              : `No authenticated automation request has ever arrived. Considered stale after ${N8N_CONTACT_WINDOW_HOURS} h.`
          }
          icon={PlugZap}
          tone={connectionTone}
        />
        <MetricCard
          label="Last successful export"
          value={status.lastSuccess ? relative(status.lastSuccess.createdAt) : "Never"}
          hint={
            status.lastSuccess
              ? `${status.lastSuccess.dataset} · ${numberFormat.format(status.lastSuccess.rowCount)} rows · ${formatWhen(status.lastSuccess.createdAt)}`
              : "No export has succeeded yet."
          }
          icon={CircleCheck}
        />
        <MetricCard
          label="Records exported (24 h)"
          value={numberFormat.format(status.rowsLast24h)}
          hint={`${numberFormat.format(status.rowsAllTime)} all time · ${status.succeededLast24h} request${status.succeededLast24h === 1 ? "" : "s"} succeeded, ${status.failedLast24h} failed.`}
          icon={Download}
        />
        <MetricCard
          label="Last export error"
          value={status.lastFailure ? relative(status.lastFailure.createdAt) : "None"}
          hint={
            status.lastFailure
              ? `${status.lastFailure.dataset} · ${formatWhen(status.lastFailure.createdAt)}`
              : "No export has failed."
          }
          icon={status.lastFailure ? CircleAlert : CircleSlash}
          tone={status.lastFailure ? "danger" : "default"}
        />
      </MetricGrid>

      {status.lastFailure?.errorMessage ? (
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle className="text-base">Most recent export failure</CardTitle>
            <CardDescription>
              {status.lastFailure.dataset} · {formatWhen(status.lastFailure.createdAt)}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {/* Sanitised where it was recorded. Never a raw database message. */}
            <p className="font-mono text-xs break-words text-muted-foreground">
              {status.lastFailure.errorMessage}
            </p>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Export activity by dataset</CardTitle>
          <CardDescription>
            The most recent request per dataset, so one broken branch is visible even when the
            others are fine.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <div className="overflow-x-auto">
            <Table>
              <caption className="sr-only">
                The latest export request for each dataset, with its outcome.
              </caption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Dataset</TableHead>
                  <TableHead scope="col">Last run</TableHead>
                  <TableHead scope="col">Status</TableHead>
                  <TableHead scope="col" className="text-right">
                    Rows
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {status.perDataset.map((row) => (
                  <TableRow key={row.dataset}>
                    <TableCell className="font-mono text-xs">{row.dataset}</TableCell>
                    <TableCell className="text-xs whitespace-nowrap text-muted-foreground">
                      {formatWhen(row.lastRunAt)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={row.status === "failed" ? "destructive" : "secondary"}>
                        {row.status}
                      </Badge>
                      {row.errorMessage ? (
                        <p className="mt-1 max-w-md text-xs text-muted-foreground">
                          {row.errorMessage}
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {numberFormat.format(row.rowCount)}
                    </TableCell>
                  </TableRow>
                ))}

                {status.perDataset.length === 0 ? (
                  <TableRow className="hover:bg-transparent">
                    <TableCell
                      colSpan={4}
                      className="h-20 text-center text-sm text-muted-foreground"
                    >
                      No export has been requested yet. The n8n workflow records one row here per
                      request.
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

export default async function SettingsPage() {
  /*
   * Resolved rather than hard-coded: on a preview this is that deployment's own
   * hostname, because a preview has no canonical URL. Showing the production URL
   * on a preview would send an operator to configure n8n against the wrong app.
   */
  const exportBaseUrl = resolveAppOrigin();
  const user = await requireUser();
  const env = getServerEnvSafe();
  const missing = env.ok ? [] : env.missingKeys;
  const sheetsEnabled = env.ok ? env.env.GOOGLE_SHEETS_EXPORT_ENABLED : false;

  return (
    <>
      <PageHeader
        title="Settings"
        description="Configuration, and the health of the Google Sheets reporting pipeline. All times are UTC."
      />

      <Suspense
        fallback={
          <MetricGrid>
            {Array.from({ length: 5 }, (_, index) => (
              <MetricCardSkeleton key={index} />
            ))}
          </MetricGrid>
        }
      >
        <ExportStatus sheetsEnabled={sheetsEnabled} />
      </Suspense>

      {/* ------------------------------------------------------------------ */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            {env.ok ? (
              <CircleCheck className="size-4 text-emerald-600" aria-hidden />
            ) : (
              <CircleAlert className="size-4 text-destructive" aria-hidden />
            )}
            Server configuration
          </CardTitle>
          <CardDescription>
            Validated against the Zod contract in <code className="text-xs">src/config/env.ts</code>
            . Key names only — values are never sent to the browser.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {env.ok ? (
            <p className="text-sm">All required environment variables are present and valid.</p>
          ) : (
            <div className="space-y-2">
              <p className="text-sm">
                {missing.length} variable{missing.length === 1 ? "" : "s"} missing or invalid:
              </p>
              <ul className="flex flex-wrap gap-2">
                {missing.map((key) => (
                  <li key={key}>
                    <Badge variant="outline" className="font-mono text-xs">
                      {key}
                    </Badge>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ------------------------------------------------------------------ */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Google Sheets tabs</CardTitle>
          <CardDescription>
            The reporting mirror is seven tabs, one per n8n branch. Each is written with Append or
            Update Row keyed on its matching column — a plain Append would duplicate every row on
            every run.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <div className="overflow-x-auto">
            <Table>
              <caption className="sr-only">
                Google Sheets tabs, their n8n branch, matching column and CSV fallback.
              </caption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Branch</TableHead>
                  <TableHead scope="col">Tab</TableHead>
                  <TableHead scope="col" className="hidden md:table-cell">
                    Matching column
                  </TableHead>
                  <TableHead scope="col" className="hidden text-right lg:table-cell">
                    Columns
                  </TableHead>
                  <TableHead scope="col" className="text-right">
                    CSV fallback
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {SHEET_TABS.map((tab) => (
                  <TableRow key={tab.tab}>
                    <TableCell className="font-mono text-xs">
                      {branchLetterFor(tab.dataset)}
                    </TableCell>
                    <TableCell>
                      <p className="text-sm font-medium">{tab.tab}</p>
                      <p className="text-xs text-muted-foreground">{tab.description}</p>
                    </TableCell>
                    <TableCell className="hidden font-mono text-xs md:table-cell">
                      {tab.matchColumn}
                    </TableCell>
                    <TableCell className="hidden text-right font-mono text-xs lg:table-cell">
                      {tab.columns.length}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button asChild variant="ghost" size="icon-sm">
                        <a
                          href={`/api/export/sheets/${tab.dataset.replace(/_/g, "-")}`}
                          download
                          aria-label={`Download ${tab.tab} as CSV`}
                        >
                          <Download className="size-4" aria-hidden />
                        </a>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* ------------------------------------------------------------------ */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Credentials and boundaries</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            <strong className="text-foreground">Export endpoint base URL.</strong>{" "}
            <code className="text-xs">{exportBaseUrl}/api/automation/exports/…</code>
            {" — "}
            this is the value the <em>Configuration</em> node in n8n must hold. On a preview
            deployment it is that deployment&rsquo;s own hostname, because a preview has no
            canonical URL.
          </p>
          <p>
            <strong className="text-foreground">n8n owns the Google credential.</strong> This
            application has no field to store one, never asks for one, and never calls the Google
            Sheets API. It produces rows; n8n moves them.
          </p>
          <p>
            <strong className="text-foreground">
              No Facebook Page token reaches Google Sheets.
            </strong>{" "}
            No tab has a column capable of carrying one. The Streamers tab shows{" "}
            <em>token status</em> — a health value such as <code className="text-xs">expiring</code>{" "}
            — which is what lets a workflow raise an alert without ever seeing the credential.
          </p>
          <p>
            <strong className="text-foreground">Sheets is written, never read.</strong> The database
            is the primary source; the spreadsheet is a mirror. Nothing in this application reads a
            sheet back.
          </p>
          <p>
            An empty cell means the value was <em>not reported</em> by Meta. It never means zero.
          </p>
        </CardContent>
      </Card>

      {/* ------------------------------------------------------------------ */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Reference</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href="/reports">
              <Download className="size-4" aria-hidden />
              Reports and exports
            </Link>
          </Button>
          {isAdmin(user.role) ? (
            <Button asChild variant="outline" size="sm">
              <Link href="/admin/streamers">
                <ExternalLink className="size-4" aria-hidden />
                Manage streamers and tokens
              </Link>
            </Button>
          ) : null}
        </CardContent>
      </Card>
    </>
  );
}
