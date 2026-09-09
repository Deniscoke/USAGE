import type { NextRequest } from "next/server";
import { createPublicKey } from "node:crypto";
import { authenticateMiner, createSupabaseMinerStore, hasScope } from "@/lib/miner/credentials";
import { readPresentedToken } from "@/lib/miner/token";
import { requireLiveDevice } from "@/lib/miner/devices";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { checkRateLimit } from "@/lib/gateway/observability";
import { isSupabaseConfigured } from "@/lib/supabase/env";

/**
 * A device registers its signing key.
 *
 * First registration wins for the life of the device: a key, once set, is
 * not silently replaced by a later upload, because "the device's key
 * changed" is exactly the event an audit would want to notice. Re-registering
 * the same key is a no-op. A different key is refused; revoke and re-pair.
 *
 * A registered key upgrades what the device's observations can claim from
 * local_observed to device_attested. That is a statement about origin --
 * "this came from that machine" -- and nothing more.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (!isSupabaseConfigured()) return Response.json({ error: "unavailable" }, { status: 503 });

  const admin = createAdminSupabase();
  const auth = await authenticateMiner(readPresentedToken(request.headers), createSupabaseMinerStore(admin));
  if (!auth.ok) return Response.json({ error: auth.reason }, { status: 401 });
  if (!hasScope(auth.identity, "miner:telemetry")) {
    return Response.json({ error: "insufficient_scope" }, { status: 403 });
  }
  if (!checkRateLimit(`device-key:${auth.identity.credentialId}`, 10).allowed) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  const device = await requireLiveDevice(admin, auth.identity);
  if (!device.ok) return Response.json({ error: device.reason }, { status: device.reason === "revoked" ? 403 : 404 });

  let body: { algorithm?: unknown; publicKey?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "bad_json" }, { status: 400 });
  }
  if (body.algorithm !== "ed25519" || typeof body.publicKey !== "string" || body.publicKey.length > 200) {
    return Response.json({ error: "bad_key" }, { status: 400 });
  }
  // Must actually be an Ed25519 SPKI key, not any base64 string.
  try {
    const key = createPublicKey({ key: Buffer.from(body.publicKey, "base64"), format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519") throw new Error("not ed25519");
  } catch {
    return Response.json({ error: "bad_key" }, { status: 400 });
  }

  if (device.device.public_key) {
    if (device.device.public_key === body.publicKey) return Response.json({ ok: true, unchanged: true });
    return Response.json({ error: "key_already_registered" }, { status: 409 });
  }

  await admin
    .from("miner_devices")
    .update({
      public_key: body.publicKey,
      public_key_algorithm: "ed25519",
      public_key_registered_at: new Date().toISOString(),
      device_trust_level: "attested",
    })
    .eq("id", device.device.id);

  return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
}
