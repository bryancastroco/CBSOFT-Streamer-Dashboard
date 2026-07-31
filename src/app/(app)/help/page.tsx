import type { Metadata } from "next";
import {
  ExternalLink,
  KeyRound,
  LifeBuoy,
  Plug,
  RefreshCw,
  Rocket,
  ShieldCheck,
  Table2,
  UserPlus,
  Wrench,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { PageHeader, SectionHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { requireUser } from "@/lib/auth/guards";

export const metadata: Metadata = { title: "Help and documentation" };

/**
 * Where the documentation lives.
 *
 * The guides are markdown in the repository rather than pages served by this
 * application, so these are external links and are marked as such. Pointing at
 * the repository is honest about where the answer is; rendering the markdown
 * in-app would create a second copy to keep current, and a stale copy of a
 * troubleshooting guide is worse than a link to a fresh one.
 *
 * Paths are relative to the default branch. If the repository moves, this
 * constant is the only thing to change.
 */
const REPO = "https://github.com/bryancastroco/CBSOFT-Streamer-Dashboard/blob/main";

type HelpLink = {
  title: string;
  description: string;
  doc: string;
  icon: LucideIcon;
};

const GETTING_STARTED: HelpLink[] = [
  {
    title: "Getting started",
    description:
      "What the system does, how the pieces fit together, and the vocabulary the rest of the documentation uses.",
    doc: "README.md",
    icon: Rocket,
  },
  {
    title: "Add a streamer",
    description:
      "Registering a Facebook Page, what the streamer code is for, and what happens on the first synchronisation.",
    doc: "docs/META-API-SETUP.md",
    icon: UserPlus,
  },
  {
    title: "Generate a Page token",
    description:
      "Getting a long-lived Page access token from the Graph API Explorer, and why a User token will not do.",
    doc: "docs/META-API-SETUP.md",
    icon: KeyRound,
  },
  {
    title: "Required Facebook permissions",
    description:
      "The four permissions a Page token needs. read_insights is the one most often missed — without it the sync succeeds and every insight comes back empty.",
    doc: "docs/META-API-SETUP.md",
    icon: ShieldCheck,
  },
  {
    title: "Replacing a token",
    description:
      "Replacing a token that has expired or been revoked, and how tokens are protected while stored.",
    doc: "docs/PAGE-TOKENS.md",
    icon: RefreshCw,
  },
];

const TROUBLESHOOTING: HelpLink[] = [
  {
    title: "Meta API troubleshooting",
    description:
      "What each Graph error code means and what to do about it, including the rate limit that applies per app rather than per Page.",
    doc: "docs/META-API-SETUP.md",
    icon: Wrench,
  },
  {
    title: "AI summary troubleshooting",
    description:
      "Why a summary did not regenerate — usually because the comments did not change — and how the hash gate works.",
    doc: "docs/ANTHROPIC-SETUP.md",
    icon: LifeBuoy,
  },
  {
    title: "Production troubleshooting",
    description:
      "Symptom-first diagnosis for build failures, stuck sync runs, 401s from n8n, and exports that reach nothing.",
    doc: "docs/PRODUCTION-TROUBLESHOOTING.md",
    icon: Wrench,
  },
];

const INTEGRATIONS: HelpLink[] = [
  {
    title: "n8n setup",
    description:
      "The production workflow node by node: the poll loop, the seven export branches, and the credentials it needs.",
    doc: "docs/N8N-PRODUCTION-WORKFLOW.md",
    icon: Plug,
  },
  {
    title: "Google Sheets setup",
    description:
      "Tab layout, the unique matching column for each tab, and how the upsert avoids creating duplicate rows.",
    doc: "docs/GOOGLE-SHEETS.md",
    icon: Table2,
  },
  {
    title: "Vercel deployment",
    description:
      "Project settings, environment variables per target, cron limits, and how to verify a deployment.",
    doc: "docs/VERCEL-DEPLOYMENT.md",
    icon: Rocket,
  },
  {
    title: "Security and secret rotation",
    description:
      "Where every secret lives, which are safe to rotate routinely, and the one that orphans every stored token if rotated carelessly.",
    doc: "docs/SECURITY-AND-SECRET-ROTATION.md",
    icon: ShieldCheck,
  },
];

function HelpGroup({ title, links }: { title: string; links: HelpLink[] }) {
  return (
    <section className="space-y-3">
      <SectionHeader title={title} />
      <ul className="grid gap-3 sm:grid-cols-2">
        {links.map((link) => {
          const Icon = link.icon;

          return (
            <li key={link.title}>
              <a
                href={`${REPO}/${link.doc}`}
                target="_blank"
                rel="noopener noreferrer"
                className="block h-full rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <Card className="h-full transition-colors hover:border-border-strong">
                  <CardContent className="flex gap-3 p-4">
                    <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-brand-subtle text-accent-foreground">
                      <Icon className="size-4" aria-hidden />
                    </span>
                    <div className="min-w-0 space-y-1">
                      <p className="flex items-center gap-1.5 text-sm font-medium">
                        {link.title}
                        <ExternalLink
                          className="size-3 shrink-0 text-muted-foreground"
                          aria-hidden
                        />
                        <span className="sr-only">(opens in a new tab)</span>
                      </p>
                      <p className="text-sm text-muted-foreground">{link.description}</p>
                    </div>
                  </CardContent>
                </Card>
              </a>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export default async function HelpPage() {
  // Readable by both roles: nothing here is privileged, and a viewer who
  // cannot find the setup guide is a support request waiting to happen.
  await requireUser();

  return (
    <>
      <PageHeader
        title="Help and documentation"
        description="Setup guides, troubleshooting and secret rotation. The guides live in the project repository and open in a new tab."
        showBreadcrumbs={false}
      />

      <HelpGroup title="Getting started" links={GETTING_STARTED} />
      <HelpGroup title="Troubleshooting" links={TROUBLESHOOTING} />
      <HelpGroup title="Integrations and operations" links={INTEGRATIONS} />

      {/*
       * Required, and placed where it will be read rather than in a footer
       * nobody scrolls to. The product reads Meta's API; it is not Meta's
       * product, and saying so plainly protects both this project and anyone
       * who might otherwise mistake one for the other.
       */}
      <Card className="bg-muted/40 shadow-none">
        <CardContent className="p-4">
          <h2 className="sr-only">Disclaimer</h2>
          <p className="text-sm text-muted-foreground">
            This application uses the Meta Graph API but is not affiliated with or endorsed by Meta.
            Facebook is a trademark of Meta Platforms, Inc.
          </p>
        </CardContent>
      </Card>
    </>
  );
}
