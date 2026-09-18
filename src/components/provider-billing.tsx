import Link from "next/link";
import { formatUsd } from "@/lib/domain/money";
import { formatMicroUnits } from "@/lib/provider-billing/decimal";
import { NO_PERSONAL_BILLING_COPY } from "@/lib/provider-billing/github";
import {
  billingHeadline,
  PROVIDER_BILLING_COPY,
  type BillingAccountView,
  type BillingDaySummary,
  type BillingMonthSummary,
  type UnitTotals,
} from "@/lib/provider-billing/view";

/**
 * The provider-billing lane (M17C): provider-authoritative aggregates, reward 0.
 *
 * Its own neutral colour (--billing), never verified green and never the local
 * lane's grey. Its figures are money and provider units, never "requests",
 * and they are never added to local telemetry or verified compute.
 */

const TONE = "var(--billing)";

function usd(micros: number): string {
  return formatUsd(micros, { maximumFractionDigits: 4 });
}

function unitLabel(unitType: string): string {
  return unitType;
}

export function RewardNotEnabledChip() {
  return (
    <span
      className="rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-[0.12em]"
      style={{ borderColor: `color-mix(in srgb, ${TONE} 45%, transparent)`, color: TONE }}
    >
      Provider billing · {PROVIDER_BILLING_COPY.reward}
    </span>
  );
}

const FLASH: Record<string, string> = {
  connected: "GitHub connected. Billing evidence is read from GitHub directly.",
  refreshed: "Refreshed from GitHub billing.",
  disconnected: "GitHub disconnected. The authorization was removed and your billing history kept.",
  not_configured: "GitHub connector is not configured on this deployment",
  cancelled: "GitHub authorization was cancelled.",
  state_invalid: "That GitHub sign-in link expired or was not started from this account. Please connect again.",
  exchange_failed: "GitHub did not complete the sign-in. Please connect again.",
  identity_failed: "GitHub did not confirm which account signed in. Please try again.",
  principal_taken: "That GitHub account is already connected to another USAGE account.",
  different_account:
    "This USAGE account is already bound to a different GitHub account. One GitHub account per USAGE account.",
  storage_failed: "USAGE could not store the GitHub authorization securely. Nothing was connected.",
  rate_limited: "Refreshed less than five minutes ago. Try again shortly.",
  busy: "A sync is already running for this account.",
  needs_reauth: "GitHub no longer accepts this authorization. Reconnect to continue.",
  principal_mismatch: "GitHub now reports a different account for this authorization. Reconnect to continue.",
  degraded: "GitHub billing could not be read just now. Previous data is kept; USAGE will retry.",
  not_connected: "No GitHub account is connected.",
};

export function githubFlash(value: string | undefined): string | null {
  return value ? (FLASH[value] ?? null) : null;
}

