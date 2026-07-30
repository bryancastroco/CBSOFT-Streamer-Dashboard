import { randomBytes } from "node:crypto";

/**
 * Test environment.
 *
 * `src/config/env.ts` validates the whole contract at once and caches it, so a
 * test touching any server module needs a complete, valid environment. These
 * are throwaway values generated per run — none is a real credential, and the
 * encryption key is fresh each time so no ciphertext can outlive a run.
 */
// NODE_ENV is set to "test" by Vitest and is typed read-only by Next.js, so it
// is deliberately not assigned here.
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test-project.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
process.env.DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/postgres";
process.env.META_APP_ID = "1234567890";
process.env.META_APP_SECRET = "test-meta-app-secret";
process.env.META_GRAPH_API_VERSION = "v25.0";
process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("hex");
process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
process.env.AI_PROVIDER = "anthropic";
process.env.CRON_SECRET = randomBytes(32).toString("base64url");
process.env.N8N_API_SECRET = randomBytes(32).toString("base64url");
process.env.GOOGLE_SHEETS_EXPORT_ENABLED = "false";
