import Link from "next/link";
import { redirect } from "next/navigation";
import { AppNav, PrivacyNote, StateBadge } from "@/components/product";
import { EnableMiningButton } from "@/components/enable-mining";
import { Panel } from "@/components/ui";
import { createServerSupabase } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { listProviders, type ConnectionMethod, type ProviderDefinition } from "@/lib/providers/catalog";
import type { ConnectionState } from "@/lib/product/connections";

export const dynamic = "force-dynamic";

/**
 * Onboarding.
 *
 * "What AI do you use?" — then, for each answer, the methods that genuinely
 * exist. A method the registry does not mark `available` is shown as COMING
 * SOON with the reason. Never pretend an integration works.
 */

const METHOD_LABEL: Record<ConnectionMethod, string> = {
  routed_mining: "Enable Mining",
  verified_import: "Connect Organization",
  byok: "Use your own key",
  subscription: "Use your subscription",
};

const METHOD_BLURB: Record<ConnectionMethod, string> = {
  routed_mining: "Mine usage routed through USAGE.",
  verified_import: "Import verified organizational usage.",
  byok: "Route with your own provider key.",
  subscription: "Route your existing subscription.",
};

export default async function OnboardingPage() {
  if (!isSupabaseConfigured()) redirect("/");

  const supabase = await createServerSupabase();
  if (!supabase) redirect("/");

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/onboarding");

  const providers = listProviders();

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-6">
      <AppNav email={user.email} />

      <section className="mb-8">
        <h1 className="text-3xl font-medium tracking-tight sm:text-4xl">Welcome to USAGE.</h1>
        <p className="mt-3 max-w-xl text-sm leading-relaxed text-[var(--muted)]">
          Use AI. Mine USAGE. Pick the tools you already use, connect them, and your verified
          compute starts counting toward the current epoch.
        </p>
      </section>

      <h2 className="mb-3 text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--muted)]">
        What AI do you use?
      </h2>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {providers.map((provider) => (
          <ProviderCard key={provider.slug} provider={provider} />
        ))}
      </div>

      <div className="mt-8 space-y-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
        <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--muted)]">
          What USAGE records
        </p>
        <PrivacyNote />
        <Link href="/dashboard" className="inline-block text-xs text-[var(--routed)] hover:underline">
          Skip for now — go to my dashboard →
        </Link>
      </div>
    </main>
  );
}

function ProviderCard({ provider }: { provider: ProviderDefinition }) {
  const methods = (Object.entries(provider.methods) as [ConnectionMethod, ProviderDefinition["methods"][ConnectionMethod]][])
    .filter(([, method]) => method.availability !== "unsupported");

  return (
    <Panel title={provider.name} hint={provider.tools.map((tool) => tool.name).join(" · ") || undefined}>
      <div className="space-y-3">
        {methods.map(([method, definition]) => {
          const state: ConnectionState =
            definition.availability === "available"
              ? "setup_required"
              : definition.availability === "experimental"
                ? "experimental"
                : "coming_soon";

          return (
            <div key={method} className="space-y-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-xs">{METHOD_LABEL[method]}</span>
                <StateBadge state={state} />
              </div>
              <p className="text-[11px] leading-relaxed text-[var(--faint)]">
                {definition.note ?? METHOD_BLURB[method]}
              </p>
              {method === "routed_mining" && definition.availability === "available" && (
                <EnableMiningButton provider={provider.slug} providerName={provider.name} />
              )}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}
