import Link from "next/link";
import { redirect } from "next/navigation";
import { AppNav, PrivacyNote, StateBadge } from "@/components/product";
import { EnableMiningButton } from "@/components/enable-mining";
import { Panel } from "@/components/ui";
import { createServerSupabase } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { isUsable, listProviders, type ProviderDefinition } from "@/lib/providers/catalog";
import { ROUTE_STATUS_MEANING } from "@/components/provider-meta";

export const dynamic = "force-dynamic";

/**
 * Onboarding.
 *
 * "What AI do you use?" — then, for each answer, the methods that genuinely
 * exist. A method the registry does not mark `available` is shown as COMING
 * SOON with the reason. Never pretend an integration works.
 */

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

      <section className="mb-8 rounded-lg border border-[color-mix(in_srgb,var(--verified)_30%,transparent)] bg-[color-mix(in_srgb,var(--verified)_6%,transparent)] p-4">
        <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--verified)]">
          Fastest way to start
        </p>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-md text-xs leading-relaxed text-[var(--muted)]">
            Connect OpenRouter in one click — sign in there, approve, done. One connection covers
            hundreds of models from Anthropic, OpenAI, Google and others.
          </p>
          <a
            href="/api/providers/oauth/openrouter/start"
            className="shrink-0 rounded-md bg-[var(--foreground)] px-4 py-2 text-xs font-medium text-[var(--background)]"
          >
            Connect OpenRouter
          </a>
        </div>
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
  return (
    <Panel title={provider.name} hint={provider.tools.map((tool) => tool.name).join(" · ") || undefined}>
      <div className="space-y-3">
        {provider.routes.map((route) => {
          const usable = isUsable(route.status);
          return (
            <div key={route.gateway} className="space-y-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-xs">
                  Enable Mining
                  <span className="ml-1.5 text-[10px] text-[var(--faint)]">
                    via {route.gatewayName}
                  </span>
                </span>
                <StateBadge state={usable ? "setup_required" : "coming_soon"} />
              </div>
              <p className="text-[11px] leading-relaxed text-[var(--faint)]">
                {route.note ?? ROUTE_STATUS_MEANING[route.status]}
              </p>
              {usable && (
                <EnableMiningButton
                  provider={provider.slug}
                  providerName={provider.name}
                  gateway={route.gateway}
                  gatewayName={route.gatewayName}
                />
              )}
            </div>
          );
        })}

        {provider.import.status !== "unsupported" && (
          <div className="space-y-1.5 border-t border-[var(--border)] pt-3">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-xs">Connect Organization</span>
              <StateBadge
                state={isUsable(provider.import.status) ? "setup_required" : "coming_soon"}
              />
            </div>
            <p className="text-[11px] leading-relaxed text-[var(--faint)]">
              {provider.import.note ?? "Import verified organizational usage."}
            </p>
            {isUsable(provider.import.status) && (
              <p className="text-[11px] leading-relaxed text-[var(--muted)]">
                Requires {provider.import.accountRequirement.toLowerCase()} Ask an administrator to
                configure it for your organization.
              </p>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}
