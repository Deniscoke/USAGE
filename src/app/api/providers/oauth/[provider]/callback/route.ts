import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { createConnectionStore } from "@/lib/providers/connections";
import {
  exchangeCodeForKey,
  getOAuthProvider,
  readOpenRouterAccount,
} from "@/lib/providers/oauth";

/**
 * Finish a one-click provider connection.
 *
 * The provider returns a code; USAGE exchanges it for a credential using the
 * verifier it kept, stores that credential in the secret store, and creates a
 * validated connection. The user never sees or types a key.
 *
 * The pending attempt is consumed atomically, so a replayed callback cannot
 * mint a second connection, and its recorded user id -- not anything the
 * browser sends -- decides who the connection belongs to.
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

  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  if (!code || !state) redirect("/providers/add?error=oauth_cancelled");

  const admin = createAdminSupabase();

  // Consume the pending attempt in one statement: a replay finds nothing.
  const { data: pending } = await admin
    .from("provider_oauth_requests")
    .update({ consumed_at: new Date().toISOString() })
    .eq("state", state)
    .eq("provider_slug", provider.slug)
    .is("consumed_at", null)
    .gt("expires_at", new Date().toISOString())
    .select("user_id, code_verifier")
    .maybeSingle();

  if (!pending) redirect("/providers/add?error=oauth_expired");

  let credential: string;
  try {
    credential = await exchangeCodeForKey({
      provider,
      code,
      verifier: pending.code_verifier,
    });
  } catch {
    // The message is ours: an upstream body can echo request configuration.
    redirect("/providers/add?error=oauth_exchange_failed");
  }

  try {
    const store = createConnectionStore(admin);
    const result = await store.create({
      userId: pending.user_id,
      displayName: provider.displayName,
      protocol: provider.protocol,
      baseUrl: provider.apiBaseUrl,
      credential,
      providerFamily: provider.slug,
      // A definition USAGE curates, not a URL the user typed: the endpoint is
      // therefore trusted as economic evidence.
      definitionId: null,
      authMethod: "oauth",
    });

    // Account context, for the product to show and for the reward policy to
    // classify. Failing here must not undo a working connection.
    if (provider.slug === "openrouter") {
      const account = await readOpenRouterAccount({ credential });
      if (account) {
        // Context only. Economic classification still comes from the cost the
        // provider reports on each request, which is stronger evidence than an
        // account-level tier flag.
        await admin
          .from("provider_connections")
          .update({
            account_context: {
              usage_usd: account.usage,
              limit_usd: account.limit,
              is_free_tier: account.isFreeTier,
            },
          })
          .eq("id", result.connectionId);
      }
    }

    redirect(`/providers?connected=${provider.slug}`);
  } catch (error) {
    // redirect() throws by design; let it through.
    if (error && typeof error === "object" && "digest" in error) throw error;
    redirect("/providers/add?error=oauth_connect_failed");
  }
}
