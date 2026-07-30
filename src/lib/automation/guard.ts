import "server-only";

import { findTokenMaterial } from "@/lib/automation/token-material";
import { childLogger } from "@/lib/observability/logger";
import { authenticateMachineRequest } from "@/lib/security/machine-auth";
import { RateLimiter, rateLimitHeaders, type RateLimitRule } from "@/lib/security/rate-limit";

/**
 * The gate every `/api/automation/*` endpoint passes through.
 *
 * Three checks in a fixed order, and the order is the point:
 *
 * 1. **Authenticate** with `N8N_API_SECRET`, compared in constant time. An
 *    unauthenticated caller is rejected before it can consume a rate-limit slot,
 *    so a stranger cannot lock out the real workflow by spamming the endpoint.
 * 2. **Rate limit**, keyed per endpoint class. Writes are far scarcer than
 *    reads, because a write spends Meta quota and can spend Anthropic tokens.
 * 3. **Refuse token material** in the body. See `token-material.ts` — n8n has no
 *    business holding a Page token, and a request carrying one is a
 *    misconfiguration worth failing loudly.
 *
 * Nothing here grants access to a Page token. It authenticates the *caller*; the
 * token stays inside `withStreamerToken` on the server regardless of who asked.
 */

/**
 * Two classes of endpoint, two budgets.
 *
 * A nightly workflow needs one sync-all and a handful of export reads per run,
 * so these are generous for correct use and tight against a runaway schedule.
 * Polling a run's status is a read, and the documented workflow polls it in a
 * loop — hence the wider read budget.
 */
export const AUTOMATION_RATE_LIMITS = {
  /** Endpoints that start work. */
  write: { limit: 10, windowMs: 60_000 } satisfies RateLimitRule,
  /** Exports and run-status polling. */
  read: { limit: 120, windowMs: 60_000 } satisfies RateLimitRule,
} as const;

export type AutomationEndpointKind = keyof typeof AUTOMATION_RATE_LIMITS;

/**
 * One limiter for the whole process.
 *
 * Module-level, so it survives between requests on a warm instance. On a
 * serverless platform the counters are per instance — see the note in
 * `rate-limit.ts` on why that is accepted.
 */
const limiter = new RateLimiter();

/** Opportunistic cleanup, roughly every 50 requests. */
let requestsSincePrune = 0;
function maybePrune(): void {
  requestsSincePrune += 1;
  if (requestsSincePrune >= 50) {
    requestsSincePrune = 0;
    limiter.prune();
  }
}

export type AutomationGuardResult =
  { ok: true; headers: Record<string, string> } | { ok: false; response: Response };

/** The error shape every automation endpoint returns. Stable, and terse. */
export function automationError(
  status: number,
  code: string,
  message: string,
  extra?: Record<string, unknown>,
  headers: Record<string, string> = {},
): Response {
  return Response.json(
    { ok: false, error: code, message, ...(extra ?? {}) },
    { status, headers: { "cache-control": "no-store", ...headers } },
  );
}

export function automationOk(
  data: Record<string, unknown>,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return Response.json(
    { ok: true, ...data },
    { status, headers: { "cache-control": "no-store", ...headers } },
  );
}

/**
 * Authenticate and rate-limit. Returns headers the route must echo on success.
 *
 * The rate-limit key is the endpoint class rather than the caller, because there
 * is exactly one credential: `N8N_API_SECRET` identifies "the n8n workflow", not
 * a particular workflow. Keying on a client IP would be worse than useless — a
 * cloud-hosted n8n changes address, and an attacker chooses theirs.
 */
export function guardAutomationRequest(
  request: Request,
  kind: AutomationEndpointKind,
): AutomationGuardResult {
  const log = childLogger({ component: "automation.guard", kind });

  const auth = authenticateMachineRequest(request, "n8n");

  if (!auth.ok) {
    // The reason is logged, not returned: telling an unauthenticated caller
    // whether the secret was missing or merely wrong is free reconnaissance.
    log.warn("automation.auth.rejected", { status: auth.status, reason: auth.reason });

    return {
      ok: false,
      response:
        auth.status === 500
          ? automationError(
              503,
              "not_configured",
              "Automation is not configured on this deployment.",
            )
          : automationError(401, "unauthorized", "Valid bearer credentials are required."),
    };
  }

  maybePrune();

  const decision = limiter.check(`n8n:${kind}`, AUTOMATION_RATE_LIMITS[kind]);
  const headers = rateLimitHeaders(decision);

  if (!decision.allowed) {
    log.warn("automation.rate_limited", { retryAfterSeconds: decision.retryAfterSeconds });

    return {
      ok: false,
      response: automationError(
        429,
        "rate_limited",
        `Too many automation requests. Retry in ${decision.retryAfterSeconds}s.`,
        { retry_after_seconds: decision.retryAfterSeconds },
        headers,
      ),
    };
  }

  return { ok: true, headers };
}

export type BodyResult<T> = { ok: true; body: T } | { ok: false; response: Response };

/**
 * Read and screen a JSON request body.
 *
 * An absent or empty body is valid — every automation write has usable defaults,
 * and requiring `{}` would be a pointless trap for an n8n node configured
 * without a body. Malformed JSON is a `400`, and so is anything carrying
 * credential material.
 */
export async function readAutomationBody(
  request: Request,
  headers: Record<string, string>,
): Promise<BodyResult<unknown>> {
  let parsed: unknown = {};

  const raw = await request.text();

  if (raw.trim().length > 0) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {
        ok: false,
        response: automationError(
          400,
          "invalid_json",
          "The request body is not valid JSON.",
          undefined,
          headers,
        ),
      };
    }
  }

  const findings = findTokenMaterial(parsed);

  if (findings.length > 0) {
    // The paths are returned so the workflow can be fixed; the values never are.
    childLogger({ component: "automation.guard" }).error("automation.token_material_refused", {
      paths: findings.map((finding) => finding.path),
    });

    return {
      ok: false,
      response: automationError(
        400,
        "token_material_refused",
        "This endpoint never accepts Facebook Page tokens or other credentials. " +
          "The application decrypts Page tokens server-side and calls Meta itself. " +
          "Remove the offending fields and retry.",
        { fields: findings },
        headers,
      ),
    };
  }

  return { ok: true, body: parsed };
}

/** Exposed for tests, so a suite can start from a known state. */
export function resetAutomationRateLimiterForTests(): void {
  limiter.reset();
  requestsSincePrune = 0;
}
