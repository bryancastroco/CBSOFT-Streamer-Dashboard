"use client";

import { useId, useRef, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, RotateCcw, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { buildBrowseHref, type BrowseQuery } from "@/lib/filters/browse";
import {
  CONTENT_SCOPES,
  CONTENT_SCOPE_LABELS,
  PERIOD_LABELS,
  PERIOD_PRESETS,
  toIsoDate,
  type ContentScope,
  type PeriodPreset,
} from "@/lib/filters/period";
import type { SortState } from "@/lib/filters/sorting";
import { cn } from "@/lib/utils";

/**
 * The filter bar every browsable screen shares.
 *
 * Filters live in the URL, not in component state. That is what makes a filtered
 * view shareable, survivable across a refresh, undoable with the back button,
 * and — most importantly — reproducible by the CSV export, which is handed the
 * same query string.
 *
 * The text and date inputs are **uncontrolled**, keyed on the resolved value
 * from the URL. Holding them in React state would mean syncing that state back
 * from props every time the URL changed — after a Reset, a back button, or a
 * link from elsewhere — and a draft value left behind after a navigation is a
 * filter box that disagrees with the table beneath it. Keying them makes the URL
 * the single source of truth: a changed key gives a fresh input with the right
 * default.
 *
 * Native `<select>` rather than a custom listbox: it gets the platform picker on
 * a phone, and is already keyboard- and screen-reader-correct without a single
 * line of ARIA.
 */

export type FilterBarOptions = {
  /** Streamers to choose between. Identity only — no token fields exist here. */
  streamers: readonly { id: string; streamerCode: string; streamerName: string }[];
  /** Hide the posts/videos switch on screens that are already one or the other. */
  showScope?: boolean;
  /** Hide the search box on screens with nothing to search. */
  showSearch?: boolean;
  searchPlaceholder?: string;
};

/**
 * The `[&>option]` rules are load-bearing in dark mode.
 *
 * An `<option>` inherits the page's text colour but gets **no background of its
 * own** — measured in the browser, its computed `background-color` was
 * `rgba(0,0,0,0)`. The control's own `dark:bg-input/30` does not fill the popup
 * either: it resolves to a near-white at four per cent alpha, which is right for
 * a control sitting on a dark card and nothing at all behind a list.
 *
 * So the browser painted its own popup surface, and near-white option text
 * landed on it. Unreadable, only in dark mode, and only once opened — which is
 * why a full responsive pass never caught it.
 *
 * Giving the options an explicit opaque background is the fix; declaring
 * `color-scheme` is not, since `next-themes` already sets it inline.
 */
const selectClass =
  "h-8 w-full min-w-0 rounded-lg border border-border bg-background px-2 text-sm shadow-xs transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none dark:border-input dark:bg-input/30 [&>option]:bg-popover [&>option]:text-popover-foreground";

export function FilterBar<K extends string>({
  query,
  basePath,
  defaultSort,
  options,
}: {
  query: BrowseQuery<K>;
  basePath: string;
  defaultSort: SortState<K>;
  options: FilterBarOptions;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const ids = useId();

  const searchRef = useRef<HTMLInputElement>(null);
  const fromRef = useRef<HTMLInputElement>(null);
  const toRef = useRef<HTMLInputElement>(null);

  const currentSearch = query.search ?? "";
  const currentFrom = query.period.from ? toIsoDate(query.period.from) : "";
  const currentTo = query.period.to ? toIsoDate(query.period.to) : "";

  const go = (overrides: Parameters<typeof buildBrowseHref<K>>[3]) => {
    startTransition(() => {
      router.push(buildBrowseHref(basePath, query, defaultSort, overrides));
    });
  };

  /** Both bounds are sent together — a range is one filter, not two. */
  const commitRange = () => {
    go({
      period: "custom",
      from: fromRef.current?.value || null,
      to: toRef.current?.value || null,
    });
  };

  const isCustom = query.period.preset === "custom";
  const isFiltered =
    query.period.preset !== "30d" ||
    query.scope !== "all" ||
    query.streamerId !== undefined ||
    query.search !== undefined;

  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="flex flex-col gap-3 lg:flex-row lg:flex-wrap lg:items-end">
        {/* ---------------------------------------------------------------- */}
        <div className="grid gap-1.5 lg:w-40">
          <Label htmlFor={`${ids}-period`} className="text-xs text-muted-foreground">
            Period
          </Label>
          <select
            id={`${ids}-period`}
            className={selectClass}
            value={query.period.preset}
            onChange={(event) => go({ period: event.target.value as PeriodPreset })}
          >
            {PERIOD_PRESETS.map((preset) => (
              <option key={preset} value={preset}>
                {PERIOD_LABELS[preset]}
              </option>
            ))}
          </select>
        </div>

        {isCustom ? (
          <>
            <div className="grid gap-1.5 lg:w-40">
              <Label htmlFor={`${ids}-from`} className="text-xs text-muted-foreground">
                From (UTC)
              </Label>
              <Input
                key={`from-${currentFrom}`}
                id={`${ids}-from`}
                ref={fromRef}
                type="date"
                defaultValue={currentFrom}
                max={currentTo || undefined}
                onChange={commitRange}
              />
            </div>
            <div className="grid gap-1.5 lg:w-40">
              <Label htmlFor={`${ids}-to`} className="text-xs text-muted-foreground">
                To (UTC)
              </Label>
              <Input
                key={`to-${currentTo}`}
                id={`${ids}-to`}
                ref={toRef}
                type="date"
                defaultValue={currentTo}
                min={currentFrom || undefined}
                onChange={commitRange}
              />
            </div>
          </>
        ) : null}

        {/* ---------------------------------------------------------------- */}
        <div className="grid gap-1.5 lg:w-56">
          <Label htmlFor={`${ids}-streamer`} className="text-xs text-muted-foreground">
            Streamer
          </Label>
          <select
            id={`${ids}-streamer`}
            className={selectClass}
            value={query.streamerId ?? ""}
            onChange={(event) => go({ streamerId: event.target.value || null })}
          >
            <option value="">All streamers</option>
            {options.streamers.map((streamer) => (
              <option key={streamer.id} value={streamer.id}>
                {streamer.streamerCode} · {streamer.streamerName}
              </option>
            ))}
          </select>
        </div>

        {options.showScope !== false ? (
          <div className="grid gap-1.5 lg:w-44">
            <Label htmlFor={`${ids}-scope`} className="text-xs text-muted-foreground">
              Content
            </Label>
            <select
              id={`${ids}-scope`}
              className={selectClass}
              value={query.scope}
              onChange={(event) => go({ scope: event.target.value as ContentScope })}
            >
              {CONTENT_SCOPES.map((scope) => (
                <option key={scope} value={scope}>
                  {CONTENT_SCOPE_LABELS[scope]}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        {/* ---------------------------------------------------------------- */}
        {options.showSearch === false ? (
          <div className="flex-1" />
        ) : (
          <form
            className="grid flex-1 gap-1.5 lg:min-w-56"
            onSubmit={(event) => {
              event.preventDefault();
              go({ search: searchRef.current?.value.trim() || null });
            }}
          >
            <Label htmlFor={`${ids}-search`} className="text-xs text-muted-foreground">
              Search
            </Label>
            <div className="flex gap-2">
              <Input
                key={`search-${currentSearch}`}
                id={`${ids}-search`}
                ref={searchRef}
                type="search"
                name="search"
                defaultValue={currentSearch}
                placeholder={options.searchPlaceholder ?? "Search…"}
                className="flex-1"
              />
              <Button type="submit" variant="outline" size="sm" aria-label="Apply search">
                <Search className="size-4" aria-hidden />
              </Button>
            </div>
          </form>
        )}

        <div className="flex items-center gap-2">
          {isFiltered ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                startTransition(() => {
                  router.push(basePath);
                })
              }
            >
              <RotateCcw className="size-4" aria-hidden />
              Reset
            </Button>
          ) : null}
          <span
            className={cn(
              "inline-flex items-center gap-1 text-xs text-muted-foreground transition-opacity",
              pending ? "opacity-100" : "opacity-0",
            )}
            aria-live="polite"
          >
            <Loader2 className="size-3 animate-spin" aria-hidden />
            Updating…
          </span>
        </div>
      </div>

      {query.period.warning ? (
        <p role="status" className="mt-3 text-xs text-amber-600 dark:text-amber-500">
          {query.period.warning}
        </p>
      ) : null}
    </div>
  );
}
