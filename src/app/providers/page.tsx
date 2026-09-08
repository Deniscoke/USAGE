import Link from "next/link";
import { listComputeGateways } from "@/lib/compute/registry";
import { listProviders, type RouteStatus } from "@/lib/providers/catalog";
import { ROUTE_STATUS_COLOR, ROUTE_STATUS_LABEL } from "@/components/provider-meta";

export const dynamic = "force-static";

/**
 * Provider coverage.
 *
 * Rendered entirely from the registry, so this page cannot claim a capability
 * the code does not have. A provider is not a gateway: routing is listed per
 * gateway, because "Anthropic via Vercel" and "Anthropic via OpenRouter" are
 * different integrations with different upstreams.
 */
export default function ProvidersPage() {
  const providers = listProviders();
  const gateways = listComputeGateways();

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-6">
      <header className="mb-8 flex flex-wrap items-center justify-between gap-3">
        <Link href="/" className="tnum text-sm font-medium tracking-[0.3em]">
          USAGE
        </Link>
        <Link
          href="/sign-up"
          className="rounded-md border border-[var(--border-strong)] px-3 py-1.5 text-xs text-[var(--muted)] hover:border-[var(--verified)] hover:text-[var(--foreground)]"
        >
          Start mining
        </Link>
      </header>

      <h1 className="text-3xl font-medium tracking-tight">Provider coverage.</h1>
      <p className="mt-3 max-w-2xl text-sm leading-relaxed text-[var(--muted)]">
        What USAGE can actually do with each provider today, generated from the integration
        registry. A provider is a model lab; a gateway is the infrastructure that carries the
        request. The same provider can be reachable through several gateways, each with its own
        status.
      </p>

      <div className="mt-8 overflow-x-auto rounded-lg border border-[var(--border)]">
        <table className="w-full min-w-[46rem] border-collapse text-xs">
          <thead>
            <tr className="border-b border-[var(--border)] bg-[var(--surface)] text-left">
              <th className="px-4 py-3 font-medium text-[var(--muted)]">Provider</th>
              <th className="px-4 py-3 font-medium text-[var(--muted)]">Mining routes</th>
              <th className="px-4 py-3 font-medium text-[var(--muted)]">Verified import</th>
              <th className="px-4 py-3 font-medium text-[var(--muted)]">Cost</th>
              <th className="px-4 py-3 font-medium text-[var(--muted)]">Status</th>
            </tr>
          </thead>
          <tbody>
            {providers.map((provider) => (
              <tr key={provider.slug} className="border-b border-[var(--border)] last:border-0">
                <td className="px-4 py-3">
                  <Link href={`/providers/${provider.slug}`} className="hover:underline">
                    {provider.name}
                  </Link>
                  <span className="block text-[10px] text-[var(--faint)]">
                    {provider.category.replace("_", " ")}
                  </span>
                </td>
                <td className="px-4 py-3">
                  {provider.routes.length === 0 ? (
                    <span className="text-[var(--faint)]">—</span>
                  ) : (
                    <ul className="space-y-1">
                      {provider.routes.map((route) => (
                        <li key={route.gateway} className="flex items-center gap-2">
                          <StatusDot status={route.status} />
                          <span className="text-[var(--muted)]">{route.gatewayName}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
                <td className="px-4 py-3">
                  <span style={{ color: ROUTE_STATUS_COLOR[provider.import.status] }}>
                    {ROUTE_STATUS_LABEL[provider.import.status]}
                  </span>
                  <span className="block text-[10px] text-[var(--faint)]">
                    {provider.import.granularity === "per_generation"
                      ? "per request"
                      : "provider aggregate"}
                  </span>
                </td>
                <td className="px-4 py-3 text-[var(--muted)]">
                  {provider.routes.some((route) => route.costAvailability === "authoritative") ||
                  provider.import.costAvailability === "authoritative"
                    ? "authoritative"
                    : "unavailable"}
                </td>
                <td className="px-4 py-3 uppercase tracking-[0.1em] text-[var(--faint)]">
                  {provider.status}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <section className="mt-6 grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
          <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--muted)]">
            Compute gateways
          </p>
          <ul className="mt-2 space-y-1 text-xs text-[var(--muted)]">
            {gateways.map((gateway) => (
              <li key={gateway.id} className="tnum">
                {gateway.id}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] leading-relaxed text-[var(--faint)]">
            A gateway is infrastructure USAGE operates, so it can observe a request first-hand.
            Every proof records which one executed it.
          </p>
        </div>
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
          <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--muted)]">
            What earns
          </p>
          <p className="mt-2 text-[11px] leading-relaxed text-[var(--faint)]">
            Compute USAGE observed directly, or imported from an authenticated provider admin API,
            can contribute to mining. Self-reported usage is shown in your history and earns
            nothing. Where an import might cover compute already counted, the reward is held rather
            than paid twice.
          </p>
        </div>
      </section>

      <p className="mt-6 text-[11px] leading-relaxed text-[var(--faint)]">
        <strong className="text-[var(--muted)]">Statuses.</strong> Live: exercised in production.
        Tested: implemented and covered by tests, not yet run live. Configured: implemented with a
        credential present. Available: implemented and usable. Coming soon: declared, not
        implemented.
      </p>
    </main>
  );
}

function StatusDot({ status }: { status: RouteStatus }) {
  const color = ROUTE_STATUS_COLOR[status];
  return (
    <span
      className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-[0.1em]"
      style={{ color }}
      title={ROUTE_STATUS_LABEL[status]}
    >
      <span className="size-1.5 rounded-full" style={{ background: color }} />
      {ROUTE_STATUS_LABEL[status]}
    </span>
  );
}
