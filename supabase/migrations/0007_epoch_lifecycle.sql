-- USAGE — explicit epoch lifecycle.
--
-- Crediting the ledger is permanent: an allocation id is `<epoch>:<user>` and
-- carries a unique index, so an epoch can credit exactly once. That is the
-- right guarantee, but it means settling an epoch that is still collecting
-- usage silently strands every proof that arrives afterwards.
--
-- So collection and settlement are now separate, explicit phases:
--
--   open        accepts economic usage; estimates only, ledger untouched
--   finalizing  no new usage assigned here; allocations computed
--   settled     allocations immutable, ledger credited exactly once

alter table reward_epochs
  add column if not exists state text not null default 'open',
  add column if not exists finalizing_at timestamptz;

alter table reward_epochs
  add constraint reward_epochs_state_check check (state in ('open', 'finalizing', 'settled'));

-- Historical development epochs were credited under the old one-shot flow.
-- They ARE settled; recording that is a statement of fact, not a change to them.
update reward_epochs set state = 'settled' where settled_at is not null and state = 'open';

-- ---------------------------------------------------- epoch on a usage event
--
-- An event belongs to exactly one epoch, decided at ingestion and never
-- revised. Normally that is the epoch containing occurred_at; when that epoch
-- has already stopped accepting usage the event carries forward to the first
-- open one, and `carried_forward` records that it did. Late compute is never
-- discarded, and a settled epoch is never rewritten.
alter table usage_events
  add column if not exists epoch_id text,
  add column if not exists carried_forward boolean not null default false;

-- Backfill: every existing event belongs to the epoch containing its timestamp.
update usage_events
  set epoch_id = 'epoch-' || to_char(occurred_at at time zone 'utc', 'YYYY-MM-DD')
  where epoch_id is null;

create index if not exists usage_events_epoch_idx on usage_events (user_id, epoch_id);
