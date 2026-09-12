/**
 * Put credit into somebody's wallet, by hand.
 *
 *   npm run wallet:grant -- --email someone@example.com --usd 5 --note "beta tester"
 *   npm run wallet:grant -- --wallet USG-4K7M-2QX9 --usd 5
 *   npm run wallet:grant -- --email someone@example.com --usd 5 --kind topup --reference pi_123
 *
 * The wallet id is the identifier a person can quote without handing over
 * their email address, which is why it is accepted here.
 *
 * This is the operator's path, and until payments exist it is the only one.
 * Every entry carries a reference so it can never be applied twice: give one,
 * or a dated default is generated for you.
 *
 * Credit is money for inference. It is NOT USAGE Points and cannot become
 * them. Nothing in this script or anywhere else converts between the two.
 */
import { createAdminSupabase } from "../src/lib/supabase/admin";
import { creditWallet, readWallet, userIdForWalletId } from "../src/lib/wallet/store";
import { usdStringToMicros } from "../src/lib/domain/money";

function line(text = ""): void {
  process.stdout.write(`${text}\n`);
}

function arg(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

async function main(): Promise<number> {
  const email = arg("email");
  const wallet = arg("wallet");
  const usd = arg("usd");
  const kind = (arg("kind") ?? "grant") as "grant" | "topup" | "refund" | "adjustment";
  const note = arg("note") ?? undefined;
  const reference = arg("reference") ?? `manual-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}`;

  if ((!email && !wallet) || !usd) {
    line("Usage: npm run wallet:grant -- (--email <address> | --wallet USG-XXXX-XXXX) --usd <amount> [--kind grant|topup|refund|adjustment] [--note text] [--reference key]");
    return 1;
  }

  let micros: number;
  try {
    micros = Number(usdStringToMicros(usd));
  } catch {
    line(`Not an amount: ${usd}`);
    return 1;
  }

  const admin = createAdminSupabase();

  let userId: string | null = null;
  let who = "";

  if (wallet) {
    userId = await userIdForWalletId(admin, wallet);
    who = wallet.trim().toUpperCase();
    if (!userId) {
      line(`No wallet with that id: ${who}`);
      return 1;
    }
  } else {
    // `listUsers` rather than a filter: the admin API has no email lookup, and
    // this is an operator script run against a small user table.
    const { data: users, error } = await admin.auth.admin.listUsers({ perPage: 1000 });
    if (error) {
      line(`Could not read the user list: ${error.message}`);
      return 1;
    }
    const user = users.users.find((candidate) => candidate.email?.toLowerCase() === email!.toLowerCase());
    if (!user) {
      line(`No account with that email: ${email}`);
      return 1;
    }
    userId = user.id;
    who = email!;
  }

  const before = await readWallet(admin, userId);
  if (!before.persisted) {
    line("The wallet ledger does not exist on this deployment yet. Apply migration 0024 first.");
    return 1;
  }

  const result = await creditWallet(admin, {
    userId,
    kind,
    amountMicros: micros,
    reference,
    note,
    createdBy: "operator",
  });

  if (!result.ok) {
    line(`Refused: ${result.reason}`);
    return 1;
  }

  if (result.duplicate) {
    line(`Already applied: reference "${reference}" is already in this wallet. Nothing changed.`);
    return 0;
  }

  const after = await readWallet(admin, userId);
  line(`${who}${after.walletId && after.walletId !== who ? `  (${after.walletId})` : ""}`);
  line(`  ${kind}: ${usd} USD  (reference ${reference})`);
  line(`  balance: ${(before.balanceMicros / 1_000_000).toFixed(4)} -> ${(after.balanceMicros / 1_000_000).toFixed(4)} USD`);
  line();
  line("This is credit for inference. It is not USAGE Points and earns none.");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    line(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
