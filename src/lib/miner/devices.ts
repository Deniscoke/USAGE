import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, MinerDeviceRow } from "@/lib/supabase/database.types";
import type { MinerIdentity } from "./credentials";

/**
 * Resolve the device behind a credential, and refuse anything revoked.
 *
 * Every miner route that writes device state goes through here, so "a revoked
 * device fails immediately" is one check in one place rather than a habit.
 */
export async function requireLiveDevice(
  admin: SupabaseClient<Database>,
  identity: MinerIdentity,
): Promise<{ ok: true; device: MinerDeviceRow } | { ok: false; reason: "no_device" | "revoked" }> {
  const { data: credential } = await admin
    .from("usage_miner_credentials")
    .select("device_id")
    .eq("id", identity.credentialId)
    .maybeSingle();
  if (!credential?.device_id) return { ok: false, reason: "no_device" };

  const { data: device } = await admin
    .from("miner_devices")
    .select("*")
    .eq("id", credential.device_id)
    .eq("user_id", identity.userId)
    .maybeSingle();
  if (!device) return { ok: false, reason: "no_device" };
  if (device.revoked_at) return { ok: false, reason: "revoked" };
  return { ok: true, device: device as MinerDeviceRow };
}
