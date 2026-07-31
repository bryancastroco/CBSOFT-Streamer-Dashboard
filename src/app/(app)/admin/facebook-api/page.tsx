import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { CircleAlert, ExternalLink } from "lucide-react";

import { ConfigurationBroken, SettingsCard } from "@/components/admin/settings-table";
import { PageHeader, SectionHeader } from "@/components/layout/page-header";
import { CardSkeleton } from "@/components/layout/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/status-badge";
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
import { isTokenStatus } from "@/lib/meta/token-status";
import { daysUntil, listTokenHealth } from "@/lib/repositories/admin-health";

export const metadata: Metadata = { title: "Facebook API" };
export const dynamic = "force-dynamic";

/**
 * Meta app configuration and the health of every Page token.
 *
 * Token health lives here as well as on each streamer because the question an
 * operator actually has is "is anything about to break", and answering it by
 * opening every streamer in turn is how one Page's token reached its expiry
 * date unnoticed.
 *
 * The expiry column is the point of the screen. Once a Page token lapses, no
 * server-side path can renew it — Meta refuses every refresh with
 * `(190) Session has expired` — so the only useful moment to act is before.
 */

function formatWhen(value: Date | null): string {
  if (!value) return "Never";
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(value);
}

/** Expiry, said in the way that prompts action rather than arithmetic. */
function ExpiryCell({ expiresAt }: { expiresAt: Date | null }) {
  if (!expiresAt) {
    return <span className="text-sm text-emerald-600 dark:text-emerald-500">Does not expire</span>;
  }

  const days = daysUntil(expiresAt);
  if (days === null) return <span className="text-sm text-muted-foreground">Unknown</span>;

  if (days < 0) {
    return (
      <div>
        <span className="text-sm font-medium text-destructive">Expired</span>
        <p className="text-xs text-muted-foreground">{formatWhen(expiresAt)}</p>
      </div>
    );
  }

  return (
    <div>
      <span
        className={days <= 14 ? "text-sm font-medium text-amber-600 dark:text-amber-500" : "text-sm"}
      >
        {days === 0 ? "Today" : `${days} day${days === 1 ? "" : "s"}`}
      </span>
      <p className="text-xs text-muted-foreground">{formatWhen(expiresAt)}</p>
    </div>
  );
}

async function TokenHealth() {
  const rows = await listTokenHealth();

  const needsAttention = rows.filter(
    (row) => row.tokenStatus !== "valid" || (daysUntil(row.tokenExpiresAt) ?? 999) < 14,
  );

  return (
    <div className="space-y-4">
      {needsAttention.length > 0 ? (
        <Card className="border-amber-500/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <CircleAlert className="size-4 text-amber-600 dark:text-amber-500" aria-hidden />
              {needsAttention.length} token{needsAttention.length === 1 ? "" : "s"} need attention
            </CardTitle>
            <CardDescription>
              A token can only be renewed while it still works. Once it expires Meta refuses every
              refresh path, and the only remedy is generating a new one from Facebook by hand.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      <Card>
        <CardContent className="px-0">
          <div className="overflow-x-auto">
            <Table>
              <caption className="sr-only">
                Page token health for every streamer, most urgent first.
              </caption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Streamer</TableHead>
                  <TableHead scope="col">Status</TableHead>
                  <TableHead scope="col">Expires</TableHead>
                  <TableHead scope="col" className="hidden lg:table-cell">
                    Last checked
                  </TableHead>
                  <TableHead scope="col" className="hidden xl:table-cell">
                    Scopes
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
                      <p className="text-sm font-medium">{row.streamerName}</p>
                      <p className="font-mono text-xs text-muted-foreground">{row.streamerCode}</p>
                      <p className="font-mono text-xs text-muted-foreground">{row.pageId}</p>
                    </TableCell>

                    <TableCell className="align-top">
                      {isTokenStatus(row.tokenStatus) ? (
                        <StatusBadge domain="token" status={row.tokenStatus} />
                      ) : (
                        <span className="text-xs">{row.tokenStatus}</span>
                      )}
                      {row.tokenValidationError ? (
                        <p className="mt-1 max-w-64 text-xs text-muted-foreground">
                          {row.tokenValidationError}
                        </p>
                      ) : null}
                    </TableCell>

                    <TableCell className="align-top">
                      <ExpiryCell expiresAt={row.tokenExpiresAt} />
                    </TableCell>

                    <TableCell className="hidden align-top text-xs whitespace-nowrap text-muted-foreground lg:table-cell">
                      {formatWhen(row.tokenLastValidatedAt)}
                    </TableCell>

                    <TableCell className="hidden max-w-72 align-top xl:table-cell">
                      <div className="flex flex-wrap gap-1">
                        {row.tokenScopes.length === 0 ? (
                          <span className="text-xs text-muted-foreground">None recorded</span>
                        ) : (
                          row.tokenScopes.map((scope) => (
                            <Badge key={scope} variant="outline" className="font-mono text-[10px]">
                              {scope}
                            </Badge>
                          ))
                        )}
                      </div>
                    </TableCell>

                    <TableCell className="text-right align-top">
                      <Button asChild variant="outline" size="sm">
                        <Link href={`/admin/streamers/${row.id}`}>Manage</Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}

                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                      No streamers yet. Add one from Admin → Streamers.
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default async function FacebookApiPage() {
  await requireAdmin();

  const config = describeConfiguration();

  return (
    <>
      <PageHeader
        title="Facebook API"
        description="Meta app configuration and Page token health, in one place instead of spread across streamer records."
        primaryAction={
          <Button asChild variant="outline" size="sm">
            <a
              href="https://developers.facebook.com/tools/explorer/"
              target="_blank"
              rel="noopener noreferrer"
            >
              <ExternalLink className="size-4" aria-hidden />
              Graph API Explorer
            </a>
          </Button>
        }
      />

      {config.ok && config.meta ? (
        <SettingsCard section={config.meta} />
      ) : (
        <ConfigurationBroken missingKeys={config.missingKeys} />
      )}

      <section className="space-y-3">
        <SectionHeader
          title="Page tokens"
          description="Most urgent first. The nightly sweep renews any token that still can be; this is where the ones it cannot show up."
        />
        <Suspense fallback={<CardSkeleton count={1} />}>
          <TokenHealth />
        </Suspense>
      </section>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Replacing an expired token</CardTitle>
          <CardDescription>
            Open Graph API Explorer, select the Page, grant{" "}
            <code className="font-mono text-xs">pages_read_engagement</code> and{" "}
            <code className="font-mono text-xs">read_insights</code>, then paste the token into that
            streamer&apos;s Replace token field. Press Extend token afterwards and it becomes
            non-expiring.
          </CardDescription>
        </CardHeader>
      </Card>
    </>
  );
}
