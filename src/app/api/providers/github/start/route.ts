import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { sessionSatisfiesSecondFactor } from "@/lib/auth/assurance";
import { startGithubConnection } from "@/lib/provider-billing/connect";
import { createGithubBillingDeps } from "@/lib/provider-billing/server";

/**
 * Begin connecting GitHub Copilot billing (provider billing evidence, reward 0).
 *
 * Signed-in, second factor satisfied. The PKCE verifier and state are stored
 * server-side against this user (provider_oauth_requests); only the S256
 * challenge travels to GitHub. The app requests the "Plan" account permission
 * (read) and nothing else -- that is fixed at app registration, not here.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = (await supabase?.auth.getUser()) ?? { data: { user: null } };
  if (!user || !supabase) redirect(`/login?next=/providers`);
  if (!(await sessionSatisfiesSecondFactor(supabase))) redirect(`/login/verify?next=/providers`);

  const deps = await createGithubBillingDeps().catch(() => null);
  if (!deps) redirect("/providers?github=not_configured");

  let authorizeUrl: string;
  try {
    authorizeUrl = await startGithubConnection({
      store: deps.store,
      config: deps.config,
      userId: user.id,
      origin: request.nextUrl.origin,
    });
  } catch {
    redirect("/providers?github=start_failed");
  }
  redirect(authorizeUrl);
}
