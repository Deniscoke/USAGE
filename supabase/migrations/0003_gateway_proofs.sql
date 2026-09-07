-- USAGE — routed evidence from an AI gateway.
--
-- Adds the provenance columns needed to explain *why* an event is trusted, and
-- a source value for gateway-observed traffic.

-- A dedicated source: `gateway` stays valid for any future gateway, this names
-- the one we actually observe through.
alter type usage_source add value if not exists 'vercel_ai_gateway';

-- ---------------------------------------------------------------- provenance
--
-- Given an event, these answer: where did it come from, why is it that
-- verification level, which external request proves it, and which integration
-- version normalized it.
--
-- Deliberately NOT stored: credentials, prompts, completions, raw provider
-- payloads. `proof_metadata` carries a whitelisted set of non-secret fields
-- chosen by the adapter -- never arbitrary provider JSON.
alter table proof_records
  add column if not exists proof_source text,
  add column if not exists external_reference text,
  add column if not exists observed_at timestamptz,
  add column if not exists ingested_at timestamptz not null default now(),
  add column if not exists adapter_version text;

-- One proof of a given kind per event, so re-ingesting an observation cannot
-- accumulate duplicate provenance rows.
create unique index if not exists proof_records_event_kind_key
  on proof_records (usage_event_id, proof_kind);

create index if not exists proof_records_external_reference_idx
  on proof_records (user_id, external_reference);
