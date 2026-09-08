import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { decryptSecret, encryptSecret, secretHint, secretsConfigured } from "./crypto";

/**
 * Where provider credentials live.
 *
 * The application never learns which backend holds a secret: it holds an opaque
 * reference and asks the store. That indirection is the point -- moving from
 * application-level encryption to Supabase Vault changes this file and nothing
 * else, and a future move changes it again.
 *
 * Two backends today:
 *
 *   vault   production. Postgres-managed authenticated encryption; the key is
 *           never in application configuration, so rotating an app env var
 *           cannot orphan a credential.
 *   aes     local and test. AES-256-GCM under a server key, which works
 *           everywhere including the in-process Postgres the tests run against.
 *
 * A secret is written once and read only by trusted server code making an
 * outbound request. It is never returned to a browser, never logged, never put
 * in a receipt.
 */

export type SecretBackend = "vault" | "aes";

export interface StoredSecretRef {
  /** Opaque handle. Meaningless without the backend that issued it. */
  id: string;
  backend: SecretBackend;
  /** Last four characters, so a UI can identify a key without holding it. */
  hint: string | null;
}

export interface SecretStore {
  readonly backend: SecretBackend;
  create(input: { userId: string; secret: string; label?: string }): Promise<StoredSecretRef>;
  read(ref: { id: string; userId: string }): Promise<string>;
  update(ref: { id: string; userId: string; secret: string }): Promise<void>;
  delete(ref: { id: string; userId: string }): Promise<void>;
}

export class SecretStoreError extends Error {
  constructor(
    readonly code: "not_found" | "unavailable" | "denied",
    message: string,
  ) {
    super(message);
    this.name = "SecretStoreError";
  }
}

/**
 * Application-level AES store.
 *
 * Ciphertext in `provider_secrets`, key in server configuration. Its one
 * operational weakness is exactly why Vault exists: rotating
 * USAGE_SECRET_ENCRYPTION_KEY makes every stored credential unreadable.
 */
export function createAesSecretStore(admin: SupabaseClient<Database>): SecretStore {
  return {
    backend: "aes",

    async create({ userId, secret }) {
      const { data, error } = await admin
        .from("provider_secrets")
        .insert({
          user_id: userId,
          ciphertext: encryptSecret(secret),
          hint: secretHint(secret),
          backend: "aes",
        })
        .select("id, hint")
        .single();
      if (error || !data) {
        throw new SecretStoreError("unavailable", `storeSecret: ${error?.message ?? "no row"}`);
      }
      return { id: data.id, backend: "aes", hint: data.hint };
    },

    async read({ id, userId }) {
      const { data, error } = await admin
        .from("provider_secrets")
        .select("ciphertext")
        .eq("id", id)
        // Ownership is a WHERE clause, not a check a caller can skip.
        .eq("user_id", userId)
        .maybeSingle();
      if (error) throw new SecretStoreError("unavailable", `readSecret: ${error.message}`);
      if (!data?.ciphertext) throw new SecretStoreError("not_found", "No such secret.");
      return decryptSecret(data.ciphertext);
    },

    async update({ id, userId, secret }) {
      const { error } = await admin
        .from("provider_secrets")
        .update({
          ciphertext: encryptSecret(secret),
          hint: secretHint(secret),
          rotated_at: new Date().toISOString(),
        })
        .eq("id", id)
        .eq("user_id", userId);
      if (error) throw new SecretStoreError("unavailable", `updateSecret: ${error.message}`);
    },

    async delete({ id, userId }) {
      const { error } = await admin
        .from("provider_secrets")
        .delete()
        .eq("id", id)
        .eq("user_id", userId);
      if (error) throw new SecretStoreError("unavailable", `deleteSecret: ${error.message}`);
    },
  };
}

/**
 * Supabase Vault store.
 *
 * The `vault` schema is not reachable through PostgREST, so access goes through
 * four SECURITY DEFINER functions with `search_path = ''`, every object
 * schema-qualified, EXECUTE revoked from public/anon/authenticated and granted
 * only to `service_role` (see migration 0012).
 *
 * They are deliberately NOT a general secret-reading RPC: the read function
 * takes the owning user id and refuses a row that is not theirs, so even a
 * service-role caller cannot use it to enumerate other users' credentials.
 *
 * `provider_secrets` still holds the row that ties a user to a secret; the
 * ciphertext column stays null, because Vault holds the ciphertext.
 */
export function createVaultSecretStore(admin: SupabaseClient<Database>): SecretStore {
  async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await admin.rpc(fn as never, args as never);
    if (error) {
      // The message never carries the secret, and never the upstream detail.
      throw new SecretStoreError("unavailable", `${fn}: ${error.message}`);
    }
    return data as T;
  }

  return {
    backend: "vault",

    async create({ userId, secret, label }) {
      const secretId = await rpc<string>("usage_vault_create_secret", {
        p_user_id: userId,
        p_secret: secret,
        p_label: label ?? "provider credential",
      });
      return { id: secretId, backend: "vault", hint: secretHint(secret) };
    },

    async read({ id, userId }) {
      const secret = await rpc<string | null>("usage_vault_read_secret", {
        p_user_id: userId,
        p_secret_id: id,
      });
      if (secret === null) throw new SecretStoreError("not_found", "No such secret.");
      return secret;
    },

    async update({ id, userId, secret }) {
      await rpc<void>("usage_vault_update_secret", {
        p_user_id: userId,
        p_secret_id: id,
        p_secret: secret,
      });
    },

    async delete({ id, userId }) {
      await rpc<void>("usage_vault_delete_secret", { p_user_id: userId, p_secret_id: id });
    },
  };
}

/**
 * Is Vault usable on this database?
 *
 * Checked rather than assumed: the in-process Postgres the integration tests
 * run against has no Vault, and a credential path that silently fails is worse
 * than one that says so.
 */
export async function vaultAvailable(admin: SupabaseClient<Database>): Promise<boolean> {
  const { error } = await admin.rpc("usage_vault_available" as never);
  return !error;
}

/**
 * The store to use.
 *
 * Vault when the database offers it, application AES otherwise. Preferring
 * Vault means production credentials stop depending on an application
 * environment variable, which is the operational weakness M8 shipped with.
 */
export async function resolveSecretStore(
  admin: SupabaseClient<Database>,
): Promise<SecretStore> {
  if (await vaultAvailable(admin)) return createVaultSecretStore(admin);
  if (!secretsConfigured()) {
    throw new SecretStoreError(
      "unavailable",
      "No secret backend is available: Vault is absent and USAGE_SECRET_ENCRYPTION_KEY is not set.",
    );
  }
  return createAesSecretStore(admin);
}

/** Read a secret whichever backend holds it, from its recorded reference. */
export function storeForBackend(
  admin: SupabaseClient<Database>,
  backend: SecretBackend,
): SecretStore {
  return backend === "vault" ? createVaultSecretStore(admin) : createAesSecretStore(admin);
}
