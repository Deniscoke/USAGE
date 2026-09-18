import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { sessionSatisfiesSecondFactor } from "@/lib/auth/assurance";
import { createGithubBillingDeps, isSameOrigin } from "@/lib/provider-billing/server";
import { syncBillingAccount } from "@/lib/provider-billing/sync";

/**
 * "Refresh now" for the signed-in user's own GitHub billing account.
 *
 * Takes no body: the account is found by the session's user id, never by
 * anything the browser sends, so there is nothing to point at somebody else's
 * account and no way to submit billing data. Rate-limited per account inside
 * the sync (one manual refresh per five minutes).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  const back = (outcome: string) => NextResponse.redirect(new URL(`/providers?github=${outcome}`, request.url), 303);
  if (!isSameOrigin(request)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = (await supabase?.auth.getUser()) ?? { data: { user: null } };
  if (!user || !supabase) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await sessionSatisfiesSecondFactor(supabase))) return NextResponse.json({ error: "mfa_required" }, { status: 401 });

  const deps = await createGithubBillingDeps().catch(() => null);
  if (!deps) return back("not_configured");

  const account = await deps.store.getAccountForUser(user.id, "github");
  if (!account) return back("not_connected");
  try {
    const result = await syncBillingAccount(deps, { accountId: account.id, mode: "manual" });
    return back(result.outcome === "ok" ? "refreshed" : result.outcome);
  } catch {
    return back("refresh_failed");
  }
}
