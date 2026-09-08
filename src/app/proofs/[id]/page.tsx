import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AppNav, PrivacyNote } from "@/components/product";
import { Panel, VerificationBadge } from "@/components/ui";
import { formatNumber, formatUsd } from "@/lib/domain/money";
import { rowToUsageRecord } from "@/lib/db/rows";
import { checkStoredSignature, receiptFromStoredProof } from "@/lib/product/proof";
import { providerForModel } from "@/lib/providers/catalog";
import { createServerSupabase } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { expectedIssuer, publishedPublicKeys } from "@/lib/trust/production";
import type { ProofRecordRow, UsageEventRow } from "@/lib/supabase/database.types";

export const dynamic = "force-dynamic";

/**
 * Proof of Usage, for a person.
 *
 * The top of the page answers "did this count, and can I trust it?". Receipt
 * ids, issuers and signatures are real and shown, but folded away: they are
 * evidence for the curious, not the headline.
 *
 * Reads run as the signed-in user, so RLS -- not this code -- decides whether
 * the proof is theirs to see.
 */

const ECONOMIC_COPY: Record<string, { label: string; detail: string; tone: string }> = {
  eligible: {
    label: "ELIGIBLE",
    detail: "Counted toward mining in its epoch.",
    tone: "var(--verified)",
  },
  settled: {
    label: "SETTLED",
    detail: "Already counted into a settled epoch allocation.",
    tone: "var(--verified)",
  },
  pending_pricing: {
    label: "PENDING",
    detail: "A genuine proof, waiting for approved pricing for this model.",
    tone: "var(--warn)",
  },
  pending_cost: {
    label: "PENDING",
    detail: "A genuine proof whose economic weight is not established yet.",
    tone: "var(--warn)",
  },
  ineligible: {
    label: "NOT EARNING",
    detail: "Shown in your history. Self-reported usage never earns.",
    tone: "var(--reported)",
  },
};

