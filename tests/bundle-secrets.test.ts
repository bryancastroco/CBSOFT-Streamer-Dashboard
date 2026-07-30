import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Nothing secret may reach the browser.
 *
 * `server-only` and the ESLint rules are the *design*: a Client Component that
 * imports `@/config/env` is a build error. This is the *verification* — it reads
 * the bytes Next actually produced and looks for anything that should not be
 * there.
 *
 * The two are not redundant. `server-only` catches an import; it does not catch
 * a secret interpolated into a string, passed as a prop from a Server Component
 * into a Client Component, or embedded in a serialised RSC payload. Those all
 * end up in `.next/static`, and only reading the output finds them.
 *
 * ## When the build is missing
 *
 * The suite runs before `next build` in `npm run verify`, so the directory may
 * not exist. Rather than fail — which would make `npm test` on a clean checkout
 * look broken — the assertions are skipped with an explanatory message. The
 * ordering in `verify` (build last) means CI does exercise them on the second
 * run, and `npm run verify:bundle` runs them against a fresh build on demand.
 */

const CLIENT_BUNDLE_DIR = path.join(process.cwd(), ".next", "static");

/** Env vars that must never appear in a client bundle, by name or by value. */
const SERVER_ONLY_ENV_KEYS = [
  "SUPABASE_SERVICE_ROLE_KEY",
  "DATABASE_URL",
  "META_APP_SECRET",
  "TOKEN_ENCRYPTION_KEY",
  "ANTHROPIC_API_KEY",
  "CRON_SECRET",
  "N8N_API_SECRET",
] as const;

/**
 * The only two values that are *allowed* to be in the bundle.
 *
 * Both are public by design — the anon key is meant to be shipped, and is
 * useless without a row-level-security policy that permits the read.
 */
const PUBLIC_ENV_KEYS = ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"] as const;

async function collectFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(full)));
    } else if (/\.(js|mjs|css|json|txt)$/.test(entry.name)) {
      files.push(full);
    }
  }

  return files;
}

async function bundleExists(): Promise<boolean> {
  try {
    return (await stat(CLIENT_BUNDLE_DIR)).isDirectory();
  } catch {
    return false;
  }
}

const hasBundle = await bundleExists();
const files = hasBundle ? await collectFiles(CLIENT_BUNDLE_DIR) : [];

const contents = await Promise.all(
  files.map(async (file) => ({
    name: path.relative(process.cwd(), file).replaceAll("\\", "/"),
    text: await readFile(file, "utf8"),
  })),
);

describe.skipIf(!hasBundle)("the client bundle carries no server secret", () => {
  it("produced files to scan", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(SERVER_ONLY_ENV_KEYS)("does not mention %s by name", (key) => {
    /*
     * The name alone is the signal worth failing on. Next inlines
     * `process.env.FOO` at build time only for `NEXT_PUBLIC_` names — so a
     * server-only name appearing in a client chunk means something reached for
     * it from the wrong side of the boundary, whether or not the value came
     * with it.
     */
    const offenders = contents.filter((file) => file.text.includes(key)).map((file) => file.name);

    expect(offenders, `${key} appears in ${offenders.join(", ")}`).toEqual([]);
  });

  it.each(SERVER_ONLY_ENV_KEYS)("does not contain the value of %s", (key) => {
    const value = process.env[key];
    // Short values would produce false positives against minified identifiers.
    if (!value || value.length < 12) return;

    const offenders = contents.filter((file) => file.text.includes(value)).map((file) => file.name);

    expect(offenders, `the value of ${key} appears in ${offenders.join(", ")}`).toEqual([]);
  });

  it("contains no Meta access token", () => {
    // The `EAA` prefix every Meta user and Page token carries.
    const pattern = /\bEAA[A-Za-z0-9_-]{20,}/;
    const offenders = contents.filter((file) => pattern.test(file.text)).map((file) => file.name);

    expect(offenders).toEqual([]);
  });

  it("contains no ciphertext envelope", () => {
    // `v1.<iv>.<tag>.<ciphertext>` — this application's own format. One in a
    // client chunk would mean an encrypted token was serialised to the browser.
    const pattern = /\bv[0-9]+\.[A-Za-z0-9+/=_-]{16,}\.[A-Za-z0-9+/=_-]{16,}\./;
    const offenders = contents.filter((file) => pattern.test(file.text)).map((file) => file.name);

    expect(offenders).toEqual([]);
  });

  it("contains no Postgres connection string", () => {
    const pattern = /postgres(ql)?:\/\/[^\s"'`]+:[^\s"'`]+@/;
    const offenders = contents.filter((file) => pattern.test(file.text)).map((file) => file.name);

    expect(offenders).toEqual([]);
  });

  it("contains no Anthropic or Supabase service key prefix", () => {
    const patterns = [/sk-ant-[A-Za-z0-9_-]{10,}/, /\bservice_role\b/];

    for (const pattern of patterns) {
      const offenders = contents.filter((file) => pattern.test(file.text)).map((file) => file.name);
      expect(offenders, `${pattern} matched in ${offenders.join(", ")}`).toEqual([]);
    }
  });

  it("is scanning real compiled output, not an empty directory", () => {
    /*
     * The counter-check. A scan that passes because there was nothing to scan
     * proves nothing, so this asserts the files really are Next's compiled
     * client chunks.
     */
    const bytes = contents.reduce((total, file) => total + file.text.length, 0);
    expect(bytes).toBeGreaterThan(100_000);

    const looksLikeNext = contents.some(
      (file) =>
        file.text.includes("__next") ||
        file.text.includes("webpack") ||
        file.text.includes("turbopack"),
    );
    expect(looksLikeNext).toBe(true);
  });

  it("does not ship a Supabase URL at all, because the browser never calls it", () => {
    /*
     * Stronger than "no secret leaked": there is no Supabase *configuration* in
     * the client bundle either.
     *
     * Sign-in and sign-out are Server Actions and session refresh happens in
     * the proxy, so `createSupabaseBrowserClient` is never imported and the
     * anon key is never inlined. That is what lets the CSP keep `connect-src`
     * at `'self'` in production.
     *
     * If a browser-side Supabase feature is ever added this will fail — which
     * is the right prompt to widen `connect-src` at the same time, rather than
     * discovering the mismatch as a console error in production.
     */
    const offenders = contents
      .filter((file) => /[a-z0-9-]+\.supabase\.co/.test(file.text))
      .map((file) => file.name);

    expect(offenders).toEqual([]);
  });

  it("keeps the public allow-list to exactly two values", () => {
    // Adding a third `NEXT_PUBLIC_` variable is a decision to publish it, and
    // should be a deliberate edit here rather than a side effect.
    expect([...PUBLIC_ENV_KEYS]).toEqual([
      "NEXT_PUBLIC_SUPABASE_URL",
      "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    ]);
  });
});

describe("the source keeps public and private configuration apart", () => {
  it("exposes only the two public values through public-env.ts", async () => {
    // The module a Client Component is allowed to import. Everything else goes
    // through `config/env.ts`, which imports `server-only`.
    const source = await readFile(path.join(process.cwd(), "src/config/public-env.ts"), "utf8");

    for (const key of SERVER_ONLY_ENV_KEYS) {
      expect(source, `public-env.ts must not mention ${key}`).not.toContain(key);
    }
  });

  it("keeps config/env.ts server-only", async () => {
    const source = await readFile(path.join(process.cwd(), "src/config/env.ts"), "utf8");
    expect(source.startsWith('import "server-only"')).toBe(true);
  });
});
