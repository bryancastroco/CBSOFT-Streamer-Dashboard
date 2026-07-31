import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * A `use server` file may export async functions and nothing else.
 *
 * This exists because of an outage. `actions.ts` exported one constant:
 *
 *     export const idleState: ActionState = { status: "idle", message: null };
 *
 * Next rejects that at module evaluation — "A use server file can only export
 * async functions, found object" — before any line of the module runs. Every
 * page importing it then failed to render, which took out the streamer roster,
 * streamer detail, post detail and video detail at once.
 *
 * Nothing caught it. It typechecks, it lints, the production build compiles
 * cleanly, and the failure appears only when a route is requested. The error
 * surfaced as a digest with no message, and finding it needed the production
 * log.
 *
 * So the rule is checked structurally, in the one place it can be.
 */

const SKIP = new Set(["node_modules", ".git", ".next", ".vercel", "dist", "coverage"]);

function sourceFiles(directory: string, collected: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    if (SKIP.has(entry)) continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, collected);
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) collected.push(path);
  }
  return collected;
}

/**
 * True only when the file opens with the directive.
 *
 * Matching the string anywhere would flag any file that merely mentions
 * `use server` in a comment — which the shared action-state module does, at
 * length, explaining this very rule.
 */
function isUseServerModule(source: string): boolean {
  const firstCode = source
    .split("\n")
    .map((line) => line.trim())
    .find(
      (line) =>
        line.length > 0 &&
        !line.startsWith("//") &&
        !line.startsWith("/*") &&
        !line.startsWith("*"),
    );

  return firstCode === '"use server";' || firstCode === "'use server';";
}

const files = sourceFiles(join(process.cwd(), "src"));
const actionModules = files.filter((path) => isUseServerModule(readFileSync(path, "utf8")));

describe("use server modules export only async functions", () => {
  it("finds the action modules, so an empty sweep cannot pass vacuously", () => {
    expect(actionModules.length).toBeGreaterThan(0);
  });

  it.each(actionModules.map((p) => relative(process.cwd(), p).split(sep).join("/")))(
    "%s",
    (relativePath) => {
      const source = readFileSync(join(process.cwd(), relativePath), "utf8");

      const offenders = source
        .split("\n")
        .map((line, index) => ({ line: line.trim(), number: index + 1 }))
        .filter(({ line }) => line.startsWith("export "))
        // `export type` and `export interface` are erased before Next sees them.
        .filter(
          ({ line }) => !line.startsWith("export type") && !line.startsWith("export interface"),
        )
        .filter(({ line }) => !line.startsWith("export async function"))
        .map(({ line, number }) => `line ${number}: ${line.slice(0, 60)}`);

      expect(
        offenders,
        `${relativePath} exports something that is not an async function. ` +
          `Next throws at module evaluation and every page importing it fails to render.`,
      ).toEqual([]);
    },
  );
});
