/**
 * Move provider credentials from application AES encryption into Supabase Vault.
 *
 *   npm run usage:secrets:migrate -- --dry-run
 *   npm run usage:secrets:migrate -- --confirm
 *
 * IDEMPOTENT. A secret already marked `vault` is skipped, so running twice is a
 * no-op and a partial run can simply be re-run.
 *
 * SAFE ORDER, deliberately: read the old value, write it to Vault, verify the
 * Vault copy reads back byte-for-byte, repoint the connection, and only then
 * clear the old ciphertext. If any step fails the old value is still there and
 * the connection still works.
 *
 * No credential is ever printed. Progress is reported by id and by hint.
 */
import { createClient } from "@supabase/supabase-js";
import { decryptSecret } from "../src/lib/secrets/crypto";
import { createVaultSecretStore, vaultAvailable } from "../src/lib/secrets/store";
import type { Database } from "../src/lib/supabase/database.types";

const line = (text = "") => process.stdout.write(`${text}\n`);

async function main(): Promise<number> {
  const confirmed = process.argv.includes("--confirm");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !secret) {
    line("Supabase is not configured.");
    return 1;
  }

  const admin = createClient<Database>(url, secret, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  line("USAGE — provider secret migration (AES -> Vault)");
  line("================================================");
  line();

  if (!(await vaultAvailable(admin))) {
    line("Vault is not available on this database. Nothing to do.");
    line("Credentials stay on the application AES backend.");
    return 1;
  }
  line("Vault  : available");

  const { data, error } = await admin
    .from("provider_secrets")
    .select("id, user_id, hint, backend, ciphertext")
    .eq("backend", "aes");
  if (error) {
    line(`Could not list secrets: ${error.message}`);
    return 1;
  }

  const pending = (data ?? []).filter((row) => row.ciphertext !== null);
  line(`Pending: ${pending.length} AES secret(s)`);
  line();

  if (pending.length === 0) {
    // The common case on a fresh deployment, and worth saying plainly rather
    // than dressing up as work.
    line("No AES-encrypted credentials exist. Nothing to migrate.");
    line("New credentials will be written straight to Vault.");
    return 0;
  }

  if (!confirmed) {
    for (const row of pending) {
      line(`  would migrate ${row.id}  (key ${row.hint ?? "?"})`);
    }
    line();
    line("Dry run. Re-run with --confirm to migrate.");
    return 0;
  }

  const vault = createVaultSecretStore(admin);
  let migrated = 0;
  let failed = 0;

  for (const row of pending) {
    try {
      // 1. Read the old value with the key that is still configured.
      const plaintext = decryptSecret(row.ciphertext!);

      // 2. Write it to Vault under the same owner.
      const created = await vault.create({
        userId: row.user_id,
        secret: plaintext,
        label: `migrated ${row.hint ?? ""}`.trim(),
      });

      // 3. VERIFY before destroying anything. A Vault copy that does not read
      //    back is not a copy.
      const readBack = await vault.read({ id: created.id, userId: row.user_id });
      if (readBack !== plaintext) {
        line(`  FAILED ${row.id}: Vault copy did not match; old value left intact.`);
        failed += 1;
        continue;
      }

      // 4. Repoint the connections that used the old secret.
      const { error: repointError } = await admin
        .from("provider_connections")
        .update({ secret_id: created.id })
        .eq("secret_id", row.id);
      if (repointError) {
        line(`  FAILED ${row.id}: could not repoint connections; old value left intact.`);
        failed += 1;
        continue;
      }

      // 5. Only now remove the old ciphertext.
      await admin.from("provider_secrets").delete().eq("id", row.id);

      line(`  migrated ${row.id} -> ${created.id}  (key ${row.hint ?? "?"})`);
      migrated += 1;
    } catch (caught) {
      // Never print the error verbatim: it could carry the value.
      void caught;
      line(`  FAILED ${row.id}: old value left intact.`);
      failed += 1;
    }
  }

  line();
  line(`Migrated: ${migrated}`);
  line(`Failed  : ${failed}`);
  if (failed === 0 && migrated > 0) {
    line();
    line("USAGE_SECRET_ENCRYPTION_KEY is no longer the root of trust for hosted");
    line("provider credentials. Keep it configured for local development and tests.");
  }
  return failed === 0 ? 0 : 1;
}

main().then((code) => process.exit(code));
