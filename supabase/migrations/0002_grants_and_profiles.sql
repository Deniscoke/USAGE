-- USAGE — privileges and automatic profile creation.
--
-- 0001 established the tables and RLS. This migration pins down *who may write
-- what*, so the trust model does not depend on a project setting.

-- ------------------------------------------------------- table privileges
--
-- Two classes of table:
--
--   USER-OWNED    profiles, provider_connections
--                 The user may read and write their own rows (RLS scopes them).
--
--   TRUSTED       usage_events, usage_daily_aggregates, proof_records,
--                 score_records, reward_epochs, reward_allocations
--                 Written ONLY by server-side ingestion running as the service
--                 role. Clients get SELECT and nothing else.
--
-- This is the verification security boundary: a client cannot POST an event
-- claiming verification_type = 'verified', because a client cannot insert a
-- usage event at all. Verification type is assigned by the adapter layer during
-- trusted server-side ingestion.

grant usage on schema public to anon, authenticated, service_role;

-- Trusted ingestion writes everything; it also bypasses RLS by design.
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;

grant select, insert, update, delete on table profiles to authenticated;
grant select, insert, update, delete on table provider_connections to authenticated;

revoke insert, update, delete on table usage_events from anon, authenticated;
revoke insert, update, delete on table usage_daily_aggregates from anon, authenticated;
revoke insert, update, delete on table proof_records from anon, authenticated;
revoke insert, update, delete on table score_records from anon, authenticated;
revoke insert, update, delete on table reward_epochs from anon, authenticated;
revoke insert, update, delete on table reward_allocations from anon, authenticated;

grant select on table usage_events to authenticated;
grant select on table usage_daily_aggregates to authenticated;
grant select on table proof_records to authenticated;
grant select on table score_records to authenticated;
grant select on table reward_allocations to authenticated;
grant select on table reward_epochs to anon, authenticated;

-- ---------------------------------------------------------- profile creation
--
-- Decision: create profiles with a database trigger on auth.users rather than
-- from application code. It cannot be skipped by a signup path we forget to
-- update, it runs inside the same transaction as the user row, and it is
-- idempotent. The application additionally repairs a missing profile on first
-- authenticated request (see ensureProfile) for users created before this ran.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, split_part(coalesce(new.email, ''), '@', 1))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
