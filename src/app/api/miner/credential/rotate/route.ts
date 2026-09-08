import type { NextRequest } from "next/server";
import {
  authenticateMiner,
  createSupabaseMinerStore,
  hasScope,
} from "@/lib/miner/credentials";
import { readPresentedToken } from "@/lib/miner/token";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { checkRateLimit } from "@/lib/gateway/observability";
import { isSupabaseConfigured } from "@/lib/supabase/env";

/**
 * A device replaces its own credential.
 *
 * This exists because of one specific mistake: builds before 0.3.0 routed
 * Claude Code by writing the device's miner token into `settings.json` in
 * plaintext. Removing it from the file is necessary but not sufficient -- a
 * secret that has sat in a readable file, been copied into a dotfiles
 * repository, or been pasted into a bug report has to be assumed read. The only
 * honest remedy is a new credential and the immediate death of the old one.
 *
 * AUTHENTICATED BY THE CREDENTIAL BEING REPLACED. That is not circular: holding
 * a valid token is exactly what proves you are the device entitled to a
 * replacement. It cannot be used to escalate -- the new credential carries the
 * same device scopes, belongs to the same user, and stays bound to the same
 * device row.
 *
 * The old credential is revoked in the same operation, so a rotation cannot
 * leave two live tokens behind. If the device never receives the response it
 * simply signs in again; a lost rotation costs a pairing, not a security hole.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (!isSupabaseConfigured()) return Response.json({ error: "unavailable" }, { status: 503 });

  const admin = createAdminSupabase();
  const store = createSupabaseMinerStore(admin);
  const auth = await authenticateMiner(readPresentedToken(request.headers), store);
  if (!auth.ok) return Response.json({ error: auth.reason }, { status: 401 });

  if (!hasScope(auth.identity, "miner:rotate")) {
    return Response.json({ error: "insufficient_scope" }, { status: 403 });
  }

  // Rotation is rare by nature -- once per exposure, not per session. A tight
  // limit means a stolen token cannot be used to churn credentials.
  if (!checkRateLimit(`rotate:${auth.identity.credentialId}`, 3).allowed) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  const replacement = await store.rotate(
    auth.identity.credentialId,
    auth.identity.userId,
    auth.identity.name,
  );

  // The plaintext is returned exactly once, over TLS, to the device that
  // authenticated as its predecessor. It is not logged here or anywhere else.
  return Response.json(
    {
      token: replacement.token,
      credentialId: replacement.credentialId,
      previousRevoked: true,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
