-- Immutable upgrade for deployments that applied the first scheduler migration
-- before lease recovery and revision-scoped idempotency were introduced.
-- Keep this separate from 010: Vercel/Neon deployments may already have
-- recorded that migration.

begin;

-- Browsers cannot self-verify an offer. Normalize records saved before the
-- V1 server-owned verification rule, and retire a stale verification time.
update studio_ad_automations
   set workflow = jsonb_set(
     workflow #- '{creative,creativeBrief,offer,verification,verifiedAt}',
     '{creative,creativeBrief,offer,verification,status}',
     '"unverified"'::jsonb,
     true
   )
 where jsonb_typeof(workflow) = 'object'
   and workflow #> '{creative,creativeBrief,offer,verification}' is not null;

-- Scheduled records with advisory free-form visual direction need an editor
-- review under the stricter V1 scheduler. Normalize every such workflow (the
-- new parser rejects it whether currently active or not), and pause any
-- previously active schedule until an editor explicitly re-enables it.
update studio_ad_automations
   set workflow = jsonb_set(
         workflow,
         '{creative,creativeBrief,customVisualDirection}',
         '""'::jsonb,
         true
       ),
       active = false,
       next_run_at = null
 where workflow #>> '{trigger,kind}' = 'schedule'
   and coalesce(workflow #>> '{creative,creativeBrief,customVisualDirection}', '') <> '';

alter table studio_ad_automation_runs
  add column if not exists lease_expires_at timestamptz;
alter table studio_ad_automation_runs
  add column if not exists attempts integer not null default 0;
alter table studio_ad_automation_runs
  add column if not exists max_attempts integer not null default 3;

-- A pre-lease worker could have left a record in `running` forever. Return
-- those receipts to the safe draft-only queue before requiring all running
-- rows to carry a lease, so no old claim blocks the scheduler indefinitely.
update studio_ad_automation_runs
   set state = 'queued',
       claim_token = null,
       claimed_by = null,
       claimed_at = null,
       lease_expires_at = null,
       completed_at = null,
       failure_code = null,
       failure_detail = null
 where state = 'running';

alter table studio_ad_automation_runs
  drop constraint if exists studio_ad_automation_runs_workspace_id_automation_id_scheduled_for_key;

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'studio_ad_automation_runs'::regclass
       and conname = 'studio_ad_automation_runs_workspace_id_automation_id_workflow_revision_scheduled_for_key'
  ) then
    alter table studio_ad_automation_runs
      add constraint studio_ad_automation_runs_workspace_id_automation_id_workflow_revision_scheduled_for_key
      unique (workspace_id, automation_id, workflow_revision, scheduled_for);
  end if;
end
$$;

alter table studio_ad_automation_runs
  drop constraint if exists studio_ad_automation_runs_running_claim_check;
alter table studio_ad_automation_runs
  add constraint studio_ad_automation_runs_running_claim_check
  check ((state = 'running' and claim_token is not null and claimed_at is not null and lease_expires_at is not null) or state <> 'running');

alter table studio_ad_automation_runs
  drop constraint if exists studio_ad_automation_runs_attempts_check;
alter table studio_ad_automation_runs
  add constraint studio_ad_automation_runs_attempts_check
  check (attempts >= 0 and max_attempts between 1 and 10);

create index if not exists studio_ad_automation_runs_lease_idx
  on studio_ad_automation_runs(lease_expires_at)
  where state = 'running';

commit;
