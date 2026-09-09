-- Vercel + Neon Studio foundation.
--
-- Apply this file with a database owner through Neon SQL Editor or the chosen
-- migration runner. The application only uses DATABASE_URL on the server.
-- Authorization is intentionally not implemented in this schema: all future
-- server repositories must select by a trusted workspace_id.

begin;

create extension if not exists pgcrypto;

create table if not exists app_workspaces (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug = lower(slug) and slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name text not null check (char_length(trim(name)) between 1 and 160),
  timezone text not null default 'Europe/Stockholm' check (char_length(timezone) between 1 and 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists app_users (
  id uuid primary key default gen_random_uuid(),
  vercel_subject text not null unique,
  email text,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (email is null or char_length(email) <= 320),
  check (display_name is null or char_length(trim(display_name)) between 1 and 160)
);

create table if not exists app_workspace_memberships (
  workspace_id uuid not null references app_workspaces(id) on delete cascade,
  user_id uuid not null references app_users(id) on delete cascade,
  role text not null default 'editor' check (role in ('owner', 'editor', 'viewer')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

-- Stores only a one-way session token hash. Raw session tokens never belong in
-- Neon or in browser-visible environment variables. workspace_id is a durable
-- membership-scoped session choice, never an unverified cookie claim.
create table if not exists app_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id) on delete cascade,
  workspace_id uuid not null,
  token_hash text not null unique check (char_length(token_hash) >= 32),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_seen_at timestamptz,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  foreign key (workspace_id, user_id)
    references app_workspace_memberships(workspace_id, user_id)
    on delete cascade
);

create table if not exists studio_templates (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app_workspaces(id) on delete cascade,
  created_by_user_id uuid not null,
  name text not null check (char_length(trim(name)) between 1 and 160),
  content_type text not null check (content_type in ('social_post', 'newsletter', 'article')),
  title_template text not null default '',
  body_template text not null default '',
  prompt text,
  channel_defaults jsonb not null default '{}'::jsonb check (jsonb_typeof(channel_defaults) = 'object'),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, created_by_user_id)
    references app_workspace_memberships(workspace_id, user_id)
    on delete restrict
);

create table if not exists studio_drafts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app_workspaces(id) on delete cascade,
  author_user_id uuid not null,
  template_id uuid,
  automation_job_id uuid,
  content_type text not null check (content_type in ('social_post', 'newsletter', 'article')),
  status text not null default 'draft' check (status in ('draft', 'in_review', 'approved', 'scheduled', 'publishing', 'published', 'failed', 'cancelled')),
  title text not null default '',
  body text not null default '',
  excerpt text,
  publication_channels jsonb not null default '[]'::jsonb check (jsonb_typeof(publication_channels) = 'array'),
  source_context jsonb not null default '[]'::jsonb check (jsonb_typeof(source_context) = 'array'),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  revision integer not null default 1 check (revision > 0),
  scheduled_at timestamptz,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status <> 'scheduled' or scheduled_at is not null),
  check (status <> 'published' or published_at is not null),
  unique (workspace_id, id),
  foreign key (workspace_id, author_user_id)
    references app_workspace_memberships(workspace_id, user_id)
    on delete restrict,
  foreign key (workspace_id, template_id)
    references studio_templates(workspace_id, id)
    on delete restrict
);

create table if not exists studio_automations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app_workspaces(id) on delete cascade,
  created_by_user_id uuid not null,
  template_id uuid,
  name text not null check (char_length(trim(name)) between 1 and 160),
  content_type text not null check (content_type in ('social_post', 'newsletter', 'article')),
  schedule_kind text not null default 'manual' check (schedule_kind in ('manual', 'cron', 'trigger')),
  cron_expression text,
  trigger_config jsonb not null default '{}'::jsonb check (jsonb_typeof(trigger_config) = 'object'),
  generation_config jsonb not null default '{}'::jsonb check (jsonb_typeof(generation_config) = 'object'),
  enabled boolean not null default false,
  approval_required boolean not null default true,
  next_run_at timestamptz,
  last_run_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((schedule_kind = 'cron' and cron_expression is not null) or (schedule_kind <> 'cron' and cron_expression is null)),
  unique (workspace_id, id),
  foreign key (workspace_id, created_by_user_id)
    references app_workspace_memberships(workspace_id, user_id)
    on delete restrict,
  foreign key (workspace_id, template_id)
    references studio_templates(workspace_id, id)
    on delete restrict
);

create table if not exists studio_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app_workspaces(id) on delete cascade,
  automation_id uuid,
  draft_id uuid,
  kind text not null check (kind in ('draft_generation', 'media_generation', 'publish', 'newsletter_delivery')),
  status text not null default 'queued' check (status in ('queued', 'running', 'completed', 'failed', 'cancelled')),
  idempotency_key text,
  claim_token uuid,
  run_after timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  lease_expires_at timestamptz,
  locked_by text,
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 3 check (max_attempts between 1 and 20),
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  result jsonb not null default '{}'::jsonb check (jsonb_typeof(result) = 'object'),
  failure_code text,
  failure_detail text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, idempotency_key),
  unique (workspace_id, id),
  check ((status = 'running' and started_at is not null) or status <> 'running'),
  check ((status in ('completed', 'failed', 'cancelled') and completed_at is not null) or status not in ('completed', 'failed', 'cancelled')),
  foreign key (workspace_id, automation_id)
    references studio_automations(workspace_id, id)
    on delete restrict,
  foreign key (workspace_id, draft_id)
    references studio_drafts(workspace_id, id)
    on delete restrict
);

