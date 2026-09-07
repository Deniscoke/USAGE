/**
 * First trusted proof: one tiny request through the hosted gateway, then read
 * the receipt back through the user's own authorised path and verify its
 * signature with nothing but the published public key.
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { createPublicKey, verify as nodeVerify } from "node:crypto";

const HOST = "https://usage-denis-mitrovics-projects.vercel.app";
const miner = JSON.parse(readFileSync(".usage/hosted-miner.json", "utf8"));
const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split(/\r?\n/)
    .map((l) => /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(l.trim()))
    .filter(Boolean)
    .map((m) => [m[1], m[2].trim()]),
);

const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const out = (t = "") => process.stdout.write(`${t}\n`);

async function main() {
  out("1. Miner credential proti hostovanemu gateway");
  const trust = await fetch(`${HOST}/api/gateway/trust`, {
    headers: { "x-usage-miner-token": miner.token },
  }).then((r) => r.json());
  out(`   credential: ${trust.minerCredential}`);
  out(`   issuer    : ${trust.issuer}  key: ${trust.issuerKeyId}`);
  if (trust.minerCredential !== "accepted") return 1;

  out("\n2. Jeden maly request cez hostovany USAGE Gateway");
  const model = process.env.MODEL ?? "inclusionai/ling-3.0-flash-fin";
  const started = Date.now();
  const res = await fetch(`${HOST}/api/gateway/anthropic/v1/messages`, {
    method: "POST",
    headers: { "x-usage-miner-token": miner.token, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: 16,
      messages: [{ role: "user", content: "Reply exactly: USAGE_PROOF_OK" }],
    }),
  });
  const body = await res.json();
  out(`   HTTP ${res.status}  (${Date.now() - started} ms)  model ${model}`);
  if (!res.ok) {
    out(`   ${JSON.stringify(body).slice(0, 220)}`);
    return 1;
  }
  out(`   generation id: ${body.id}`);
  out(`   usage        : ${JSON.stringify(body.usage)}`);

  out("\n3. Cakam na zapis dokazu...");
  let proof = null;
  for (let i = 0; i < 12 && !proof; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const { data } = await admin
      .from("proof_records")
      .select("*")
      .eq("user_id", miner.userId)
      .order("ingested_at", { ascending: false })
      .limit(1);
    if (data?.length) proof = data[0];
  }
  if (!proof) {
    out("   ziadny dokaz nezapisany");
    return 1;
  }

  const { data: events } = await admin
    .from("usage_events")
    .select("*")
    .eq("user_id", miner.userId);
  const event = events[0];

  out(`   proof_status    : ${proof.proof_status}`);
  out(`   economic_status : ${event.economic_status}`);
  out(`   verification    : ${event.verification_type} / ${event.verification_status}`);
  out(`   issuer          : ${proof.issuer}  key: ${proof.issuer_key_id}`);
  out(`   canonical hash  : ${proof.proof_hash}`);
  out(`   signature       : ${proof.signature ? proof.signature.slice(0, 24) + "..." : "(ziadny)"}`);
  out(`   tokens          : ${event.input_tokens} in / ${event.cached_input_tokens} cached / ${event.output_tokens} out`);
  out(`   cost            : ${event.reported_cost_micros === null ? "neznamy (" + event.raw_metadata.cost_basis + ")" : event.reported_cost_micros + " micro-USD"}`);

  out("\n4. Nezavisle overenie podpisu (len verejnym klucom)");
  const published = await fetch(`${HOST}/api/receipts/keys`).then((r) => r.json());
  const publicKeyBase64 = published.keys[proof.issuer_key_id];
  if (!publicKeyBase64) {
    out("   verejny kluc pre toto key id nie je publikovany");
    return 1;
  }
  const ok = nodeVerify(
    null,
    Buffer.from(proof.proof_hash, "utf8"),
    createPublicKey({ key: Buffer.from(publicKeyBase64, "base64"), format: "der", type: "spki" }),
    Buffer.from(proof.signature, "base64"),
  );
  out(`   podpis overeny  : ${ok ? "PLATNY" : "NEPLATNY"}`);
  out(`   overene bez     : privatneho kluca, Supabase secret, Gateway kluca`);

  out("\n5. Idempotencia (znovu ta ista generacia, bez noveho requestu)");
  const before = events.length;
  const { data: after } = await admin
    .from("usage_events")
    .select("id")
    .eq("user_id", miner.userId);
  out(`   udalosti: ${before} -> ${after.length}`);
  return ok ? 0 : 1;
}

main().then((c) => process.exit(c));
