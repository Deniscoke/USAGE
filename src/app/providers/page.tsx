import Link from "next/link";
import { listComputeGateways } from "@/lib/compute/registry";
import {
  listProviders,
  type ConnectionMethod,
  type MethodAvailability,
} from "@/lib/providers/catalog";

export const dynamic = "force-static";

/**
 * Provider coverage.
 *
 * Rendered entirely from the registry, so this page cannot claim a capability
 * the code does not have. If a column says "available" it is because an
 * implementation exists and a gateway backs it.
 */

const AVAILABILITY_LABEL: Record<MethodAvailability, string> = {
  available: "Available",
  experimental: "Experimental",
  coming_soon: "Coming soon",
  unsupported: "—",
};

const AVAILABILITY_COLOR: Record<MethodAvailability, string> = {
  available: "var(--verified)",
  experimental: "var(--warn)",
  coming_soon: "var(--faint)",
  unsupported: "var(--faint)",
};

const COLUMNS: { method: ConnectionMethod; label: string }[] = [
  { method: "routed_mining", label: "Mining" },
  { method: "verified_import", label: "Verified import" },
  { method: "byok", label: "BYOK" },
  { method: "subscription", label: "Subscription" },
];

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
        What USAGE can actually do with each provider today. This table is generated from the
        integration registry — a capability appears as available only when an implementation exists.
      </p>

      <div className="mt-8 overflow-x-auto rounded-lg border border-[var(--border)]">
        <table className="w-full min-w-[46rem] border-collapse text-xs">
          <thead>
            <tr className="border-b border-[var(--border)] bg-[var(--surface)] text-left">
              <th className="px-4 py-3 font-medium text-[var(--muted)]">Provider</th>
              {COLUMNS.map((column) => (
                <th key={column.method} className="px-4 py-3 font-medium text-[var(--muted)]">
                  {column.label}
                </th>
              ))}
              <th className="px-4 py-3 font-medium text-[var(--muted)]">Status</th>
            </tr>
          </thead>
          <tbody>
            {providers.map((provider) => (
              <tr key={provider.slug} className="border-b border-[var(--border)] last:border-0">
                <td className="px-4 py-3">
                  <span className="block">{provider.name}</span>
                  <span className="text-[10px] text-[var(--faint)]">
                    {provider.category.replace("_", " ")}
                  </span>
                </td>
                {COLUMNS.map((column) => {
                  const method = provider.methods[column.method];
                  return (
                    <td
                      key={column.method}
                      className="px-4 py-3"
                      style={{ color: AVAILABILITY_COLOR[method.availability] }}
                    >
                      {AVAILABILITY_LABEL[method.availability]}
                    </td>
                  );
                })}
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
            That first-hand observation is what makes usage verifiable.
          </p>
        </div>
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
          <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--muted)]">
            What earns
          </p>
          <p className="mt-2 text-[11px] leading-relaxed text-[var(--faint)]">
            Only compute USAGE observed directly, or imported from an authenticated provider API,
            can contribute to mining. Self-reported usage is shown in your history and earns
            nothing.
          </p>
        </div>
      </section>
    </main>
  );
}
