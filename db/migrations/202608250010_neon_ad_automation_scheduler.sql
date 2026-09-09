-- Dedicated scheduler for SAGA ad flows.
--
-- It is intentionally draft-only. A run can create one private Studio draft
-- from a server-validated creative brief, but this schema has no provider
-- credentials, publish queue, ad account, budget or outbound delivery state.

begin;

alter table studio_ad_automations
  add column if not exists next_run_at timestamptz;

alter table studio_ad_automation_test_receipts
  drop constraint if exists studio_ad_automation_test_receipts_state_check;
alter table studio_ad_automation_test_receipts
  add constraint studio_ad_automation_test_receipts_state_check
  check (state in ('queued', 'completed', 'failed'));
alter table studio_ad_automation_test_receipts
  drop constraint if exists studio_ad_automation_test_receipts_workspace_draft_fkey;
alter table studio_ad_automation_test_receipts
  add constraint studio_ad_automation_test_receipts_workspace_draft_fkey
  foreign key (workspace_id, draft_id)
  references studio_drafts(workspace_id, id)
  on delete restrict;
alter table studio_ad_automation_test_receipts
  drop constraint if exists studio_ad_automation_test_receipts_completed_draft_check;
alter table studio_ad_automation_test_receipts
  add constraint studio_ad_automation_test_receipts_completed_draft_check
  check ((state = 'completed' and draft_id is not null) or state <> 'completed');

create table if not exists studio_ad_automation_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app_workspaces(id) on delete cascade,
  automation_id uuid not null,
  workflow_revision integer not null check (workflow_revision > 0),
  scheduled_for timestamptz not null,
  scheduled_local_date date not null,
  scheduled_local_time time not null,
  timezone text not null check (char_length(timezone) between 3 and 80),
  state text not null default 'queued' check (state in ('queued', 'running', 'completed', 'failed', 'cancelled')),
  claim_token uuid,
  claimed_by text,
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 3 check (max_attempts between 1 and 10),
  completed_at timestamptz,
  draft_id uuid,
  failure_code text,
  failure_detail text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, automation_id, workflow_revision, scheduled_for),
  unique (workspace_id, id),
  foreign key (workspace_id, automation_id)
    references studio_ad_automations(workspace_id, id)
    on delete cascade,
  foreign key (workspace_id, draft_id)
    references studio_drafts(workspace_id, id)
    on delete restrict,
  check ((state = 'running' and claim_token is not null and claimed_at is not null and lease_expires_at is not null) or state <> 'running'),
  check ((state in ('completed', 'failed', 'cancelled') and completed_at is not null) or state not in ('completed', 'failed', 'cancelled'))
);

-- Every scheduled run and every manual test receipt owns at most one private
-- Studio draft even when Vercel retries after the INSERT succeeds.
create unique index if not exists studio_drafts_ad_automation_run_idx
  on studio_drafts(workspace_id, (metadata ->> 'adAutomationRunId'))
  where metadata ? 'adAutomationRunId';
create unique index if not exists studio_drafts_ad_automation_test_receipt_idx
  on studio_drafts(workspace_id, (metadata ->> 'adAutomationTestReceiptId'))
  where metadata ? 'adAutomationTestReceiptId';
create index if not exists studio_ad_automation_runs_claimable_idx
  on studio_ad_automation_runs(scheduled_for, created_at)
  where state = 'queued';
create index if not exists studio_ad_automation_runs_lease_idx
  on studio_ad_automation_runs(lease_expires_at)
  where state = 'running';
create index if not exists studio_ad_automations_active_next_run_idx
  on studio_ad_automations(workspace_id, active, next_run_at)
  where active = true;

drop trigger if exists studio_ad_automation_runs_set_updated_at on studio_ad_automation_runs;
create trigger studio_ad_automation_runs_set_updated_at
before update on studio_ad_automation_runs
for each row execute function app_set_updated_at();

commit;
