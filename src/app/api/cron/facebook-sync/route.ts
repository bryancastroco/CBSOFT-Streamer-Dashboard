import { GET as dailySync } from "@/app/api/cron/daily-sync/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/*
 * Literal, and deliberately not re-exported from daily-sync.
 *
 * Next reads segment configuration by static analysis at build time — it does
 * not evaluate the module. `export const maxDuration = dailyMaxDuration` is an
 * imported binding, so the analyser cannot see a number and rejects the whole
 * segment with "Invalid segment configuration export". That failed the Vercel
 * build while passing locally, which is the worst shape a bug can have.
 *
 * So this is a literal that must match daily-sync's. `tests/cron-alias.test.ts`
 * asserts they stay equal, since nothing else now ties them together.
 */
export const maxDuration = 300;

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
