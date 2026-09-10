"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { connectProvider, type ConnectProviderState } from "@/app/actions/providers";
import { StatusRows } from "./provider-catalog";

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
    blurb: "POST /v1/chat/completions with `Authorization: Bearer`. Validated with GET /v1/models.",
  },
  {
    id: "anthropic_compatible" as const,
    label: "Anthropic compatible",
    blurb: "POST /v1/messages with `x-api-key` and `anthropic-version`. Validated with GET /v1/models.",
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

          <Field
            label="API base URL"
            hint={
              preset
                ? `Fixed by USAGE for ${preset.name}: the provider's documented API host, not its website.`
                : "https only. USAGE will not connect to private addresses. Paste the API host (for example https://api.deepseek.com), not the provider's website. A path such as /some/path/openai is kept; a trailing /v1 is optional."
            }
          >
            <input
              name="baseUrl"
              type="url"
              defaultValue={preset?.baseUrl ?? ""}
              key={`url-${preset?.slug ?? "custom"}`}
              placeholder="https://api.deepseek.com"
              readOnly={preset !== null}
              required
              className="w-full rounded-md border border-[var(--border-strong)] bg-[var(--surface-2)] px-2.5 py-2 text-xs outline-none focus:border-[var(--verified)] read-only:opacity-70"
            />
          </Field>
          {preset === null && (
            <p className="text-[11px] leading-relaxed text-[var(--faint)]">
              Custom providers are supported when they use one of the two protocols above with its
              documented auth header. Other authentication schemes (custom headers, query-string keys)
              are not supported — USAGE is not a general credential proxy.
            </p>
          )}

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
            USAGE checks the credential with the provider&apos;s documented non-generative endpoint
            (a model list, or OpenRouter&apos;s key endpoint). Nothing is generated, so this cannot
            cost you provider credit. A key is reported as rejected only when the provider itself
            answers 401 or 403; anything USAGE cannot conclude is saved as &quot;validation
            incomplete&quot;, never as an invalid key.
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

/**
 * Route-capability copy, used only when the server view is absent. Note that
 * `eligible_route` is ROUTE capability: routable, measurable, priced. Whether
 * a request earns is the economic policy's call, shown in the status rows.
 */
const OUTCOME: Record<string, { title: string; detail: string; tone: string }> = {
  eligible_route: {
    title: "Connected — routable and priced",
    detail: "USAGE can route, prove and price compute through this provider. Whether it earns depends on the funding the provider states; see Funding and Mining.",
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
  const inconclusive = state.verdict === "inconclusive";
  const mining = state.view?.mining;
  const outcome = {
    title: inconclusive
      ? "Saved — validation incomplete"
      : mining?.outcome === "eligible"
        ? "Connected — mining eligible"
        : mining?.outcome === "held"
          ? "Connected — mining held"
          : mining?.outcome === "ineligible"
            ? "Connected — not reward eligible"
            : "Connected — not measurable",
    detail: mining?.reason ?? OUTCOME[state.eligibility ?? "unsupported"]?.detail ?? "",
    tone: mining?.outcome === "eligible" ? "var(--verified)" : mining?.outcome === "held" ? "var(--warn)" : "var(--reported)",
  };
  const rows: [string, string][] = [
    ["Connection", inconclusive ? "Credential saved — validation incomplete" : "✓ API credential accepted"],
    ["Protocol", state.protocol ?? "—"],
    [
      "Usage evidence",
      state.usageEvidence === "documented"
        ? "Documented by the provider; confirmed on the first observed request"
        : "Pending first observed request",
    ],
    ["Models", state.modelCount ? `${state.modelCount} discovered` : "Not listed by this endpoint"],
    ["Pricing", state.eligibility === "eligible_route" ? "Approved price available" : "Pending — no approved price for these models yet"],
    ["Mining", state.eligibility === "eligible_route" ? "Eligible when routed through USAGE" : "Not yet eligible"],
  ];

  return (
    <div className="space-y-4 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5">
      <p className="text-sm" style={{ color: inconclusive ? "var(--warn)" : outcome.tone }}>
        {outcome.title}
      </p>
      <p className="text-xs leading-relaxed text-[var(--muted)]">{state.message}</p>
      {state.view ? (
        <StatusRows view={state.view} compact />
      ) : (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[11px]">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-[var(--faint)]">{label}</dt>
              <dd className="text-[var(--foreground)]">{value}</dd>
            </div>
          ))}
        </dl>
      )}
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
