import { createAdminSupabase } from "@/lib/supabase/admin";
import { settleDailyEpoch, type SettleDailyResult } from "@/lib/db/settle-daily";
import { recentCompleteDays, settlementRunStatus } from "@/lib/domain/settlement-run";

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

  // A named day settles that day alone. Otherwise the job looks back over the
  // last few finished days, so a refused or missed night is picked up later
  // instead of never; a day that is already settled is skipped.
  const named = new URL(request.url).searchParams.get("day");
  if (named !== null && !/^\d{4}-\d{2}-\d{2}$/.test(named)) {
    return Response.json({ error: "bad_day" }, { status: 400 });
  }
  const days = named ? [named] : recentCompleteDays();

  const admin = createAdminSupabase();
  const results: SettleDailyResult[] = [];
  // In order, oldest first, one at a time: settlement takes locks and writes a
  // ledger, and nothing is gained by racing two days against each other.
  for (const day of days) {
    results.push(await settleDailyEpoch(admin, { day }));
  }

  // A refusal is the system declining to pay people. It used to be a 200 with
  // the reason in the body, which the scheduler recorded as a healthy run
  // every night it happened. Now it fails the run, where it can be seen.
  return Response.json(
    { results },
    { status: settlementRunStatus(results.map((result) => result.outcome)), headers: { "cache-control": "no-store" } },
  );
}
