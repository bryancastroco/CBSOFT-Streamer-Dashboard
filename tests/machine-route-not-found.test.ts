import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { MACHINE_NAMESPACES } from "@/lib/auth/route-policy";
import { machineRouteNotFound } from "@/lib/automation/not-found";

/**
 * An automation path that does not exist must say so, in JSON, with 404.
 *
 * The bug this pins was found in production, not by the suite. Route access is
 * resolved by prefix, so anything under `/api/automation` is handed to Next as
 * a machine endpoint; when no route file matched, Next rendered the HTML
 * not-found page and it came back **200 text/html**.
 *
 * For a browser that is untidy. For n8n it is expensive: a typo in a base URL
 * or endpoint returns `200 OK`, the HTTP node reports success, the export node
 * finds no `rows`, and the Sheet nodes continue on error by design. The run is
 * green and the spreadsheet silently never changed.
 */

describe("the not-found response itself", () => {
  const request = new Request("https://example.test/api/automation/nope");

  it("is a 404, not a 200", async () => {
    expect(machineRouteNotFound(request, "/api/automation/nope").status).toBe(404);
  });

  it("is JSON, so a machine client can read it", async () => {
    const response = machineRouteNotFound(request, "/api/automation/nope");

    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toMatchObject({ error: "not_found" });
  });

  it("names the path that missed, so the typo is visible in the log", async () => {
    const body = await machineRouteNotFound(request, "/api/automation/expots/posts").json();

    expect(body.message).toContain("/api/automation/expots/posts");
  });

  it("is never cached, so adding the route later takes effect", () => {
    expect(machineRouteNotFound(request, "/api/n8n/typo").headers.get("cache-control")).toBe(
      "no-store",
    );
  });

  it("carries a request id, matching every other machine response", () => {
    const correlated = new Request("https://example.test/api/automation/nope", {
      headers: { "x-request-id": "n8n-run-4417" },
    });

    // The caller's id wins, so n8n and the app name the same event identically.
    expect(machineRouteNotFound(correlated, "/x").headers.get("x-request-id")).toBe("n8n-run-4417");
  });
});

describe("every machine namespace has a catch-all", () => {
  /*
   * The guard that keeps this fixed. Adding a fourth machine prefix to
   * `route-policy.ts` without a catch-all reintroduces the 200, so the policy
   * list is the source of truth rather than a hand-maintained copy.
   */
  it.each(MACHINE_NAMESPACES)("%s", (namespace) => {
    const directory = join(process.cwd(), "src", "app", namespace, "[...unmatched]");

    expect(existsSync(join(directory, "route.ts")), `${namespace} needs a catch-all route`).toBe(
      true,
    );
  });

  it("finds namespaces to check, so an empty list cannot pass vacuously", () => {
    expect(MACHINE_NAMESPACES.length).toBeGreaterThan(0);
  });

  it("does not shadow a real route", () => {
    /*
     * Next resolves static and dynamic segments ahead of catch-alls, so the
     * real endpoints still win. Assert they are actually present — a catch-all
     * that answered everything would be far worse than the bug it fixes.
     */
    const automation = readdirSync(join(process.cwd(), "src", "app", "api", "automation"));

    expect(automation).toContain("exports");
    expect(automation).toContain("sync-all");
    expect(automation).toContain("[...unmatched]");
  });
});
