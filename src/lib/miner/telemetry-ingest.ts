import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, MinerDeviceRow } from "@/lib/supabase/database.types";
import {
  correlate,
  providerIdentityHash,
  validateIncoming,
  verifyDeviceSignature,
  type CorrelationCandidate,
} from "./telemetry";

/**
 * Store what a device observed, and nothing it is not entitled to say.
 *
 * Every write in this file goes to `local_usage_observations`, plus one
 * narrow update on `usage_events` -- provenance_sources and correlation_status
 * -- when an observation's provider request id exactly matches an event USAGE
 * recorded itself. The update object for that event is built here, in the
 * open, and it contains no reward, pricing, status or compute field. Read it;
 * that is the proof.
 */

export interface IngestVerdicts {
  accepted: number;
  duplicate: number;
  rejected: number;
  matched: number;
  verdicts: Record<string, "accepted" | "duplicate" | "rejected" | "matched">;
  /** Reasons by localEventId, for rejected items. Never content. */
  reasons: Record<string, string>;
}

export async function ingestLocalObservations(
  admin: SupabaseClient<Database>,
  input: { userId: string; device: MinerDeviceRow; items: unknown[] },
): Promise<IngestVerdicts> {
  const out: IngestVerdicts = { accepted: 0, duplicate: 0, rejected: 0, matched: 0, verdicts: {}, reasons: {} };

  // Which tools this device may report on. Anything else is rejected, per item.
  const { data: mappingRows } = await admin
    .from("miner_tool_mappings")
    .select("id, tool_id, status")
    .eq("device_id", input.device.id)
    .eq("user_id", input.userId);
  const enabledMappings = new Map(
    (mappingRows ?? []).filter((m) => m.status === "enabled").map((m) => [m.tool_id, m.id] as const),
  );

  for (let index = 0; index < input.items.length; index += 1) {
    const validated = validateIncoming(input.items[index]);
    const key = validated.ok ? validated.observation.localEventId : `item-${index}`;
    if (!validated.ok) {
      out.rejected += 1;
      out.verdicts[key] = "rejected";
      out.reasons[key] = validated.reason;
      continue;
    }
    const { observation, signature } = validated;

    const mappingId = enabledMappings.get(observation.tool);
    if (!mappingId) {
      out.rejected += 1;
      out.verdicts[key] = "rejected";
      out.reasons[key] = "mapping_not_enabled";
      continue;
    }

    // Signature: verified when the device has a key, else recorded unverified.
    // An INVALID signature from a device that has a key is rejected outright --
    // that is either tampering or a second machine using a copied credential.
    let signatureVerified = false;
    if (signature) {
      if (!input.device.public_key) {
        signatureVerified = false;
      } else if (verifyDeviceSignature(input.device.public_key, observation, signature.value)) {
        signatureVerified = true;
      } else {
        out.rejected += 1;
        out.verdicts[key] = "rejected";
        out.reasons[key] = "bad_signature";
        continue;
      }
    }

    // Exact correlation against a record the server itself produced. The
    // candidate must be this user's, this provider's, and carry the very same
    // upstream identity in the metadata the gateway wrote at the time.
    let candidate: CorrelationCandidate | null = null;
    if (observation.upstreamRequestId) {
      const { data: event } = await admin
        .from("usage_events")
        .select("id, verification_level, provenance_sources, verification_status")
        .eq("user_id", input.userId)
        .eq("provider", observation.provider)
        .eq("verification_status", "confirmed")
        .contains("raw_metadata", { upstream_request_id: observation.upstreamRequestId })
        .maybeSingle();
      if (event) {
        candidate = {
          eventId: event.id,
          verificationLevel: event.verification_level,
          provenanceSources: event.provenance_sources ?? [],
        };
      }
    }
    const decision = correlate({ upstreamRequestId: observation.upstreamRequestId, signatureVerified }, candidate);

    const { data: inserted, error } = await admin
      .from("local_usage_observations")
      .insert({
        user_id: input.userId,
        device_id: input.device.id,
        mapping_id: mappingId,
        schema_version: observation.schema,
        adapter: observation.adapter,
        tool_id: observation.tool,
        tool_version: observation.toolVersion,
        source_type: observation.sourceType,
        provider: observation.provider,
        model: observation.model,
        upstream_request_id: observation.upstreamRequestId,
        input_tokens: observation.inputTokens,
        output_tokens: observation.outputTokens,
        cache_read_tokens: observation.cacheReadTokens,
        cache_write_tokens: observation.cacheWriteTokens,
        reasoning_tokens: observation.reasoningTokens,
        tool_tokens: observation.toolTokens,
        estimated_cost_micros: observation.estimatedCostMicros,
        occurred_at: observation.occurredAt,
        local_session_id: observation.localSessionId,
        local_event_id: observation.localEventId,
        device_signature: signature?.value ?? null,
        signature_verified: signatureVerified,
        verification_level: decision.observation.level,
        correlation_status: decision.observation.correlationStatus,
        correlated_event_id: decision.observation.correlatedEventId,
        provider_identity_hash: providerIdentityHash(observation.provider, observation.upstreamRequestId),
      })
      .select("id")
      .maybeSingle();

    if (error) {
      // 23505 is the unique (device_id, local_event_id) -- a retried upload.
      if (error.code === "23505") {
        out.duplicate += 1;
        out.verdicts[key] = "duplicate";
      } else {
        out.rejected += 1;
        out.verdicts[key] = "rejected";
        out.reasons[key] = "store";
      }
      continue;
    }
    if (!inserted) continue;

    if (decision.event) {
      // The whole of what correlation may change on a trusted event. Note
      // what is absent: reward_status, eligible_compute_micros, economic
      // fields, pricing. They are not here because nothing about provenance
      // changes what was earned.
      await admin
        .from("usage_events")
        .update({
          provenance_sources: decision.event.provenanceSources,
          correlation_status: decision.event.correlationStatus,
        })
        .eq("id", decision.event.eventId)
        .eq("user_id", input.userId);
      out.matched += 1;
      out.verdicts[key] = "matched";
    } else {
      out.verdicts[key] = "accepted";
    }
    out.accepted += 1;
  }

  if (out.accepted > 0) {
    const now = new Date().toISOString();
    await admin.from("miner_devices").update({ last_usage_event_at: now, last_seen_at: now }).eq("id", input.device.id);
    await admin
      .from("miner_tool_mappings")
      .update({ last_event_at: now })
      .eq("device_id", input.device.id)
      .in("id", [...enabledMappings.values()]);
  }

  return out;
}
