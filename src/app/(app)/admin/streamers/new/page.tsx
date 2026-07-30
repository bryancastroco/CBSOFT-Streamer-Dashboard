import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { StreamerForm } from "@/app/(app)/admin/streamers/streamer-form";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { requireAdmin } from "@/lib/auth/guards";

export const metadata: Metadata = { title: "Add streamer" };
export const dynamic = "force-dynamic";

export default async function NewStreamerPage() {
  await requireAdmin();

  return (
    <>
      <PageHeader
        title="Add streamer"
        description="Register a CBSOFT streamer and the Facebook Page they broadcast on."
        primaryAction={
          <Button asChild variant="outline" size="sm">
            <Link href="/admin/streamers">
              <ArrowLeft className="size-4" aria-hidden />
              Back
            </Link>
          </Button>
        }
      />

      <Card>
        <CardContent className="pt-6">
          <StreamerForm />
        </CardContent>
      </Card>
    </>
  );
}
