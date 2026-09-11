import Link from "next/link";
import { listComputeGateways } from "@/lib/compute/registry";
import { isUsable, listProviders } from "@/lib/providers/catalog";
import { createConnectionStore } from "@/lib/providers/connections";
import { PROTOCOL_LABELS } from "@/lib/protocols/registry";
import { createServerSupabase } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import {
  ConnectionRow,
  ProviderCatalog,
  type CatalogCategory,
  type CatalogEntry,
  type ConnectionCard,
} from "@/components/provider-catalog";
import { InstallMinerNextStep } from "@/components/miner-status";
import { loadDeviceViews } from "@/lib/miner/device-view";
import { loadDistribution } from "@/lib/miner/distribution-source";
import { minerPresence, type MinerPresence } from "@/lib/miner/presence";
import { MINIMUM_MINER_VERSION } from "@/lib/miner/release";

export const dynamic = "force-dynamic";

/**
 * Providers.
 *
 * Two halves: what a user has connected, and everything they could connect.
 * The catalog is a starting point rather than a limit -- the "add custom
 * provider" path connects something USAGE has never heard of, and the empty
 * search result says so rather than shrugging.
 */

function catalogEntries(): CatalogEntry[] {
  return listProviders().map((provider) => {
    const routes = provider.routes.filter((route) => isUsable(route.status));
    const category: CatalogCategory =
      routes.length > 0 || isUsable(provider.import.status) ? "official" : "coming_soon";

    const ways = [
      ...routes.map((route) => `mine via ${route.gatewayName}`),
      isUsable(provider.import.status) ? "verified organization import" : null,
    ].filter((way): way is string => way !== null);

    return {
      slug: provider.slug,
      name: provider.name,
      category,
      summary: ways.length > 0 ? capitalize(ways.join(", ")) : "No integration yet.",
      href: `/providers/${provider.slug}`,
    };
  });
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export default async function ProvidersPage() {
  const gateways = listComputeGateways();
  // The public origin a miner should point at. Relative would be ambiguous in
  // a config file the user pastes somewhere else.
  const baseUrl = process.env.NEXT_PUBLIC_USAGE_URL ?? "https://usage-ten.vercel.app";
  const entries = catalogEntries();

  let connections: ConnectionCard[] = [];
  let email: string | undefined;
  let presence: MinerPresence | null = null;

  if (isSupabaseConfigured()) {
    const supabase = await createServerSupabase();
    const {
      data: { user },
    } = (await supabase?.auth.getUser()) ?? { data: { user: null } };

    if (user && supabase) {
      email = user.email;
      const { createAdminSupabase } = await import("@/lib/supabase/admin");
      const store = createConnectionStore(createAdminSupabase());
      // Devices are read as the user, so RLS decides what comes back.
      const [summaries, devices, distribution] = await Promise.all([
        store.list(user.id),
        loadDeviceViews(supabase, user.id),
        loadDistribution(),
      ]);
      presence = minerPresence({
        devices,
        latestVersion: distribution.version,
        minimumVersion: MINIMUM_MINER_VERSION,
      });

      connections = summaries.map((summary) => ({
        id: summary.id,
        displayName: summary.displayName,
        protocolLabel: summary.protocol ? PROTOCOL_LABELS[summary.protocol] : "Unknown protocol",
        host: summary.baseUrlHost,
        status: summary.status,
        statusLabel: summary.view.connection.label,
        miningLabel: `Mining: ${summary.view.mining.label}`,
        miningDetail: summary.view.mining.reason,
        view: summary.view,
        modelCount: summary.modelCount,
        pricedModelCount: summary.pricedModelCount,
        origin: summary.origin,
        authMethod: summary.authMethod,
        provider: summary.provider,
        routeUrl: `${baseUrl}/api/gateway/provider/${summary.id}`,
        capabilities: [
          { label: "Usage", supported: summary.capabilities.usage },
          { label: "Request ID", supported: summary.capabilities.requestIdentity },
          { label: "Cache", supported: summary.capabilities.cacheUsage },
          { label: "Cost", supported: summary.capabilities.cost },
        ],
        lastSuccessAt: summary.lastSuccessAt,
      }));

      // Connections a user made appear in the catalog too, as their own.
      for (const summary of summaries) {
        entries.unshift({
          slug: `connection-${summary.id}`,
          name: summary.displayName,
          category: summary.origin === "custom" ? "custom" : "compatible",
          summary: `${summary.protocol ? PROTOCOL_LABELS[summary.protocol] : "Connected"} · mining ${summary.view.mining.label.toLowerCase()}`,
          href: null,
        });
      }
    }
  }

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-6">
      <header className="mb-8 flex flex-wrap items-center justify-between gap-3">
        <Link href={email ? "/dashboard" : "/"} className="tnum text-sm font-medium tracking-[0.3em]">
          USAGE
        </Link>
        <div className="flex items-center gap-3">
          {email && <span className="text-[11px] text-[var(--muted)]">{email}</span>}
          <Link
            href={email ? "/providers/add" : "/sign-up"}
            className="rounded-md border border-[var(--border-strong)] px-3 py-1.5 text-xs text-[var(--muted)] hover:border-[var(--verified)] hover:text-[var(--foreground)]"
          >
            {email ? "Add provider" : "Start mining"}
          </Link>
        </div>
      </header>

      <h1 className="text-3xl font-medium tracking-tight">Connect any AI.</h1>
      <p className="mt-3 max-w-2xl text-sm leading-relaxed text-[var(--muted)]">
        Use your existing AI providers with USAGE. Verified compute can earn USAGE. A provider is a
        model lab; a gateway is the infrastructure that carries the request — the same provider can
        be reachable several ways, each with its own status.
      </p>

      {connections.length === 0 && email && (
        <section className="mt-8">
          <div className="rounded-lg border border-[var(--border-strong)] bg-[var(--surface)] p-4">
            <p className="text-sm">Start here</p>
            <p className="mt-2 max-w-2xl text-[11px] leading-relaxed text-[var(--muted)]">
              OpenRouter is the one connection that can earn today. It states, per request, what
              the compute cost and whether the account has purchased credit — the two things USAGE
              needs before it can reward anything. Connect it by signing in, with an account that
              has credit on it.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <a
                href="/api/providers/oauth/openrouter/start"
                className="rounded-md bg-[var(--foreground)] px-4 py-2 text-xs font-medium text-[var(--background)]"
              >
                Connect OpenRouter
              </a>
              <Link href="/providers/add" className="text-[11px] text-[var(--routed)] hover:underline">
                Connect something else
              </Link>
            </div>
          </div>
        </section>
      )}

      {connections.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-3 text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--muted)]">
            Your connections
          </h2>
          <ul className="space-y-3">
            {connections.map((connection) => (
              <ConnectionRow key={connection.id} connection={connection} />
            ))}
          </ul>
          {presence && (
            <div className="mt-3">
              <InstallMinerNextStep presence={presence} />
            </div>
          )}
        </section>
      )}

      <section className="mt-8">
        <h2 className="mb-3 text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--muted)]">
          Providers
        </h2>
        <ProviderCatalog entries={entries} />
      </section>

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
            <li className="tnum">connection:&lt;your provider&gt;</li>
          </ul>
          <p className="mt-2 text-[11px] leading-relaxed text-[var(--faint)]">
            A gateway is infrastructure USAGE operates so it can observe a request first-hand. Every
            proof records which one executed it.
          </p>
        </div>
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
          <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--muted)]">
            Connecting is not earning
          </p>
          <p className="mt-2 text-[11px] leading-relaxed text-[var(--faint)]">
            A connection earns only when USAGE can observe token counts and a stable request id, and
            an approved pricing snapshot covers the model. Everything else connects, is measured
            where possible, and earns nothing — including a provider that would like to set its own
            price.
          </p>
        </div>
      </section>

      <p className="mt-6 text-[11px] leading-relaxed text-[var(--faint)]">
        USAGE measures compute metadata. We do not store your prompts or AI responses.
      </p>
    </main>
  );
}
