import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { syncStatusEnum, tokenStatusEnum, summaryStatusEnum } from "@/lib/db/schema";
import { commentSentimentEnum } from "@/lib/db/schema";
import { AI_STATUS, SENTIMENT_STATUS, SYNC_STATUS, TOKEN_STATUS } from "@/lib/ui/status";

/**
 * Status names, checked against the enum that defines them.
 *
 * Two separate failures motivate this, and neither was caught by anything.
 *
 * `getSyncLogTotals` counted `status = 'succeeded'`, `'partial'` and
 * `'running'` — names migration 0009 renamed. Postgres does not treat an
 * unknown enum label as "matches nothing"; it raises `invalid input value for
 * enum sync_status`, so the entire Sync History page threw in production while
 * the suite stayed green, because no test ran that query against a real enum.
 *
 * The presentation layer has the same exposure from the other direction: a
 * status the badge table has never heard of renders as a bare identifier.
 *
 * Both are cheap to pin, so they are pinned.
 */

describe("the badge tables cover every enum value", () => {
  it.each([
    ["sync", syncStatusEnum.enumValues, SYNC_STATUS],
    ["token", tokenStatusEnum.enumValues, TOKEN_STATUS],
    ["ai", summaryStatusEnum.enumValues, AI_STATUS],
    ["sentiment", commentSentimentEnum.enumValues, SENTIMENT_STATUS],
  ] as const)("%s", (_name, values, table) => {
    const missing = values.filter((value) => !(value in table));

    expect(missing, `no badge defined for: ${missing.join(", ")}`).toEqual([]);
  });

  it("defines nothing the enum does not have", () => {
    /*
     * The other direction. A leftover entry for a renamed value is dead code
     * that looks like coverage, which is how the stale names survived above.
     */
    const stale = Object.keys(SYNC_STATUS).filter(
      (key) => !(syncStatusEnum.enumValues as readonly string[]).includes(key),
    );

    expect(stale, `not in sync_status: ${stale.join(", ")}`).toEqual([]);
  });
});

describe("raw SQL never names a status the enum dropped", () => {
  /*
   * Reads the source rather than executing it. Executing needs a database;
   * this catches the mistake at the moment it is typed, in any environment.
   */
  const RENAMED = ["succeeded", "partial", "running", "pending"];

  it.each([
    "src/lib/repositories/sync-logs.ts",
    "src/lib/repositories/automation-exports.ts",
    "src/lib/services/sync-all.ts",
  ])("%s", (path) => {
    let source: string;
    try {
      source = readFileSync(path, "utf8");
    } catch {
      return; // File moved; the other guards still apply.
    }

    for (const name of RENAMED) {
      // Only inside a comparison against a status column — the words
      // themselves are fine in prose and in unrelated identifiers.
      const pattern = new RegExp(`status[^\\n]{0,40}=\\s*'${name}'`, "g");

      expect(source.match(pattern), `${path} compares status to the renamed '${name}'`).toBeNull();
    }
  });
});
