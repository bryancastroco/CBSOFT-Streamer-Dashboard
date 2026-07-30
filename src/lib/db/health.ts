import "server-only";

import { sql } from "drizzle-orm";

import { getDb } from "@/lib/db";
import { childLogger } from "@/lib/observability/logger";

/**
 * Can this instance reach Postgres, and how quickly?
 *
 * ## Why the result is this thin
 *
 * The caller is `/api/health`, whose body may be read by anyone. So the return
 * value is a boolean and a number — never the driver's error, which routinely
 * carries the host, the database name, the role and sometimes the failing
 * statement. The reason for a failure goes to the server log, where the
 * redacting logger already handles it, and the responder says only "not
 * reachable".
 *
 * `select 1` on purpose: no table, so it cannot be affected by RLS, migrations,
 * or a permissions change, and it stays valid no matter how the schema evolves.
 */
export type DatabaseHealth = {
  reachable: boolean;
  /** Round trip in whole milliseconds, or `null` when unreachable. */
  latencyMs: number | null;
};

/** Give up rather than hold a health check open behind a hung connection. */
const PROBE_TIMEOUT_MS = 4000;

export async function checkDatabase(): Promise<DatabaseHealth> {
  const startedAt = Date.now();

  try {
    /*
     * Raced against a timer. Without this a health check inherits the driver's
     * own connect timeout, which is long enough that an uptime monitor times out
     * first and reports nothing useful — the probe has to fail faster than the
     * thing probing it.
     */
    await Promise.race([
      getDb().execute(sql`select 1`),
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error("probe timed out")), PROBE_TIMEOUT_MS),
      ),
    ]);

    return { reachable: true, latencyMs: Date.now() - startedAt };
  } catch (cause) {
    childLogger({ component: "db.health" }).error("db.health.unreachable", {
      // The message only. A driver error object can carry the connection URL.
      error: cause instanceof Error ? cause.message : "unknown",
      elapsedMs: Date.now() - startedAt,
    });

    return { reachable: false, latencyMs: null };
  }
}
