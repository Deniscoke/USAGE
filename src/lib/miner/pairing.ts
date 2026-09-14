import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import {
  generatePollToken,
  generateUserCode,
  hashPollToken,
  normalizeUserCode,
  parseInstallationId,
} from "./pairing-codes";
import { createSupabaseMinerStore } from "./credentials";

export {
  generatePollToken,
  generateUserCode,
  hashPollToken,
  normalizeUserCode,
} from "./pairing-codes";

/**
 * Browser device pairing.
 *
 * The last manual step in onboarding was a user copying a miner token into a
 * terminal. Instead: the miner asks for a short code, the user approves the
 * device in a browser where they are already signed in, and the credential goes
 * straight to the device.
 *
 * TWO SECRETS, deliberately different:
 *
 *   user_code   short, human-readable, shown on screen. Anyone who glimpses it
 *               could type it, so it can only ever *identify* a request.
 *   poll_token  long and random, generated on the device and never displayed.
 *               Only its hash is stored, and only its holder can collect the
 *               credential.
 *
 * That split is the whole security argument: seeing the code is not enough to
 * steal the pairing, and approving a code is not enough to obtain a credential.
 */

export interface PairingStart {
  userCode: string;
  /** Returned to the device once, never stored in plaintext. */
  pollToken: string;
  expiresAt: string;
}

export type PairingState =
  | { status: "pending" }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "unknown" }
  | { status: "approved"; token: string; deviceId: string; deviceName: string };

export interface PairingRequestView {
  id: string;
  userCode: string;
  deviceName: string;
  platform: string;
  appVersion: string;
  installationId: string | null;
  createdAt: string;
  expiresAt: string;
}

