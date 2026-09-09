-- SAGA Daily Knowledge: a workspace-scoped, opt-in research loop.
--
-- It consumes only the existing, metadata-only SAGA News Core catalog. This
-- migration intentionally creates no Studio draft, prompt, model, media,
-- delivery or publication record. A daily entry is a retained evidence bundle
-- that a person may inspect; it is not an article or a publishing instruction.

begin;

create table if not exists saga_daily_knowledge_policies (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null unique references app_workspaces(id) on delete cascade,
  created_by_user_id uuid not null,
  updated_by_user_id uuid not null,
  enabled boolean not null default false,
  timezone text not null default 'Europe/Stockholm'
    check (char_length(trim(timezone)) between 3 and 80),
  daily_at time without time zone not null default time '06:00',
  topics text[] not null,
  source_ids uuid[] not null,
  minimum_independent_publishers smallint not null default 2
    check (minimum_independent_publishers between 2 and 12),
  minimum_evidence_items smallint not null default 2
    check (minimum_evidence_items between 2 and 30),
  maximum_evidence_items smallint not null default 8
    check (maximum_evidence_items between 2 and 30),
  evidence_window_hours smallint not null default 72
    check (evidence_window_hours between 12 and 168),
  retention_days smallint not null default 90
    check (retention_days between 7 and 365),
  last_materialized_for_date date,
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, created_by_user_id)
    references app_workspace_memberships(workspace_id, user_id)
    on delete restrict,
  foreign key (workspace_id, updated_by_user_id)
    references app_workspace_memberships(workspace_id, user_id)
    on delete restrict,
  check (cardinality(topics) between 1 and 12),
  check (cardinality(source_ids) between 1 and 40),
  check (minimum_evidence_items <= maximum_evidence_items)
);

create table if not exists saga_daily_knowledge_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app_workspaces(id) on delete cascade,
  policy_id uuid not null,
  policy_revision integer not null check (policy_revision > 0),
  knowledge_date date not null,
  idempotency_key text not null check (char_length(trim(idempotency_key)) between 12 and 220),
  policy_snapshot jsonb not null default '{}'::jsonb
    check (jsonb_typeof(policy_snapshot) = 'object'),
  state text not null default 'queued'
    check (state in ('queued', 'running', 'completed', 'failed', 'cancelled')),
  run_after timestamptz not null default now(),
  claim_token uuid,
  claimed_by text,
  lease_expires_at timestamptz,
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 3 check (max_attempts between 1 and 10),
  evidence_entries_created integer not null default 0 check (evidence_entries_created >= 0),
  failure_code text,
  failure_detail text,
  completed_at timestamptz,
  retention_expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, policy_id, knowledge_date),
  unique (workspace_id, idempotency_key),
  foreign key (workspace_id, policy_id)
    references saga_daily_knowledge_policies(workspace_id, id)
    on delete cascade,
  check ((state = 'running' and claim_token is not null and lease_expires_at is not null) or state <> 'running'),
  check ((state in ('completed', 'failed', 'cancelled') and completed_at is not null) or state not in ('completed', 'failed', 'cancelled'))
);

create table if not exists saga_daily_knowledge_entries (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app_workspaces(id) on delete cascade,
  policy_id uuid not null,
  job_id uuid not null,
  policy_revision integer not null check (policy_revision > 0),
  knowledge_date date not null,
  topic text not null check (char_length(trim(topic)) between 2 and 160),
  topic_key text not null check (topic_key ~ '^[a-f0-9]{64}$'),
  headline text not null check (char_length(trim(headline)) between 1 and 320),
  summary text not null check (char_length(trim(summary)) between 1 and 1200),
  evidence_count integer not null default 0 check (evidence_count between 0 and 30),
  independent_publisher_count integer not null default 0 check (independent_publisher_count >= 0),
  -- The application schema only permits a narrow, metadata-only evidence
  -- shape. `body_text` from saga_news_source_items is never selected into it.
  evidence jsonb not null default '[]'::jsonb
    check (jsonb_typeof(evidence) = 'array' and jsonb_array_length(evidence) <= 30),
  retention_expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, policy_id, knowledge_date, topic_key),
  foreign key (workspace_id, policy_id)
    references saga_daily_knowledge_policies(workspace_id, id)
    on delete cascade,
  foreign key (workspace_id, job_id)
    references saga_daily_knowledge_jobs(workspace_id, id)
    on delete cascade
);

create index if not exists saga_daily_knowledge_policies_due_idx
  on saga_daily_knowledge_policies(enabled, last_materialized_for_date)
  where enabled = true;
create index if not exists saga_daily_knowledge_jobs_claimable_idx
  on saga_daily_knowledge_jobs(state, run_after, created_at)
  where state = 'queued';
create index if not exists saga_daily_knowledge_jobs_lease_idx
  on saga_daily_knowledge_jobs(lease_expires_at)
  where state = 'running';
create index if not exists saga_daily_knowledge_jobs_retention_idx
  on saga_daily_knowledge_jobs(retention_expires_at)
  where state in ('completed', 'failed', 'cancelled');
create index if not exists saga_daily_knowledge_entries_recent_idx
  on saga_daily_knowledge_entries(workspace_id, knowledge_date desc, created_at desc);

drop trigger if exists saga_daily_knowledge_policies_set_updated_at on saga_daily_knowledge_policies;
create trigger saga_daily_knowledge_policies_set_updated_at
before update on saga_daily_knowledge_policies
for each row execute function app_set_updated_at();

drop trigger if exists saga_daily_knowledge_jobs_set_updated_at on saga_daily_knowledge_jobs;
create trigger saga_daily_knowledge_jobs_set_updated_at
before update on saga_daily_knowledge_jobs
for each row execute function app_set_updated_at();

drop trigger if exists saga_daily_knowledge_entries_set_updated_at on saga_daily_knowledge_entries;
create trigger saga_daily_knowledge_entries_set_updated_at
before update on saga_daily_knowledge_entries
for each row execute function app_set_updated_at();

commit;
