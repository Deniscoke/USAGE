import { createGithubBillingDeps } from "@/lib/provider-billing/server";
import { syncBillingAccount, type SyncOutcome } from "@/lib/provider-billing/sync";

/**
 * Daily provider-billing sync (M17C). Same authorization as settle-epoch: a
 * bearer CRON_SECRET the deployment configured, or nothing.
 *
 * WHAT IT MAY DO: read each connected account's GitHub billing aggregates and
 * record them in the provider-billing tables. It writes nothing economic --
 * no usage_events, no scores, no ledger -- and returns counts only, never an
 * account id, login or token.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Accounts per run; the least recently synced go first. */
const BATCH = 50;

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(request: Request): Promise<Response> {
  if (!authorized(request)) return Response.json({ error: "unauthorized" }, { status: 401 });

  const deps = await createGithubBillingDeps().catch(() => null);
  if (!deps) {
    return Response.json({ skipped: "github_not_configured" }, { headers: { "cache-control": "no-store" } });
  }

  const outcomes: Partial<Record<SyncOutcome | "error", number>> = {};
  const ids = await deps.store.listAccountsForScheduledSync(BATCH);
  for (const accountId of ids) {
    let outcome: SyncOutcome | "error";
    try {
      outcome = (await syncBillingAccount(deps, { accountId, mode: "scheduled" })).outcome;
    } catch {
      outcome = "error";
    }
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
  }
  return Response.json({ accounts: ids.length, outcomes }, { headers: { "cache-control": "no-store" } });
}
