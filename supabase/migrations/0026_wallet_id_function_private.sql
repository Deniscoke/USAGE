-- 0026 — new_wallet_id() is not an API.
--
-- 0025 created public.new_wallet_id() as SECURITY DEFINER. Postgres grants
-- EXECUTE on new functions to PUBLIC, and Supabase exposes every function in
-- the public schema over its REST API, so after 0025 anybody -- signed in or
-- not -- could call it. It leaks nothing (it only ever returns an identifier
-- nobody holds), but a definer function that strangers can invoke in a loop is
-- a door with no reason to be open, and the platform's own advisor flags it.
--
-- Nothing legitimate needs it from outside: identifiers are issued by the
-- column default, evaluated inside the signup trigger (which runs as the
-- function owner) and inside the service-role profile repair.

revoke execute on function public.new_wallet_id() from public;
revoke execute on function public.new_wallet_id() from anon, authenticated;
grant execute on function public.new_wallet_id() to service_role;
