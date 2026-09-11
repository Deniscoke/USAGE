import { createAdminSupabase } from "@/lib/supabase/admin";
import { lastCompleteDay, settleDailyEpoch } from "@/lib/db/settle-daily";

/**
 * Settle yesterday's epoch, once a day.
 *
 * Until this existed, points only appeared when somebody remembered to run a
 * script, so a person could mine all week and see nothing. A reward that
 * depends on an operator noticing is not a reward.
 *
 * WHAT IT MAY DO. Exactly what the operator script does, through the same
 * function: apply the protocol the epoch was already governed by, and credit
 * the allocations that fall out of it. It cannot choose a reward policy,
 * cannot settle a day that is still in progress, cannot re-credit a settled
 * epoch, and cannot touch a calibration epoch. Those refusals live in
 * `settleDailyEpoch` and are shared with the script, so there is no second
 * implementation to forget one.
 *
 * WHO MAY CALL IT. Vercel's scheduler sends a bearer token this deployment
 * configured. Anything else is refused before a database client exists --
 * crediting a ledger is not something an anonymous request gets to start. With
 * no secret configured the route refuses everything, which is the right
 * failure for a deployment that has not been set up yet.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Settlement reads a day of usage and writes allocations; it is not instant. */
export const maxDuration = 300;

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) return false;
  const header = request.headers.get("authorization");
  return header === `Bearer ${secret}`;
}

export async function GET(request: Request): Promise<Response> {
  if (!authorized(request)) {
    // No detail. An unauthenticated caller learns nothing about whether the
    // secret is set, only that it is not them.
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const day = new URL(request.url).searchParams.get("day") ?? lastCompleteDay();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return Response.json({ error: "bad_day" }, { status: 400 });
  }

  const result = await settleDailyEpoch(createAdminSupabase(), { day });

  // A refusal is a 200 with a reason: the job ran correctly and decided not to
  // write. Only an exception is a failure, and that is left to throw.
  return Response.json(result, {
    headers: { "cache-control": "no-store" },
  });
}
