-- Durable Vercel/Neon audit receipts for intentional social publishing.
--
-- Apply after 202608230003_neon_social_connections.sql. A receipt is created
-- before any provider request, so an unavailable audit table can never result
-- in an untracked external post. Provider tokens never appear in this table.

begin;

create table if not exists social_publish_attempts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app_workspaces(id) on delete cascade,
  draft_id uuid,
  connection_id uuid,
  initiated_by_user_id uuid not null,
  provider text not null check (provider in ('facebook_page', 'instagram_professional', 'linkedin')),
  -- One key covers every state, not just success. A timeout after a provider
  -- accepts a post must never turn a retry into a silent duplicate.
  idempotency_key text not null check (char_length(btrim(idempotency_key)) between 1 and 220),
  payload_fingerprint text not null check (payload_fingerprint ~ '^[a-f0-9]{64}$'),
  -- A deliberately tiny safe receipt: never copy post body, OAuth tokens,
  -- full provider responses, or private Blob URLs into audit metadata.
  payload_summary jsonb not null default '{}'::jsonb check (jsonb_typeof(payload_summary) = 'object'),
  state text not null default 'running' check (state in ('running', 'published', 'failed')),
  provider_post_id text,
  provider_response jsonb not null default '{}'::jsonb check (jsonb_typeof(provider_response) = 'object'),
  error_code text check (error_code is null or char_length(error_code) <= 120),
  error_message text check (error_message is null or char_length(error_message) <= 1000),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, provider, idempotency_key),
  check (
    (state = 'running' and finished_at is null)
    or (state in ('published', 'failed') and finished_at is not null)
  ),
  foreign key (workspace_id, initiated_by_user_id)
    references app_workspace_memberships(workspace_id, user_id)
    on delete restrict,
  -- Keep the audit receipt after a draft or connection is removed, without
  -- weakening workspace isolation for a live relation.
  foreign key (workspace_id, draft_id)
    references studio_drafts(workspace_id, id)
    on delete set null (draft_id),
  foreign key (workspace_id, connection_id)
    references social_connections(workspace_id, id)
    on delete set null (connection_id)
);

create index if not exists social_publish_attempts_workspace_draft_idx
  on social_publish_attempts (workspace_id, draft_id, created_at desc);
create index if not exists social_publish_attempts_workspace_connection_idx
  on social_publish_attempts (workspace_id, connection_id, created_at desc);
create index if not exists social_publish_attempts_running_idx
  on social_publish_attempts (workspace_id, started_at)
  where state = 'running';

drop trigger if exists social_publish_attempts_set_updated_at on social_publish_attempts;
create trigger social_publish_attempts_set_updated_at
before update on social_publish_attempts
for each row execute function app_set_updated_at();

commit;
