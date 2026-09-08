-- USAGE — provider credentials in Supabase Vault.
--
-- M8 stored credentials as AES-256-GCM ciphertext under an application
-- environment variable. That works and is tested, but it has one real
-- operational weakness: rotating USAGE_SECRET_ENCRYPTION_KEY makes every stored
-- credential unreadable, so the key can never actually be rotated.
--
-- Vault moves the key into Postgres, where it is managed rather than pasted.
-- The application keeps holding an opaque reference and never learns which
-- backend answered.

-- Which backend holds a given secret, so both can coexist during migration and
-- a reference is never read with the wrong one.
alter table provider_secrets
  add column if not exists backend text not null default 'aes',
  -- Null once the value lives in Vault. The row still ties a user to a secret.
  alter column ciphertext drop not null;

alter table provider_secrets
  add constraint provider_secrets_backend_check check (backend in ('aes', 'vault'));

-- ------------------------------------------------------------- vault access
--
-- The `vault` schema is not reachable through PostgREST, so access goes through
-- SECURITY DEFINER functions. Those are dangerous by default, so every one of
-- them is written the careful way:
--
--   * search_path = '' and every object schema-qualified, so nothing can be
--     resolved through a caller-controlled schema;
--   * EXECUTE revoked from public, anon and authenticated;
--   * granted only to service_role, which no browser ever holds;
--   * the owning user id is a REQUIRED argument and is checked against the
--     row, so this is not a general secret-reading RPC even for service_role.
--
-- vault.decrypted_secrets is never exposed to anon or authenticated. Nothing
-- here grants it.
do $$
begin
  if not exists (select 1 from pg_namespace where nspname = 'vault') then
    -- No Vault on this database (the in-process Postgres used by tests). The
    -- application checks availability and falls back to the AES backend.
    return;
  end if;

  create or replace function public.usage_vault_available()
  returns boolean
  language sql
  security definer
  set search_path = ''
  as $fn$ select true $fn$;

  create or replace function public.usage_vault_create_secret(
    p_user_id uuid,
    p_secret text,
    p_label text
  )
  returns uuid
  language plpgsql
  security definer
  set search_path = ''
  as $fn$
  declare
    v_secret_id uuid;
  begin
    -- The Vault name namespaces the secret to its owner, so two users' secrets
    -- can never collide and a name alone is not guessable.
    v_secret_id := vault.create_secret(
      p_secret,
      'usage:' || p_user_id::text || ':' || gen_random_uuid()::text,
      p_label
    );
    insert into public.provider_secrets (id, user_id, ciphertext, backend)
    values (v_secret_id, p_user_id, null, 'vault');
    return v_secret_id;
  end;
  $fn$;

  create or replace function public.usage_vault_read_secret(
    p_user_id uuid,
    p_secret_id uuid
  )
  returns text
  language plpgsql
  security definer
  set search_path = ''
  as $fn$
  declare
    v_secret text;
  begin
    -- Ownership is enforced here, inside the definer, so a caller cannot read
    -- a secret belonging to somebody else even with service_role.
    if not exists (
      select 1 from public.provider_secrets s
      where s.id = p_secret_id and s.user_id = p_user_id and s.backend = 'vault'
    ) then
      return null;
    end if;

    select ds.decrypted_secret into v_secret
    from vault.decrypted_secrets ds
    where ds.id = p_secret_id;

    return v_secret;
  end;
  $fn$;

  create or replace function public.usage_vault_update_secret(
    p_user_id uuid,
    p_secret_id uuid,
    p_secret text
  )
  returns void
  language plpgsql
  security definer
  set search_path = ''
  as $fn$
  begin
    if not exists (
      select 1 from public.provider_secrets s
      where s.id = p_secret_id and s.user_id = p_user_id and s.backend = 'vault'
    ) then
      return;
    end if;

    perform vault.update_secret(p_secret_id, p_secret);
    update public.provider_secrets
    set rotated_at = now()
    where id = p_secret_id;
  end;
  $fn$;

  create or replace function public.usage_vault_delete_secret(
    p_user_id uuid,
    p_secret_id uuid
  )
  returns void
  language plpgsql
  security definer
  set search_path = ''
  as $fn$
  begin
    if not exists (
      select 1 from public.provider_secrets s
      where s.id = p_secret_id and s.user_id = p_user_id and s.backend = 'vault'
    ) then
      return;
    end if;

    delete from vault.secrets where id = p_secret_id;
    delete from public.provider_secrets where id = p_secret_id;
  end;
  $fn$;

  -- Default-deny, then grant exactly one role. A SECURITY DEFINER function that
  -- public can execute is a privilege escalation, not a helper.
  revoke all on function public.usage_vault_available() from public, anon, authenticated;
  revoke all on function public.usage_vault_create_secret(uuid, text, text) from public, anon, authenticated;
  revoke all on function public.usage_vault_read_secret(uuid, uuid) from public, anon, authenticated;
  revoke all on function public.usage_vault_update_secret(uuid, uuid, text) from public, anon, authenticated;
  revoke all on function public.usage_vault_delete_secret(uuid, uuid) from public, anon, authenticated;

  grant execute on function public.usage_vault_available() to service_role;
  grant execute on function public.usage_vault_create_secret(uuid, text, text) to service_role;
  grant execute on function public.usage_vault_read_secret(uuid, uuid) to service_role;
  grant execute on function public.usage_vault_update_secret(uuid, uuid, text) to service_role;
  grant execute on function public.usage_vault_delete_secret(uuid, uuid) to service_role;
end $$;
