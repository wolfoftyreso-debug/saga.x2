-- Social publishing credentials are private integration secrets. Browser
-- clients never get direct table access: the server-only connection service
-- encrypts OAuth tokens with AES-256-GCM before they reach this table.
--
-- This migration follows 202608220015_content_studio.sql, which creates
-- public.content_drafts. Publish attempts retain audit records even if a
-- connection is removed; the encrypted credential itself is deleted with the
-- connection.
create table if not exists public.social_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  provider text not null check (provider in ('facebook_page', 'instagram_professional', 'linkedin')),
  provider_account_id text not null check (char_length(btrim(provider_account_id)) between 1 and 300),
  account_label text not null check (char_length(btrim(account_label)) between 1 and 240),
  account_handle text,
  -- v1.<nonce>.<ciphertext>.<tag>; no plaintext OAuth token is stored.
  token_ciphertext text not null check (token_ciphertext ~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'),
  refresh_token_ciphertext text check (refresh_token_ciphertext is null or refresh_token_ciphertext ~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'),
  token_expires_at timestamptz,
  scopes text[] not null default array[]::text[] check (array_position(scopes, null) is null),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  state text not null default 'active' check (state in ('active', 'needs_reauth', 'disconnected', 'error')),
  last_verified_at timestamptz,
  last_error text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (user_id, provider, provider_account_id)
);

create index if not exists social_connections_user_state_idx
  on public.social_connections(user_id, state, updated_at desc);

create table if not exists public.social_publish_attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  content_draft_id uuid references public.content_drafts(id) on delete set null,
  connection_id uuid references public.social_connections(id) on delete set null,
  provider text not null check (provider in ('facebook_page', 'instagram_professional', 'linkedin')),
  -- Scheduler jobs should pass a stable idempotency key. It blocks a retry
  -- from silently creating a second external post after a network timeout.
  idempotency_key text not null check (char_length(btrim(idempotency_key)) between 1 and 220),
  payload_fingerprint text not null check (payload_fingerprint ~ '^[a-f0-9]{64}$'),
  payload_summary jsonb not null default '{}'::jsonb check (jsonb_typeof(payload_summary) = 'object'),
  state text not null default 'running' check (state in ('running', 'published', 'failed')),
  provider_post_id text,
  provider_response jsonb,
  error_code text,
  error_message text,
  started_at timestamptz not null default timezone('utc', now()),
  finished_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  constraint social_publish_attempts_terminal_check check (
    (state = 'running' and finished_at is null)
    or (state in ('published', 'failed') and finished_at is not null)
  )
);

create index if not exists social_publish_attempts_user_draft_idx
  on public.social_publish_attempts(user_id, content_draft_id, created_at desc);
create index if not exists social_publish_attempts_connection_idx
  on public.social_publish_attempts(connection_id, created_at desc);
-- Failed attempts remain auditable and may be retried, but a successful
-- scheduler job can never create a duplicate external post for the same key.
create unique index if not exists social_publish_attempts_published_idempotency_idx
  on public.social_publish_attempts(user_id, provider, idempotency_key)
  where state = 'published';

drop trigger if exists social_connections_updated_at on public.social_connections;
create trigger social_connections_updated_at
before update on public.social_connections
for each row execute function public.set_updated_at();

-- OAuth ciphertext and provider audit data must not be exposed through the
-- generated Supabase browser client. Owner-scoped API routes use service_role
-- and return a deliberately safe projection instead.
alter table public.social_connections enable row level security;
alter table public.social_publish_attempts enable row level security;
revoke all on table public.social_connections from anon, authenticated;
revoke all on table public.social_publish_attempts from anon, authenticated;
