import type { NextRequest } from "next/server";
import { anthropicError } from "@/lib/gateway/anthropic";
import { authenticateMiner, createSupabaseMinerStore } from "@/lib/miner/credentials";
import { readPresentedToken } from "@/lib/miner/token";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { assessTrust, expectedIssuer } from "@/lib/trust/production";

/**
 * Trust diagnostics.
 *
 * Answers one question: "would this deployment issue a CONFIRMED proof right
 * now, and if not, which signal failed?" Without it, a misconfigured issuer or
 * deployment id fails closed silently and looks identical to a bug.
 *
 * Requires a valid miner credential, and returns only non-secret facts: booleans,
 * state names, the public issuer name and the key id. No key material, no
 * environment values, no user data.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const store = isSupabaseConfigured()
    ? createSupabaseMinerStore((await import("@/lib/supabase/admin")).createAdminSupabase())
    : null;

  const auth = await authenticateMiner(readPresentedToken(request.headers), store);
  if (!auth.ok) {
    return anthropicError(401, "authentication_error", "Invalid USAGE miner credential.");
  }

  const trust = await assessTrust(request.headers);

  return Response.json({
    canIssueProduction: trust.canIssueProduction,
    issuer: trust.canIssueProduction ? expectedIssuer() : null,
    // Public by design: verifiers need it to check a signature.
    issuerKeyId: trust.issuer?.keyId ?? null,
    signals: trust.signals,
    reasons: trust.reasons,
    supabaseConfigured: isSupabaseConfigured(),
  });
}
