"use client";
import type { ProviderStatusView } from "@/lib/providers/status-view";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useActionState } from "react";
import {
  revokeProviderConnection,
  testProviderConnection,
  type ConnectionActionState,
} from "@/app/actions/providers";

/**
 * The searchable provider catalog, and the user's own connections.
 *
 * Everything shown here is registry data or discovered fact. Nothing claims a
 * capability that was not probed, and a connection's mining outcome is stated
 * plainly rather than reduced to a green dot.
 */

export type CatalogCategory = "official" | "compatible" | "custom" | "coming_soon";

export interface CatalogEntry {
  slug: string;
  name: string;
  category: CatalogCategory;
  summary: string;
  href: string | null;
}

export interface ConnectionCard {
  id: string;
  displayName: string;
  protocolLabel: string;
  host: string | null;
  status: string;
  statusLabel: string;
  miningLabel: string;
  miningDetail: string;
  /** Six separate facts, server-derived. */
  view: ProviderStatusView;
  modelCount: number;
  pricedModelCount: number;
  origin: string | null;
  authMethod: "api_key" | "oauth";
  /** Provider slug the connection was created under (e.g. "openrouter"). */
  provider: string;
  capabilities: { label: string; supported: boolean }[];
  lastSuccessAt: string | null;
  /** Where a tool should send requests so USAGE can observe them. */
  routeUrl: string;
}

/**
 * Connection, credential, routing, usage evidence, pricing, funding, mining:
 * seven lines that are never one word. "Routable and priced" is not "earns".
 */
