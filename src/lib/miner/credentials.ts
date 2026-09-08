import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, MinerCredentialRow, MinerScope } from "@/lib/supabase/database.types";
import { hashesMatch, hashMinerToken, looksLikeMinerToken, mintMinerToken } from "./token";

/**
 * Resolving a miner credential to a user.
 *
 * A rejected credential must never reach the AI Gateway: an unauthenticated or
 * revoked miner is not allowed to spend USAGE's upstream budget, let alone earn
 * anything.
 */

export interface MinerIdentity {
  credentialId: string;
  userId: string;
  name: string;
  scopes: MinerScope[];
}

/**
 * Everything a device credential is ever given.
 *
 * Named here rather than assembled at each call site, so widening what a miner
 * can do is a deliberate edit to one list -- not something that happens by
 * accident when a new endpoint copies the wrong constant.
 */
export const DEVICE_SCOPES: MinerScope[] = [
  "miner:route",
  "miner:config",
  "miner:heartbeat",
  "miner:rotate",
];

/**
 * Does this credential carry the scope an endpoint needs?
 *
 * A credential with no scopes recorded predates migration 0016 and is treated
 * as a full device credential -- which is exactly what it was. Nothing is
 * silently widened: that set is the same one every device has always had.
 */
export function hasScope(identity: MinerIdentity, scope: MinerScope): boolean {
  const scopes = identity.scopes.length > 0 ? identity.scopes : DEVICE_SCOPES;
  return scopes.includes(scope);
}

export type MinerAuthResult =
  | { ok: true; identity: MinerIdentity }
  | { ok: false; reason: "missing" | "malformed" | "unknown" | "revoked" };

export interface MinerCredentialStore {
  findByTokenHash(tokenHash: string): Promise<(MinerCredentialRow & { id: string }) | null>;
  touch(credentialId: string): Promise<void>;
  create(userId: string, name: string): Promise<{ credentialId: string; token: string }>;
  revoke(credentialId: string): Promise<void>;
  /** Mint a replacement and retire the old credential in one step. */
  rotate(
    credentialId: string,
    userId: string,
    name: string,
  ): Promise<{ credentialId: string; token: string }>;
}

export function createSupabaseMinerStore(
  admin: SupabaseClient<Database>,
): MinerCredentialStore {
  return {
    async findByTokenHash(tokenHash) {
      const { data, error } = await admin
        .from("usage_miner_credentials")
        .select("*")
        .eq("token_hash", tokenHash)
        .maybeSingle();
      if (error) throw new Error(`findByTokenHash: ${error.message}`);
      return data ?? null;
    },

    async touch(credentialId) {
      await admin
        .from("usage_miner_credentials")
        .update({ last_used_at: new Date().toISOString() })
        .eq("id", credentialId);
    },

    async create(userId, name) {
      const minted = mintMinerToken();
      const { data, error } = await admin
        .from("usage_miner_credentials")
        .insert({
          user_id: userId,
          name,
          token_hash: minted.tokenHash,
          token_prefix: minted.tokenPrefix,
          scopes: DEVICE_SCOPES,
        })
        .select("id")
        .single();
      if (error) throw new Error(`createMinerCredential: ${error.message}`);
      // The plaintext is returned to the caller once and never stored.
      return { credentialId: data.id, token: minted.token };
    },

    async revoke(credentialId) {
      const { error } = await admin
        .from("usage_miner_credentials")
        .update({ revoked_at: new Date().toISOString() })
        .eq("id", credentialId);
      if (error) throw new Error(`revokeMinerCredential: ${error.message}`);
    },

    /**
     * Replace a credential, and retire the one it replaces.
     *
     * The new credential is minted first: if anything fails after that the
     * device is left holding a working token rather than none. The old row is
     * then revoked and pointed at its successor, so an audit can follow why a
     * device's credential changed without anyone having to remember.
     *
     * Neither token is logged. The old one is not even read -- its value is
     * irrelevant, since the reason for rotating is that it must be assumed
     * compromised.
     */
    async rotate(credentialId, userId, name) {
      const minted = await this.create(userId, name);

      const { error } = await admin
        .from("usage_miner_credentials")
        .update({
          revoked_at: new Date().toISOString(),
          rotated_at: new Date().toISOString(),
          rotated_to: minted.credentialId,
        })
        .eq("id", credentialId)
        // Belt and braces: a credential can only retire itself, for its owner.
        .eq("user_id", userId);
      if (error) throw new Error(`rotateMinerCredential: ${error.message}`);

      // Carry the device binding across, so /miners still shows one device.
      const { data: previous } = await admin
        .from("usage_miner_credentials")
        .select("device_id")
        .eq("id", credentialId)
        .maybeSingle();
      if (previous?.device_id) {
        await admin
          .from("usage_miner_credentials")
          .update({ device_id: previous.device_id })
          .eq("id", minted.credentialId);
        await admin
          .from("miner_devices")
          .update({ credential_id: minted.credentialId })
          .eq("id", previous.device_id);
      }

      return minted;
    },
  };
}

/**
 * Development credential.
 *
 * Local work needs a working miner before a hosted database exists. Only the
 * HASH is configured (`USAGE_DEV_MINER_TOKEN_HASH`), so the plaintext never
 * lands in a config file, and it resolves to a fixed development user id. This
 * path exists solely so the gateway can be exercised locally -- everything it
 * produces is development-trust evidence and earns nothing.
 */
export function devMinerIdentity(tokenHash: string): MinerIdentity | null {
  const expected = process.env.USAGE_DEV_MINER_TOKEN_HASH?.trim();
  const userId = process.env.USAGE_DEV_MINER_USER_ID?.trim();
  if (!expected || !userId) return null;
  if (!hashesMatch(tokenHash, expected)) return null;
  // A development credential gets the same device scopes and nothing more.
  return { credentialId: "dev-miner", userId, name: "development", scopes: DEVICE_SCOPES };
}

export async function authenticateMiner(
  presented: string | null,
  store: MinerCredentialStore | null,
): Promise<MinerAuthResult> {
  if (!presented) return { ok: false, reason: "missing" };
  if (!looksLikeMinerToken(presented)) return { ok: false, reason: "malformed" };

  const tokenHash = hashMinerToken(presented);

  const dev = devMinerIdentity(tokenHash);
  if (dev) return { ok: true, identity: dev };

  if (!store) return { ok: false, reason: "unknown" };

  const row = await store.findByTokenHash(tokenHash);
  if (!row) return { ok: false, reason: "unknown" };
  if (row.revoked_at) return { ok: false, reason: "revoked" };

  return {
    ok: true,
    identity: {
      credentialId: row.id,
      userId: row.user_id,
      name: row.name,
      scopes: row.scopes ?? [],
    },
  };
}
