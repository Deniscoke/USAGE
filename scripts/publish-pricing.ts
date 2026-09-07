/**
 * Publish a reviewed protocol pricing snapshot to the database.
 *
 *   npm run usage:pricing:publish -- usage-pricing-v1
 *
 * The database copy exists so an economic record can be audited without reading
 * the source tree. It is a mirror of the frozen snapshot in src/lib/pricing,
 * never an independent source of truth.
 *
 * A version that has already priced usage is refused: changing it would silently
 * re-price history. A price change means a new version.
 */
import { createClient } from "@supabase/supabase-js";
import { getPricingSnapshot } from "../src/lib/pricing/compute";
import type { Database } from "../src/lib/supabase/database.types";

const line = (text = "") => process.stdout.write(`${text}\n`);

async function main(): Promise<number> {
  const version = process.argv[2] ?? "usage-pricing-v1";
  const snapshot = getPricingSnapshot(version);
  if (!snapshot) {
    line(`Unknown pricing version: ${version}`);
    return 1;
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !secret) {
    line("Supabase is not configured.");
    return 1;
  }

  const admin = createClient<Database>(url, secret, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const priced = await admin
    .from("usage_events")
    .select("id", { count: "exact", head: true })
    .eq("protocol_pricing_version", version);

  if ((priced.count ?? 0) > 0) {
    line(`${version} has already priced ${priced.count} event(s) and is frozen.`);
    line("Generate a new version instead; historical proofs keep their own.");
    // Still ensure the frozen marker is set, then stop.
    await admin.from("protocol_pricing_versions").update({ status: "frozen" }).eq("version", version);
    return 0;
  }

  const versionRow = await admin.from("protocol_pricing_versions").upsert(
    {
      version: snapshot.version,
      source: snapshot.source,
      effective_from: snapshot.effectiveFrom,
      captured_at: snapshot.capturedAt,
      status: "active",
    },
    { onConflict: "version" },
  );
  if (versionRow.error) {
    line(`Failed: ${versionRow.error.message}`);
    return 1;
  }

  const prices = await admin.from("protocol_model_prices").upsert(
    snapshot.prices.map((price) => ({
      pricing_version: snapshot.version,
      model: price.model,
      provider_family: price.providerFamily,
      input_micros_per_million: price.inputMicrosPerMillion,
      output_micros_per_million: price.outputMicrosPerMillion,
      cache_read_micros_per_million: price.cacheReadMicrosPerMillion,
      cache_write_micros_per_million: price.cacheWriteMicrosPerMillion,
      reasoning_micros_per_million: price.reasoningMicrosPerMillion ?? null,
    })),
    { onConflict: "pricing_version,model" },
  );
  if (prices.error) {
    line(`Failed: ${prices.error.message}`);
    return 1;
  }

  line(`Published ${snapshot.version} (${snapshot.prices.length} models, source ${snapshot.source}).`);
  for (const price of snapshot.prices) {
    line(
      `  ${price.model.padEnd(34)} in ${price.inputMicrosPerMillion} / out ${price.outputMicrosPerMillion} micro-USD per 1M`,
    );
  }
  return 0;
}

main().then((code) => process.exit(code));