create table if not exists studio_media (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app_workspaces(id) on delete cascade,
  draft_id uuid,
  job_id uuid,
  created_by_user_id uuid not null,
  storage_provider text not null default 'vercel_blob' check (storage_provider = 'vercel_blob'),
  blob_url text not null check (blob_url ~ '^https://'),
  blob_pathname text not null check (char_length(trim(blob_pathname)) between 1 and 1024),
  content_type text not null check (char_length(trim(content_type)) between 1 and 255),
  byte_size bigint check (byte_size is null or byte_size >= 0),
  width integer check (width is null or width > 0),
  height integer check (height is null or height > 0),
  kind text not null default 'upload' check (kind in ('upload', 'generated', 'derived')),
  status text not null default 'ready' check (status in ('processing', 'ready', 'failed', 'deleted')),
  alt_text text,
  content_hash text,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, blob_pathname),
  unique (workspace_id, id),
  foreign key (workspace_id, draft_id)
    references studio_drafts(workspace_id, id)
    on delete restrict,
  foreign key (workspace_id, job_id)
    references studio_jobs(workspace_id, id)
    on delete restrict,
  foreign key (workspace_id, created_by_user_id)
    references app_workspace_memberships(workspace_id, user_id)
    on delete restrict
);

-- studio_drafts and studio_jobs intentionally reference each other: a job may
-- materialize one draft, and the draft must retain that job receipt. Add this
-- FK after both tables exist so retries can never create a second draft.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'studio_drafts_workspace_automation_job_fkey'
  ) then
    alter table studio_drafts
      add constraint studio_drafts_workspace_automation_job_fkey
      foreign key (workspace_id, automation_job_id)
      references studio_jobs(workspace_id, id)
      on delete restrict;
  end if;
end;
$$;

create index if not exists app_sessions_active_by_user_idx
  on app_sessions (workspace_id, user_id, expires_at)
  where revoked_at is null;
create index if not exists app_users_email_idx
  on app_users (lower(email))
  where email is not null;
create index if not exists app_workspace_memberships_user_idx
  on app_workspace_memberships (user_id, workspace_id);
create index if not exists studio_templates_workspace_active_idx
  on studio_templates (workspace_id, is_active, updated_at desc);
-- Template slugs are stored in the JSON compatibility envelope so the Neon
-- schema can retain all rich editor fields without duplicating a legacy row.
-- Enforce uniqueness inside a workspace at the database boundary as well.
create unique index if not exists studio_templates_workspace_slug_idx
  on studio_templates (workspace_id, (metadata ->> 'slug'))
  where metadata ? 'slug';
create index if not exists studio_drafts_workspace_status_idx
  on studio_drafts (workspace_id, status, updated_at desc);
create index if not exists studio_drafts_workspace_schedule_idx
  on studio_drafts (workspace_id, scheduled_at)
  where status = 'scheduled';
create unique index if not exists studio_drafts_workspace_automation_job_key
  on studio_drafts (workspace_id, automation_job_id)
  where automation_job_id is not null;
create unique index if not exists studio_jobs_workspace_automation_scheduled_run_idx
  on studio_jobs (workspace_id, automation_id, run_after)
  where automation_id is not null
    and coalesce(payload ->> 'triggerKind', 'scheduled') = 'scheduled';
create index if not exists studio_automations_workspace_enabled_idx
  on studio_automations (workspace_id, enabled, next_run_at);
create index if not exists studio_jobs_claimable_idx
  on studio_jobs (workspace_id, run_after, created_at)
  where status = 'queued';
create index if not exists studio_jobs_global_claimable_idx
  on studio_jobs (run_after, created_at)
  where status = 'queued';
create index if not exists studio_jobs_lease_idx
  on studio_jobs (lease_expires_at)
  where status = 'running';
create index if not exists studio_media_workspace_created_idx
  on studio_media (workspace_id, created_at desc);

create or replace function app_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists app_workspaces_set_updated_at on app_workspaces;
create trigger app_workspaces_set_updated_at
before update on app_workspaces
for each row execute function app_set_updated_at();

drop trigger if exists app_users_set_updated_at on app_users;
create trigger app_users_set_updated_at
before update on app_users
for each row execute function app_set_updated_at();

drop trigger if exists studio_templates_set_updated_at on studio_templates;
create trigger studio_templates_set_updated_at
before update on studio_templates
for each row execute function app_set_updated_at();

drop trigger if exists studio_drafts_set_updated_at on studio_drafts;
create trigger studio_drafts_set_updated_at
before update on studio_drafts
for each row execute function app_set_updated_at();

drop trigger if exists studio_automations_set_updated_at on studio_automations;
create trigger studio_automations_set_updated_at
before update on studio_automations
for each row execute function app_set_updated_at();

drop trigger if exists studio_jobs_set_updated_at on studio_jobs;
create trigger studio_jobs_set_updated_at
before update on studio_jobs
for each row execute function app_set_updated_at();

drop trigger if exists studio_media_set_updated_at on studio_media;
create trigger studio_media_set_updated_at
before update on studio_media
for each row execute function app_set_updated_at();

commit;
