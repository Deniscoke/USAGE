-- USAGE — signed proof issuance and the proof/economic split.
--
-- Three separate questions, three separate columns:
--
--   verification_type  what kind of evidence is this?      (routed/verified/reported)
--   proof_status       do we attest that it happened?      (observed/confirmed/rejected)
--   economic_status    may it earn right now?              (eligible/pending_cost/ineligible)
--
-- A genuine hosted request whose cost has not reconciled is
-- routed + confirmed + pending_cost: a real proof that is not yet payable.
-- Calling it unconfirmed because a billing figure is missing would be false.

alter table usage_events
  add column if not exists economic_status text not null default 'ineligible';

alter table usage_events
  add constraint usage_events_economic_status_check
  check (economic_status in ('eligible', 'pending_cost', 'ineligible'));

create index if not exists usage_events_economic_status_idx
  on usage_events (user_id, economic_status);

-- --------------------------------------------------------- signed receipts
--
-- The canonical hash proves integrity; the signature proves origin. The private
-- key lives only in trusted hosted infrastructure, so a receipt that verifies
-- against the published USAGE public key could not have been minted locally.
alter table proof_records
  add column if not exists proof_status text not null default 'observed',
  add column if not exists receipt_id uuid,
  add column if not exists receipt_version text,
  add column if not exists issuer text,
  add column if not exists issuer_key_id text,
  add column if not exists signature text,
  add column if not exists signed_at timestamptz;

alter table proof_records
  add constraint proof_records_proof_status_check
  check (proof_status in ('observed', 'confirmed', 'rejected'));

create unique index if not exists proof_records_receipt_id_key
  on proof_records (receipt_id) where receipt_id is not null;

create index if not exists proof_records_status_idx on proof_records (user_id, proof_status);

-- Clients still read only. Confirmation and signing happen server-side, and no
-- grant here would let a client set proof_status or economic_status.
grant select on table proof_records to authenticated;
