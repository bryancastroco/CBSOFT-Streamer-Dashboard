import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Source-level containment checks for architecture rules 4 and 5.
 *
 * Unit tests prove the crypto works. These prove the *boundary* holds: that no
 * future edit quietly widens where a token can travel. They read the actual
 * source tree, so they fail on the commit that introduces the leak rather than
 * whenever someone next thinks to look.
 */

const SRC = path.join(process.cwd(), "src");

async function collectFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(full)));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      files.push(full);
    }
  }

  return files;
}

function rel(file: string): string {
  return path.relative(process.cwd(), file).replaceAll("\\", "/");
}

const allFiles = await collectFiles(SRC);

describe("the encrypted token column is confined", () => {
  it("is referenced only by the schema, the streamer repository and the redactor", async () => {
    const referencing: string[] = [];

    for (const file of allFiles) {
      const source = await readFile(file, "utf8");
      if (/encryptedPageToken|encrypted_page_token/.test(source)) referencing.push(rel(file));
    }

    // Widening this list is a deliberate act that must be argued for in review.
    //
    // Two of the four entries name the column without ever reading it, which is
    // why this is an allow-list of files rather than a blanket ban on the
    // identifier:
    //
    //   - `logger.ts` names it in its redaction pattern. It exists to erase the
    //     value.
    //   - `automation/token-material.ts` names it in the deny-list of field
    //     names the automation endpoints refuse. It exists to reject the value
    //     at the door.
    //
    // Both are the opposite of a leak. Only `schema.ts` declares the column and
    // only `repositories/streamers.ts` selects it — including for a token the
    // streamer connected themselves, which is why that flow writes through this
    // repository rather than from its own service.
    expect(referencing.sort()).toEqual([
      "src/lib/automation/token-material.ts",
      "src/lib/db/schema.ts",
      "src/lib/observability/logger.ts",
      "src/lib/repositories/streamers.ts",
    ]);
  });

  it("is decrypted in exactly one place", async () => {
    const decrypting: string[] = [];

    for (const file of allFiles) {
      const source = await readFile(file, "utf8");
      // Ignore the definition itself.
      if (rel(file) === "src/lib/crypto/tokens.ts") continue;
      if (/\bdecryptToken\s*\(/.test(source)) decrypting.push(rel(file));
    }

    /*
     * Two entries, for two different credentials.
     *
     * `streamers.ts` decrypts the **Page** token — the one architecture rule 5
     * is about, and still the only file that can.
     *
     * `page-connections.ts` decrypts the **user** token held between the OAuth
     * callback and the streamer choosing a Page. It is a different secret with
     * a different lifetime: fifteen minutes, cleared the moment a Page is
     * attached, and it can only ever list the Pages that person administers.
     *
     * The rule this list enforces is not "one file" but "the file that stores a
     * credential is the only one that reads it back". Widening it past that is
     * a deliberate act to be argued for in review — a service or a route
     * appearing here means a credential has escaped its repository.
     */
    expect(decrypting.sort()).toEqual([
      "src/lib/repositories/page-connections.ts",
      "src/lib/repositories/streamers.ts",
    ]);
  });
});

describe("client components cannot reach token code", () => {
  it('keeps crypto, Graph and repository imports out of every "use client" file', async () => {
    const offenders: string[] = [];

    for (const file of allFiles) {
      const source = await readFile(file, "utf8");
      const isClient = /^\s*["']use client["']/m.test(source);
      if (!isClient) continue;

      if (
        /from ["']@\/lib\/crypto\//.test(source) ||
        /from ["']@\/lib\/meta\/(graph|token-validation)["']/.test(source) ||
        /from ["']@\/lib\/repositories\//.test(source) ||
        /from ["']@\/lib\/db/.test(source) ||
        /from ["']@\/config\/env["']/.test(source)
      ) {
        offenders.push(rel(file));
      }
    }

    expect(offenders).toEqual([]);
  });

  it("allows client components to import the pure token-status module", async () => {
    // token-status.ts is deliberately pure and shareable — it holds labels and
    // badge tones the UI needs, and receives no token.
    const source = await readFile(path.join(SRC, "lib/meta/token-status.ts"), "utf8");

    expect(source).not.toContain('import "server-only"');
    expect(source).not.toMatch(/\bprocess\.env\b/);
  });
});

describe("server-only modules are marked as such", () => {
  it("marks every module that touches secrets", async () => {
    const mustBeServerOnly = [
      "lib/crypto/tokens.ts",
      "lib/meta/graph.ts",
      "lib/meta/token-validation.ts",
      "lib/repositories/streamers.ts",
      "lib/repositories/users.ts",
      "lib/db/index.ts",
      "lib/audit/log.ts",
      "lib/api/admin-guard.ts",
      "config/env.ts",
    ];

    for (const relative of mustBeServerOnly) {
      const source = await readFile(path.join(SRC, relative), "utf8");
      expect(source, `${relative} must import "server-only"`).toContain('import "server-only"');
    }
  });
});

describe("tokens do not reach logs", () => {
  it("never logs a value that could be a token", async () => {
    const offenders: string[] = [];

    for (const file of allFiles) {
      const source = await readFile(file, "utf8");
      const logs = source.match(/console\.(log|info|warn|error|debug)\([^)]*\)/gs) ?? [];

      for (const call of logs) {
        if (/token|Token/.test(call) && !/tokenStatus|token_status|TokenCrypto/.test(call)) {
          offenders.push(`${rel(file)}: ${call.slice(0, 80)}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
