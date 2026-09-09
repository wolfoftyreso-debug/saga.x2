-- Manual "run now" actions are durable so a browser retry cannot create a
-- second AI draft. They are intentionally distinct from scheduled queue rows:
-- downstream materialisation treats `manual` as an unscheduled draft only.

alter table public.content_automation_jobs
  add column if not exists trigger_kind text not null default 'scheduled';

alter table public.content_automation_jobs
  add column if not exists manual_run_key uuid;

-- Existing rows predate manual runs and are safely classified as scheduled.
update public.content_automation_jobs
set trigger_kind = 'scheduled'
where trigger_kind is null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'content_automation_jobs_trigger_kind_check'
      and conrelid = 'public.content_automation_jobs'::regclass
  ) then
    alter table public.content_automation_jobs
      add constraint content_automation_jobs_trigger_kind_check
      check (trigger_kind in ('scheduled', 'manual'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'content_automation_jobs_manual_run_shape_check'
      and conrelid = 'public.content_automation_jobs'::regclass
  ) then
    alter table public.content_automation_jobs
      add constraint content_automation_jobs_manual_run_shape_check
      check (
        (trigger_kind = 'scheduled' and manual_run_key is null)
        or (trigger_kind = 'manual' and manual_run_key is not null)
      );
  end if;
end
$$;

-- A key is supplied by the browser for one deliberate click. The partial
-- unique index leaves ordinary scheduled slots governed by their existing
-- `(automation_rule_id, scheduled_for)` uniqueness rule.
create unique index if not exists content_automation_jobs_manual_run_key_idx
  on public.content_automation_jobs (automation_rule_id, manual_run_key)
  where manual_run_key is not null;

create index if not exists content_automation_jobs_manual_user_idx
  on public.content_automation_jobs (user_id, trigger_kind, scheduled_for desc)
  where trigger_kind = 'manual';