export function StatusRows({ view, compact = false }: { view: ProviderStatusView; compact?: boolean }) {
  const tone = (ok: boolean, warn = false) => (ok ? "var(--verified)" : warn ? "var(--warn)" : "var(--faint)");
  const rows: { label: string; value: string; color: string }[] = [
    { label: "Connection", value: view.connection.label.toUpperCase(), color: tone(view.connection.state === "active" || view.connection.state === "limited" || view.connection.state === "pending_pricing", view.connection.state === "validating") },
    { label: "API credential", value: view.credential === "valid" ? "VALID" : view.credential === "rejected" ? "REJECTED" : "UNVERIFIED", color: tone(view.credential === "valid", view.credential === "unverified") },
    { label: "Models", value: view.models.discovered > 0 ? `${view.models.discovered} discovered · ${view.models.priced} priced` : "not listed", color: "var(--foreground)" },
    { label: "Routing", value: view.routing === "available" ? "AVAILABLE" : "UNSUPPORTED", color: tone(view.routing === "available") },
    { label: "Usage evidence", value: view.usageEvidence === "routed_proof" ? "ROUTED PROOF" : view.usageEvidence === "analytics_only" ? "ANALYTICS ONLY" : "NONE", color: tone(view.usageEvidence === "routed_proof", view.usageEvidence === "analytics_only") },
    { label: "Pricing", value: view.pricing === "available" ? "AVAILABLE" : view.pricing === "pending" ? "PENDING" : "NONE", color: tone(view.pricing === "available", view.pricing === "pending") },
    { label: "Funding", value: view.funding.class === "paid_account" ? "PAID-ACCOUNT METERED" : view.funding.class === "free_tier_account" ? "FREE TIER" : view.funding.class === "byok_upstream" ? "BYOK — UNKNOWN" : view.funding.class.toUpperCase(), color: tone(view.funding.class === "paid_account", view.funding.class === "unknown") },
    { label: "Mining", value: view.mining.label.toUpperCase(), color: tone(view.mining.outcome === "eligible", view.mining.outcome === "held") },
    ...(view.privacy ? [{ label: "Privacy", value: view.privacy.lines.join(" · ").toUpperCase(), color: "var(--verified)" }] : []),
  ];
  return (
    <dl className={`grid gap-x-4 gap-y-1 text-[11px] ${compact ? "grid-cols-[auto_1fr]" : "grid-cols-[auto_1fr] sm:grid-cols-[auto_1fr_auto_1fr]"}`}>
      {rows.map((row) => (
        <div key={row.label} className="contents">
          <dt className="text-[var(--faint)]">{row.label}</dt>
          <dd className="tnum" style={{ color: row.color }}>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

const CATEGORY_LABEL: Record<CatalogCategory, string> = {
  official: "Official",
  compatible: "Compatible",
  custom: "Custom",
  coming_soon: "Coming soon",
};

const CATEGORY_COLOR: Record<CatalogCategory, string> = {
  official: "var(--verified)",
  compatible: "var(--routed)",
  custom: "var(--warn)",
  coming_soon: "var(--faint)",
};

export function ProviderCatalog({ entries }: { entries: CatalogEntry[] }) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<CatalogCategory | "all">("all");

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return entries.filter((entry) => {
      if (category !== "all" && entry.category !== category) return false;
      if (!needle) return true;
      return (
        entry.name.toLowerCase().includes(needle) || entry.summary.toLowerCase().includes(needle)
      );
    });
  }, [entries, query, category]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search providers"
          className="min-w-0 flex-1 rounded-md border border-[var(--border-strong)] bg-[var(--surface-2)] px-2.5 py-2 text-xs outline-none focus:border-[var(--verified)]"
        />
        <Link
          href="/providers/add"
          className="rounded-md bg-[var(--foreground)] px-3 py-2 text-xs font-medium text-[var(--background)]"
        >
          Add provider
        </Link>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {(["all", "official", "compatible", "custom", "coming_soon"] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setCategory(option)}
            className="rounded-sm border px-2 py-1 text-[10px] uppercase tracking-[0.1em] transition-colors"
            style={{
              borderColor: category === option ? "var(--border-strong)" : "var(--border)",
              color: category === option ? "var(--foreground)" : "var(--faint)",
            }}
          >
            {option === "all" ? "All" : CATEGORY_LABEL[option]}
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--border-strong)] p-6 text-center">
          <p className="text-xs text-[var(--muted)]">
            No provider here matches “{query}”.
          </p>
          <Link
            href="/providers/add"
            className="mt-2 inline-block text-xs text-[var(--routed)] hover:underline"
          >
            Add it as a custom provider →
          </Link>
        </div>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2">
          {visible.map((entry) => (
            <li
              key={entry.slug}
              className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3"
            >
              <div className="flex items-baseline justify-between gap-2">
                {entry.href ? (
                  <Link href={entry.href} className="text-xs hover:underline">
                    {entry.name}
                  </Link>
                ) : (
                  <span className="text-xs">{entry.name}</span>
                )}
                <span
                  className="shrink-0 text-[10px] uppercase tracking-[0.1em]"
                  style={{ color: CATEGORY_COLOR[entry.category] }}
                >
                  {CATEGORY_LABEL[entry.category]}
                </span>
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-[var(--faint)]">{entry.summary}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const EMPTY: ConnectionActionState = {};

export function ConnectionRow({ connection }: { connection: ConnectionCard }) {
  const [testState, testAction, testing] = useActionState(testProviderConnection, EMPTY);
  const [revokeState, revokeAction, revoking] = useActionState(revokeProviderConnection, EMPTY);

  const disconnected = Boolean(revokeState.message) || connection.status === "revoked";

  return (
    <li className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm">{connection.displayName}</p>
          <p className="tnum mt-0.5 truncate text-[10px] text-[var(--faint)]">
            {connection.authMethod === "oauth" ? "Connected with sign-in" : connection.protocolLabel}
            {connection.host ? ` · ${connection.host}` : ""}
            {connection.origin ? ` · ${connection.origin.replace("_", " ")}` : ""}
          </p>
        </div>
        <span
          className="shrink-0 text-[10px] uppercase tracking-[0.1em]"
          style={{ color: disconnected ? "var(--reported)" : statusColor(connection.status) }}
        >
          {disconnected ? "Disconnected" : connection.statusLabel}
        </span>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-4">
        {connection.capabilities.map((capability) => (
          <div key={capability.label}>
            <dt className="text-[var(--faint)]">{capability.label}</dt>
            <dd style={{ color: capability.supported ? "var(--verified)" : "var(--faint)" }}>
              {capability.supported ? "✓ supported" : "— unavailable"}
            </dd>
          </div>
        ))}
      </dl>

      <div className="mt-3 border-t border-[var(--border)] pt-3">
        <StatusRows view={connection.view} />
        <p className="mt-2 text-[11px] leading-relaxed text-[var(--faint)]">
          {connection.miningDetail}
        </p>
        {connection.modelCount > 0 && (
          <p className="tnum mt-1 text-[11px] text-[var(--faint)]">
            {connection.modelCount} model{connection.modelCount === 1 ? "" : "s"} discovered ·{" "}
            {connection.pricedModelCount} priced · {connection.modelCount - connection.pricedModelCount}{" "}
            pending pricing
          </p>
        )}
      </div>

      {!disconnected && (
        <details className="mt-3 border-t border-[var(--border)] pt-3">
          <summary className="cursor-pointer text-[11px] text-[var(--routed)]">
            Route your AI tool through this connection
          </summary>
          <p className="mt-2 text-[11px] leading-relaxed text-[var(--faint)]">
            Point your tool at this base URL and send your mining key as a header. Requests then
            reach {connection.displayName} through USAGE, which is what makes them verifiable.
          </p>
          <code className="mt-2 block w-full overflow-x-auto rounded-sm border border-[var(--border-strong)] bg-[var(--surface-2)] px-2.5 py-2 text-[11px]">
            {connection.routeUrl}
          </code>
          <code className="mt-1.5 block w-full overflow-x-auto rounded-sm border border-[var(--border-strong)] bg-[var(--surface-2)] px-2.5 py-2 text-[11px]">
            x-usage-miner-token: &lt;your mining key&gt;
          </code>
          <p className="mt-2 text-[11px] text-[var(--faint)]">
            Your provider key stays on USAGE&apos;s servers and is never sent to your machine.
          </p>
        </details>
      )}

      {disconnected && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-[var(--border)] pt-3">
          <a
            href={connection.authMethod === "oauth" ? `/api/providers/oauth/${connection.provider}/start` : "/providers/add"}
            className="rounded-md border border-[var(--border)] px-2.5 py-1 text-[10px] uppercase tracking-[0.1em] text-[var(--muted)] hover:border-[var(--border-strong)] hover:text-[var(--foreground)]"
          >
            {connection.authMethod === "oauth" ? "Reconnect with sign-in" : "Reconnect with a new key"}
          </a>
          <span className="text-[11px] text-[var(--faint)]">
            Reconnecting revives this connection with a fresh credential; its history stays attached.
          </span>
        </div>
      )}

      {!disconnected && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <form action={testAction}>
            <input type="hidden" name="connectionId" value={connection.id} />
            <button
              type="submit"
              disabled={testing}
              className="rounded-md border border-[var(--border)] px-2.5 py-1 text-[10px] uppercase tracking-[0.1em] text-[var(--muted)] hover:border-[var(--border-strong)] hover:text-[var(--foreground)] disabled:opacity-40"
            >
              {testing ? "Testing…" : "Test"}
            </button>
          </form>
          <form action={revokeAction}>
            <input type="hidden" name="connectionId" value={connection.id} />
            <button
              type="submit"
              disabled={revoking}
              className="rounded-md border border-[var(--border)] px-2.5 py-1 text-[10px] uppercase tracking-[0.1em] text-[var(--muted)] hover:border-[var(--warn)] hover:text-[var(--warn)] disabled:opacity-40"
            >
              {revoking ? "Disconnecting…" : "Disconnect"}
            </button>
          </form>
        </div>
      )}

      {(testState.message || testState.error || revokeState.message || revokeState.error) && (
        <p
          className="mt-2 text-[11px]"
          style={{
            color: testState.error || revokeState.error ? "var(--warn)" : "var(--verified)",
          }}
        >
          {testState.message ?? testState.error ?? revokeState.message ?? revokeState.error}
        </p>
      )}
    </li>
  );
}

function statusColor(status: string): string {
  if (status === "active") return "var(--verified)";
  if (status === "invalid_credentials" || status === "error") return "var(--warn)";
  if (status === "revoked") return "var(--reported)";
  return "var(--routed)";
}
