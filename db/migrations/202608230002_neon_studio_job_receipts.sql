-- Upgrade path for databases that applied the Neon Studio core before durable
-- automation receipts were added. This migration is safe after 202608230001.

begin;

create extension if not exists pgcrypto;

alter table studio_drafts
  add column if not exists automation_job_id uuid;

alter table studio_jobs
  add column if not exists claim_token uuid;

create unique index if not exists studio_drafts_workspace_automation_job_key
  on studio_drafts (workspace_id, automation_job_id)
  where automation_job_id is not null;

create unique index if not exists studio_jobs_workspace_automation_scheduled_run_idx
  on studio_jobs (workspace_id, automation_id, run_after)
  where automation_id is not null
    and coalesce(payload ->> 'triggerKind', 'scheduled') = 'scheduled';

create index if not exists studio_jobs_global_claimable_idx
  on studio_jobs (run_after, created_at)
  where status = 'queued';

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

commit;
