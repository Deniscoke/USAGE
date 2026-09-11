import "server-only";
import type { MinerAuthResult } from "@/lib/miner/credentials";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * The signed-in browser, as an identity the gateway understands.
 *
 * The chat runs inside the website, so the person is already authenticated by
 * their session cookie; there is no miner token and no reason to invent one.
 * What the gateway needs is a user id it can trust and a key to rate-limit on,
 * and it gets exactly that. `getUser()` revalidates the token with Supabase on
 * every call -- never `getSession()`, which trusts the cookie's own claim.
 *
 * The scope is `miner:route` and nothing else: a browser session may start a
 * request and may not read configuration, send heartbeats or rotate anything.
 */
export async function authenticateWebSession(): Promise<MinerAuthResult> {
  const supabase = await createServerSupabase();
  if (!supabase) return { ok: false, reason: "missing" };

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, reason: "missing" };

  return {
    ok: true,
    identity: {
      credentialId: `web:${user.id}`,
      userId: user.id,
      name: "web-chat",
      scopes: ["miner:route"],
      origin: "web",
    },
  };
}

/** The signed-in user id, or null. For reads that need no gateway. */
export async function signedInUserId(): Promise<string | null> {
  const auth = await authenticateWebSession();
  return auth.ok ? auth.identity.userId : null;
}
