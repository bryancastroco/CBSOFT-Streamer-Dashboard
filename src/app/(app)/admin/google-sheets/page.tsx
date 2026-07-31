import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Download } from "lucide-react";

import { ConfigurationBroken, SettingsCard } from "@/components/admin/settings-table";
import { PageHeader, SectionHeader } from "@/components/layout/page-header";
import { CardSkeleton } from "@/components/layout/states";
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
import { requireAdmin } from "@/lib/auth/guards";
import { describeConfiguration } from "@/lib/config/settings-view";
import { SHEET_TABS, branchLetterFor } from "@/lib/google-sheets/sheet-schema";
import { getExportVolumes } from "@/lib/repositories/admin-health";

export const metadata: Metadata = { title: "Google Sheets" };
export const dynamic = "force-dynamic";

/**
 * The export contract: seven tabs, their columns, and their match columns.
 *
 * Read from `sheet-schema.ts` rather than restated, so this screen cannot drift
 * from what the endpoints actually send. If a column is added there, it appears
 * here on the next render.
 *
 * The match column is the field that earns its own emphasis. n8n's
 * Append-or-Update needs a value that is stable for the life of a row; point it
 * at a timestamp and every run appends instead of updating, which is silent and
 * doubles the sheet every night.
 */

const numberFormat = new Intl.NumberFormat("en-GB");

async function Volumes() {
  const volumes = await getExportVolumes();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Rows available now</CardTitle>
        <CardDescription>
          What each endpoint would return unfiltered. A workflow normally asks for a window rather
          than the whole table.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Tab</TableHead>
                <TableHead scope="col" className="text-right">
                  Rows
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {SHEET_TABS.map((tab) => (
                <TableRow key={tab.tab}>
                  <TableCell className="text-sm">{tab.tab}</TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {numberFormat.format(volumes[tab.dataset] ?? 0)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

export default async function GoogleSheetsPage() {
  await requireAdmin();

  const config = describeConfiguration();

  return (
    <>
      <PageHeader
        title="Google Sheets"
        description="Export tabs, their match columns, and the rows behind each."
        primaryAction={
          <Button asChild variant="outline" size="sm">
            <Link href="/reports">
              <Download className="size-4" aria-hidden />
              Reports and CSV
            </Link>
          </Button>
        }
      />

      {config.ok && config.sheets ? (
        <SettingsCard section={config.sheets} />
      ) : (
        <ConfigurationBroken missingKeys={config.missingKeys} />
      )}

      <Suspense fallback={<CardSkeleton count={1} />}>
        <Volumes />
      </Suspense>

      <section className="space-y-3">
        <SectionHeader
          title="Tab layout"
          description="The header row each tab must use, in order. Sheets is positional once a header exists, so column order is part of the contract."
        />

        {SHEET_TABS.map((tab) => {
          const branch = branchLetterFor(tab.dataset);

          return (
            <Card key={tab.tab}>
              <CardHeader>
                <div className="flex flex-wrap items-center gap-2">
                  <CardTitle className="text-base">{tab.tab}</CardTitle>
                  {branch ? <Badge variant="outline">Branch {branch}</Badge> : null}
                  <Badge variant="secondary" className="font-mono text-[10px]">
                    {tab.columns.length} columns
                  </Badge>
                </div>
                <CardDescription>{tab.description}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-xs">
                  <span className="text-muted-foreground">Column to match on: </span>
                  <code className="font-mono font-medium">{tab.matchColumn}</code>
                </p>
                <div className="flex flex-wrap gap-1">
                  {tab.columns.map((column) => (
                    <Badge
                      key={column.header}
                      variant={column.header === tab.matchColumn ? "default" : "outline"}
                      className="text-[10px] font-normal"
                      title={column.description}
                    >
                      {column.header}
                    </Badge>
                  ))}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </section>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Why this application holds no Google credentials</CardTitle>
          <CardDescription>
            Sheets is a destination, never a source. Nothing here reads from a spreadsheet, and no
            Google client library is installed — writing the rows is n8n&apos;s job, using its own
            credential. That boundary is what keeps a spreadsheet permission change from becoming a
            dashboard outage.
          </CardDescription>
        </CardHeader>
      </Card>
    </>
  );
}
