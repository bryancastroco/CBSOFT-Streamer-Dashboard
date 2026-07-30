import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * The navigation-level loading state for every authenticated screen.
 *
 * This covers the gap between clicking a nav link and the new page's own
 * Suspense boundaries taking over. Each screen additionally wraps its data in a
 * Suspense boundary of its own, so a filter change re-renders only the table
 * rather than blanking the whole page.
 */
export default function AppLoading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading…</span>

      <div className="space-y-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-full max-w-xl" />
      </div>

      <Skeleton className="h-16 w-full rounded-lg" />

      <Card>
        <CardContent className="space-y-2 py-4">
          {Array.from({ length: 8 }, (_, index) => (
            <Skeleton key={index} className="h-8 w-full" />
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
