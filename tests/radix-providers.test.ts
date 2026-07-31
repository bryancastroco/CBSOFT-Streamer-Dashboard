import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Radix primitives that need a provider ancestor must have one.
 *
 * This exists because of a bug that reached production and took the dashboard
 * with it. `Tooltip` is a bare `TooltipPrimitive.Root`, and Radix does not warn
 * when there is no `TooltipProvider` above it — it throws. The dashboard
 * renders a tooltip on each of eight metric tiles, so the page died on load and
 * showed the error boundary instead. The collapsed sidebar would have failed
 * the same way.
 *
 * Nothing caught it: it typechecks, it lints, the component tests do not render
 * a whole page, and the production build compiles happily because the failure
 * is at render time.
 *
 * So the check is structural. If a primitive is used anywhere, its provider has
 * to be mounted in a layout — which is the only place that can guarantee it
 * wraps every consumer.
 */

const PROVIDERS = [
  { use: "TooltipTrigger", provider: "TooltipProvider" },
  { use: "DropdownMenuTrigger", provider: null }, // Radix dropdown needs none.
] as const;

const SKIP = new Set(["node_modules", ".git", ".next", ".vercel", "dist", "coverage"]);

function sourceFiles(directory: string, collected: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    if (SKIP.has(entry)) continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, collected);
    else if (entry.endsWith(".tsx")) collected.push(path);
  }
  return collected;
}

const files = sourceFiles(join(process.cwd(), "src"));

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/** Files that mount a provider, and are layouts so they wrap everything. */
function layoutsMounting(provider: string): string[] {
  return files
    .filter((path) => {
      const name = relative(process.cwd(), path).split(sep).join("/");
      return name.includes("/layout.tsx") || name.endsWith("/providers.tsx");
    })
    .filter((path) => read(path).includes(`<${provider}`));
}

describe("Radix primitives have their required provider", () => {
  it.each(PROVIDERS.filter((entry) => entry.provider !== null))(
    "$use is covered by $provider",
    ({ use, provider }) => {
      const consumers = files.filter((path) => {
        const source = read(path);
        // Skip the primitive's own definition file.
        if (source.includes(`function ${provider}`)) return false;
        return source.includes(`<${use}`);
      });

      if (consumers.length === 0) return;

      const mounts = layoutsMounting(provider!);

      expect(
        mounts.length,
        `${consumers.length} file(s) render <${use}> but no layout mounts <${provider}>. ` +
          `Radix throws at render, it does not warn.`,
      ).toBeGreaterThan(0);
    },
  );

  it("mounts the tooltip provider at the root, not in a nested layout", () => {
    /*
     * The root specifically. Mounting it in the authenticated layout would
     * leave sign-in and the error pages uncovered, and those are exactly the
     * screens where a crash is hardest to diagnose.
     */
    const root = read(join(process.cwd(), "src", "app", "layout.tsx"));

    expect(root).toContain("<TooltipProvider");
  });
});
