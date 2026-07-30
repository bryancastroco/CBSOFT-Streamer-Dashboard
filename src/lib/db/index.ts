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
