/**
 * Create (or promote) the first administrator.
 *
 *   npm run seed:admin -- --email you@cbsoft.example --name "Your Name"
 *
 * Reads secrets from `.env.local` via Node's `--env-file`. Deliberately kept
 * free of `@/` imports so it runs under plain Node type-stripping, with no
 * bundler and no Next.js runtime.
 *
 * Behaviour:
 *   - No such auth user  → creates one with a generated password, marks the
 *                          email confirmed, then promotes the profile to admin.
 *   - Auth user exists   → promotes the existing profile to admin. The password
 *                          is left alone.
 *
 * The generated password is printed ONCE and never stored anywhere. Change it
 * on first sign-in.
 *
 * This is the only path by which an admin comes into existence. Signing up
 * always yields a viewer, so this script is the root of trust for the
 * workspace — run it against production exactly once.
 */

import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";

import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";

type Args = { email: string; name: string | null; password: string | null };

function fail(message: string): never {
  console.error(`\n  ✖ ${message}\n`);
  process.exit(1);
}

function readArgs(): Args {
  const { values } = parseArgs({
    options: {
      email: { type: "string" },
      name: { type: "string" },
      password: { type: "string" },
    },
    allowPositionals: false,
  });

  const email = values.email?.trim().toLowerCase();

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    fail('Pass a valid address, e.g. --email "you@cbsoft.example"');
  }

  return {
    email,
    name: values.name?.trim() || null,
    password: values.password ?? null,
  };
}

function readEnv(): { supabaseUrl: string; serviceRoleKey: string; databaseUrl: string } {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const databaseUrl = process.env.DATABASE_URL;

  const missing = [
    !supabaseUrl && "NEXT_PUBLIC_SUPABASE_URL",
    !serviceRoleKey && "SUPABASE_SERVICE_ROLE_KEY",
    !databaseUrl && "DATABASE_URL",
  ].filter((value): value is string => typeof value === "string");

  if (missing.length > 0) {
    fail(
      `Missing environment variables: ${missing.join(", ")}\n` +
        "    Copy .env.example to .env.local and fill it in first.",
    );
  }

  return {
    supabaseUrl: supabaseUrl as string,
    serviceRoleKey: serviceRoleKey as string,
    databaseUrl: databaseUrl as string,
  };
}

/** 32 bytes of entropy, printed once. */
function generatePassword(): string {
  return randomBytes(24).toString("base64url");
}

async function main(): Promise<void> {
  const args = readArgs();
  const env = readEnv();

  const auth = createClient(env.supabaseUrl, env.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const sql = postgres(env.databaseUrl, { max: 1, prepare: false, onnotice: () => {} });

  try {
    // ---------------------------------------------------------------------
    // 1. Find or create the auth user
    // ---------------------------------------------------------------------
    const existingRows = await sql<{ id: string }[]>`
      SELECT id FROM auth.users WHERE lower(email) = ${args.email} LIMIT 1
    `;

    let userId = existingRows[0]?.id ?? null;
    let generatedPassword: string | null = null;

    if (userId) {
      console.log(`  • Auth user already exists for ${args.email}`);
    } else {
      generatedPassword = args.password ?? generatePassword();

      const { data, error } = await auth.auth.admin.createUser({
        email: args.email,
        password: generatedPassword,
        email_confirm: true,
        user_metadata: args.name ? { full_name: args.name } : {},
      });

      if (error || !data.user) {
        fail(`Could not create the auth user: ${error?.message ?? "unknown error"}`);
      }

      userId = data.user.id;
      console.log(`  • Created auth user ${args.email}`);
    }

    // ---------------------------------------------------------------------
    // 2. Ensure the profile row exists
    //
    // The `on_auth_user_created` trigger normally does this. Upserting here as
    // well means the script still works if migration 0001 has not been applied
    // to this database yet.
    // ---------------------------------------------------------------------
    await sql`
      INSERT INTO public.users (id, email, full_name, role)
      VALUES (${userId}, ${args.email}, ${args.name}, 'viewer')
      ON CONFLICT (id) DO NOTHING
    `;

    // ---------------------------------------------------------------------
    // 3. Promote to admin, and audit it in the same transaction
    // ---------------------------------------------------------------------
    const [promoted] = await sql.begin(async (tx) => {
      const before = await tx<{ role: string }[]>`
        SELECT role FROM public.users WHERE id = ${userId} FOR UPDATE
      `;

      const previousRole = before[0]?.role ?? "viewer";

      const updated = await tx<{ id: string; email: string; role: string }[]>`
        UPDATE public.users
        SET role = 'admin',
            full_name = COALESCE(${args.name}, full_name)
        WHERE id = ${userId}
        RETURNING id, email, role
      `;

      if (previousRole !== "admin") {
        await tx`
          INSERT INTO public.audit_logs (user_id, action, entity_type, entity_id, metadata_json)
          VALUES (
            ${userId}, 'user.role_changed', 'user', ${userId},
            ${sql.json({
              targetEmail: args.email,
              previousRole,
              newRole: "admin",
              source: "seed-admin script",
            })}
          )
        `;
      }

      return updated;
    });

    if (!promoted) {
      fail("Promotion did not return a row — check that migration 0000 has been applied.");
    }

    // ---------------------------------------------------------------------
    // 4. Report
    // ---------------------------------------------------------------------
    console.log("\n  ✔ Administrator ready\n");
    console.log(`    Email : ${promoted.email}`);
    console.log(`    Role  : ${promoted.role}`);

    if (generatedPassword) {
      console.log(`    Password: ${generatedPassword}`);
      console.log("\n  This password is shown once and is not stored. Change it after signing in.");
    } else {
      console.log("\n  Existing account promoted. Its password is unchanged.");
    }

    console.log("\n  Sign in at /login\n");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : "Unexpected failure");
});
