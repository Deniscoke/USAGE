"use server";

import { revalidatePath } from "next/cache";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { createServerSupabase } from "@/lib/supabase/server";
import { createConnectionStore, ConnectionError } from "@/lib/providers/connections";
import { getProtocol } from "@/lib/protocols/registry";
import { SsrfError } from "@/lib/net/ssrf";
import { SecretCryptoError } from "@/lib/secrets/crypto";
import type { MiningEligibility } from "@/lib/protocols/protocol";

/**
 * Connecting a provider, as a product action.
 *
 * Everything a normal user needs: a name, a URL, a key. No environment
 * variables, no terminal, no server configuration.
 *
 * The credential arrives once, is encrypted immediately, and is never returned
 * by any action here. Errors are deliberately ours rather than the upstream's:
 * an upstream body can echo request configuration back, and an SSRF probe
 * should not learn anything from an error message.
 */

export interface ConnectProviderState {
  error?: string;
  message?: string;
  connectionId?: string;
  eligibility?: MiningEligibility;
  /** "accepted" or "inconclusive" once stored; a rejection is an error. */
  verdict?: "accepted" | "inconclusive";
  status?: string;
  protocol?: string;
  modelCount?: number;
  /** Generation-time evidence is documented for known providers; pending for custom. */
  usageEvidence?: "documented" | "pending";
  pricedModelCount?: number;
}

async function requireUser() {
  const supabase = await createServerSupabase();
  if (!supabase) return { error: "USAGE is not configured." as const };

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Sign in to connect a provider." as const };

  return { supabase, user };
}

export async function connectProvider(
  _previous: ConnectProviderState,
  formData: FormData,
): Promise<ConnectProviderState> {
  const session = await requireUser();
  if ("error" in session) return { error: session.error };

  const displayName = String(formData.get("displayName") ?? "").trim().slice(0, 60);
  const protocolId = String(formData.get("protocol") ?? "");
  const baseUrl = String(formData.get("baseUrl") ?? "").trim();
  const credential = String(formData.get("credential") ?? "").trim();
  const providerFamily = String(formData.get("providerFamily") ?? "").trim() || null;

  if (!displayName) return { error: "Give this provider a name." };
  if (!baseUrl) return { error: "Enter the provider's API base URL." };
  if (!credential) return { error: "Enter an API key." };

  const protocol = getProtocol(protocolId);
  if (!protocol) {
    // usage_import and custom_unsupported are honest answers, but USAGE cannot
    // route them, and it will not pretend a connection is live when it is not.
    return {
      error:
        "USAGE cannot route that protocol yet. Choose an OpenAI- or Anthropic-compatible API.",
    };
  }

  try {
    const store = createConnectionStore(createAdminSupabase());
    const result = await store.create({
      userId: session.user.id,
      displayName,
      protocol: protocol.id,
      baseUrl,
      credential,
      providerFamily,
    });

    revalidatePath("/providers");
    revalidatePath("/dashboard");
    revalidatePath("/settings");

    return {
      connectionId: result.connectionId,
      eligibility: result.eligibility,
      message: result.message,
      verdict: result.validation.verdict === "accepted" ? "accepted" : "inconclusive",
      status: result.status,
      protocol: protocol.label,
      modelCount: result.validation.models.length,
      usageEvidence: result.validation.capabilities.usage ? "documented" : "pending",
      pricedModelCount: result.eligibility === "eligible_route" ? 1 : 0,
    };
  } catch (error) {
    if (error instanceof SsrfError) return { error: error.message };
    if (error instanceof ConnectionError) return { error: error.message };
    if (error instanceof SecretCryptoError) {
      // A deployment without an encryption key must refuse to take credentials
      // at all rather than storing them in a way it cannot protect.
      return { error: "USAGE cannot store credentials securely right now. Contact support." };
    }
    return { error: "That provider could not be connected." };
  }
}

export interface ConnectionActionState {
  error?: string;
  message?: string;
}

export async function revokeProviderConnection(
  _previous: ConnectionActionState,
  formData: FormData,
): Promise<ConnectionActionState> {
  const session = await requireUser();
  if ("error" in session) return { error: session.error };

  const connectionId = String(formData.get("connectionId") ?? "");
  if (!connectionId) return { error: "No connection selected." };

  // Scoped to the signed-in user's id, so a connection that is not theirs is
  // simply not found.
  const store = createConnectionStore(createAdminSupabase());
  const revoked = await store.revoke(connectionId, session.user.id);

  revalidatePath("/providers");
  revalidatePath("/settings");

  return revoked
    ? { message: "Disconnected. It can no longer route requests." }
    : { error: "That connection could not be disconnected." };
}

/**
 * Re-check a connection without spending the user's provider credit.
 *
 * Uses the same cheap probe as creation -- a models listing, which generates
 * nothing. No inference request is ever made to test a connection.
 */
export async function testProviderConnection(
  _previous: ConnectionActionState,
  formData: FormData,
): Promise<ConnectionActionState> {
  const session = await requireUser();
  if ("error" in session) return { error: session.error };

  const connectionId = String(formData.get("connectionId") ?? "");
  if (!connectionId) return { error: "No connection selected." };

  try {
    // Re-validates with the STORED credential through the provider profile's
    // documented, non-generative probe, and records what actually came back.
    // Nothing is generated and the credential is never returned.
    const store = createConnectionStore(createAdminSupabase());
    const result = await store.revalidate(connectionId, session.user.id);
    revalidatePath("/providers");

    if (result.validation.verdict === "accepted") return { message: result.validation.message };
    if (result.validation.verdict === "rejected") return { error: result.validation.message };
    return { message: `Credential saved — validation incomplete. ${result.validation.message}` };
  } catch (error) {
    if (error instanceof SsrfError) return { error: error.message };
    if (error instanceof ConnectionError) return { error: error.message };
    return { error: "That connection could not be tested." };
  }
}
