-- Give each brand its own retained knowledge policy. Ambiguous legacy data is
-- retained but paused and invisible to authoring; never guess a default brand.
begin;

alter table saga_daily_knowledge_policies
  add column if not exists brand_profile_id uuid;

alter table saga_daily_knowledge_policies
  drop constraint if exists saga_daily_knowledge_policies_workspace_id_key;

create unique index if not exists saga_daily_knowledge_policies_workspace_brand_idx
  on saga_daily_knowledge_policies(workspace_id, brand_profile_id);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'saga_daily_knowledge_policy_brand_fk') then
    alter table saga_daily_knowledge_policies
      add constraint saga_daily_knowledge_policy_brand_fk
      foreign key (workspace_id, brand_profile_id)
      references content_engine_brand_profiles(workspace_id, id) on delete cascade;
  end if;
end;
$$;

create or replace function saga_daily_knowledge_brand_is_eligible(target_workspace uuid, target_brand uuid)
returns boolean language sql stable as $$
  select exists (
    select 1 from content_engine_brand_profiles brand
    join saga_brand_onboardings onboarding
      on onboarding.workspace_id = brand.workspace_id and onboarding.brand_profile_id = brand.id
    where brand.workspace_id = target_workspace and brand.id = target_brand
      and brand.active = true and onboarding.completion_state = 'completed'
  );
$$;

-- Backfill only where the old workspace policy has a single possible owner.
-- Reruns cannot adopt formerly ambiguous records after a brand was removed.
do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'saga_daily_knowledge_policy_brand_guard') then
    with unique_brand as (
      select brand.workspace_id, (array_agg(brand.id order by brand.id))[1] as brand_profile_id
      from content_engine_brand_profiles brand
      where saga_daily_knowledge_brand_is_eligible(brand.workspace_id, brand.id)
        and (select count(*) from content_engine_brand_profiles all_brands
             where all_brands.workspace_id = brand.workspace_id) = 1
      group by brand.workspace_id having count(*) = 1
    )
    update saga_daily_knowledge_policies policy
      set brand_profile_id = unique_brand.brand_profile_id
      from unique_brand
      where policy.workspace_id = unique_brand.workspace_id and policy.brand_profile_id is null;
  end if;
end;
$$;

update saga_daily_knowledge_policies
  set enabled = false, revision = revision + 1
  where brand_profile_id is null and enabled = true;

create or replace function saga_daily_knowledge_guard_brand()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' and new.brand_profile_id is null then
    raise exception 'A knowledge policy requires an explicit brand' using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' and (
    new.workspace_id is distinct from old.workspace_id
    or new.brand_profile_id is distinct from old.brand_profile_id
  ) then
    raise exception 'A knowledge policy brand cannot be reassigned' using errcode = '23514';
  end if;
  if new.enabled and not saga_daily_knowledge_brand_is_eligible(new.workspace_id, new.brand_profile_id) then
    raise exception 'An enabled knowledge policy requires completed brand onboarding' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists saga_daily_knowledge_policy_brand_guard on saga_daily_knowledge_policies;
create trigger saga_daily_knowledge_policy_brand_guard
  before insert or update on saga_daily_knowledge_policies
  for each row execute function saga_daily_knowledge_guard_brand();

-- In-flight jobs for an unassigned or deactivated brand lose their lease now.
update saga_daily_knowledge_jobs job
  set state = 'cancelled', completed_at = now(), claim_token = null,
      claimed_by = null, lease_expires_at = null,
      failure_code = 'daily_knowledge_policy_changed',
      failure_detail = 'Kunskapspolicyn saknar ett aktivt, färdigställt varumärke.'
  where job.state in ('queued', 'running') and not exists (
    select 1 from saga_daily_knowledge_policies policy
    where policy.id = job.policy_id and policy.workspace_id = job.workspace_id
      and policy.enabled = true and policy.revision = job.policy_revision
      and saga_daily_knowledge_brand_is_eligible(policy.workspace_id, policy.brand_profile_id)
  );

commit;
