import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { sessionSatisfiesSecondFactor } from "@/lib/auth/assurance";
import { completeGithubConnection } from "@/lib/provider-billing/connect";
import { createGithubBillingDeps } from "@/lib/provider-billing/server";

/**
 * Finish connecting GitHub Copilot billing.
 *
 * The state must have been minted for THIS signed-in user, be unexpired and
 * unused; anything else is refused before a code is exchanged. Tokens go to
 * the secret store and nowhere else: the redirect below carries only an
 * outcome word, never a token, code or state.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** The first sync reads the month and each day so far. */
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  if (params.get("error")) redirect("/providers?github=cancelled");

  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = (await supabase?.auth.getUser()) ?? { data: { user: null } };
  if (!user || !supabase) redirect("/login?next=/providers");
  if (!(await sessionSatisfiesSecondFactor(supabase))) redirect("/login/verify?next=/providers");

  const deps = await createGithubBillingDeps().catch(() => null);
  if (!deps) redirect("/providers?github=not_configured");

  let outcome: string;
  try {
    const result = await completeGithubConnection(deps, {
      sessionUserId: user.id,
      state: params.get("state"),
      code: params.get("code"),
      origin: request.nextUrl.origin,
    });
    outcome = result.ok ? "connected" : result.error;
  } catch {
    outcome = "connect_failed";
  }
  redirect(`/providers?github=${outcome}`);
}
