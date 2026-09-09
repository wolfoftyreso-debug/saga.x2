-- Vercel/Neon social connection store.
--
-- Apply after 202608230001_neon_studio_core.sql. OAuth secrets are encrypted
-- by server-only code before this table is written; no browser role or API
-- response is granted direct access to either ciphertext column.

begin;

create table if not exists social_connections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app_workspaces(id) on delete cascade,
  -- A workspace owns the connection, while this records which eligible member
  -- last authenticated/reconnected it. The composite FK prevents a user from
  -- attaching a credential to a workspace they do not belong to.
  connected_by_user_id uuid not null,
  provider text not null check (provider in ('facebook_page', 'instagram_professional', 'linkedin')),
  provider_account_id text not null check (char_length(btrim(provider_account_id)) between 1 and 300),
  account_label text not null check (char_length(btrim(account_label)) between 1 and 240),
  account_handle text check (account_handle is null or char_length(btrim(account_handle)) between 1 and 240),
  -- AES-256-GCM envelopes: v1.<nonce>.<ciphertext>.<authentication-tag>.
  -- Plain OAuth tokens, refresh tokens and provider responses do not belong in
  -- this table.
  token_ciphertext text not null check (token_ciphertext ~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'),
  refresh_token_ciphertext text check (refresh_token_ciphertext is null or refresh_token_ciphertext ~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'),
  token_expires_at timestamptz,
  scopes text[] not null default array[]::text[] check (array_position(scopes, null) is null),
  -- Provider account IDs / account type only. Never persist an access token in
  -- metadata, even encrypted, because it would bypass the dedicated columns.
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  state text not null default 'active' check (state in ('active', 'needs_reauth', 'disconnected', 'error')),
  last_verified_at timestamptz,
  last_error text check (last_error is null or char_length(last_error) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, provider, provider_account_id),
  foreign key (workspace_id, connected_by_user_id)
    references app_workspace_memberships(workspace_id, user_id)
    on delete restrict
);

create index if not exists social_connections_workspace_state_idx
  on social_connections (workspace_id, state, updated_at desc);
create index if not exists social_connections_workspace_provider_idx
  on social_connections (workspace_id, provider, updated_at desc);

drop trigger if exists social_connections_set_updated_at on social_connections;
create trigger social_connections_set_updated_at
before update on social_connections
for each row execute function app_set_updated_at();

commit;
