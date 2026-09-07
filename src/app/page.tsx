import Link from "next/link";
import { VERIFICATION_META } from "@/components/ui";
import type { VerificationType } from "@/lib/domain/types";
import { listIntegrations } from "@/lib/providers/registry";

const PIPELINE = [
  { step: "Connect", detail: "Provider APIs, gateways, developer tools." },
  { step: "Normalize", detail: "One record shape across every source." },
  { step: "Verify", detail: "Verified, Routed or Reported. Weighted accordingly." },
  { step: "Score", detail: "Proof of Usage, versioned and reproducible." },
];

export default function LandingPage() {
  const integrations = listIntegrations();

  return (
    <main className="flex-1">
      <div className="grid-backdrop">
        <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
          <span className="tnum text-sm font-medium tracking-[0.3em]">USAGE</span>
          <Link
            href="/login"
            className="rounded-md border border-[var(--border-strong)] px-3 py-1.5 text-xs text-[var(--muted)] transition-colors hover:border-[var(--verified)] hover:text-[var(--foreground)]"
          >
            Sign in
          </Link>
        </header>

        <section className="mx-auto max-w-6xl px-6 pb-20 pt-12 sm:pt-20">
          <p className="text-xs uppercase tracking-[0.24em] text-[var(--faint)]">
            Proof of Work → Proof of Stake → Proof of Usage
          </p>
          <h1 className="mt-6 text-4xl font-medium leading-[1.05] tracking-tight sm:text-6xl">
            Proof of AI Usage.
          </h1>
          <p className="mt-5 max-w-xl text-base leading-relaxed text-[var(--muted)] sm:text-lg">
            See, verify and own your AI usage history. USAGE reads consumption from every provider
            you use, normalizes it into one record, and turns verified compute into a measurable
            score.
          </p>

          <div className="mt-9 flex flex-wrap items-center gap-3">
            <Link
              href="/sign-up"
              className="rounded-md bg-[var(--foreground)] px-5 py-2.5 text-sm font-medium text-[var(--background)] transition-opacity hover:opacity-90"
            >
              Start tracking
            </Link>
            <span className="text-xs text-[var(--faint)]">
              Free account. No provider credentials required to try the demo pipeline.
            </span>
          </div>
        </section>
      </div>

      <section className="mx-auto max-w-6xl px-6 pb-16">
        <div className="grid gap-px overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--border)] sm:grid-cols-2 lg:grid-cols-4">
          {PIPELINE.map((item, index) => (
            <div key={item.step} className="bg-[var(--surface)] p-5">
              <span className="tnum text-[10px] text-[var(--faint)]">
                {String(index + 1).padStart(2, "0")}
              </span>
              <h3 className="mt-2 text-sm font-medium">{item.step}</h3>
              <p className="mt-1.5 text-xs leading-relaxed text-[var(--muted)]">{item.detail}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 pb-16">
        <h2 className="text-[11px] font-medium uppercase tracking-[0.16em] text-[var(--muted)]">
          Three levels of proof
        </h2>
        <div className="mt-4 grid gap-4 md:grid-cols-3">
          {(Object.keys(VERIFICATION_META) as VerificationType[]).map((type) => {
            const meta = VERIFICATION_META[type];
            return (
              <div
                key={type}
                className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5"
                style={{ borderTopColor: meta.color, borderTopWidth: 2 }}
              >
                <div className="flex items-baseline justify-between">
                  <h3 className="text-sm font-medium" style={{ color: meta.color }}>
                    {meta.label}
                  </h3>
                  <span className="tnum text-xs text-[var(--faint)]">weight {meta.weight}</span>
                </div>
                <p className="mt-2 text-xs leading-relaxed text-[var(--muted)]">{meta.blurb}</p>
              </div>
            );
          })}
        </div>
        <p className="mt-4 max-w-2xl text-xs leading-relaxed text-[var(--faint)]">
          Rewards come from a fixed pool per epoch, split by share of verified network usage. Burning
          tokens to farm points does not work: extra spend only dilutes the pool. USAGE Points are
          off-chain, non-transferable and carry no monetary value.
        </p>
      </section>

      <section className="mx-auto max-w-6xl px-6 pb-24">
        <h2 className="text-[11px] font-medium uppercase tracking-[0.16em] text-[var(--muted)]">
          Registered adapters
        </h2>
        <ul className="mt-4 divide-y divide-[var(--border)] overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)]">
          {integrations.map((integration) => (
            <li key={integration.provider} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm">
              <span className="tnum text-xs text-[var(--faint)]">{integration.provider}</span>
              <span className="flex-1 text-[var(--foreground)]">{integration.label}</span>
              <span
                className="text-[10px] uppercase tracking-[0.12em]"
                style={{ color: VERIFICATION_META[integration.verificationType].color }}
              >
                {VERIFICATION_META[integration.verificationType].label}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-[var(--faint)]">
          Real provider integrations plug in behind the same adapter interface. Capabilities are
          documented per provider before any integration ships.
        </p>
      </section>

      <footer className="border-t border-[var(--border)] px-6 py-6">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 text-xs text-[var(--faint)]">
          <span className="tnum tracking-[0.2em]">USAGE</span>
          <span>Measures consumption metadata only. Never prompts or completions.</span>
        </div>
      </footer>
    </main>
  );
}
