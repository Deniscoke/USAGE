import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { createServerSupabase } from "@/lib/supabase/server";
import {
  buildAuthorizeUrl,
  createOAuthState,
  createPkcePair,
  getOAuthProvider,
} from "@/lib/providers/oauth";

/**
 * Begin a one-click provider connection.
 *
 * Generates a PKCE pair, records the pending attempt against the signed-in
 * user, and sends the browser to the provider. The verifier never leaves the
 * server; only its SHA-256 challenge travels with the user.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ provider: string }> },
) {
  const { provider: slug } = await context.params;
  const provider = getOAuthProvider(slug);
  if (!provider) redirect("/providers/add?error=unsupported_provider");

  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = (await supabase?.auth.getUser()) ?? { data: { user: null } };
  // Only a signed-in user can start a flow, so a pending attempt always has an
  // owner and the callback never has to trust the browser about who it is.
  if (!user) redirect(`/login?next=/api/providers/oauth/${slug}/start`);

  const pkce = createPkcePair();
  const state = createOAuthState();

  const admin = createAdminSupabase();
  const { error } = await admin.from("provider_oauth_requests").insert({
    state,
    user_id: user.id,
    provider_slug: provider.slug,
    code_verifier: pkce.verifier,
  });
  if (error) redirect("/providers/add?error=oauth_start_failed");

  const callbackUrl = new URL(
    `/api/providers/oauth/${provider.slug}/callback`,
    request.nextUrl.origin,
  ).toString();

  redirect(
    buildAuthorizeUrl({ provider, callbackUrl, challenge: pkce.challenge, state }),
  );
}
