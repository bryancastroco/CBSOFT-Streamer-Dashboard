import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { readdirSync, statSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * No invisible control characters in source.
 *
 * This exists because of a real bug that cost an afternoon. A stray `\x08`
 * ended up inside a regex literal in the logger:
 *
 *     pattern: /<BS>(postgres(?:ql)?:\/\/).../gi
 *
 * It was valid TypeScript, compiled clean, linted clean, and was invisible in
 * every tool used to look at it — an editor, `grep`, and a file reader all
 * render it as nothing. The regex simply required a backspace character in its
 * input, so it never matched, and `DATABASE_URL` passwords would have gone
 * to logs unredacted with a passing test suite alongside them.
 *
 * A character that cannot be seen cannot be reviewed, so it is banned outright
 * rather than left to a reader to catch.
 */

/** Tab, newline and carriage return are the only invisibles source may contain. */
const PERMITTED = new Set([0x09, 0x0a, 0x0d]);

/**
 * `src/lib/comments/hashing.ts` uses ASCII unit (0x1f) and record (0x1e)
 * separators on purpose: they delimit fields inside the comment hash precisely
 * because they cannot occur in comment text. That is the one deliberate use,
 * and it is named here so it stays deliberate.
 */
const ALLOWED_DELIBERATE = new Map([["src/lib/comments/hashing.ts", new Set([0x1e, 0x1f])]]);

const SKIP_DIRECTORIES = new Set(["node_modules", ".git", ".next", ".vercel", "dist", "coverage"]);

const EXTENSIONS = [".ts", ".tsx", ".sql", ".mjs", ".css", ".json"];

function sourceFiles(directory: string, collected: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    if (SKIP_DIRECTORIES.has(entry)) continue;

    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      sourceFiles(path, collected);
    } else if (EXTENSIONS.some((extension) => entry.endsWith(extension))) {
      collected.push(path);
    }
  }

  return collected;
}

describe("source contains no invisible control characters", () => {
  const files = sourceFiles(process.cwd());

  it("finds files to check, so a broken walk cannot pass vacuously", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it.each(files)("%s", (path) => {
    const relativePath = relative(process.cwd(), path).split(sep).join("/");
    const permittedHere = ALLOWED_DELIBERATE.get(relativePath) ?? new Set<number>();

    const offenders = new Set<string>();
    for (const character of readFileSync(path, "utf8")) {
      const code = character.codePointAt(0) ?? 0;
      const isControl = code < 0x20 || code === 0x7f;

      if (isControl && !PERMITTED.has(code) && !permittedHere.has(code)) {
        offenders.add(`0x${code.toString(16).padStart(2, "0")}`);
      }
    }

    expect([...offenders], `${relativePath} contains invisible control characters`).toEqual([]);
  });
});
