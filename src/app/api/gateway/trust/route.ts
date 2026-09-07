import type { NextRequest } from "next/server";
import { authenticateMiner, createSupabaseMinerStore } from "@/lib/miner/credentials";
import { readPresentedToken } from "@/lib/miner/token";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { assessTrust, expectedIssuer } from "@/lib/trust/production";

/**
 * Trust diagnostics.
 *
 * Answers one question: "would this deployment issue a CONFIRMED proof right
 * now, and if not, which signal failed?" Without it, a missing signing key or a
 * mistyped deployment id fails closed silently and is indistinguishable from a
 * bug.
 *
 * Unauthenticated callers get booleans and state names only — enough to
 * diagnose a deployment, useless to an attacker. Gating this behind a miner
 * credential would be circular, since credential lookup is itself one of the
 * things that can be broken.
 *
 * Nothing here is secret: no key material, no environment values, no user data.
 * The issuer name and key id are published anyway at /api/receipts/keys.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const supabaseConfigured = isSupabaseConfigured();

  const store = supabaseConfigured
    ? createSupabaseMinerStore((await import("@/lib/supabase/admin")).createAdminSupabase())
    : null;

  const auth = await authenticateMiner(readPresentedToken(request.headers), store);
  const trust = await assessTrust(request.headers);

  return Response.json({
    canIssueProduction: trust.canIssueProduction,
    signals: trust.signals,
    reasons: trust.reasons,
    supabaseConfigured,
    minerCredential: auth.ok ? "accepted" : `rejected:${auth.reason}`,
    // Public by design, but only worth returning to a caller that got this far.
    issuer: auth.ok ? expectedIssuer() : null,
    issuerKeyId: auth.ok ? (trust.issuer?.keyId ?? null) : null,
  });
}
