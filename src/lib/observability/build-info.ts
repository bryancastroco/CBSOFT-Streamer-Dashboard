/**
 * Identity of the running deployment.
 *
 * Safe for a public response body: a name, a version and a coarse environment
 * label. Nothing here is derived from a secret, and nothing here should ever be.
 *
 * Deliberately not `server-only` — a Client Component may want to render the
 * version in a footer, and none of these values are sensitive.
 */

export const APP_NAME = "cbsoft-streamer-dashboard";

/**
 * Kept in step with `package.json` by a test rather than by memory.
 *
 * Importing `package.json` here would work in Node but drags the whole manifest
 * into any bundle that touches this module, so the value is a literal and
 * `tests/build-info.test.ts` asserts the two agree.
 */
export const APP_VERSION = "0.1.0";

export type DeploymentEnvironment = "development" | "preview" | "production" | "test";

/**
 * Which deployment this is.
 *
 * `VERCEL_ENV` is authoritative when present — Vercel sets it to `production`,
 * `preview` or `development`, and it is the only signal that distinguishes a
 * preview deployment from production. A preview build has `NODE_ENV=production`
 * too, so `NODE_ENV` alone would report every preview as production and make a
 * health check useless for telling them apart.
 */
export function deploymentEnvironment(): DeploymentEnvironment {
  const vercelEnv = process.env["VERCEL_ENV"];

  if (vercelEnv === "production" || vercelEnv === "preview" || vercelEnv === "development") {
    return vercelEnv;
  }

  if (process.env.NODE_ENV === "test") return "test";
  if (process.env.NODE_ENV === "production") return "production";

  return "development";
}
