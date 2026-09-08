/**
 * Mirror the provider catalog and mining protocol into the database.
 *
 *   npm run usage:providers:publish
 *
 * The code is the source of truth; this makes the same facts auditable from the
 * database without reading the source tree. Idempotent: re-running writes the
 * same rows.
 */
import { createClient } from "@supabase/supabase-js";
import { listProviders } from "../src/lib/providers/catalog";
import { listMiningProtocols } from "../src/lib/protocol/emission";
import type { Database } from "../src/lib/supabase/database.types";

const line = (text = "") => process.stdout.write(`${text}\n`);

async function main(): Promise<number> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !secret) {
    line("Supabase is not configured.");
    return 1;
  }

  const admin = createClient<Database>(url, secret, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const providers = listProviders().map((provider) => ({
    slug: provider.slug,
    name: provider.name,
    category: provider.category,
    status: provider.status,
    integration_version: provider.integrationVersion,
    byok: provider.byok.availability,
    subscription: provider.subscription.availability,
    import_status: provider.import.status,
    import_source: provider.import.source,
    import_account_requirement: provider.import.accountRequirement,
    import_granularity: provider.import.granularity,
    import_cost_availability: provider.import.costAvailability,
    usage_fields: [...provider.usageFields],
    cost_fields: [...provider.costFields],
    updated_at: new Date().toISOString(),
  }));

  const { error: providerError } = await admin
    .from("providers")
    .upsert(providers, { onConflict: "slug" });
  if (providerError) {
    line(`providers: ${providerError.message}`);
    return 1;
  }

  const routes = listProviders().flatMap((provider) =>
    provider.routes.map((route) => ({
      provider_slug: provider.slug,
      gateway: route.gateway,
      status: route.status,
      auth_requirement: route.authRequirement,
      cost_availability: route.costAvailability,
      note: route.note ?? null,
      updated_at: new Date().toISOString(),
    })),
  );

  const { error: routeError } = await admin
    .from("provider_routes")
    .upsert(routes, { onConflict: "provider_slug,gateway" });
  if (routeError) {
    line(`provider routes: ${routeError.message}`);
    return 1;
  }

  const { error: protocolError } = await admin.from("mining_protocol_versions").upsert(
    listMiningProtocols().map((protocol) => ({
      version: protocol.version,
      epoch_duration_seconds: protocol.epochDurationSeconds,
      epoch_emission_points: protocol.epochEmissionPoints,
      scoring_version: protocol.scoringVersion,
      pricing_version: protocol.pricingVersion,
      effective_from: protocol.effectiveFrom,
      network: protocol.network,
      status: protocol.status,
      created_at: new Date().toISOString(),
    })),
    { onConflict: "version" },
  );
  if (protocolError) {
    line(`mining protocol: ${protocolError.message}`);
    return 1;
  }

  line(
    `Published ${providers.length} provider(s), ${routes.length} route(s) and ` +
      `${listMiningProtocols().length} protocol version(s).`,
  );
  for (const provider of listProviders()) {
    const routeSummary =
      provider.routes.map((route) => `${route.gateway}=${route.status}`).join(" ") || "no routes";
    line(`  ${provider.slug.padEnd(14)} ${routeSummary.padEnd(46)} import=${provider.import.status}`);
  }
  return 0;
}

main().then((code) => process.exit(code));