export default async function ProofPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isSupabaseConfigured()) notFound();

  const supabase = await createServerSupabase();
  if (!supabase) notFound();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=/proofs/${id}`);

  const { data: eventRow } = await supabase
    .from("usage_events")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (!eventRow) notFound();

  const { data: proofRow } = await supabase
    .from("proof_records")
    .select("*")
    .eq("usage_event_id", id)
    .maybeSingle();

  const event = rowToUsageRecord(eventRow as UsageEventRow);
  const proof = (proofRow ?? null) as ProofRecordRow | null;
  const signed = proof ? receiptFromStoredProof(event, proof) : null;
  const signature = checkStoredSignature(signed, publishedPublicKeys(), expectedIssuer());

  const provider = providerForModel(event.model);
  const economic = ECONOMIC_COPY[event.economicStatus ?? "ineligible"] ?? ECONOMIC_COPY.ineligible;
  const confirmed = proof?.proof_status === "confirmed";

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:px-6">
      <AppNav email={user.email} />

      <p className="text-[11px] uppercase tracking-[0.18em] text-[var(--faint)]">Proof of Usage</p>
      <h1
        className="mt-2 text-3xl font-medium tracking-tight"
        style={{ color: confirmed ? "var(--verified)" : "var(--warn)" }}
      >
        {confirmed ? "Confirmed ✓" : (proof?.proof_status ?? "no proof").toUpperCase()}
      </h1>
      <p className="mt-2 text-sm text-[var(--muted)]">
        {confirmed
          ? "USAGE observed this request first-hand and stands behind it."
          : "This record exists, but USAGE does not attest to it as trusted evidence."}
      </p>

      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        <Panel title="What ran">
          <dl className="space-y-2.5 text-xs">
            <Row label="Tool" value={String(event.rawMetadata.client_type ?? "—")} />
            <Row label="Provider" value={provider?.name ?? event.provider} />
            <Row label="Model" value={event.model} />
            <Row label="When" value={event.occurredAt.slice(0, 19).replace("T", " ")} />
            <div className="flex items-center justify-between gap-3 pt-1">
              <dt className="text-[var(--muted)]">Evidence</dt>
              <dd>
                <VerificationBadge type={event.verificationType} />
              </dd>
            </div>
          </dl>
        </Panel>

        <Panel title="Usage">
          <dl className="space-y-2.5 text-xs">
            <Row label="Input" value={formatNumber(event.inputTokens)} />
            <Row label="Cache read" value={formatNumber(event.cachedInputTokens)} />
            <Row
              label="Cache write"
              value={
                typeof event.rawMetadata.cache_write_tokens === "number"
                  ? formatNumber(event.rawMetadata.cache_write_tokens)
                  : "—"
              }
            />
            <Row label="Output" value={formatNumber(event.outputTokens)} />
          </dl>
        </Panel>

        <Panel title="Protocol compute">
          <dl className="space-y-2.5 text-xs">
            <Row
              label="Compute equivalent"
              value={
                event.protocolPricingVersion
                  ? formatUsd(event.protocolComputeMicros ?? 0)
                  : "not priced yet"
              }
            />
            <Row label="Pricing" value={event.protocolPricingVersion ?? "—"} />
            <Row
              label="Provider cost"
              value={
                event.reportedCostMicros === null
                  ? "not reported"
                  : formatUsd(event.reportedCostMicros)
              }
            />
          </dl>
          <p className="mt-3 text-[11px] leading-relaxed text-[var(--faint)]">
            Protocol compute is what the network values this work at. It is not a bill and not what
            anyone was charged.
          </p>
        </Panel>

        <Panel title="Mining">
          <p className="text-lg tracking-tight" style={{ color: economic.tone }}>
            {economic.label}
          </p>
          <p className="mt-2 text-[11px] leading-relaxed text-[var(--muted)]">{economic.detail}</p>
          <div className="mt-3 border-t border-[var(--border)] pt-3 text-xs">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[var(--muted)]">Signature</span>
              <span
                style={{
                  color: signature.state === "valid" ? "var(--verified)" : "var(--warn)",
                }}
              >
                {signature.state === "valid" ? "SIGNED ✓" : signature.state.toUpperCase()}
              </span>
            </div>
            {"reason" in signature && (
              <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--faint)]">
                {signature.reason}
              </p>
            )}
          </div>
        </Panel>
      </div>

      <details className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
        <summary className="cursor-pointer text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--muted)]">
          Advanced
        </summary>
        <dl className="mt-3 space-y-2 text-[11px]">
          <Row label="Receipt ID" value={proof?.receipt_id ?? "—"} mono />
          <Row label="Receipt version" value={proof?.receipt_version ?? "—"} mono />
          <Row
            label="Generation ID"
            value={String(event.rawMetadata.gateway_generation_id ?? "—")}
            mono
          />
          <Row label="Issuer" value={proof?.issuer ?? "—"} mono />
          <Row label="Issuer key" value={proof?.issuer_key_id ?? "—"} mono />
          <Row label="Canonical hash" value={proof?.proof_hash ?? "—"} mono />
          <Row label="Trust environment" value={proof?.trust_environment ?? "—"} mono />
          <Row label="Adapter" value={proof?.adapter_version ?? "—"} mono />
        </dl>
        <p className="mt-3 text-[11px] leading-relaxed text-[var(--faint)]">
          The signature is checked against USAGE&apos;s published public key, which anyone can fetch
          from{" "}
          <Link href="/api/receipts/keys" className="text-[var(--routed)] hover:underline">
            /api/receipts/keys
          </Link>
          . The private key never leaves USAGE infrastructure.
        </p>
      </details>

      <div className="mt-4">
        <PrivacyNote />
      </div>
    </main>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-[var(--muted)]">{label}</dt>
      <dd className={`truncate text-right ${mono ? "tnum text-[var(--faint)]" : "tnum"}`}>
        {value}
      </dd>
    </div>
  );
}
