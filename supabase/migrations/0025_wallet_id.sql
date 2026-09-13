-- 0025 — a wallet a person can name out loud.
--
-- WHY. Until now the only way to point at somebody's wallet was their email
-- address or a UUID. An email is personal data that ends up quoted in support
-- threads and payment references; a UUID is unreadable and nobody types it
-- twice the same way. So every profile gets a short identifier: USG-4K7M-2QX9.
--
-- IT IS AN IDENTIFIER, NOT A CREDENTIAL. Knowing somebody's wallet id grants
-- nothing. It does not authenticate, it does not authorise, and the RLS policy
-- on this table still keys on auth.uid() and nothing else. Treat it the way a
-- bank account number is treated: fine to write down, useless on its own.
--
-- Random, not sequential. A counter would leak how many accounts exist and
-- would let anyone guess their neighbour's. Forty bits from pgcrypto is
-- plenty at any size this reaches, and the unique index is the backstop.
--
-- Crockford's alphabet without I, L, O and U: no character can be confused
-- with another when somebody reads it down a phone line, and the set contains
-- no vowels, so it cannot spell anything unfortunate.
--
-- NOT `profiles.wallet_address`. That column is a nullable label for a chain
-- address a person chose to show, and USAGE takes no custody of it. This one
-- names the USAGE credit wallet -- dollars for inference, issued by us, held
-- by us, spendable only here. Two different things that both contain the word
-- wallet, and they must never be displayed or queried as if interchangeable.

create or replace function public.new_wallet_id()
returns text
language plpgsql
volatile
security definer
-- `extensions` is where Supabase installs pgcrypto; a local Postgres puts it in
-- `public`. Both are on the path so gen_random_bytes resolves in either. The
-- first attempt to apply this migration to production failed exactly here,
-- with the path set to public alone, and rolled back cleanly.
set search_path = public, extensions, pg_catalog
as $$
declare
  alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  bytes bytea;
  candidate text;
  position int;
begin
  loop
    bytes := gen_random_bytes(8);
    candidate := '';
    for position in 0..7 loop
      candidate := candidate || substr(alphabet, 1 + (get_byte(bytes, position) % 32), 1);
    end loop;
    candidate := 'USG-' || substr(candidate, 1, 4) || '-' || substr(candidate, 5, 4);
    exit when not exists (select 1 from public.profiles where wallet_id = candidate);
  end loop;
  return candidate;
end;
$$;

comment on function public.new_wallet_id() is
  'A short, unguessable, human-readable wallet identifier. An identifier, never a credential.';

alter table public.profiles
  add column if not exists wallet_id text;

-- Existing accounts get one now. The function is volatile, so this is a
-- fresh identifier per row rather than one value repeated down the table.
update public.profiles set wallet_id = public.new_wallet_id() where wallet_id is null;

create unique index if not exists profiles_wallet_id_key on public.profiles (wallet_id);

alter table public.profiles
  alter column wallet_id set default public.new_wallet_id();

-- Only once every existing row has one, or the constraint cannot hold.
alter table public.profiles
  alter column wallet_id set not null;

-- The shape is enforced, so a hand-written row cannot introduce a second format
-- that support and payment references would then both have to understand.
alter table public.profiles
  drop constraint if exists profiles_wallet_id_format;
alter table public.profiles
  add constraint profiles_wallet_id_format
  check (wallet_id ~ '^USG-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$');

comment on column public.profiles.wallet_id is
  'Public wallet identifier, e.g. USG-4K7M-2QX9. Safe to quote; grants nothing.';
