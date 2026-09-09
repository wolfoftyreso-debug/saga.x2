-- SAGA Signal Production: an opt-in, draft-only bridge from qualified News
-- signals to private Studio review items.
--
-- This migration intentionally has no provider credentials, no model queue,
-- no Blob write, and no social/newsletter delivery table.  It only stores a
-- durable receipt and a private draft reference created by the Vercel Cron.

begin;

create table if not exists saga_signal_production_policies (
  workspace_id uuid primary key references app_workspaces(id) on delete cascade,
  created_by_user_id uuid not null,
  updated_by_user_id uuid not null,
  enabled boolean not null default false,
  calendar_enabled boolean not null default false,
  calendar_delay_minutes integer not null default 1440
    check (calendar_delay_minutes between 15 and 43200),
  timezone text not null default 'Europe/Stockholm'
    check (char_length(trim(timezone)) between 3 and 80),
  max_drafts_per_tick smallint not null default 2
    check (max_drafts_per_tick between 1 and 5),
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (workspace_id, created_by_user_id)
    references app_workspace_memberships(workspace_id, user_id)
    on delete restrict,
  foreign key (workspace_id, updated_by_user_id)
    references app_workspace_memberships(workspace_id, user_id)
    on delete restrict
);

create table if not exists saga_signal_production_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app_workspaces(id) on delete cascade,
  signal_candidate_id uuid not null,
  author_user_id uuid not null,
  policy_revision integer not null check (policy_revision > 0),
  calendar_enabled boolean not null default false,
  calendar_scheduled_at timestamptz,
  calendar_timezone text not null default 'Europe/Stockholm'
    check (char_length(trim(calendar_timezone)) between 3 and 80),
  state text not null default 'queued'
    check (state in ('queued', 'running', 'completed', 'blocked', 'failed', 'cancelled')),
  run_after timestamptz not null default now(),
  claim_token uuid,
  claimed_by text,
  lease_expires_at timestamptz,
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 3 check (max_attempts between 1 and 10),
  draft_id uuid,
  quality jsonb not null default '{}'::jsonb check (jsonb_typeof(quality) = 'object'),
  calendar_withheld boolean not null default false,
  failure_code text,
  failure_detail text,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, signal_candidate_id),
  unique (workspace_id, id),
  foreign key (workspace_id, signal_candidate_id)
    references saga_news_signal_candidates(workspace_id, id)
    on delete restrict,
  foreign key (workspace_id, author_user_id)
    references app_workspace_memberships(workspace_id, user_id)
    on delete restrict,
  foreign key (workspace_id, draft_id)
    references studio_drafts(workspace_id, id)
    on delete restrict,
  check ((state = 'running' and claim_token is not null and lease_expires_at is not null) or state <> 'running'),
  check ((state in ('completed', 'blocked', 'failed', 'cancelled') and completed_at is not null) or state not in ('completed', 'blocked', 'failed', 'cancelled')),
  check ((calendar_enabled and calendar_scheduled_at is not null) or (not calendar_enabled and calendar_scheduled_at is null))
);

-- A retry that loses its Vercel response after inserting the private draft
-- re-reads this sole row instead of creating a second review item.
create unique index if not exists studio_drafts_saga_signal_production_job_idx
  on studio_drafts(workspace_id, (metadata ->> 'sagaSignalProductionJobId'))
  where metadata ? 'sagaSignalProductionJobId';
create index if not exists saga_signal_production_jobs_claimable_idx
  on saga_signal_production_jobs(state, run_after, created_at)
  where state = 'queued';
create index if not exists saga_signal_production_jobs_lease_idx
  on saga_signal_production_jobs(lease_expires_at)
  where state = 'running';
create index if not exists saga_signal_production_policies_enabled_idx
  on saga_signal_production_policies(workspace_id)
  where enabled = true;

drop trigger if exists saga_signal_production_policies_set_updated_at on saga_signal_production_policies;
create trigger saga_signal_production_policies_set_updated_at
before update on saga_signal_production_policies
for each row execute function app_set_updated_at();

drop trigger if exists saga_signal_production_jobs_set_updated_at on saga_signal_production_jobs;
create trigger saga_signal_production_jobs_set_updated_at
before update on saga_signal_production_jobs
for each row execute function app_set_updated_at();

commit;
