import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { mfaState } from "./mfa";

/**
 * Does this session satisfy the account's second factor?
 *
 * WHY THIS EXISTS. Two-factor authentication was enforced by the middleware,
 * which redirects pages. API routes and server actions are not pages: a stolen
 * password alone still reached chat on USAGE's key, the wallet's spend, provider
 * connections and device pairing, because each of them only asked "is anyone
 * signed in". A factor that guards the screens and not the actions behind
 * them protects nothing.
 *
 * FAILS CLOSED. Every caller spends money, changes a connection or reads
 * account data. When the level cannot be read, the answer is no, and the
 * person is told to finish signing in -- the safe inconvenience, never the
 * unsafe convenience. (The middleware is different: it fails open, because a
 * page it lets through still has to pass this.)
 *
 * An account with no factor enrolled is satisfied at the password, exactly as
 * before; nothing changes for it.
 */
export async function sessionSatisfiesSecondFactor(
  supabase: Pick<SupabaseClient, "auth">,
): Promise<boolean> {
  try {
    const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (error) return false;
    return mfaState(data).kind !== "challenge_required";
  } catch {
    return false;
  }
}

export const SECOND_FACTOR_REQUIRED_MESSAGE =
  "This account uses two-factor authentication. Enter your code to finish signing in, then try again.";