export function GithubCopilotCard({
  account,
  configured,
  flash,
}: {
  account: BillingAccountView | null;
  configured: boolean;
  flash: string | null;
}) {
  const live = account && account.status !== "revoked" ? account : null;
  const headline = live ? billingHeadline(live) : null;
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4" style={{ borderTop: `2px solid ${TONE}` }}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm">GitHub Copilot</p>
        <RewardNotEnabledChip />
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-[var(--faint)]">
        Personal AI-credit billing, read from GitHub with read-only &ldquo;Plan&rdquo; permission. Provider billing
        evidence: authoritative aggregates, not requests, and not mining.
      </p>

      {flash && <p className="mt-3 text-[11px] text-[var(--muted)]">{flash}</p>}

      {!configured ? (
        <p className="mt-3 text-[11px] text-[var(--muted)]">GitHub connector is not configured on this deployment</p>
      ) : !live || !headline ? (
        <div className="mt-3">
          <a
            href="/api/providers/github/start"
            className="inline-block rounded-md bg-[var(--foreground)] px-4 py-2 text-xs font-medium text-[var(--background)]"
          >
            {account?.status === "revoked" ? "Reconnect GitHub" : "Connect GitHub"}
          </a>
          {account?.status === "revoked" && (
            <p className="mt-2 text-[10px] text-[var(--faint)]">Disconnected. Billing history from before is kept.</p>
          )}
        </div>
      ) : (
        <>
          <dl className="tnum mt-3 grid grid-cols-1 gap-x-6 gap-y-1 text-[11px] sm:grid-cols-2">
            <Row label="Status" value={headline.connectionLabel} />
            <Row label="Provider billing" value={headline.availability} />
            <Row label="Scope" value={headline.scopeLabel} />
            <Row label="Permission" value={headline.permissionLabel} />
            <Row label="Account" value={live.login ?? "—"} />
            <Row label="Last sync" value={live.lastSyncAt ? `${live.lastSyncAt.slice(0, 16).replace("T", " ")} UTC` : "never"} />
            <Row label="Reward" value="NOT ENABLED" />
          </dl>
          {live.billingScope === "no_data_or_managed" && (
            <p className="mt-3 text-[11px] leading-relaxed text-[var(--muted)]">{NO_PERSONAL_BILLING_COPY}</p>
          )}
          {live.status === "needs_reauth" ? (
            <a href="/api/providers/github/start" className="mt-3 inline-block text-[11px] text-[var(--routed)] hover:underline">
              Reconnect GitHub
            </a>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-2">
            <form method="post" action="/api/providers/github/refresh">
              <button
                type="submit"
                disabled={live.status === "needs_reauth"}
                className="rounded-md border border-[var(--border-strong)] px-3 py-1.5 text-[11px] text-[var(--muted)] hover:text-[var(--foreground)] disabled:opacity-50"
              >
                Refresh now
              </button>
            </form>
            <form method="post" action="/api/providers/github/disconnect">
              <button
                type="submit"
                className="rounded-md border border-[var(--border)] px-3 py-1.5 text-[11px] text-[var(--faint)] hover:text-[var(--foreground)]"
              >
                Disconnect
              </button>
            </form>
          </div>
        </>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-[var(--faint)]">{label}</dt>
      <dd className="text-right text-[var(--muted)]">{value}</dd>
    </div>
  );
}

function UnitLines({ units }: { units: UnitTotals[] }) {
  return (
    <>
      {units.map((u) => (
        <div key={u.unitType}>
          <dt className="text-[10px] uppercase tracking-[0.14em] text-[var(--faint)]">AI credits · {unitLabel(u.unitType)}</dt>
          <dd className="tnum mt-1.5 text-lg leading-none tracking-tight">{formatMicroUnits(u.netMicroUnits, 4)}</dd>
          <dd className="tnum mt-1 text-[10px] text-[var(--muted)]">
            net · {formatMicroUnits(u.grossMicroUnits, 4)} gross · {formatMicroUnits(u.includedMicroUnits, 4)} included
          </dd>
        </div>
      ))}
    </>
  );
}

/** Dashboard area: this month, per provider. */
export function ProviderBillingMonth({
  summaries,
  accounts,
  month,
}: {
  summaries: BillingMonthSummary[];
  accounts: BillingAccountView[];
  month: string;
}) {
  const github = accounts.find((a) => a.provider === "github") ?? null;
  const summary = summaries.find((s) => s.provider === "github") ?? null;
  return (
    <div>
      {!github ? (
        <p className="text-xs text-[var(--muted)]">
          No provider billing connected. <Link href="/providers" className="text-[var(--routed)] hover:underline">Connect GitHub Copilot</Link> to see
          what GitHub bills your personal plan.
        </p>
      ) : summary ? (
        <div>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-xs">GitHub Copilot · {month}</p>
            <span className="text-[10px] uppercase tracking-[0.12em]" style={{ color: TONE }}>
              {PROVIDER_BILLING_COPY.reward}
            </span>
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <UnitLines units={summary.units} />
            <div>
              <dt className="text-[10px] uppercase tracking-[0.14em] text-[var(--faint)]">Provider billing value</dt>
              <dd className="tnum mt-1.5 text-lg leading-none tracking-tight">{usd(summary.netAmountMicros)}</dd>
              <dd className="tnum mt-1 text-[10px] text-[var(--muted)]">
                net · {usd(summary.grossAmountMicros)} gross · {usd(summary.includedAmountMicros)} included
              </dd>
            </div>
            <div className="col-span-2">
              <dt className="text-[10px] uppercase tracking-[0.14em] text-[var(--faint)]">Models</dt>
              <dd className="mt-1.5 text-[11px] text-[var(--muted)]">{summary.models.length > 0 ? summary.models.join(", ") : "—"}</dd>
            </div>
          </dl>
        </div>
      ) : github.billingScope === "no_data_or_managed" ? (
        <p className="text-xs leading-relaxed text-[var(--muted)]">{NO_PERSONAL_BILLING_COPY}</p>
      ) : (
        <p className="text-xs text-[var(--muted)]">
          GitHub Copilot · {billingHeadline(github).connectionLabel.toLowerCase()} · provider billing{" "}
          {billingHeadline(github).availability.toLowerCase()}. Nothing billed for {month} has been read yet.
        </p>
      )}
      <p className="mt-4 border-t border-[var(--border)] pt-3 text-[11px] leading-relaxed text-[var(--faint)]">
        {PROVIDER_BILLING_COPY.explanation} The current day and month are provisional until GitHub finalizes them.
      </p>
    </div>
  );
}

/** /analytics: this month by day, where GitHub reported days. */
export function ProviderBillingDays({ days }: { days: BillingDaySummary[] }) {
  if (days.length === 0) {
    return <p className="text-xs text-[var(--muted)]">No daily provider billing for this month yet.</p>;
  }
  return (
    <table className="tnum w-full text-[11px]">
      <thead>
        <tr className="text-left text-[10px] uppercase tracking-[0.12em] text-[var(--faint)]">
          <th className="py-1.5 font-normal">Day (UTC)</th>
          <th className="py-1.5 font-normal">AI credits (net)</th>
          <th className="py-1.5 text-right font-normal">Gross value</th>
          <th className="py-1.5 text-right font-normal">Net value</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-[var(--border)]">
        {days.map((d) => (
          <tr key={d.day}>
            <td className="py-1.5">{d.day}</td>
            <td className="py-1.5 text-[var(--muted)]">
              {d.units.map((u) => `${formatMicroUnits(u.netMicroUnits, 4)} ${unitLabel(u.unitType)}`).join(" · ")}
            </td>
            <td className="py-1.5 text-right text-[var(--muted)]">{usd(d.grossAmountMicros)}</td>
            <td className="py-1.5 text-right">{usd(d.netAmountMicros)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export const PROVIDER_BILLING_TONE = TONE;
