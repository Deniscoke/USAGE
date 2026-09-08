/**
 * One real request, end to end, through a user's own provider connection.
 *
 *   npm run usage:e2e:openrouter -- --connection <uuid> --model <id> --confirm
 *
 * This is the proof that the whole chain works on production infrastructure:
 *
 *   miner credential -> hosted USAGE gateway -> the user's stored provider
 *   credential -> a real model -> usage metadata -> generation identity ->
 *   signed receipt -> production database
 *
 * It spends money, so it refuses to run without --confirm, and it defaults to
 * a free model. It sends one request. Not a loop, not a benchmark.
 *
 * CREDENTIALS. It mints a miner credential in memory, uses it, and revokes it
 * before exiting -- including when the request fails. The token is never
 * printed, never written to disk, and never logged. The provider credential is
 * never touched at all: it stays server-side, which is the property being
 * demonstrated.
 */
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../src/lib/supabase/database.types";
import { createSupabaseMinerStore } from "../src/lib/miner/credentials";

const args = process.argv.slice(2);

function flag(name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

const origin = flag("origin") ?? "https://usage-ten.vercel.app";
const connectionId = flag("connection");
const model = flag("model") ?? "liquid/lfm-2.5-2.6b:free";
const confirmed = args.includes("--confirm");

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const secret = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY!;

function line(text = ""): void {
  process.stdout.write(`${text}\n`);
}

function field(label: string, value: unknown): void {
  line(`  ${label.padEnd(24)}${value === null || value === undefined ? "unknown" : String(value)}`);
}

async function main(): Promise<number> {
  if (!connectionId) {
    line("Usage: --connection <uuid> [--model <id>] [--origin <url>] --confirm");
    return 1;
  }
  if (!confirmed) {
    line("This sends a real request through a real provider. Re-run with --confirm.");
    return 1;
  }

  const admin = createClient<Database>(url, secret, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: connection, error: connectionError } = await admin
    .from("provider_connections")
    .select("id, user_id, provider, account_label, protocol, status, mining_eligibility, revoked_at")
    .eq("id", connectionId)
    .single();
  if (connectionError || !connection) {
    line(`No such connection: ${connectionError?.message ?? "not found"}`);
    return 1;
  }
  if (connection.revoked_at) {
    line("That connection is revoked.");
    return 1;
  }

  line();
  line("  CONNECTION");
  field("provider", connection.provider);
  field("label", connection.account_label);
  field("protocol", connection.protocol);
  field("status", connection.status);
  field("mining eligibility", connection.mining_eligibility);
  line();

  const credentials = createSupabaseMinerStore(admin);
  const minted = await credentials.create(connection.user_id, "m11b-e2e");

  // Everything from here runs inside try/finally: the credential is revoked
  // whether the request succeeds, fails, or throws.
  try {
    const endpoint = `${origin}/api/gateway/provider/${connectionId}/v1/chat/completions`;
    line("  REQUEST");
    field("endpoint", endpoint.replace(connectionId, `${connectionId.slice(0, 8)}…`));
    field("model", model);

    const startedAt = Date.now();
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-usage-miner-token": minted.token,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Reply with the single word: ok" }],
        max_tokens: 16,
      }),
    });

    // Read as text first. A gateway or platform error page is HTML, and
    // "unexpected token <" tells you nothing about what actually went wrong.
    const raw = await response.text();
    let body: {
      id?: string;
      model?: string;
      usage?: Record<string, unknown>;
      error?: { message?: string };
      choices?: { message?: { content?: string } }[];
    };
    try {
      body = JSON.parse(raw);
    } catch {
      field("status", response.status);
      field("content type", response.headers.get("content-type"));
      line();
      line("  The gateway did not return JSON. First 400 bytes:");
      line(`  ${raw.slice(0, 400).replace(/\s+/g, " ")}`);
      return 1;
    }

    field("status", response.status);
    field("latency", `${Date.now() - startedAt} ms`);
    if (!response.ok) {
      field("error", body.error?.message ?? "(no message)");
      return 1;
    }
    field("generation id", body.id);
    field("model returned", body.model);
    field("reply", JSON.stringify(body.choices?.[0]?.message?.content ?? ""));
    field("usage reported", JSON.stringify(body.usage ?? null));
    line();

    // The write happens after the response is streamed, so give it a moment.
    // Polling rather than sleeping: it either lands or it demonstrably did not.
    line("  WAITING FOR INGESTION");
    let event: Database["public"]["Tables"]["usage_events"]["Row"] | null = null;
    for (let attempt = 0; attempt < 15 && !event; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      const { data } = await admin
        .from("usage_events")
        .select("*")
        .eq("connection_id", connectionId)
        .eq("external_reference", body.id ?? "")
        .maybeSingle();
      event = data ?? null;
      process.stdout.write(".");
    }
    line();
    line();

    if (!event) {
      line("  No usage event was recorded for that generation id.");
      return 1;
    }

    line("  USAGE EVENT");
    field("id", event.id);
    field("provider", event.provider);
    field("model", event.model);
    field("source", event.source);
    field("gateway", event.gateway_id);
    field("external reference", event.external_reference);
    field("input tokens", event.input_tokens);
    field("cached input tokens", event.cached_input_tokens);
    field("output tokens", event.output_tokens);
    field("actual cost (micro-USD)", event.actual_cost_micros);
    field("actual cost basis", event.actual_cost_basis);
    field("protocol compute (micros)", event.protocol_compute_micros);
    field("protocol pricing", event.protocol_pricing_version);
    field("eligible compute (micros)", event.eligible_compute_micros);
    line();
    line("  TRUST");
    field("verification type", event.verification_type);
    field("verification status", event.verification_status);
    field("economic status", event.economic_status);
    line();
    line("  ECONOMICS");
    field("economic source", event.economic_source_class);
    field("reward status", event.reward_status);
    field("reward reason", event.reward_reason);
    field("reward policy", event.reward_policy_version);
    field("reward hold", event.reward_hold);
    line();

    const { data: proof } = await admin
      .from("proof_records")
      .select("*")
      .eq("usage_event_id", event.id)
      .maybeSingle();

    if (!proof) {
      line("  No proof record was written.");
      return 1;
    }

    line("  PROOF");
    field("id", proof.id);
    field("kind", proof.proof_kind);
    field("status", proof.proof_status);
    field("verification type", proof.verification_type);
    field("trust environment", proof.trust_environment);
    field("receipt version", proof.receipt_version);
    field("issuer", proof.issuer);
    field("issuer key id", proof.issuer_key_id);
    field("signed at", proof.signed_at);
    field("signature", proof.signature ? `${proof.signature.slice(0, 24)}… (${proof.signature.length} chars)` : null);
    line();
    line(`  Proof page: ${origin}/proofs/${proof.id}`);
    line();

    return 0;
  } finally {
    await credentials.revoke(minted.credentialId).catch(() => undefined);
    line("  (the E2E miner credential has been revoked)");
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    line(`Failed: ${(error as Error).message}`);
    process.exit(1);
  });
