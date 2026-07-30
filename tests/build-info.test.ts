import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { APP_NAME, APP_VERSION, deploymentEnvironment } from "@/lib/observability/build-info";

/**
 * Deployment identity, and the health endpoint's promise not to leak.
 *
 * `APP_VERSION` is a literal rather than an import of `package.json`, so the two
 * can drift. This is the test that stops that.
 */

const manifest = JSON.parse(await readFile(path.join(process.cwd(), "package.json"), "utf8")) as {
  name: string;
  version: string;
};

describe("build info agrees with package.json", () => {
  it("matches the package name", () => {
    expect(APP_NAME).toBe(manifest.name);
  });

  it("matches the package version", () => {
    expect(APP_VERSION).toBe(manifest.version);
  });

  it("exposes a semver-shaped version", () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("deploymentEnvironment", () => {
  const original = { ...process.env };

  afterEach(() => {
    process.env = { ...original };
  });

  it("trusts VERCEL_ENV when it is set", () => {
    for (const value of ["production", "preview", "development"] as const) {
      process.env["VERCEL_ENV"] = value;
      expect(deploymentEnvironment()).toBe(value);
    }
  });

  it("reports a preview deployment as preview, not production", () => {
    /*
     * The case that motivates the whole function: a preview build also runs with
     * NODE_ENV=production, so NODE_ENV alone would label every preview as
     * production and make the health endpoint useless for telling them apart.
     */
    process.env["VERCEL_ENV"] = "preview";
    (process.env as Record<string, string>).NODE_ENV = "production";

    expect(deploymentEnvironment()).toBe("preview");
  });

  it("falls back to NODE_ENV off Vercel", () => {
    delete process.env["VERCEL_ENV"];
    (process.env as Record<string, string>).NODE_ENV = "production";
    expect(deploymentEnvironment()).toBe("production");
  });

  it("ignores an unrecognised VERCEL_ENV rather than passing it through", () => {
    process.env["VERCEL_ENV"] = "staging-ish";
    (process.env as Record<string, string>).NODE_ENV = "development";
    expect(deploymentEnvironment()).toBe("development");
  });
});
