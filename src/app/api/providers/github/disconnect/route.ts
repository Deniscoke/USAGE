import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { sessionSatisfiesSecondFactor } from "@/lib/auth/assurance";
import { disconnectGithubBilling } from "@/lib/provider-billing/connect";
import { createGithubBillingDeps, isSameOrigin } from "@/lib/provider-billing/server";

/**
 * Disconnect the signed-in user's GitHub billing account: revoke the grant at
 * GitHub (best effort), destroy the stored tokens, keep the billing history
 * marked disconnected. Takes no body; the account is the session user's.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
  try {
    const result = await disconnectGithubBilling(deps, { userId: user.id });
    return back(result.ok ? "disconnected" : "not_connected");
  } catch {
    return back("disconnect_failed");
  }
}
