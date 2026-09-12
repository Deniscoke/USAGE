import Link from "next/link";
import { redirect } from "next/navigation";
import { createServerSupabase } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { readWallet } from "@/lib/wallet/store";
import { walletDailyCapMicros } from "@/lib/wallet/balance";
import { formatUsd } from "@/lib/domain/money";
import { ChatDock } from "@/components/chat/chat-dock";
import { WalletId } from "@/components/wallet-id";

export const dynamic = "force-dynamic";

/**
 * The wallet.
 *
 * Credit that buys replies on USAGE's own key, and the ledger it came from.
 * Read as the signed-in user, so RLS decides what is visible rather than this
 * file deciding it.
 *
 * The page says plainly, more than once, that credit is not points. They are
 * two different things that both look like a number next to a name, and a
 * person who confuses them will draw exactly the wrong conclusion about what
 * USAGE is.
 */

const KIND_LABEL: Record<string, string> = {
  grant: "Grant from USAGE",
  topup: "Top-up",
  refund: "Refund",
  adjustment: "Adjustment",
};

export default async function WalletPage() {
  if (!isSupabaseConfigured()) redirect("/");

  const supabase = await createServerSupabase();
  if (!supabase) redirect("/");

  const { data: auth } = await supabase.auth.getUser();
  const user = auth.user;
  if (!user) redirect("/login?next=/wallet");

  const wallet = await readWallet(supabase, user.id);
  const dailyCap = walletDailyCapMicros(wallet);
  const spentShare = wallet.creditedMicros > 0 ? Math.round((100 * wallet.balanceMicros) / wallet.creditedMicros) : 0;

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:px-6">
      <header className="mb-8 flex flex-wrap items-center justify-between gap-3">
        <Link href="/dashboard" className="tnum text-sm font-medium tracking-[0.3em]">
          USAGE
        </Link>
        <div className="flex items-center gap-3">
          <span className="text-[11px] text-[var(--muted)]">{user.email}</span>
          <ChatDock />
        </div>
      </header>

      <h1 className="text-3xl font-medium tracking-tight">Wallet</h1>
      <p className="mt-3 max-w-2xl text-sm leading-relaxed text-[var(--muted)]">
        Credit pays for chat that runs on USAGE&apos;s own provider key. It is money, measured in
        US dollars, and it is spent when you send a message. It is not USAGE Points, it does not
        become USAGE Points, and no amount of it earns any.
      </p>

      {wallet.walletId && (
        <section className="mt-8 flex flex-wrap items-center justify-between gap-4 rounded-lg border border-[var(--border)] px-5 py-4">
          <div>
            <span className="text-[10px] uppercase tracking-[0.12em] text-[var(--faint)]">Wallet ID</span>
            <p className="mt-1 text-[11px] leading-relaxed text-[var(--muted)]">
              Quote this instead of your email. It identifies your wallet and grants nothing on its own.
            </p>
          </div>
          <WalletId walletId={wallet.walletId} />
        </section>
      )}

      <section className="mt-6 rounded-lg border border-[var(--border)] p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <span className="text-[10px] uppercase tracking-[0.12em] text-[var(--faint)]">Balance</span>
          <span
            className="tnum text-3xl"
            style={{ color: wallet.balanceMicros > 0 ? "var(--foreground)" : "var(--warn)" }}
          >
            {formatUsd(wallet.balanceMicros, { maximumFractionDigits: 4 })}
          </span>
        </div>

        <div className="chat-credit__bar mt-3" aria-hidden="true">
          <span style={{ width: `${Math.max(0, Math.min(100, spentShare))}%` }} />
        </div>

        <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-3 text-xs sm:grid-cols-4">
          <Figure label="Credited" value={formatUsd(wallet.creditedMicros, { maximumFractionDigits: 4 })} />
          <Figure label="Spent" value={formatUsd(wallet.spentMicros, { maximumFractionDigits: 4 })} />
          <Figure label="Given by USAGE" value={formatUsd(wallet.grantedMicros, { maximumFractionDigits: 4 })} />
          <Figure label="Paid in" value={formatUsd(wallet.paidMicros, { maximumFractionDigits: 4 })} />
        </dl>

        <p className="mt-5 text-[11px] leading-relaxed text-[var(--faint)]">
          Today: {formatUsd(wallet.todayMicros, { maximumFractionDigits: 4 })} of{" "}
          {formatUsd(dailyCap, { maximumFractionDigits: 2 })} spent across {wallet.requestsToday} messages. The
          daily limit resets at midnight UTC.
          {wallet.overdrawnMicros > 0 && (
            <>
              {" "}
              The last reply ran {formatUsd(wallet.overdrawnMicros, { maximumFractionDigits: 4 })} past the
              balance, because a reply&apos;s cost is only known once it has been written. It is not owed and
              will not be collected.
            </>
          )}
        </p>
      </section>

      <section className="mt-6 rounded-lg border border-[var(--border)] p-5">
        <h2 className="text-sm font-medium">Adding credit</h2>
        <p className="mt-2 text-[12px] leading-relaxed text-[var(--muted)]">
          Top-ups are not open yet. Taking payment needs a company, VAT registration and a payment
          processor, and none of that exists today. When it does, a top-up will appear in the ledger
          below like any other entry, and this page will be where it happens.
        </p>
        <p className="mt-3 text-[12px] leading-relaxed text-[var(--muted)]">
          Until then there are two ways to keep chatting. Connect a paid provider of your own, which
          costs you nothing here and is the only route that earns USAGE Points. Or ask the operator
          for a grant.
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          <Link
            href="/providers"
            className="rounded-md border border-[var(--border-strong)] px-3 py-1.5 text-xs text-[var(--muted)] hover:border-[var(--verified)] hover:text-[var(--foreground)]"
          >
            Connect a provider
          </Link>
          <Link
            href="/dashboard"
            className="rounded-md border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--muted)] hover:text-[var(--foreground)]"
          >
            See what you have earned
          </Link>
        </div>
      </section>

      <section className="mt-6">
        <h2 className="text-sm font-medium">Ledger</h2>
        <p className="mt-2 text-[12px] leading-relaxed text-[var(--muted)]">
          Every movement of credit into this wallet. Spending is not listed here: it is measured from
          your actual usage records, which is why the balance above can never disagree with what your
          messages really cost.
        </p>

        {!wallet.persisted && (
          <p className="mt-3 rounded-md border border-[var(--border)] px-3 py-2 text-[11px] text-[var(--faint)]">
            The ledger table is not on this deployment yet, so only the starting grant is shown.
          </p>
        )}

        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[32rem] text-left text-xs">
            <thead className="text-[10px] uppercase tracking-[0.12em] text-[var(--faint)]">
              <tr>
                <th className="pb-2 font-normal">Date</th>
                <th className="pb-2 font-normal">Kind</th>
                <th className="pb-2 font-normal">Note</th>
                <th className="pb-2 text-right font-normal">Amount</th>
              </tr>
            </thead>
            <tbody className="text-[var(--muted)]">
              {wallet.entries.map((entry, index) => (
                <tr key={`${entry.reference ?? "entry"}-${index}`} className="border-t border-[var(--border)]">
                  <td className="py-2 tnum">
                    {entry.createdAt.startsWith("1970") ? "—" : entry.createdAt.slice(0, 10)}
                  </td>
                  <td className="py-2">{KIND_LABEL[entry.kind] ?? entry.kind}</td>
                  <td className="py-2">{entry.note ?? "—"}</td>
                  <td className="py-2 text-right tnum" style={{ color: entry.amountMicros < 0 ? "var(--warn)" : undefined }}>
                    {entry.amountMicros > 0 ? "+" : "−"}
                    {formatUsd(Math.abs(entry.amountMicros), { maximumFractionDigits: 4 })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <p className="mt-10 text-[11px] leading-relaxed text-[var(--faint)]">
        USAGE Points are an off-chain reputation record. They are not transferable, they carry no
        monetary value, and they cannot be bought with the credit on this page or exchanged back
        into it.
      </p>
    </main>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-[0.12em] text-[var(--faint)]">{label}</dt>
      <dd className="tnum mt-1 text-sm text-[var(--foreground)]">{value}</dd>
    </div>
  );
}
