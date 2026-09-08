"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { connectProvider, type ConnectProviderState } from "@/app/actions/providers";

/**
 * The Add Provider wizard.
 *
 * Three fields and a protocol choice. No environment variables, no terminal,
 * no server configuration -- that is the whole point of the milestone.
 *
 * The credential input is write-only: it is submitted once and never rendered
 * back, because there is no code path that could fetch it again.
 */

const EMPTY: ConnectProviderState = {};

export interface ProviderPreset {
  slug: string;
  name: string;
  protocol: "openai_compatible" | "anthropic_compatible";
  baseUrl: string;
  /** Registry family, when this is a provider USAGE already knows. */
  family: string | null;
}

const PROTOCOLS = [
  {
    id: "openai_compatible" as const,
    label: "OpenAI compatible",
    blurb: "A /v1/chat/completions endpoint. Most providers speak this.",
  },
  {
    id: "anthropic_compatible" as const,
    label: "Anthropic compatible",
    blurb: "A /v1/messages endpoint.",
  },
];

const UNSUPPORTED = [
  { id: "usage_import", label: "USAGE import API", blurb: "Import usage a provider already recorded." },
  { id: "custom_unsupported", label: "Something else", blurb: "A protocol USAGE cannot route yet." },
];

export function AddProviderWizard({ presets }: { presets: ProviderPreset[] }) {
  const [state, action, pending] = useActionState(connectProvider, EMPTY);
  const [preset, setPreset] = useState<ProviderPreset | null>(null);
  const [protocol, setProtocol] = useState<"openai_compatible" | "anthropic_compatible">(
    "openai_compatible",
  );
  const [showUnsupported, setShowUnsupported] = useState(false);

  if (state.connectionId) {
    return <ConnectedSummary state={state} />;
  }

  function choose(next: ProviderPreset | null) {
    setPreset(next);
    if (next) setProtocol(next.protocol);
  }

  return (
    <div className="space-y-6">
      <section>
        <h2 className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--muted)]">
          1 · Choose a provider
        </h2>
        <div className="mt-3 flex flex-wrap gap-2">
          {presets.map((entry) => (
            <button
              key={entry.slug}
              type="button"
              onClick={() => choose(entry)}
              className="rounded-md border px-3 py-1.5 text-xs transition-colors"
              style={{
                borderColor:
                  preset?.slug === entry.slug ? "var(--verified)" : "var(--border-strong)",
                color: preset?.slug === entry.slug ? "var(--foreground)" : "var(--muted)",
              }}
            >
              {entry.name}
            </button>
          ))}
          <button
            type="button"
            onClick={() => choose(null)}
            className="rounded-md border border-dashed px-3 py-1.5 text-xs transition-colors"
            style={{
              borderColor: preset === null ? "var(--verified)" : "var(--border-strong)",
              color: preset === null ? "var(--foreground)" : "var(--muted)",
            }}
          >
            + Add custom provider
          </button>
        </div>
      </section>

      <form action={action} className="space-y-6">
        <section>
          <h2 className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--muted)]">
            2 · Connection protocol
          </h2>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {PROTOCOLS.map((entry) => (
              <label
                key={entry.id}
                className="cursor-pointer rounded-md border p-3 transition-colors"
                style={{
                  borderColor: protocol === entry.id ? "var(--verified)" : "var(--border)",
                }}
              >
                <input
                  type="radio"
                  name="protocol"
                  value={entry.id}
                  checked={protocol === entry.id}
                  onChange={() => setProtocol(entry.id)}
                  className="sr-only"
                />
                <span className="block text-xs">{entry.label}</span>
                <span className="mt-1 block text-[11px] leading-relaxed text-[var(--faint)]">
                  {entry.blurb}
                </span>
              </label>
            ))}
          </div>

          <button
            type="button"
            onClick={() => setShowUnsupported((value) => !value)}
            className="mt-2 text-[11px] text-[var(--routed)] hover:underline"
          >
            My provider uses something else
          </button>
          {showUnsupported && (
            <ul className="mt-2 space-y-1.5 rounded-md border border-[var(--border)] p-3">
              {UNSUPPORTED.map((entry) => (
                <li key={entry.id} className="text-[11px] text-[var(--faint)]">
                  <span className="text-[var(--muted)]">{entry.label}</span> — {entry.blurb}{" "}
                  <span className="uppercase tracking-[0.1em]">Coming soon</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="space-y-3">
          <h2 className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--muted)]">
            3 · Credentials
          </h2>

          <Field label="Provider name">
            <input
              name="displayName"
              defaultValue={preset?.name ?? ""}
              key={`name-${preset?.slug ?? "custom"}`}
              placeholder="DeepSeek"
              required
              maxLength={60}
              className="w-full rounded-md border border-[var(--border-strong)] bg-[var(--surface-2)] px-2.5 py-2 text-xs outline-none focus:border-[var(--verified)]"
            />
          </Field>

          <Field label="API base URL" hint="https only. USAGE will not connect to private addresses.">
            <input
              name="baseUrl"
              type="url"
              defaultValue={preset?.baseUrl ?? ""}
              key={`url-${preset?.slug ?? "custom"}`}
              placeholder="https://api.deepseek.com"
              required
              className="w-full rounded-md border border-[var(--border-strong)] bg-[var(--surface-2)] px-2.5 py-2 text-xs outline-none focus:border-[var(--verified)]"
            />
          </Field>

          <Field
            label="API key"
            hint="Encrypted immediately. USAGE never shows it again and never logs it."
          >
            <input
              name="credential"
              type="password"
              autoComplete="off"
              required
              placeholder="sk-…"
              className="w-full rounded-md border border-[var(--border-strong)] bg-[var(--surface-2)] px-2.5 py-2 text-xs outline-none focus:border-[var(--verified)]"
            />
          </Field>

          <input type="hidden" name="providerFamily" value={preset?.family ?? ""} />
        </section>

        <div className="space-y-2">
          <button
            type="submit"
            disabled={pending}
            className="w-full rounded-md bg-[var(--foreground)] px-3 py-2.5 text-xs font-medium text-[var(--background)] transition-opacity hover:opacity-90 disabled:opacity-40 sm:w-auto sm:px-6"
          >
            {pending ? "Validating…" : "Connect and validate"}
          </button>
          <p className="text-[11px] text-[var(--faint)]">
            USAGE checks the credential with a models request. Nothing is generated, so this cannot
            cost you provider credit.
          </p>
          {state.error && <p className="text-[11px] text-[var(--warn)]">{state.error}</p>}
        </div>
      </form>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="block text-xs text-[var(--muted)]">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-[var(--faint)]">{hint}</span>}
    </label>
  );
}

const OUTCOME: Record<string, { title: string; detail: string; tone: string }> = {
  eligible_route: {
    title: "Connected — full mining",
    detail: "Verified compute through this provider earns USAGE.",
    tone: "var(--verified)",
  },
  pending_pricing: {
    title: "Connected — routed proof, pending pricing",
    detail:
      "USAGE can prove this compute happened, but has no approved price for these models yet, so it does not earn. That is deliberate: a provider cannot set its own reward rate.",
    tone: "var(--warn)",
  },
  analytics_only: {
    title: "Connected — analytics only",
    detail:
      "This provider does not report enough to measure a request reliably. Usage will be shown, and will not earn.",
    tone: "var(--warn)",
  },
  unsupported: {
    title: "Connected — not measurable",
    detail: "USAGE could not establish that it can observe usage through this connection.",
    tone: "var(--reported)",
  },
};

function ConnectedSummary({ state }: { state: ConnectProviderState }) {
  const outcome = OUTCOME[state.eligibility ?? "unsupported"] ?? OUTCOME.unsupported;

  return (
    <div className="space-y-4 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5">
      <p className="text-sm" style={{ color: outcome.tone }}>
        {outcome.title}
      </p>
      <p className="text-xs leading-relaxed text-[var(--muted)]">{state.message}</p>
      <p className="text-[11px] leading-relaxed text-[var(--faint)]">{outcome.detail}</p>
      <div className="flex flex-wrap gap-3 pt-1">
        <Link
          href="/providers"
          className="rounded-md bg-[var(--foreground)] px-4 py-2 text-xs font-medium text-[var(--background)]"
        >
          Manage providers
        </Link>
        <Link
          href="/providers/add"
          className="rounded-md border border-[var(--border-strong)] px-4 py-2 text-xs text-[var(--muted)]"
        >
          Add another
        </Link>
      </div>
    </div>
  );
}
