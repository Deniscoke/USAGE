/**
 * Two-factor authentication: what the session's assurance level means, and
 * where a person should be sent because of it.
 *
 * Supabase Auth owns the factors, the secrets and the codes. Nothing about
 * them is stored in this schema and no migration is needed, which is most of
 * why this is the right second factor to add: the part that would be
 * dangerous to get wrong is the part we are not writing.
 *
 * What this file owns is the decision. A session carries an Authenticator
 * Assurance Level: `aal1` after a password, `aal2` after a second factor. The
 * pair of "what this session has" and "what this account could reach" says
 * everything:
 *
 *   aal1 / aal1   no second factor on the account
 *   aal1 / aal2   a factor exists and this session has not passed it
 *   aal2 / aal2   passed
 *   aal2 / aal1   the factor was removed elsewhere; this token is stale
 *
 * The middle row is the only one that changes what a person sees, and the
 * answer is a verification screen -- never a 401. Somebody who left a tab open
 * overnight is not an attacker, and treating them like one teaches people to
 * turn the feature off.
 */

export type AalLevel = "aal1" | "aal2";

/**
 * What the client reports. The levels are typed as plain strings because
 * Supabase widens them, and because a level this code has never heard of must
 * be handled rather than rejected by the type system: `mfaState` narrows, and
 * anything that is not exactly "aal2" is treated as the lower level.
 */
export interface AssuranceLevels {
  currentLevel: string | null;
  nextLevel: string | null;
}

export type MfaState =
  /** No second factor on this account. */
  | { kind: "not_enrolled" }
  /** A factor exists; this session has not passed it yet. */
  | { kind: "challenge_required" }
  /** This session passed the second factor. */
  | { kind: "verified" }
  /** The factor was removed elsewhere and this token has not caught up. */
  | { kind: "stale" };

export function mfaState(levels: AssuranceLevels | null | undefined): MfaState {
  // A JWT with no `aal` claim is aal1 by definition. Unknown is never treated
  // as verified: the safe reading of silence is the lower level.
  const current: AalLevel = levels?.currentLevel === "aal2" ? "aal2" : "aal1";
  const next: AalLevel = levels?.nextLevel === "aal2" ? "aal2" : "aal1";

  if (current === "aal1" && next === "aal2") return { kind: "challenge_required" };
  if (current === "aal2" && next === "aal2") return { kind: "verified" };
  if (current === "aal2" && next === "aal1") return { kind: "stale" };
  return { kind: "not_enrolled" };
}

/** Where the second factor is entered. Reachable at aal1, by definition. */
export const MFA_VERIFY_PATH = "/login/verify";
/** Where factors are added and removed. */
export const MFA_SETTINGS_PATH = "/settings/security";

/**
 * Paths that stay open to a session that owes a second factor.
 *
 * Sign-out is on the list on purpose. Somebody who cannot complete the
 * challenge -- lost phone, wrong clock -- must still be able to leave, or the
 * only way out of the account is to clear cookies by hand.
 */
const OPEN_WHILE_UNVERIFIED = [MFA_VERIFY_PATH, "/auth", "/api/auth", "/login", "/sign-up"];

import { isProtectedPath } from "./routing";

export type MfaRouteDecision = { kind: "allow" } | { kind: "redirect"; to: string; withNext?: string };

export function mfaRouteDecision(pathname: string, state: MfaState): MfaRouteDecision {
  const isOpen = OPEN_WHILE_UNVERIFIED.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));

  if (state.kind === "challenge_required") {
    if (isOpen) return { kind: "allow" };
    // Only what requires a signed-in user requires a verified one. The public
    // pages stay public, and an API call gets its own answer from the route
    // rather than a redirect its caller cannot follow.
    if (!isProtectedPath(pathname)) return { kind: "allow" };
    return { kind: "redirect", to: MFA_VERIFY_PATH, withNext: pathname };
  }

  // Nothing to verify, so the verification screen is a dead end: send them on.
  if (pathname === MFA_VERIFY_PATH) return { kind: "redirect", to: "/dashboard" };

  return { kind: "allow" };
}

/** What a person is told when a code is refused. */
export function verifyErrorMessage(raw: string | null | undefined): string {
  const message = (raw ?? "").toLowerCase();
  if (message.includes("invalid") || message.includes("incorrect")) {
    return "That code was not accepted. Codes last 30 seconds, so take the current one. If it keeps failing, check your phone's clock is set automatically.";
  }
  if (message.includes("expired")) {
    return "That code expired. Enter the one showing now.";
  }
  if (message.includes("rate") || message.includes("too many")) {
    return "Too many attempts. Wait a minute and try again.";
  }
  return raw?.trim() ? raw : "The code could not be checked. Try again.";
}

/** A TOTP code is six digits; anything else is a typo worth catching early. */
export function normaliseCode(input: string): string {
  return input.replace(/\D/g, "").slice(0, 6);
}

export function isCompleteCode(code: string): boolean {
  return /^\d{6}$/.test(code);
}
