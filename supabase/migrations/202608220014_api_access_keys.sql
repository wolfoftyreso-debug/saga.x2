-- External API keys are private, read-only credentials for a user's own brief
-- data. The secret is generated server-side and stored only as a SHA-256 hash
-- of a 256-bit random token; no plaintext credential column exists.
create table if not exists public.api_access_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  key_prefix text not null unique check (key_prefix ~ '^pdb_live_[A-Za-z0-9_-]{12}$'),
  secret_hash text not null check (secret_hash ~ '^[a-f0-9]{64}$'),
  scopes text[] not null default array['briefs:read', 'feed:json', 'feed:rss']::text[],
  created_at timestamptz not null default timezone('utc', now()),
  last_used_at timestamptz,
  revoked_at timestamptz,
  constraint api_access_keys_scopes_check check (
    cardinality(scopes) between 1 and 4
    and array_position(scopes, null) is null
    and scopes <@ array['briefs:read', 'feed:json', 'feed:rss', 'feed:sse']::text[]
  )
);

create index if not exists api_access_keys_user_created_idx
  on public.api_access_keys(user_id, created_at desc);

-- A prefix must remain tied to exactly one secret. Revocation and last-used
-- timestamps can change, but a token can never be silently repointed.
create or replace function public.prevent_api_access_key_identity_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.user_id is distinct from old.user_id
     or new.key_prefix is distinct from old.key_prefix
     or new.secret_hash is distinct from old.secret_hash then
    raise exception 'API key identity is immutable';
  end if;
  return new;
end;
$$;

drop trigger if exists api_access_keys_identity_before_update on public.api_access_keys;
create trigger api_access_keys_identity_before_update
before update of user_id, key_prefix, secret_hash on public.api_access_keys
for each row execute function public.prevent_api_access_key_identity_change();

-- There is intentionally no direct authenticated-table policy. A browser
-- session must go through the server route, which selects only safe metadata;
-- this keeps even the one-way secret hash out of client responses. service_role
-- bypasses RLS for the audited server-only create/list/revoke/verify path.
alter table public.api_access_keys enable row level security;
revoke all on table public.api_access_keys from anon, authenticated;
