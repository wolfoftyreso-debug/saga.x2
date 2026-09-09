-- A durable automation belongs to one brand for its entire lifetime. Jobs
-- inherit that ownership through their immutable (workspace, automation) FK.
begin;

alter table studio_automations add column if not exists brand_profile_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'studio_automation_brand_fk') then
    alter table studio_automations add constraint studio_automation_brand_fk
      foreign key (workspace_id, brand_profile_id)
      references content_engine_brand_profiles(workspace_id, id) on delete restrict;
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'studio_automation_brand_guard') then
    update studio_automations rule
      set brand_profile_id = brand.id
      from content_engine_brand_profiles brand
      where rule.workspace_id = brand.workspace_id and rule.brand_profile_id is null
        and saga_daily_knowledge_brand_is_eligible(brand.workspace_id, brand.id)
        and (select count(*) from content_engine_brand_profiles all_brands
             where all_brands.workspace_id = brand.workspace_id) = 1;
  end if;
end;
$$;

update studio_automations
  set enabled = false, next_run_at = null
  where brand_profile_id is null;

create index if not exists studio_automations_workspace_brand_idx
  on studio_automations(workspace_id, brand_profile_id);

create or replace function studio_guard_automation_brand()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' and not saga_daily_knowledge_brand_is_eligible(new.workspace_id, new.brand_profile_id) then
    raise exception 'An automation requires an explicit completed brand' using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' and (new.workspace_id is distinct from old.workspace_id
     or new.brand_profile_id is distinct from old.brand_profile_id) then
    raise exception 'An automation brand cannot be reassigned' using errcode = '23514';
  end if;
  if new.enabled and not saga_daily_knowledge_brand_is_eligible(new.workspace_id, new.brand_profile_id) then
    raise exception 'An enabled automation requires an active completed brand' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists studio_automation_brand_guard on studio_automations;
create trigger studio_automation_brand_guard before insert or update on studio_automations
  for each row execute function studio_guard_automation_brand();

create or replace function studio_guard_automation_job_owner()
returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and (new.workspace_id is distinct from old.workspace_id
      or new.automation_id is distinct from old.automation_id) then
    raise exception 'A job cannot be moved to another automation or workspace' using errcode = '23514';
  end if;
  if tg_op = 'INSERT' and new.automation_id is not null and not exists (
    select 1 from studio_automations rule
    where rule.workspace_id = new.workspace_id and rule.id = new.automation_id
      and saga_daily_knowledge_brand_is_eligible(rule.workspace_id, rule.brand_profile_id)
  ) then
    raise exception 'An automation job requires an active completed brand' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists studio_automation_job_owner_guard on studio_jobs;
create trigger studio_automation_job_owner_guard before insert or update of workspace_id, automation_id on studio_jobs
  for each row execute function studio_guard_automation_job_owner();

update studio_jobs job
  set status = 'cancelled', completed_at = now(), claim_token = null,
      lease_expires_at = null, locked_by = null,
      failure_code = 'automation_brand_unavailable',
      failure_detail = 'Automationen saknar ett aktivt, färdigställt varumärke.'
  where job.automation_id is not null and job.status in ('queued', 'running')
    and not exists (
      select 1 from studio_automations rule
      where rule.workspace_id = job.workspace_id and rule.id = job.automation_id
        and saga_daily_knowledge_brand_is_eligible(rule.workspace_id, rule.brand_profile_id)
    );

commit;
