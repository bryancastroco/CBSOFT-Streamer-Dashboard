import { GET as dailySync, maxDuration as dailyMaxDuration } from "@/app/api/cron/daily-sync/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = dailyMaxDuration;

/**
 * `/api/cron/facebook-sync` — the name Phase 13 specifies for the fallback.
 *
 * Deliberately a re-export of `/api/cron/daily-sync` rather than a copy. The
 * behaviour asked for is the behaviour that route already has: machine
 * authentication against `CRON_SECRET`, a frequency gap so a retrying platform
 * cannot hammer, the database-enforced single-sweep lock, `trigger_source` of
 * `vercel_cron`, and an immediate return with the run id while `after()`
 * carries on. Duplicating that would create two implementations of one
 * behaviour, and they would diverge the first time only one was edited.
 *
 * Both paths are live because `vercel.json` currently schedules the older name
 * and changing a cron path silently un-schedules the job.
 *
 * POST is accepted as well as GET: Vercel Cron issues GET, but the phase
 * specification names this endpoint as a POST, and a scheduler that sends
 * either should not get a 405.
 */
export const GET = dailySync;
export const POST = dailySync;
