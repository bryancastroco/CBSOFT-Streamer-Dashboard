import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireAdmin } from "@/lib/auth/guards";

export const metadata: Metadata = { title: "Admin" };

const adminAreas = [
  {
    title: "Users & roles",
    phase: 2,
    href: "/admin/users",
    description:
      "Review every account, promote or demote between Admin and Viewer, and read the audit trail.",
  },
  {
    title: "Streamers",
    phase: 3,
    href: "/admin/streamers",
    description:
      "Add, edit, disable and delete streamers. Manage Page tokens, check token health and queue a manual sync.",
  },
  {
    title: "Page connection (OAuth)",
    phase: 4,
    href: null,
    description:
      "Connect a Page via server-side OAuth instead of pasting a token by hand. Tokens stay encrypted either way.",
  },
  {
    title: "Sync logs",
    phase: 11,
    href: "/admin/sync-logs",
    description:
      "Every synchronisation run with its status, duration and counters. Per-streamer detail lives on each streamer's page.",
  },
];

export default async function AdminPage() {
  await requireAdmin();

  return (
    <>
      <PageHeader
        title="Admin"
        description="Administration for users, Facebook Page connections and synchronisation jobs."
      />

      {/*
       * The notice that used to sit here promised the sync engine "arrives in
       * Phase 5". It arrived; it has been collecting nightly for weeks. A
       * banner announcing that a live feature is still to come is worse than no
       * banner — it invites an operator to disbelieve what the screens below
       * are telling them.
       */}
      <div className="grid gap-4 sm:grid-cols-2">
        {adminAreas.map((area) => (
          <Card key={area.title} className="flex flex-col">
            <CardHeader>
              <div className="flex items-start justify-between gap-2">
                <CardTitle className="text-base">{area.title}</CardTitle>
                <Badge variant={area.href ? "default" : "secondary"}>
                  {area.href ? "Available" : `Phase ${area.phase}`}
                </Badge>
              </div>
              <CardDescription>{area.description}</CardDescription>
            </CardHeader>
            {area.href ? (
              <CardContent className="mt-auto">
                <Button asChild size="sm" variant="outline">
                  <Link href={area.href}>
                    Open
                    <ArrowRight className="size-4" aria-hidden />
                  </Link>
                </Button>
              </CardContent>
            ) : null}
          </Card>
        ))}
      </div>
    </>
  );
}
