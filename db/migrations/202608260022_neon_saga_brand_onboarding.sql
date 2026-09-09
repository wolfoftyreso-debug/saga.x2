-- SAGA Brand Onboarding: one atomically created canonical identity, annual
-- activity-plan input and deterministic budget-decision snapshot.
--
-- This migration intentionally stores no media account, provider credential,
-- model prompt, delivery instruction, market-data feed, forecast or outcome
-- claim. A plan is a revisioned decision document, not an automatic campaign.

begin;

create table if not exists saga_brand_onboardings (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app_workspaces(id) on delete cascade,
  brand_profile_id uuid not null,
  created_by_user_id uuid not null,
  updated_by_user_id uuid not null,
  create_idempotency_key uuid not null,
  completion_state text not null default 'in_progress'
    check (completion_state in ('in_progress', 'completed')),
  make_default_on_completion boolean not null default true,
  annual_plan_input jsonb not null
    check (jsonb_typeof(annual_plan_input) = 'object')
    check (not content_engine_json_has_forbidden_secret_key(annual_plan_input)),
  decision_support jsonb not null
    check (jsonb_typeof(decision_support) = 'object')
    check (not content_engine_json_has_forbidden_secret_key(decision_support)),
  calculation_version text not null
    check (calculation_version = 'saga-brand-plan-v1'),
  revision integer not null default 1 check (revision > 0),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, brand_profile_id),
  unique (workspace_id, create_idempotency_key),
  foreign key (workspace_id, brand_profile_id)
    references content_engine_brand_profiles(workspace_id, id)
    on delete restrict,
  foreign key (workspace_id, created_by_user_id)
    references app_workspace_memberships(workspace_id, user_id)
    on delete restrict,
  foreign key (workspace_id, updated_by_user_id)
    references app_workspace_memberships(workspace_id, user_id)
    on delete restrict,
  check ((completion_state = 'completed') = (completed_at is not null))
);

create table if not exists saga_brand_onboarding_revisions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app_workspaces(id) on delete cascade,
  onboarding_id uuid not null,
  revision integer not null check (revision > 0),
  saved_by_user_id uuid not null,
  completion_state text not null
    check (completion_state in ('in_progress', 'completed')),
  brand_snapshot jsonb not null
    check (jsonb_typeof(brand_snapshot) = 'object')
    check (not content_engine_json_has_forbidden_secret_key(brand_snapshot)),
  annual_plan_input jsonb not null
    check (jsonb_typeof(annual_plan_input) = 'object')
    check (not content_engine_json_has_forbidden_secret_key(annual_plan_input)),
  decision_support jsonb not null
    check (jsonb_typeof(decision_support) = 'object')
    check (not content_engine_json_has_forbidden_secret_key(decision_support)),
  calculation_version text not null
    check (calculation_version = 'saga-brand-plan-v1'),
  created_at timestamptz not null default now(),
  unique (workspace_id, onboarding_id, revision),
  foreign key (workspace_id, onboarding_id)
    references saga_brand_onboardings(workspace_id, id)
    on delete cascade,
  foreign key (workspace_id, saved_by_user_id)
    references app_workspace_memberships(workspace_id, user_id)
    on delete restrict
);

create index if not exists saga_brand_onboardings_workspace_updated_idx
  on saga_brand_onboardings(workspace_id, updated_at desc, id desc);
create index if not exists saga_brand_onboarding_revisions_onboarding_idx
  on saga_brand_onboarding_revisions(workspace_id, onboarding_id, revision desc);

-- Legacy profiles have no annual plan and therefore must never look like a
-- completed, active brand. Their copy remains editable through Content Engine,
-- but a completed onboarding is now required before activation/default use.
update content_engine_brand_profiles profile
   set active = false,
       is_default = false
 where not exists (
   select 1
     from saga_brand_onboardings onboarding
    where onboarding.workspace_id = profile.workspace_id
      and onboarding.brand_profile_id = profile.id
      and onboarding.completion_state = 'completed'
 );

