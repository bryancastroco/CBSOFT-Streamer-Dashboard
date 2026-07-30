import { Download } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * CSV download.
 *
 * A plain anchor, not a fetch-and-blob: the browser streams the response
 * straight to disk, the URL is copyable, and there is no in-memory copy of the
 * file. `download` is advisory — the route also sends
 * `Content-Disposition: attachment`, which is what actually decides.
 *
 * `href` carries the current filter query string, so the file matches the rows
 * on screen. Both sides resolve it through `lib/filters/browse`, so they cannot
 * interpret the same parameters differently.
 */
export function CsvExportLink({
  href,
  label = "Export CSV",
  disabled = false,
}: {
  href: string;
  label?: string;
  disabled?: boolean;
}) {
  if (disabled) {
    return (
      <Button variant="outline" size="sm" disabled>
        <Download className="size-4" aria-hidden />
        {label}
      </Button>
    );
  }

  return (
    <Button asChild variant="outline" size="sm">
      <a href={href} download>
        <Download className="size-4" aria-hidden />
        {label}
      </a>
    </Button>
  );
}
