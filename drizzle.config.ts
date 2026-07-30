import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit runs outside Next.js, so it reads `process.env` directly.
 * Point `DATABASE_URL` at the DIRECT Supabase connection (port 5432) when
 * running migrations — the transaction pooler cannot execute DDL reliably.
 */
export default defineConfig({
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
  strict: true,
  verbose: true,
});