create or replace function saga_brand_onboarding_require_completed_profile()
returns trigger
language plpgsql
as $$
begin
  if new.is_default and not new.active then
    raise exception 'a default brand profile must be active'
      using errcode = '23514';
  end if;

  if new.active and not exists (
    select 1
      from saga_brand_onboardings onboarding
     where onboarding.workspace_id = new.workspace_id
       and onboarding.brand_profile_id = new.id
       and onboarding.completion_state = 'completed'
  ) then
    raise exception 'an active brand profile requires a completed SAGA brand onboarding'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists saga_brand_onboarding_guard_profile_activation on content_engine_brand_profiles;
create trigger saga_brand_onboarding_guard_profile_activation
before insert or update of active, is_default
on content_engine_brand_profiles
for each row execute function saga_brand_onboarding_require_completed_profile();

create or replace function saga_brand_onboarding_assert_payload(
  target_brand jsonb,
  target_plan jsonb,
  target_support jsonb,
  target_state text
)
returns void
language plpgsql
immutable
as $$
declare
  plan_budget_minor bigint;
  plan_fixed_minor bigint;
  support_allocatable_minor bigint;
  support_allocation_total bigint;
begin
  if jsonb_typeof(target_brand) <> 'object'
     or jsonb_typeof(target_plan) <> 'object'
     or jsonb_typeof(target_support) <> 'object' then
    raise exception 'SAGA brand onboarding needs object-shaped brand, plan and decision support payloads'
      using errcode = '23514';
  end if;
  if target_state not in ('in_progress', 'completed') then
    raise exception 'SAGA brand onboarding has an invalid completion state'
      using errcode = '23514';
  end if;
  if coalesce(target_brand ->> 'slug', '') !~ '^[a-z0-9][a-z0-9-]{1,78}$'
     or char_length(trim(coalesce(target_brand ->> 'name', ''))) not between 2 and 160
     or jsonb_typeof(target_brand -> 'voice') <> 'object'
     or jsonb_typeof(target_brand -> 'profileConfig') <> 'object' then
    raise exception 'SAGA brand onboarding has an invalid canonical brand profile'
      using errcode = '23514';
  end if;
  if coalesce(target_plan ->> 'planYear', '') !~ '^[0-9]{4}$'
     or (target_plan ->> 'planYear')::integer not between 2024 and 2100
     or coalesce(target_support ->> 'calculationVersion', '') <> 'saga-brand-plan-v1'
     or coalesce(target_support ->> 'scope', '') <> 'scenario_allocation_not_outcome_forecast'
     or coalesce(target_support -> 'outcomeForecast' ->> 'available', '') <> 'false'
     or coalesce(target_support #>> '{inputProvenance,externalMarketDataUsed}', '') <> 'false' then
    raise exception 'SAGA brand onboarding has an invalid planning snapshot'
      using errcode = '23514';
  end if;
  if jsonb_typeof(target_plan -> 'budget') <> 'object'
     or jsonb_typeof(target_support -> 'budget') <> 'object'
     or coalesce(target_plan #>> '{budget,annualBudgetMinor}', '') !~ '^[0-9]{1,16}$'
     or coalesce(target_plan #>> '{budget,fixedCommitmentsMinor}', '') !~ '^[0-9]{1,16}$'
     or coalesce(target_support #>> '{budget,allocatableMinor}', '') !~ '^[0-9]{1,16}$'
     or jsonb_typeof(target_support -> 'allocation') <> 'array' then
    raise exception 'SAGA brand onboarding has an invalid budget allocation snapshot'
      using errcode = '23514';
  end if;
  plan_budget_minor := (target_plan #>> '{budget,annualBudgetMinor}')::bigint;
  plan_fixed_minor := (target_plan #>> '{budget,fixedCommitmentsMinor}')::bigint;
  support_allocatable_minor := (target_support #>> '{budget,allocatableMinor}')::bigint;
  select coalesce(sum((bucket.value ->> 'amountMinor')::bigint), 0)
    into support_allocation_total
    from jsonb_array_elements(target_support -> 'allocation') as bucket(value);
  if plan_fixed_minor > plan_budget_minor
     or support_allocatable_minor <> plan_budget_minor - plan_fixed_minor
     or support_allocation_total <> support_allocatable_minor
     or target_support #>> '{budget,currency}' is distinct from target_plan #>> '{budget,currency}'
     or target_support #>> '{budget,status}' is distinct from target_plan #>> '{budget,status}'
     or target_support #>> '{budget,annualBudgetMinor}' is distinct from target_plan #>> '{budget,annualBudgetMinor}'
     or target_support #>> '{budget,fixedCommitmentsMinor}' is distinct from target_plan #>> '{budget,fixedCommitmentsMinor}' then
    raise exception 'SAGA brand onboarding decision support does not match its plan input'
      using errcode = '23514';
  end if;
  if content_engine_json_has_forbidden_secret_key(target_brand)
     or content_engine_json_has_forbidden_secret_key(target_plan)
     or content_engine_json_has_forbidden_secret_key(target_support) then
    raise exception 'SAGA brand onboarding cannot store secrets'
      using errcode = '23514';
  end if;
end;
$$;

-- Creation runs in one PostgreSQL function because Neon HTTP queries do not
-- expose a durable transaction to route code. The advisory lock serializes an
-- interrupted retry before a canonical profile slug can be inserted twice.
create or replace function saga_create_brand_onboarding(
  target_workspace_id uuid,
  target_user_id uuid,
  target_create_idempotency_key uuid,
  target_completion_state text,
  target_make_default_on_completion boolean,
  target_brand jsonb,
  target_plan jsonb,
  target_support jsonb
)
returns table (onboarding_id uuid, brand_profile_id uuid, reused boolean)
language plpgsql
set search_path = public
as $$
declare
  created_profile_id uuid;
  created_onboarding_id uuid;
begin
  perform saga_brand_onboarding_assert_payload(target_brand, target_plan, target_support, target_completion_state);
  perform pg_advisory_xact_lock(hashtextextended(target_workspace_id::text || ':' || target_create_idempotency_key::text, 0));

  select onboarding.id, onboarding.brand_profile_id
    into created_onboarding_id, created_profile_id
    from saga_brand_onboardings onboarding
   where onboarding.workspace_id = target_workspace_id
     and onboarding.create_idempotency_key = target_create_idempotency_key;
  if found then
    onboarding_id := created_onboarding_id;
    brand_profile_id := created_profile_id;
    reused := true;
    return next;
    return;
  end if;

  -- New canonical profiles start inactive. Only after the onboarding document
  -- exists in a completed state does the activation trigger permit activation.
  insert into content_engine_brand_profiles (
    workspace_id, created_by_user_id, slug, name, organization_name, summary,
    default_language, voice, profile_config, active, is_default
  ) values (
    target_workspace_id,
    target_user_id,
    target_brand ->> 'slug',
    target_brand ->> 'name',
    coalesce(target_brand ->> 'organizationName', ''),
    coalesce(target_brand ->> 'summary', ''),
    coalesce(target_brand ->> 'defaultLanguage', 'sv'),
    target_brand -> 'voice',
    target_brand -> 'profileConfig',
    false,
    false
  ) returning id into created_profile_id;

  insert into saga_brand_onboardings (
    workspace_id, brand_profile_id, created_by_user_id, updated_by_user_id,
    create_idempotency_key, completion_state, make_default_on_completion,
    annual_plan_input, decision_support, calculation_version, completed_at
  ) values (
    target_workspace_id, created_profile_id, target_user_id, target_user_id,
    target_create_idempotency_key, target_completion_state, target_make_default_on_completion,
    target_plan, target_support, 'saga-brand-plan-v1',
    case when target_completion_state = 'completed' then now() else null end
  ) returning id into created_onboarding_id;

  insert into saga_brand_onboarding_revisions (
    workspace_id, onboarding_id, revision, saved_by_user_id, completion_state,
    brand_snapshot, annual_plan_input, decision_support, calculation_version
  ) values (
    target_workspace_id, created_onboarding_id, 1, target_user_id,
    target_completion_state, target_brand, target_plan, target_support,
    'saga-brand-plan-v1'
  );

  if target_completion_state = 'completed' then
    update content_engine_brand_profiles
       set active = true,
           is_default = target_make_default_on_completion
     where workspace_id = target_workspace_id
       and id = created_profile_id;
  end if;

  onboarding_id := created_onboarding_id;
  brand_profile_id := created_profile_id;
  reused := false;
  return next;
end;
$$;

-- Full document replacement under optimistic concurrency. The current plan,
-- canonical brand and immutable revision snapshot either all move together or
-- none of them move. No route can accidentally leave a half-onboarded brand.
create or replace function saga_update_brand_onboarding(
  target_workspace_id uuid,
  target_user_id uuid,
  target_brand_profile_id uuid,
  target_expected_revision integer,
  target_completion_state text,
  target_make_default_on_completion boolean,
  target_brand jsonb,
  target_plan jsonb,
  target_support jsonb
)
returns table (onboarding_id uuid, revision integer)
language plpgsql
set search_path = public
as $$
declare
  current_onboarding_id uuid;
  current_revision integer;
  next_revision integer;
begin
  perform saga_brand_onboarding_assert_payload(target_brand, target_plan, target_support, target_completion_state);

  select onboarding.id, onboarding.revision
    into current_onboarding_id, current_revision
    from saga_brand_onboardings onboarding
   where onboarding.workspace_id = target_workspace_id
     and onboarding.brand_profile_id = target_brand_profile_id
   for update;
  if not found then
    raise exception 'saga_brand_onboarding_not_found' using errcode = 'P0001';
  end if;
  if current_revision <> target_expected_revision then
    raise exception 'saga_brand_onboarding_revision_conflict' using errcode = 'P0001';
  end if;

  -- Deactivating comes first because the profile guard correctly refuses an
  -- active profile once the associated onboarding becomes in progress.
  if target_completion_state = 'in_progress' then
    update content_engine_brand_profiles
       set slug = target_brand ->> 'slug',
           name = target_brand ->> 'name',
           organization_name = coalesce(target_brand ->> 'organizationName', ''),
           summary = coalesce(target_brand ->> 'summary', ''),
           default_language = coalesce(target_brand ->> 'defaultLanguage', 'sv'),
           voice = target_brand -> 'voice',
           profile_config = target_brand -> 'profileConfig',
           active = false,
           is_default = false
     where workspace_id = target_workspace_id
       and id = target_brand_profile_id;
  end if;

  update saga_brand_onboardings
     set updated_by_user_id = target_user_id,
         completion_state = target_completion_state,
         make_default_on_completion = target_make_default_on_completion,
         annual_plan_input = target_plan,
         decision_support = target_support,
         calculation_version = 'saga-brand-plan-v1',
         completed_at = case
           when target_completion_state = 'completed' then coalesce(completed_at, now())
           else null
         end,
         revision = revision + 1
   where workspace_id = target_workspace_id
     and id = current_onboarding_id
     and revision = target_expected_revision
  returning revision into next_revision;
  if next_revision is null then
    raise exception 'saga_brand_onboarding_revision_conflict' using errcode = 'P0001';
  end if;

  if target_completion_state = 'completed' then
    update content_engine_brand_profiles
       set slug = target_brand ->> 'slug',
           name = target_brand ->> 'name',
           organization_name = coalesce(target_brand ->> 'organizationName', ''),
           summary = coalesce(target_brand ->> 'summary', ''),
           default_language = coalesce(target_brand ->> 'defaultLanguage', 'sv'),
           voice = target_brand -> 'voice',
           profile_config = target_brand -> 'profileConfig',
           active = true,
           is_default = target_make_default_on_completion
     where workspace_id = target_workspace_id
       and id = target_brand_profile_id;
  end if;

  insert into saga_brand_onboarding_revisions (
    workspace_id, onboarding_id, revision, saved_by_user_id, completion_state,
    brand_snapshot, annual_plan_input, decision_support, calculation_version
  ) values (
    target_workspace_id, current_onboarding_id, next_revision, target_user_id,
    target_completion_state, target_brand, target_plan, target_support,
    'saga-brand-plan-v1'
  );

  onboarding_id := current_onboarding_id;
  revision := next_revision;
  return next;
end;
$$;

drop trigger if exists saga_brand_onboardings_set_updated_at on saga_brand_onboardings;
create trigger saga_brand_onboardings_set_updated_at
before update on saga_brand_onboardings
for each row execute function app_set_updated_at();

commit;