export function createPairingStore(admin: SupabaseClient<Database>) {
  const credentials = createSupabaseMinerStore(admin);

  /**
   * Reuse this user's live row for the installation, or insert a new one, and
   * point it at the new credential. Returns the credential it replaced, which
   * the caller revokes only once the pairing is complete.
   */
  async function claimDeviceRow(
    request: PairingRequestView,
    userId: string,
    credentialId: string,
  ): Promise<{ id: string; replacedCredentialId: string | null }> {
    if (request.installationId) {
      const { data: previous, error: findError } = await admin
        .from("miner_devices")
        .select("id, credential_id")
        .eq("user_id", userId)
        .eq("installation_id", request.installationId)
        .is("revoked_at", null)
        .maybeSingle();
      if (findError) throw new Error(`approvePairing: ${findError.message}`);

      if (previous) {
        const { error } = await admin
          .from("miner_devices")
          .update({
            name: request.deviceName,
            platform: request.platform,
            app_version: request.appVersion,
            credential_id: credentialId,
            // The reinstalled miner registers the key it holds now.
            public_key: null,
            public_key_algorithm: null,
            public_key_registered_at: null,
          })
          .eq("id", previous.id)
          .eq("user_id", userId);
        if (error) throw new Error(`approvePairing: ${error.message}`);
        return { id: previous.id, replacedCredentialId: previous.credential_id };
      }
    }

    const { data, error } = await admin
      .from("miner_devices")
      .insert({
        user_id: userId,
        name: request.deviceName,
        platform: request.platform,
        app_version: request.appVersion,
        installation_id: request.installationId,
        credential_id: credentialId,
      })
      .select("id")
      .single();
    if (error || !data) throw new Error(`approvePairing: ${error?.message}`);
    return { id: data.id, replacedCredentialId: null };
  }

  return {
    /** A device asks to be paired. Unauthenticated: nobody owns it yet. */
    async start(input: {
      deviceName: string;
      platform: string;
      appVersion: string;
      /** Untrusted, from the device. Kept only when it is a well-formed id. */
      installationId?: unknown;
    }): Promise<PairingStart> {
      const userCode = generateUserCode();
      const pollToken = generatePollToken();

      const { data, error } = await admin
        .from("miner_pairing_requests")
        .insert({
          user_code: userCode,
          poll_token_hash: hashPollToken(pollToken),
          device_name: input.deviceName.slice(0, 60),
          platform: input.platform.slice(0, 40),
          app_version: input.appVersion.slice(0, 20),
          installation_id: parseInstallationId(input.installationId),
        })
        .select("expires_at")
        .single();
      if (error || !data) throw new Error(`startPairing: ${error?.message ?? "no row"}`);

      return { userCode, pollToken, expiresAt: data.expires_at };
    },

    /** What the approving user is about to authorize. Shown before they act. */
    async lookup(userCode: string): Promise<PairingRequestView | null> {
      const { data } = await admin
        .from("miner_pairing_requests")
        .select("id, user_code, device_name, platform, app_version, installation_id, created_at, expires_at")
        .eq("user_code", normalizeUserCode(userCode))
        .is("collected_at", null)
        .is("denied_at", null)
        .gt("expires_at", new Date().toISOString())
        .maybeSingle();
      if (!data) return null;

      return {
        id: data.id,
        userCode: data.user_code,
        deviceName: data.device_name,
        platform: data.platform,
        appVersion: data.app_version,
        installationId: data.installation_id,
        createdAt: data.created_at,
        expiresAt: data.expires_at,
      };
    },

    /**
     * A signed-in user approves a device.
     *
     * This is where ownership is established, and it is the only place: the
     * device never says who it belongs to. The credential is minted here and
     * bound to both the approving user and the device row.
     *
     * The same installation pairing again reuses the approving user's live row
     * for it (migration 0028), so mappings and local-event dedupe survive a
     * sign-out. Its previous credential is revoked, and its signing key is
     * cleared so the miner can register the key it holds now.
     */
    async approve(userCode: string, userId: string): Promise<{ deviceId: string } | null> {
      const request = await this.lookup(userCode);
      if (!request) return null;

      // Mint first, revoke last: whatever fails in between, a device that was
      // working keeps a working credential (the rule rotate() follows too).
      const minted = await credentials.create(userId, request.deviceName);

      // Claim the request before touching any device. A second approval of the
      // same code finds it taken and changes nothing.
      const { data: claimed, error: claimError } = await admin
        .from("miner_pairing_requests")
        .update({
          approved_by: userId,
          approved_at: new Date().toISOString(),
          credential_id: minted.credentialId,
        })
        .eq("id", request.id)
        .is("approved_at", null)
        .select("id");
      if (claimError || (claimed ?? []).length === 0) {
        await credentials.revoke(minted.credentialId).catch(() => undefined);
        if (claimError) throw new Error(`approvePairing: ${claimError.message}`);
        return null;
      }

      let device: { id: string; replacedCredentialId: string | null };
      try {
        device = await claimDeviceRow(request, userId, minted.credentialId);

        const { error: bindError } = await admin
          .from("usage_miner_credentials")
          .update({ device_id: device.id })
          .eq("id", minted.credentialId);
        if (bindError) throw new Error(`approvePairing: ${bindError.message}`);

        // The plaintext token is parked on the pairing row for one collection,
        // and only now: until this write the device keeps polling "pending".
        // It is unreachable without the poll token, and cleared the moment the
        // device picks it up.
        const { error } = await admin
          .from("miner_pairing_requests")
          .update({ device_id: device.id, pending_token: minted.token })
          .eq("id", request.id);
        if (error) throw new Error(`approvePairing: ${error.message}`);
      } catch (failure) {
        // Never delivered, so never usable -- but do not leave it live.
        await credentials.revoke(minted.credentialId).catch(() => undefined);
        throw failure;
      }

      if (device.replacedCredentialId && device.replacedCredentialId !== minted.credentialId) {
        await credentials.revoke(device.replacedCredentialId);
      }

      return { deviceId: device.id };
    },

    async deny(userCode: string): Promise<boolean> {
      const { data } = await admin
        .from("miner_pairing_requests")
        .update({ denied_at: new Date().toISOString() })
        .eq("user_code", normalizeUserCode(userCode))
        .is("denied_at", null)
        .is("collected_at", null)
        .select("id");
      return (data ?? []).length > 0;
    },

    /**
     * The device collects its credential.
     *
     * Authenticated by the poll token alone, and exactly once: the token is
     * cleared in the same statement that marks the request collected, so a
     * replayed poll returns nothing even if the token leaked afterwards.
     */
    async collect(pollToken: string): Promise<PairingState> {
      const { data } = await admin
        .from("miner_pairing_requests")
        .select("id, approved_at, denied_at, expires_at, pending_token, device_id, device_name, collected_at")
        .eq("poll_token_hash", hashPollToken(pollToken))
        .maybeSingle();

      if (!data) return { status: "unknown" };
      if (data.denied_at) return { status: "denied" };
      if (data.collected_at) return { status: "unknown" };
      if (new Date(data.expires_at).getTime() < Date.now()) return { status: "expired" };
      if (!data.approved_at || !data.pending_token) return { status: "pending" };

      const { data: claimed } = await admin
        .from("miner_pairing_requests")
        .update({ collected_at: new Date().toISOString(), pending_token: null })
        .eq("id", data.id)
        .is("collected_at", null)
        .select("id");
      // Somebody else collected it in the meantime.
      if ((claimed ?? []).length === 0) return { status: "unknown" };

      return {
        status: "approved",
        token: data.pending_token,
        deviceId: data.device_id ?? "",
        deviceName: data.device_name,
      };
    },
  };
}
