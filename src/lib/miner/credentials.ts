import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, MinerCredentialRow } from "@/lib/supabase/database.types";
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
}

export type MinerAuthResult =
  | { ok: true; identity: MinerIdentity }
  | { ok: false; reason: "missing" | "malformed" | "unknown" | "revoked" };

export interface MinerCredentialStore {
  findByTokenHash(tokenHash: string): Promise<(MinerCredentialRow & { id: string }) | null>;
  touch(credentialId: string): Promise<void>;
  create(userId: string, name: string): Promise<{ credentialId: string; token: string }>;
  revoke(credentialId: string): Promise<void>;
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
  return { credentialId: "dev-miner", userId, name: "development" };
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
    identity: { credentialId: row.id, userId: row.user_id, name: row.name },
  };
}
