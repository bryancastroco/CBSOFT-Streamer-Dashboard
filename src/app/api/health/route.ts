import { getServerEnvSafe } from "@/config/env";
import { authenticateMachineRequest } from "@/lib/security/machine-auth";
import { checkDatabase } from "@/lib/db/health";
import { APP_NAME, APP_VERSION, deploymentEnvironment } from "@/lib/observability/build-info";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/health
 *
 * Liveness and readiness for Vercel checks, uptime monitors, and the n8n
 * pre-flight before a sync run.
 *
 * ## What it deliberately does not say
 *
 * The public body carries no configuration detail. An earlier version returned
 * the NAMES of missing environment keys to any caller, which is a small but real
 * disclosure: it tells an unauthenticated visitor that the deployment is
 * half-configured and which secret is absent. That detail now requires the
 * machine bearer — the same secret n8n already holds — so an operator can still
 * diagnose a bad deploy without publishing it.
 *
 * No token, no connection string, no stack trace, and no driver error text
 * appears in either form. The database probe reports a boolean and a latency,
 * never why a connection failed; the reason goes to the server log.
 *
 * ## Status codes
 *
 *   200  serving and able to reach Postgres
 *   503  configuration invalid, or the database is unreachable
 *
 * 503 is correct rather than 500: the process is alive and answering, it is the
 * dependency that is not ready. Load balancers and uptime checks treat the two
 * differently.
 */
export async function GET(request: Request) {
  const env = getServerEnvSafe();

  // Detail is opt-in and authenticated. A failed probe is not an error here —
  // it simply means the caller gets the public body.
  const machine = authenticateMachineRequest(request, "n8n");
  const detailed = machine.ok;

  // Without valid configuration there is no point dialling the database: the
  // connection string is one of the things that failed to parse.
  const database = env.ok ? await checkDatabase() : { reachable: false, latencyMs: null };

  const healthy = env.ok && database.reachable;

  return Response.json(
    {
      status: healthy ? "ok" : "degraded",
      name: APP_NAME,
      version: APP_VERSION,
      environment: deploymentEnvironment(),
      database: {
        reachable: database.reachable,
        latency_ms: database.latencyMs,
      },
      configured: env.ok,
      timestamp: new Date().toISOString(),
      ...(detailed
        ? {
            detail: {
              missing_env_keys: env.ok ? [] : env.missingKeys,
              node: process.version,
              region: process.env["VERCEL_REGION"] ?? null,
            },
          }
        : {}),
    },
    {
      status: healthy ? 200 : 503,
      headers: { "cache-control": "no-store" },
    },
  );
}
