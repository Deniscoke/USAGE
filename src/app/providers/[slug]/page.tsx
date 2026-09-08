import Link from "next/link";
import { notFound } from "next/navigation";
import { Panel } from "@/components/ui";
import {
  ROUTE_STATUS_COLOR,
  ROUTE_STATUS_LABEL,
  ROUTE_STATUS_MEANING,
} from "@/components/provider-meta";
import { findProvider, isUsable, listProviders } from "@/lib/providers/catalog";

export const dynamic = "force-static";

export function generateStaticParams() {
  return listProviders().map((provider) => ({ slug: provider.slug }));
}

/**
 * Provider detail: every way to earn USAGE from one provider.
 *
 * Entirely data-driven. A route is a (provider, gateway) pair with its own
 * status, and the import capability names the exact API and the account it
 * needs -- because "verified import" without "organization admin key" would
 * send consumer users down a path that cannot work for them.
 */
export default async function ProviderDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const provider = findProvider(slug);
  if (!provider) notFound();

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:px-6">
      <header className="mb-8 flex flex-wrap items-center justify-between gap-3">
        <Link href="/" className="tnum text-sm font-medium tracking-[0.3em]">
          USAGE
        </Link>
        <Link href="/providers" className="text-xs text-[var(--muted)] hover:text-[var(--foreground)]">
          ← All providers
        </Link>
      </header>

      <h1 className="text-3xl font-medium tracking-tight">{provider.name}</h1>
      <p className="mt-2 text-xs uppercase tracking-[0.14em] text-[var(--faint)]">
        {provider.category.replace("_", " ")} · {provider.status} · {provider.integrationVersion}
      </p>

      <h2 className="mt-8 text-[11px] font-medium uppercase tracking-[0.16em] text-[var(--muted)]">
        Ways to earn USAGE
      </h2>

      <div className="mt-3 space-y-3">
        {provider.routes.length === 0 && (
          <Panel title="Mine through USAGE">
            <p className="text-xs text-[var(--muted)]">
              No gateway carries {provider.name} yet.
            </p>
          </Panel>
        )}

        {provider.routes.map((route) => (
          <Panel key={route.gateway} title="Mine through USAGE" hint={`Gateway: ${route.gatewayName}`}>
            <dl className="space-y-2 text-xs">
              <Row
                label="Status"
                value={ROUTE_STATUS_LABEL[route.status]}
                tone={ROUTE_STATUS_COLOR[route.status]}
              />
              <Row label="You supply" value={route.authRequirement} />
              <Row
                label="Provider cost"
                value={route.costAvailability === "authoritative" ? "Reported" : "Not reported"}
              />
            </dl>
            <p className="mt-3 text-[11px] leading-relaxed text-[var(--faint)]">
              {ROUTE_STATUS_MEANING[route.status]} {route.note ?? ""}
            </p>
          </Panel>
        ))}

        <Panel title="Verified organization import" hint={provider.import.source}>
          <dl className="space-y-2 text-xs">
            <Row
              label="Status"
              value={ROUTE_STATUS_LABEL[provider.import.status]}
              tone={ROUTE_STATUS_COLOR[provider.import.status]}
            />
            <Row label="Requires" value={provider.import.accountRequirement} />
            <Row
              label="Granularity"
              value={
                provider.import.granularity === "per_generation"
                  ? "Per request"
                  : "Provider aggregate (time buckets)"
              }
            />
            <Row
              label="Provider cost"
              value={
                provider.import.costAvailability === "authoritative" ? "Reported" : "Not reported"
              }
            />
          </dl>
          <p className="mt-3 text-[11px] leading-relaxed text-[var(--faint)]">
            {ROUTE_STATUS_MEANING[provider.import.status]} {provider.import.note ?? ""}
          </p>
          {isUsable(provider.import.status) &&
            provider.import.granularity === "provider_aggregate" && (
              <p className="mt-2 text-[11px] leading-relaxed text-[var(--faint)]">
                An aggregate import is a real Proof of Usage with different provenance to a routed
                receipt: the provider states what happened, rather than USAGE watching it happen.
                Where it may cover compute already mined, the reward is held rather than paid twice.
              </p>
            )}
        </Panel>

        {(["byok", "subscription"] as const)
          .filter((method) => provider[method].availability !== "unsupported")
          .map((method) => (
            <Panel
              key={method}
              title={method === "byok" ? "Bring your own key" : "Use your subscription"}
            >
              <p className="text-xs text-[var(--muted)]">
                {provider[method].availability === "available" ? "Available" : "Coming soon"}
              </p>
              {provider[method].note && (
                <p className="mt-2 text-[11px] leading-relaxed text-[var(--faint)]">
                  {provider[method].note}
                </p>
              )}
            </Panel>
          ))}
      </div>

      <h2 className="mt-8 text-[11px] font-medium uppercase tracking-[0.16em] text-[var(--muted)]">
        What USAGE reads
      </h2>
      <div className="mt-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
        <p className="text-[11px] text-[var(--muted)]">Usage fields</p>
        <p className="tnum mt-1 text-[11px] text-[var(--faint)]">
          {provider.usageFields.join(", ") || "—"}
        </p>
        <p className="mt-3 text-[11px] text-[var(--muted)]">Cost fields</p>
        <p className="tnum mt-1 text-[11px] text-[var(--faint)]">
          {provider.costFields.join(", ") || "none — cost is unavailable from this provider"}
        </p>
        <p className="mt-3 text-[11px] leading-relaxed text-[var(--faint)]">
          Compute metadata only. Prompts, responses, tool arguments and source code are never read
          or stored.
        </p>
      </div>
    </main>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="shrink-0 text-[var(--muted)]">{label}</dt>
      <dd className="text-right" style={tone ? { color: tone } : undefined}>
        {value}
      </dd>
    </div>
  );
}
