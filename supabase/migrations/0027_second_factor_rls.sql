-- USAGE — the second factor, enforced by the database itself.
--
-- Two-factor authentication already stops a stolen password at every page, API
-- route and server action (src/proxy.ts, src/lib/auth/assurance.ts). Those are
-- application checks. A browser also holds a Supabase session that can query
-- PostgREST directly, and a session that signed in with a password but has not
-- yet passed its factor (aal1) is still a valid `authenticated` session. Without
-- this migration it could read its owner's usage, points, wallet and devices
-- straight from the REST API.
--
-- THE RULE: an account with a verified factor reads its own data only from a
-- session that passed that factor (aal2). An account with no factor is
-- unaffected -- its password session reads exactly what it read before.
--
-- HOW: one RESTRICTIVE policy per table that holds a user's own data. Restrictive
-- policies are AND-ed with the existing permissive ones, so this can only ever
-- narrow access; it cannot grant anything to anybody. The service role bypasses
-- RLS, so ingestion, settlement and the cron are untouched.
--
-- Public reference tables (prices, protocol versions, providers) are left alone:
-- they hold nothing about the user, and hiding them mid-sign-in helps nobody.

-- Fails closed: a session whose token carries no `aal` claim is treated as aal1,
-- which is enough for an account without a factor and not enough for one with.
create or replace function public.session_satisfies_second_factor()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce((select auth.jwt()) ->> 'aal', 'aal1') = 'aal2'
      or not exists (
        select 1
        from auth.mfa_factors f
        where f.user_id = (select auth.uid())
          and f.status::text = 'verified'
      );
$$;

comment on function public.session_satisfies_second_factor() is
  'True when the current session passed its second factor, or its account has none. Used only by restrictive RLS policies.';

revoke all on function public.session_satisfies_second_factor() from public, anon;
grant execute on function public.session_satisfies_second_factor() to authenticated;

-- Every public table with a policy that mentions the caller's identity gets the
-- restrictive policy. Computed from the catalog rather than typed out, so a
-- table cannot be forgotten here; src/lib/db/second-factor-rls.test.ts fails if
-- a later migration adds a per-user table without one.
do $$
declare
  target record;
begin
  for target in
    select distinct p.schemaname, p.tablename
    from pg_policies p
    where p.schemaname = 'public'
      and (coalesce(p.qual, '') ilike '%auth.uid()%' or coalesce(p.with_check, '') ilike '%auth.uid()%')
  loop
    execute format('drop policy if exists "require second factor" on %I.%I', target.schemaname, target.tablename);
    execute format(
      'create policy "require second factor" on %I.%I as restrictive for all to authenticated
         using ((select public.session_satisfies_second_factor()))
         with check ((select public.session_satisfies_second_factor()))',
      target.schemaname,
      target.tablename
    );
  end loop;
end
$$;
