/**
 * Generate a protocol pricing snapshot from the AI Gateway model catalog.
 *
 *   npm run usage:pricing:snapshot -- usage-pricing-v2
 *
 * Run deliberately, review the diff, commit it. Mining must never change
 * because a price list changed on a website overnight: a snapshot is captured
 * once, reviewed, and then frozen. A version already used for economic records
 * is never edited — a new version is created instead.
 */
import { writeFileSync } from "node:fs";

/** Models the protocol prices. Anything else is PENDING_PRICING, never guessed. */
const MODELS = [
  "anthropic/claude-3-haiku",
  "anthropic/claude-haiku-4.5",
  "anthropic/claude-sonnet-4.6",
  "anthropic/claude-opus-5",
  "openai/gpt-5.4",
  "openai/gpt-5-nano",
  "nvidia/nemotron-3-nano-30b-a3b",
  "inclusionai/ling-3.0-flash-fin",
  "inclusionai/ling-3.0-flash-sante",
  "perplexity/sonar",
];

/**
 * Catalog prices are decimal USD *per token*. The protocol stores integer
 * micro-USD *per million tokens*, so the value is scaled by 1e12 — done with
 * BigInt digit shifting, because a float cannot hold 0.00000005 exactly and
 * economics must not inherit that error.
 */
function perTokenToMicrosPerMillion(value: string): number {
  const match = /^(\d+)(?:\.(\d*))?$/.exec(value.trim());
  if (!match) throw new Error(`Unexpected price format: ${value}`);

  const [, whole, frac = ""] = match;
  const digits = BigInt(whole + frac);
  const exponent = 12 - frac.length;

  if (exponent >= 0) return Number(digits * 10n ** BigInt(exponent));

  // More precision than micro-USD per million: round half-up, deterministically.
  const divisor = 10n ** BigInt(-exponent);
  const quotient = digits / divisor;
  const remainder = digits % divisor;
  return Number(remainder * 2n >= divisor ? quotient + 1n : quotient);
}

interface CatalogModel {
  id: string;
  pricing?: {
    input?: string;
    output?: string;
    input_cache_read?: string;
    input_cache_write?: string;
  };
}

async function main(): Promise<number> {
  const version = process.argv[2] ?? "usage-pricing-v1";
  const key = process.env.AI_GATEWAY_API_KEY;
  if (!key) {
    process.stdout.write("AI_GATEWAY_API_KEY is not set.\n");
    return 1;
  }

  const response = await fetch("https://ai-gateway.vercel.sh/v1/models", {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!response.ok) {
    process.stdout.write(`Catalog request failed: HTTP ${response.status}\n`);
    return 1;
  }

  const payload = (await response.json()) as { data?: CatalogModel[]; models?: CatalogModel[] };
  const catalog = payload.data ?? payload.models ?? [];

  const entries: string[] = [];
  for (const id of MODELS) {
    const model = catalog.find((entry) => entry.id === id);
    if (!model?.pricing?.input || !model.pricing.output) {
      process.stdout.write(`skipped (not in catalog): ${id}\n`);
      continue;
    }

    const provider = id.split("/")[0];
    const cacheRead = model.pricing.input_cache_read;
    const cacheWrite = model.pricing.input_cache_write;

    entries.push(
      [
        `  {`,
        `    model: ${JSON.stringify(id)},`,
        `    providerFamily: ${JSON.stringify(provider)},`,
        `    inputMicrosPerMillion: ${perTokenToMicrosPerMillion(model.pricing.input)},`,
        `    outputMicrosPerMillion: ${perTokenToMicrosPerMillion(model.pricing.output)},`,
        `    cacheReadMicrosPerMillion: ${cacheRead ? perTokenToMicrosPerMillion(cacheRead) : "null"},`,
        `    cacheWriteMicrosPerMillion: ${cacheWrite ? perTokenToMicrosPerMillion(cacheWrite) : "null"},`,
        `  },`,
      ].join("\n"),
    );
    process.stdout.write(`captured: ${id}\n`);
  }

  const file = `import type { ProtocolPricingSnapshot } from "./types";

/**
 * PROTOCOL PRICING SNAPSHOT — ${version}
 *
 * GENERATED, THEN FROZEN. Regenerate into a NEW version; never edit this file
 * once economic records reference it, or historical mining would silently
 * change.
 *
 * Source   : Vercel AI Gateway model catalog (GET /v1/models)
 * Captured : ${new Date().toISOString()}
 *
 * Values are integer micro-USD per million tokens. These are PROTOCOL prices,
 * used to compute a deterministic compute value for mining. They are not an
 * invoice and are not what anyone was billed — see docs/ARCHITECTURE.md.
 */
export const ${version.replace(/-/g, "_").toUpperCase()}: ProtocolPricingSnapshot = {
  version: ${JSON.stringify(version)},
  source: "vercel-ai-gateway-catalog",
  effectiveFrom: ${JSON.stringify(new Date().toISOString().slice(0, 10))},
  capturedAt: ${JSON.stringify(new Date().toISOString())},
  prices: [
${entries.join("\n")}
  ],
};
`;

  const target = `src/lib/pricing/${version}.ts`;
  writeFileSync(target, file, "utf8");
  process.stdout.write(`\nwritten: ${target}\n`);
  return 0;
}

main().then((code) => process.exit(code));
