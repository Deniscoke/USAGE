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
    routed_mining: provider.methods.routed_mining.availability,
    verified_import: provider.methods.verified_import.availability,
    byok: provider.methods.byok.availability,
    subscription: provider.methods.subscription.availability,
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

  line(`Published ${providers.length} provider(s) and ${listMiningProtocols().length} protocol version(s).`);
  for (const provider of listProviders()) {
    line(
      `  ${provider.slug.padEnd(14)} mining=${provider.methods.routed_mining.availability.padEnd(12)}` +
        ` import=${provider.methods.verified_import.availability}`,
    );
  }
  return 0;
}

main().then((code) => process.exit(code));
