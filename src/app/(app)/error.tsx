"use client";

import { useEffect } from "react";

import { ErrorState } from "@/components/data/states";
import { PageHeader } from "@/components/layout/page-header";

/**
 * The error boundary for every authenticated screen.
 *
 * Placed on the group rather than on each page: one boundary that every screen
 * inherits cannot be forgotten when a screen is added, and the recovery is the
 * same everywhere — re-run the render.
 *
 * `error.message` is deliberately not displayed. In production Next replaces it
 * with a generic string anyway, but in development it can carry a connection
 * string or a Graph URL, and this component is reachable by any signed-in role.
 * `digest` is the handle for correlating with the server log.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The server has already logged this with full detail and redaction; this
    // is only so the browser console shows something during development.
    console.error("Screen failed to render", { digest: error.digest });
  }, [error]);

  return (
    <>
      <PageHeader title="Something went wrong" description="This screen could not be loaded." />
      <ErrorState
        description="The page failed while loading its data. This is usually temporary — try again, and if it persists check the sync status for the streamers involved."
        {...(error.digest ? { digest: error.digest } : {})}
        onRetry={reset}
      />
    </>
  );
}
