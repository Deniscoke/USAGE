import Link from "next/link";
import { listMiningProviders, listProviders } from "@/lib/providers/catalog";

const STEPS = [
  { step: "Connect", detail: "Pick the AI tools you already use." },
  { step: "Use AI", detail: "Work exactly as you do now. Nothing changes." },
  { step: "Verify", detail: "USAGE observes the compute first-hand and signs a proof." },
  { step: "Earn", detail: "Verified compute mines USAGE from a fixed epoch pool." },
];

export default function LandingPage() {
  const providers = listProviders();
  const mining = listMiningProviders();

  return (
    <main className="flex-1">
      <div className="grid-backdrop">
        <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
          <span className="tnum text-sm font-medium tracking-[0.3em]">USAGE</span>
          <div className="flex items-center gap-3">
            <Link
              href="/providers"
              className="text-xs text-[var(--muted)] transition-colors hover:text-[var(--foreground)]"
            >
              Providers
            </Link>
            <Link
              href="/download"
              className="text-xs text-[var(--muted)] transition-colors hover:text-[var(--foreground)]"
            >
              Download
            </Link>
            <Link
              href="/login"
              className="rounded-md border border-[var(--border-strong)] px-3 py-1.5 text-xs text-[var(--muted)] transition-colors hover:border-[var(--verified)] hover:text-[var(--foreground)]"
            >
              Sign in
            </Link>
          </div>
        </header>

        <section className="mx-auto max-w-6xl px-6 pb-20 pt-12 sm:pt-20">
          <p className="text-xs uppercase tracking-[0.24em] text-[var(--faint)]">
            AI Compute Network
          </p>
          <h1 className="mt-6 text-4xl font-medium leading-[1.05] tracking-tight sm:text-6xl">
            Use AI.
            <br />
            Mine USAGE.
          </h1>
          <p className="mt-5 max-w-xl text-base leading-relaxed text-[var(--muted)] sm:text-lg">
            Your AI usage has value. Connect your AI tools, use them normally, and earn USAGE from
            verified compute.
          </p>

          <div className="mt-9 flex flex-wrap items-center gap-3">
            <Link
              href="/sign-up"
              className="rounded-md bg-[var(--foreground)] px-5 py-2.5 text-sm font-medium text-[var(--background)] transition-opacity hover:opacity-90"
            >
              Start mining
            </Link>
            <Link
              href="/download"
              className="rounded-md border border-[var(--border-strong)] px-5 py-2.5 text-sm text-[var(--muted)] transition-colors hover:border-[var(--verified)] hover:text-[var(--foreground)]"
            >
              Download for Windows
            </Link>
            <Link
              href="/providers"
              className="text-sm text-[var(--muted)] transition-colors hover:text-[var(--foreground)]"
            >
              Learn how it works
            </Link>
          </div>
          <p className="mt-4 text-xs text-[var(--faint)]">
            Beta. USAGE Points are off-chain, non-transferable and carry no monetary value.
          </p>
        </section>
      </div>

      <section className="mx-auto max-w-6xl px-6 pb-16">
        <div className="grid gap-px overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--border)] sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((item, index) => (
            <div key={item.step} className="bg-[var(--surface)] p-5">
              <span className="tnum text-[10px] text-[var(--faint)]">
                {String(index + 1).padStart(2, "0")}
              </span>
              <h2 className="mt-2 text-sm font-medium">{item.step}</h2>
              <p className="mt-1.5 text-xs leading-relaxed text-[var(--muted)]">{item.detail}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 pb-16">
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5">
            <h3 className="text-sm font-medium">Verified, not claimed</h3>
            <p className="mt-2 text-xs leading-relaxed text-[var(--muted)]">
              Compute USAGE routes is observed first-hand and signed. Anyone can check the
              signature against a published public key. Self-reported usage is shown in your
              history and earns nothing.
            </p>
          </div>
          <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5">
            <h3 className="text-sm font-medium">You cannot farm it</h3>
            <p className="mt-2 text-xs leading-relaxed text-[var(--muted)]">
              Each epoch emits a fixed pool of USAGE, shared by contribution. Burning tokens does
              not mint more — it only dilutes everyone, including you. There is no fixed rate of
              tokens to rewards, by design.
            </p>
          </div>
          <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5">
            <h3 className="text-sm font-medium">Compute, not conversations</h3>
            <p className="mt-2 text-xs leading-relaxed text-[var(--muted)]">
              USAGE records models, token counts and timestamps. Prompts, responses, tool arguments
              and source code are never stored.
            </p>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 pb-24">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-[11px] font-medium uppercase tracking-[0.16em] text-[var(--muted)]">
            Providers
          </h2>
          <Link href="/providers" className="text-xs text-[var(--routed)] hover:underline">
            Full coverage table →
          </Link>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {providers.map((provider) => {
            const minable = mining.some((entry) => entry.slug === provider.slug);
            return (
              <span
                key={provider.slug}
                className="rounded-sm border px-2.5 py-1 text-xs"
                style={{
                  color: minable ? "var(--foreground)" : "var(--faint)",
                  borderColor: minable ? "var(--border-strong)" : "var(--border)",
                }}
              >
                {provider.name}
                {!minable && <span className="ml-2 text-[10px] uppercase">soon</span>}
              </span>
            );
          })}
        </div>
      </section>
    </main>
  );
}
