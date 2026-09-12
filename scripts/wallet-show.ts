/**
 * Every wallet, and what is in it.
 *
 *   npm run wallet:show
 *   npm run wallet:show -- --email someone@example.com
 *
 * Reads only. Credit comes from the ledger, spend from the persisted usage
 * rows, exactly as the wallet page computes it -- so if this disagrees with
 * what somebody sees, one of the two is wrong and it matters.
 */
import { createAdminSupabase } from "../src/lib/supabase/admin";
import { readWallet } from "../src/lib/wallet/store";
import { formatUsd } from "../src/lib/domain/money";

function line(text = ""): void {
  process.stdout.write(`${text}\n`);
}

function arg(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

const usd = (micros: number) => formatUsd(micros, { maximumFractionDigits: 6 });

async function main(): Promise<number> {
  const only = arg("email");
  const admin = createAdminSupabase();

  const { data, error } = await admin.auth.admin.listUsers({ perPage: 1000 });
  if (error) {
    line(`Could not read the user list: ${error.message}`);
    return 1;
  }

  const users = only
    ? data.users.filter((user) => user.email?.toLowerCase() === only.toLowerCase())
    : data.users;

  if (users.length === 0) {
    line(only ? `No account with that email: ${only}` : "No accounts.");
    return 1;
  }

  let totalBalance = 0;
  let totalPaid = 0;

  for (const user of users) {
    const wallet = await readWallet(admin, user.id);
    totalBalance += wallet.balanceMicros;
    totalPaid += wallet.paidMicros;

    line(`${user.email ?? user.id}`);
    line(`  balance   ${usd(wallet.balanceMicros)}   (credited ${usd(wallet.creditedMicros)}, spent ${usd(wallet.spentMicros)})`);
    line(`  of which  granted ${usd(wallet.grantedMicros)}, paid in ${usd(wallet.paidMicros)}`);
    line(`  today     ${usd(wallet.todayMicros)} across ${wallet.requestsToday} messages`);
    if (wallet.overdrawnMicros > 0) line(`  overdrawn ${usd(wallet.overdrawnMicros)} (one reply past the balance, not collected)`);
    if (!wallet.persisted) line("  ledger    NOT PERSISTED -- migration 0024 has not been applied here");
    line();
  }

  if (users.length > 1) {
    line(`${users.length} accounts. Outstanding credit ${usd(totalBalance)}, of which ${usd(totalPaid)} was paid in.`);
    line();
    line("Outstanding credit is a liability: it is USAGE's money until it is spent.");
  }

  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    line(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
