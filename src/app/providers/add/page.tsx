import Link from "next/link";
import { redirect } from "next/navigation";
import { AppNav, PrivacyNote } from "@/components/product";
import { AddProviderWizard, type ProviderPreset } from "@/components/add-provider";
import { createServerSupabase } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { listProviders } from "@/lib/providers/catalog";

export const dynamic = "force-dynamic";

/**
 * Add a provider.
 *
 * Presets are conveniences, not a limit: the same form connects a provider
 * USAGE has never heard of, because what matters is the protocol, not the
 * company.
 */

/** Known providers that publish a compatible endpoint, as starting points. */
const PRESET_ENDPOINTS: Record<string, { protocol: ProviderPreset["protocol"]; baseUrl: string }> = {
  openai: { protocol: "openai_compatible", baseUrl: "https://api.openai.com" },
  anthropic: { protocol: "anthropic_compatible", baseUrl: "https://api.anthropic.com" },
  mistral: { protocol: "openai_compatible", baseUrl: "https://api.mistral.ai" },
  openrouter: { protocol: "openai_compatible", baseUrl: "https://openrouter.ai/api" },
  xai: { protocol: "openai_compatible", baseUrl: "https://api.x.ai" },
};

export default async function AddProviderPage() {
  if (!isSupabaseConfigured()) redirect("/providers");

  const supabase = await createServerSupabase();
  if (!supabase) redirect("/providers");

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/providers/add");

  const presets: ProviderPreset[] = listProviders()
    .filter((provider) => PRESET_ENDPOINTS[provider.slug])
    .map((provider) => ({
      slug: provider.slug,
      name: provider.name,
      family: provider.slug,
      ...PRESET_ENDPOINTS[provider.slug],
    }));

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-8 sm:px-6">
      <AppNav email={user.email} />

      <h1 className="text-3xl font-medium tracking-tight">Connect any AI.</h1>
      <p className="mt-3 text-sm leading-relaxed text-[var(--muted)]">
        Does your AI provider expose an OpenAI- or Anthropic-compatible API? Connect it to USAGE.
        Verified compute can earn USAGE.
      </p>

      <div className="mt-8">
        <AddProviderWizard presets={presets} />
      </div>

      <div className="mt-8 space-y-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
        <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--muted)]">
          What USAGE records
        </p>
        <PrivacyNote />
        <Link href="/providers" className="inline-block text-xs text-[var(--routed)] hover:underline">
          ← Back to providers
        </Link>
      </div>
    </main>
  );
}
