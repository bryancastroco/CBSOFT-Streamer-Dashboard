import { CircleAlert, CircleCheck, CircleSlash } from "lucide-react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { SettingRow, SettingsSection } from "@/lib/config/settings-view";

/**
 * Configuration, rendered so a reader can act on it.
 *
 * Three things every row carries, because a settings screen that omits any of
 * them sends someone hunting:
 *
 *   - **What it is now.** For a secret that is "Set" or "Not set", never the
 *     value; there is no path from here to the string.
 *   - **Where it comes from.** Every value on these screens is an environment
 *     variable, so the row names it. Without that, an admin who wants to change
 *     one has nowhere to go.
 *   - **What it does**, when the label alone would not tell them.
 */

function StatusIcon({ row }: { row: SettingRow }) {
  if (row.kind === "value") return null;

  if (row.present) {
    return (
      <CircleCheck className="size-4 shrink-0 text-emerald-600 dark:text-emerald-500" aria-hidden />
    );
  }

  // A missing secret is a fault; a disabled flag is a choice. Different icons.
  return row.kind === "secret" ? (
    <CircleAlert className="size-4 shrink-0 text-destructive" aria-hidden />
  ) : (
    <CircleSlash className="size-4 shrink-0 text-muted-foreground" aria-hidden />
  );
}

function Row({ row }: { row: SettingRow }) {
  const display =
    row.kind === "secret" ? (row.present ? "Set" : "Not set") : (row.value ?? "Not set");

  return (
    <div className="grid gap-1 border-b px-4 py-3 last:border-b-0 sm:grid-cols-[minmax(0,14rem)_1fr] sm:items-baseline sm:gap-4">
      <div className="min-w-0">
        <p className="text-sm font-medium">{row.label}</p>
        <Tooltip>
          <TooltipTrigger asChild>
            <code className="cursor-help font-mono text-[11px] break-all text-muted-foreground">
              {row.source}
            </code>
          </TooltipTrigger>
          <TooltipContent className="max-w-72">
            Set in your hosting environment — Vercel → Settings → Environment Variables — and
            applied on the next deployment.
          </TooltipContent>
        </Tooltip>
      </div>

      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <StatusIcon row={row} />
          <span
            className={
              row.kind === "secret" && !row.present
                ? "text-sm font-medium text-destructive"
                : "text-sm break-all"
            }
          >
            {display}
          </span>
        </div>
        {row.hint ? <p className="mt-1 text-xs text-muted-foreground">{row.hint}</p> : null}
      </div>
    </div>
  );
}

export function SettingsCard({ section }: { section: SettingsSection }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{section.title}</CardTitle>
        <CardDescription>{section.description}</CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        <div className="border-t">
          {section.rows.map((row) => (
            <Row key={row.label} row={row} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Shown when the environment itself failed to parse.
 *
 * These screens are the ones an operator opens *because* something is wrong, so
 * a missing variable has to render as a readable list rather than as the crash
 * `getServerEnv()` would otherwise throw.
 */
export function ConfigurationBroken({ missingKeys }: { missingKeys: string[] }) {
  return (
    <Card className="border-destructive/50">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base text-destructive">
          <CircleAlert className="size-4" aria-hidden />
          Configuration is incomplete
        </CardTitle>
        <CardDescription>
          These environment variables are missing or invalid, so parts of the application cannot
          run. Set them in Vercel → Settings → Environment Variables, then redeploy.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="space-y-1">
          {missingKeys.map((key) => (
            <li key={key} className="font-mono text-xs">
              {key}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
