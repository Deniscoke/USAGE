"use server";

import { revalidatePath } from "next/cache";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { createServerSupabase } from "@/lib/supabase/server";
import { createSupabaseMinerStore } from "@/lib/miner/credentials";
import { findProvider, isUsable } from "@/lib/providers/catalog";
import { getComputeGateway } from "@/lib/compute/registry";

/**
 * Enabling mining, as a product action.
 *
 * A user clicks one button; the server mints a miner credential bound to their
 * session's own user id. There is no user parameter to aim at somebody else's
 * account, and the plaintext token is returned exactly once -- only its hash is
 * stored, so a database leak cannot be replayed against the gateway.
 *
 * Revocation runs as the *user*, not the service role, so Postgres RLS is what
 * proves ownership rather than a check we wrote and could forget.
 */

export interface MinerActionState {
  error?: string;
  /** Shown once and never recoverable. Never persisted anywhere. */
  token?: string;
  credentialName?: string;
  /** Where the miner should point. Public routing information, not a secret. */
  endpoint?: string;
  message?: string;
}

/** The USAGE surface a gateway is served on. Public. */
function gatewayEndpoint(gatewayId: string): string {
  return gatewayId === "openrouter"
    ? "/api/gateway/openrouter"
    : "/api/gateway/anthropic";
}

async function requireUser() {
  const supabase = await createServerSupabase();
  if (!supabase) return { error: "USAGE is not configured." as const };

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Sign in to manage mining." as const };

  return { supabase, user };
}

export async function enableMining(
  _previous: MinerActionState,
  formData: FormData,
): Promise<MinerActionState> {
  const session = await requireUser();
  if ("error" in session) return { error: session.error };

  const providerSlug = String(formData.get("provider") ?? "");
  const provider = findProvider(providerSlug);
  if (!provider) return { error: "Unknown provider." };

  // Which gateway will carry it. The registry is the authority on what exists:
  // never mint a credential for a route the product cannot actually deliver.
  const gatewayId = String(formData.get("gateway") ?? "");
  const route = provider.routes.find((entry) => entry.gateway === gatewayId);
  if (!route || !isUsable(route.status) || !getComputeGateway(gatewayId)) {
    return { error: `Mining is not available for ${provider.name} on that gateway yet.` };
  }

  const label = String(formData.get("name") ?? "").trim().slice(0, 40);
  const name = label || `${provider.slug} via ${route.gatewayName}`;

  const store = createSupabaseMinerStore(createAdminSupabase());
  const minted = await store.create(session.user.id, name);

  // The connection row records that this user chose to mine this provider. It
  // holds no secret: the credential lives only as a hash.
  const admin = createAdminSupabase();
  await admin.from("provider_connections").upsert(
    {
      user_id: session.user.id,
      provider: provider.slug,
      account_label: name,
      method: "routed_mining",
      status: "active",
      // A reference to where the credential lives, never the credential. The
      // gateway is recorded so the connection says which route it set up.
      secret_ref: `miner:${minted.credentialId}`,
      config: { gateway: gatewayId },
    },
    { onConflict: "user_id,provider,account_label" },
  );

  revalidatePath("/dashboard");
  revalidatePath("/settings");
  return { token: minted.token, credentialName: name, endpoint: gatewayEndpoint(gatewayId) };
}

export async function revokeMinerCredential(
  _previous: MinerActionState,
  formData: FormData,
): Promise<MinerActionState> {
  const session = await requireUser();
  if ("error" in session) return { error: session.error };

  const credentialId = String(formData.get("credentialId") ?? "");
  if (!credentialId) return { error: "No credential selected." };

  // Runs as the signed-in user: RLS rejects a credential they do not own, so
  // there is no ownership check here to get wrong.
  const { error } = await session.supabase
    .from("usage_miner_credentials")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", credentialId)
    .is("revoked_at", null)
    .select("id");

  if (error) return { error: "That credential could not be revoked." };

  revalidatePath("/dashboard");
  revalidatePath("/settings");
  return { message: "Credential revoked. It can no longer mine." };
}
