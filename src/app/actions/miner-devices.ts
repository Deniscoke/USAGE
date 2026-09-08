"use server";

import { revalidatePath } from "next/cache";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { createServerSupabase } from "@/lib/supabase/server";
import { createPairingStore } from "@/lib/miner/pairing";

/**
 * Approving a device, and revoking one.
 *
 * Approval is the only place a device gains an owner, and it runs as the
 * signed-in user: the device never says who it belongs to, so a pairing code
 * seen by somebody else can only ever be approved into THEIR account, not into
 * the account of whoever generated it.
 */

export interface PairActionState {
  error?: string;
  message?: string;
  deviceName?: string;
}

async function requireUser() {
  const supabase = await createServerSupabase();
  if (!supabase) return { error: "USAGE is not configured." as const };
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Sign in to approve a device." as const };
  return { supabase, user };
}

export async function approveMinerDevice(
  _previous: PairActionState,
  formData: FormData,
): Promise<PairActionState> {
  const session = await requireUser();
  if ("error" in session) return { error: session.error };

  const code = String(formData.get("code") ?? "").trim();
  if (!code) return { error: "Enter the code shown by USAGE Miner." };

  const store = createPairingStore(createAdminSupabase());
  const request = await store.lookup(code);
  // Expired, already used, denied and never-existed are one answer on purpose:
  // guessing codes should learn nothing.
  if (!request) return { error: "That code is not valid. Codes expire after ten minutes." };

  const approved = await store.approve(code, session.user.id);
  if (!approved) return { error: "That code is not valid. Codes expire after ten minutes." };

  revalidatePath("/miners");
  return {
    message: "Device approved. USAGE Miner will finish connecting in a moment.",
    deviceName: request.deviceName,
  };
}

export async function denyMinerDevice(
  _previous: PairActionState,
  formData: FormData,
): Promise<PairActionState> {
  const session = await requireUser();
  if ("error" in session) return { error: session.error };

  const code = String(formData.get("code") ?? "").trim();
  const store = createPairingStore(createAdminSupabase());
  await store.deny(code);
  return { message: "Request rejected. Nothing was connected." };
}

export interface DeviceActionState {
  error?: string;
  message?: string;
}

export async function revokeMinerDevice(
  _previous: DeviceActionState,
  formData: FormData,
): Promise<DeviceActionState> {
  const session = await requireUser();
  if ("error" in session) return { error: session.error };

  const deviceId = String(formData.get("deviceId") ?? "");
  if (!deviceId) return { error: "No device selected." };

  const admin = createAdminSupabase();
  const now = new Date().toISOString();

  // Scoped to the signed-in user, so a device that is not theirs is not found.
  const { data } = await admin
    .from("miner_devices")
    .update({ revoked_at: now })
    .eq("id", deviceId)
    .eq("user_id", session.user.id)
    .is("revoked_at", null)
    .select("id, credential_id");

  const device = (data ?? [])[0];
  if (!device) return { error: "That device could not be revoked." };

  // Revoking the credential is what actually stops routing, immediately.
  if (device.credential_id) {
    await admin
      .from("usage_miner_credentials")
      .update({ revoked_at: now })
      .eq("id", device.credential_id);
  }

  revalidatePath("/miners");
  return { message: "Device revoked. It can no longer route requests." };
}
