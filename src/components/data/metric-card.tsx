import Link from "next/link";
import type { LucideIcon } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * One dashboard figure.
 *
 * `value` is a string rather than a number so a card can say `—` for something
 * that was never measured. A card that prints `0` for "not reported" is the
 * exact mistake `lib/meta/insight-display` exists to prevent, and the dashboard
 * is the loudest place to make it.
 */
/**
 * `success` exists because the set had no way to say "this is good news".
 *
 * Growth is the first metric here where up is unambiguously positive, and
 * rendering it in the same neutral grey as everything else made a card that had
 * something to report look like one that did not.
 */
export type MetricTone = "default" | "success" | "warning" | "danger" | "muted";

/*
 * The design tokens, not the Tailwind palette. `warning` and `danger` predate
 * the tokens and are left as they are rather than restyled in passing — a
 * visual change to every existing dashboard card does not belong in a commit
 * about follower growth.
 */
const TONE_CLASSES: Record<MetricTone, string> = {
  default: "",
  success: "border-success/30",
  warning: "border-amber-500/40",
  danger: "border-destructive/50",
  muted: "",
};

const VALUE_CLASSES: Record<MetricTone, string> = {
  default: "",
  success: "text-success-foreground",
  warning: "text-amber-600 dark:text-amber-500",
  danger: "text-destructive",
  muted: "text-muted-foreground",
};

export function MetricCard({
  label,
  value,
  hint,
  icon: Icon,
  tone = "default",
  href,
}: {
  label: string;
  value: string;
  /** One line under the figure — units, caveats, or what is not included. */
  hint?: string | undefined;
  icon?: LucideIcon | undefined;
  tone?: MetricTone;
  /** Makes the whole card a link to the screen that explains the figure. */
  href?: string | undefined;
}) {
  const body = (
    <Card
      className={cn(
        "h-full gap-2 transition-colors",
        TONE_CLASSES[tone],
        href && "hover:bg-muted/40",
      )}
    >
      <CardHeader className="pb-0">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-xs font-medium text-muted-foreground">{label}</CardTitle>
          {Icon ? <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden /> : null}
        </div>
      </CardHeader>
      <CardContent>
        <p className={cn("text-2xl font-semibold tabular-nums", VALUE_CLASSES[tone])}>{value}</p>
        {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
      </CardContent>
    </Card>
  );

  if (!href) return body;

  return (
    <Link
      href={href}
      className="block rounded-xl focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      {body}
    </Link>
  );
}

/** Responsive grid the dashboard cards sit in. */
export function MetricGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">{children}</div>;
}
