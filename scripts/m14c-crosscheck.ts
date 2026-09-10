/**
 * M14C cross-check: ask OpenRouter's own generation surface about ONE
 * generation, using the stored connection credential server-side.
 *
 *   npm run usage:m14c:crosscheck -- --connection <uuid> --generation <gen-id>
 *
 * The credential is read into memory, used for two GETs, and never printed.
 * Only usage metadata is echoed: no prompt, no response, no key.
 */
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../src/lib/supabase/database.types";
import { resolveSecretStore } from "../src/lib/secrets/store";

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const secret = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY!;
const connectionId = flag("connection");
const generationId = flag("generation");

const SAFE_GENERATION_FIELDS = [
  "id", "model", "provider_name", "created_at", "tokens_prompt", "tokens_completion",
  "native_tokens_prompt", "native_tokens_completion", "native_tokens_reasoning", "native_tokens_cached",
  "total_cost", "usage", "upstream_inference_cost", "is_byok", "streamed", "cancelled", "finish_reason",
  "latency", "generation_time", "origin", "app_id", "external_user",
];

function line(label: string, value: unknown): void {
  process.stdout.write(`  ${label.padEnd(30)}${value === null || value === undefined ? "unknown" : String(value)}\n`);
}

async function main(): Promise<number> {
  if (!connectionId || !generationId) throw new Error("usage: --connection <uuid> --generation <gen-id>");
  const admin = createClient<Database>(url, secret, { auth: { persistSession: false } });
  const { data: connection } = await admin
    .from("provider_connections")
    .select("id, user_id, secret_id, provider")
    .eq("id", connectionId)
    .single();
  if (!connection?.secret_id || connection.provider !== "openrouter") throw new Error("not an OpenRouter connection with a stored credential");

  const store = await resolveSecretStore(admin);
  const credential = await store.read({ id: connection.secret_id, userId: connection.user_id });
  const headers = { authorization: `Bearer ${credential}` };

  const generation = await fetch(`https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(generationId)}`, { headers });
  line("generation lookup status", generation.status);
  if (generation.ok) {
    const body = (await generation.json()) as { data?: Record<string, unknown> };
    const data = body.data ?? {};
    for (const key of SAFE_GENERATION_FIELDS) if (key in data) line(key, JSON.stringify(data[key]));
  } else {
    line("generation lookup", (await generation.text()).slice(0, 200).replace(/\s+/g, " "));
  }

  const key = await fetch("https://openrouter.ai/api/v1/key", { headers });
  line("key lookup status", key.status);
  if (key.ok) {
    const body = (await key.json()) as { data?: Record<string, unknown> };
    const data = body.data ?? {};
    for (const field of ["is_free_tier", "usage", "usage_daily", "limit", "limit_remaining", "byok_usage"]) line(`account ${field}`, JSON.stringify(data[field]));
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stdout.write(`Failed: ${(error as Error).message}\n`);
    process.exit(1);
  });
