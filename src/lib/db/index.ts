import "server-only";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { getServerEnv } from "@/config/env";
import * as schema from "@/lib/db/schema";

/**
 * Drizzle client over Supabase Postgres.
 *
 * Chosen over Prisma because it ships no query engine binary, keeps cold starts
 * low on Vercel functions, and defines the schema in TypeScript so
 * `strict` mode covers the data layer too. See docs/ARCHITECTURE.md.
 *
 * Connection notes for serverless:
 *   - `DATABASE_URL` should point at the Supabase transaction pooler (port 6543).
 *   - `prepare: false` is required by the transaction pooler.
 *   - Migrations must be run against the direct connection (port 5432).
 *
 * ## The function must run beside the database
 *
 * `vercel.json` pins `regions: ["syd1"]`, and that is not a preference — it is
 * the single largest thing governing how fast this application feels.
 *
 * Supabase is in `ap-southeast-2` (Sydney). Vercel's default region is `iad1`
 * (Washington DC). Left at the default, every query here was a Pacific round
 * trip: measured against production, one trivial query cost **210ms** warm, and
 * a cold request 1,330ms because the TLS handshake and authentication are
 * several round trips of their own.
 *
 * Nothing about that is visible in a query plan or a slow-query log — the
 * database answers in single-digit milliseconds and the time is spent in the
 * air. A page here issues twenty or more queries, so the cost was four to six
 * seconds of latency alone, and every optimisation applied to the SQL would
 * have been noise against it.
 *
 * If the Supabase project ever moves region, this pin moves with it. They are
 * one decision, and separating them silently reintroduces the whole problem.
 */

let client: ReturnType<typeof postgres> | null = null;
let database: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function getDb() {
  if (database) return database;

  const { DATABASE_URL } = getServerEnv();

  client = postgres(DATABASE_URL, {
    prepare: false,
    max: 1,
    idle_timeout: 20,
  });

  database = drizzle(client, { schema });
  return database;
}

export type Database = ReturnType<typeof getDb>;
export { schema };
