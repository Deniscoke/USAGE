/**
 * Mint a USAGE miner credential.
 *
 *   npm run miner:token                     # local development credential
 *   npm run miner:token -- --user <uuid>    # stored credential (needs Supabase)
 *
 * The plaintext token is printed ONCE and never stored anywhere by this script.
 * Only its SHA-256 hash is persisted (or configured, in development).
 */
import { mintMinerToken } from "../src/lib/miner/token";
import { isSupabaseConfigured } from "../src/lib/supabase/env";

const args = process.argv.slice(2);
const userId = readFlag("--user");
const name = readFlag("--name") ?? "development";

function readFlag(flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function line(text = ""): void {
  process.stdout.write(`${text}\n`);
}

async function main(): Promise<number> {
  if (userId && isSupabaseConfigured()) {
    const { createAdminSupabase } = await import("../src/lib/supabase/admin");
    const { createSupabaseMinerStore } = await import("../src/lib/miner/credentials");

    const store = createSupabaseMinerStore(createAdminSupabase());
    const created = await store.create(userId, name);

    line("USAGE miner credential created (stored as a hash).");
    line();
    line(created.token);
    line();
    line("Copy it now: it cannot be shown again.");
    return 0;
  }

  const minted = mintMinerToken();

  line("USAGE development miner credential");
  line("----------------------------------");
  line();
  line("Token (shown once — copy it now):");
  line();
  line(`  ${minted.token}`);
  line();
  line("Add ONLY the hash to .env.local, so the plaintext lives nowhere on disk:");
  line();
  line(`  USAGE_DEV_MINER_TOKEN_HASH=${minted.tokenHash}`);
  line("  USAGE_DEV_MINER_USER_ID=<a profile uuid, or any stable dev id>");
  line();
  line("Development credentials produce development-trust evidence only:");
  line("routed and visible, but economically pending — they earn nothing.");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    line(`Failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
