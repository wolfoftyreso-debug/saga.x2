-- SAGA quarterly activity plans.
--
-- This is an operational planning and private-review boundary, not a
-- publisher.  Planned local dates/times intentionally live on slots; a
-- generated Studio draft remains unscheduled until a person separately
-- chooses a calendar action in Studio.

begin;

create table if not exists saga_quarterly_activity_plans (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app_workspaces(id) on delete cascade,
  brand_profile_id uuid not null,
  onboarding_id uuid not null,
  created_by_user_id uuid not null,
  updated_by_user_id uuid not null,
  create_idempotency_key uuid not null,
  active boolean not null default true,
  horizon_start_date date not null,
  timezone text not null check (char_length(trim(timezone)) between 3 and 80),
  plan_input jsonb not null
    check (jsonb_typeof(plan_input) = 'object')
    check (not content_engine_json_has_forbidden_secret_key(plan_input)),
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, brand_profile_id),
  unique (workspace_id, create_idempotency_key),
  foreign key (workspace_id, brand_profile_id)
    references content_engine_brand_profiles(workspace_id, id)
    on delete restrict,
  foreign key (workspace_id, onboarding_id)
    references saga_brand_onboardings(workspace_id, id)
    on delete restrict,
  foreign key (workspace_id, created_by_user_id)
    references app_workspace_memberships(workspace_id, user_id)
    on delete restrict,
  foreign key (workspace_id, updated_by_user_id)
    references app_workspace_memberships(workspace_id, user_id)
    on delete restrict
);

create table if not exists saga_quarterly_activity_plan_revisions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app_workspaces(id) on delete cascade,
  plan_id uuid not null,
  revision integer not null check (revision > 0),
  saved_by_user_id uuid not null,
  plan_input jsonb not null
    check (jsonb_typeof(plan_input) = 'object')
    check (not content_engine_json_has_forbidden_secret_key(plan_input)),
  horizon_start_date date not null,
  timezone text not null check (char_length(trim(timezone)) between 3 and 80),
  created_at timestamptz not null default now(),
  unique (workspace_id, plan_id, revision),
  foreign key (workspace_id, plan_id)
    references saga_quarterly_activity_plans(workspace_id, id)
    on delete cascade,
  foreign key (workspace_id, saved_by_user_id)
    references app_workspace_memberships(workspace_id, user_id)
    on delete restrict
);

create table if not exists saga_quarterly_activity_plan_slots (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app_workspaces(id) on delete cascade,
  plan_id uuid not null,
  plan_revision integer not null check (plan_revision > 0),
  slot_key text not null check (char_length(trim(slot_key)) between 3 and 240),
  channel_plan_id text not null check (channel_plan_id ~ '^[a-z0-9][a-z0-9-]{1,78}$'),
  week_index integer not null check (week_index between 1 and 13),
  planned_at timestamptz not null,
  planned_local_date date not null,
  planned_local_time time not null,
  timezone text not null check (char_length(trim(timezone)) between 3 and 80),
  channel text not null check (channel in ('facebook_page', 'instagram', 'linkedin', 'newsletter')),
  content_type text not null check (content_type in ('social_post', 'newsletter')),
  theme jsonb not null
    check (jsonb_typeof(theme) = 'object')
    check (not content_engine_json_has_forbidden_secret_key(theme)),
  objective text not null check (char_length(trim(objective)) between 12 and 1200),
  content_direction text not null check (char_length(trim(content_direction)) between 12 and 1500),
  desired_call_to_action text not null default '' check (char_length(desired_call_to_action) <= 800),
  image_direction text not null default '' check (char_length(image_direction) <= 1500),
  target_length text not null default 'medium' check (target_length in ('short', 'medium', 'long')),
  planning_label text not null check (char_length(trim(planning_label)) between 2 and 240),
  state text not null default 'planned'
    check (state in ('planned', 'in_batch', 'draft_ready', 'review_resolved', 'cancelled')),
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, plan_id, plan_revision, slot_key),
  foreign key (workspace_id, plan_id)
    references saga_quarterly_activity_plans(workspace_id, id)
    on delete cascade,
  check ((channel = 'newsletter' and content_type = 'newsletter') or (channel <> 'newsletter' and content_type = 'social_post'))
);

create table if not exists saga_quarterly_activity_plan_batches (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app_workspaces(id) on delete cascade,
  plan_id uuid not null,
  plan_revision integer not null check (plan_revision > 0),
  requested_by_user_id uuid not null,
  idempotency_key uuid not null,
  requested_count integer not null check (requested_count between 1 and 10),
  state text not null default 'queued'
    check (state in ('queued', 'generating', 'ready_for_review', 'rework_required', 'resolved', 'failed', 'stale')),
  failure_message text,
  abandon_idempotency_key uuid,
  abandoned_by_user_id uuid,
  abandoned_at timestamptz,
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, idempotency_key),
  foreign key (workspace_id, plan_id)
    references saga_quarterly_activity_plans(workspace_id, id)
    on delete restrict,
  foreign key (workspace_id, requested_by_user_id)
    references app_workspace_memberships(workspace_id, user_id)
    on delete restrict,
  foreign key (workspace_id, abandoned_by_user_id)
    references app_workspace_memberships(workspace_id, user_id)
    on delete restrict,
  check (
    (abandon_idempotency_key is null and abandoned_at is null and abandoned_by_user_id is null)
    or (state = 'stale' and abandon_idempotency_key is not null and abandoned_at is not null and abandoned_by_user_id is not null)
  )
);

create table if not exists saga_quarterly_activity_plan_batch_items (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app_workspaces(id) on delete cascade,
  batch_id uuid not null,
  plan_slot_id uuid not null,
  ordinal integer not null check (ordinal between 1 and 10),
  state text not null default 'queued'
    check (state in ('queued', 'generating', 'ready_for_review', 'approved', 'returned', 'rejected', 'failed', 'cancelled')),
  studio_draft_id uuid,
  review_resolution text check (review_resolution in ('approved', 'returned', 'rejected')),
  review_note text not null default '',
  review_idempotency_key uuid,
  reviewed_by_user_id uuid,
  reviewed_at timestamptz,
  returned_draft_revision integer check (returned_draft_revision is null or returned_draft_revision > 0),
  resubmit_idempotency_key uuid,
  resubmitted_by_user_id uuid,
  resubmitted_at timestamptz,
  error_message text,
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, batch_id, plan_slot_id),
  unique (workspace_id, plan_slot_id),
  foreign key (workspace_id, batch_id)
    references saga_quarterly_activity_plan_batches(workspace_id, id)
    on delete restrict,
  foreign key (workspace_id, plan_slot_id)
    references saga_quarterly_activity_plan_slots(workspace_id, id)
    on delete restrict,
  foreign key (workspace_id, studio_draft_id)
    references studio_drafts(workspace_id, id)
    on delete restrict,
  foreign key (workspace_id, reviewed_by_user_id)
    references app_workspace_memberships(workspace_id, user_id)
    on delete restrict,
  foreign key (workspace_id, resubmitted_by_user_id)
    references app_workspace_memberships(workspace_id, user_id)
    on delete restrict,
  check (
    (state in ('approved', 'rejected') and review_resolution = state and reviewed_at is not null and reviewed_by_user_id is not null and returned_draft_revision is null)
    or (state = 'returned' and review_resolution is null and reviewed_at is not null and reviewed_by_user_id is not null and returned_draft_revision is not null)
    or (state not in ('approved', 'returned', 'rejected') and review_resolution is null and reviewed_at is null and reviewed_by_user_id is null and returned_draft_revision is null)
  )
);

create table if not exists saga_quarterly_activity_plan_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app_workspaces(id) on delete cascade,
  batch_id uuid not null,
  batch_item_id uuid not null,
  materialization_receipt_id uuid,
  plan_revision integer not null check (plan_revision > 0),
  state text not null default 'queued'
    check (state in ('queued', 'processing', 'completed', 'failed', 'cancelled')),
  claim_token uuid,
  locked_by text,
  lease_expires_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempt_count integer not null default 3 check (max_attempt_count between 1 and 3),
  failure_code text,
  failure_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (workspace_id, id),
  unique (workspace_id, batch_item_id),
  foreign key (workspace_id, batch_id)
    references saga_quarterly_activity_plan_batches(workspace_id, id)
    on delete restrict,
  foreign key (workspace_id, batch_item_id)
    references saga_quarterly_activity_plan_batch_items(workspace_id, id)
    on delete restrict,
  check ((state = 'processing' and claim_token is not null and lease_expires_at is not null) or state <> 'processing'),
  check ((state in ('completed', 'failed', 'cancelled') and completed_at is not null) or state not in ('completed', 'failed', 'cancelled'))
);

create table if not exists saga_quarterly_activity_plan_materialization_receipts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app_workspaces(id) on delete cascade,
  batch_id uuid not null,
  idempotency_key uuid not null,
  plan_revision integer not null check (plan_revision > 0),
  expected_batch_revision integer not null check (expected_batch_revision > 0),
  state text not null default 'running'
    check (state in ('running', 'completed', 'failed', 'stale')),
  job_count integer not null check (job_count between 1 and 10),
  failure_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (workspace_id, id),
  unique (workspace_id, batch_id, idempotency_key),
  foreign key (workspace_id, batch_id)
    references saga_quarterly_activity_plan_batches(workspace_id, id)
    on delete restrict
);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'saga_quarterly_jobs_materialization_receipt_fkey'
  ) then
    alter table saga_quarterly_activity_plan_jobs
      add constraint saga_quarterly_jobs_materialization_receipt_fkey
      foreign key (workspace_id, materialization_receipt_id)
      references saga_quarterly_activity_plan_materialization_receipts(workspace_id, id)
      on delete restrict;
  end if;
end;
$$;

create index if not exists saga_quarterly_plans_workspace_updated_idx
  on saga_quarterly_activity_plans(workspace_id, updated_at desc, id desc);
create index if not exists saga_quarterly_slots_current_idx
  on saga_quarterly_activity_plan_slots(workspace_id, plan_id, plan_revision, planned_at);
create index if not exists saga_quarterly_batches_plan_idx
  on saga_quarterly_activity_plan_batches(workspace_id, plan_id, state, created_at desc);
create index if not exists saga_quarterly_batch_items_batch_idx
  on saga_quarterly_activity_plan_batch_items(workspace_id, batch_id, ordinal);
create index if not exists saga_quarterly_jobs_claimable_idx
  on saga_quarterly_activity_plan_jobs(workspace_id, batch_id, materialization_receipt_id, created_at)
  where state = 'queued';
create unique index if not exists saga_quarterly_active_materialization_receipt_idx
  on saga_quarterly_activity_plan_materialization_receipts(workspace_id, batch_id)
  where state = 'running';

create or replace function saga_quarterly_plan_assert_payload(target_plan jsonb, target_slots jsonb)
returns void
language plpgsql
immutable
as $$
declare
  slot_count integer;
begin
  if jsonb_typeof(target_plan) <> 'object' or jsonb_typeof(target_slots) <> 'array' then
    raise exception 'SAGA quarterly planning needs object-shaped plan input and an array of derived slots'
      using errcode = '23514';
  end if;
  slot_count := jsonb_array_length(target_slots);
  if slot_count < 1 or slot_count > 260 then
    raise exception 'SAGA quarterly planning needs between 1 and 260 13-week slots'
      using errcode = '23514';
  end if;
  if coalesce(target_plan ->> 'horizonStartDate', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
     or coalesce(target_plan ->> 'timezone', '') = ''
     or jsonb_typeof(target_plan -> 'channelPlans') <> 'array'
     or content_engine_json_has_forbidden_secret_key(target_plan)
     or content_engine_json_has_forbidden_secret_key(target_slots) then
    raise exception 'SAGA quarterly planning has an invalid or secret-bearing payload'
      using errcode = '23514';
  end if;
end;
$$;

create or replace function saga_quarterly_require_completed_brand(
  target_workspace_id uuid,
  target_brand_profile_id uuid
)
returns uuid
language plpgsql
stable
as $$
declare
  resolved_onboarding_id uuid;
begin
  select onboarding.id
    into resolved_onboarding_id
    from saga_brand_onboardings onboarding
    join content_engine_brand_profiles profile
      on profile.workspace_id = onboarding.workspace_id
     and profile.id = onboarding.brand_profile_id
   where onboarding.workspace_id = target_workspace_id
     and onboarding.brand_profile_id = target_brand_profile_id
     and onboarding.completion_state = 'completed'
     and profile.active = true
   limit 1;
  if resolved_onboarding_id is null then
    raise exception 'saga_quarterly_completed_onboarding_required' using errcode = 'P0001';
  end if;
  return resolved_onboarding_id;
end;
$$;

create or replace function saga_create_quarterly_activity_plan(
  target_workspace_id uuid,
  target_user_id uuid,
  target_brand_profile_id uuid,
  target_create_idempotency_key uuid,
  target_plan jsonb,
  target_slots jsonb
)
returns table (plan_id uuid, reused boolean)
language plpgsql
set search_path = public
as $$
declare
  created_plan_id uuid;
  completed_onboarding_id uuid;
  existing_brand_id uuid;
begin
  perform saga_quarterly_plan_assert_payload(target_plan, target_slots);
  perform pg_advisory_xact_lock(hashtextextended(target_workspace_id::text || ':' || target_create_idempotency_key::text, 0));

  select plan.id, plan.brand_profile_id
    into created_plan_id, existing_brand_id
    from saga_quarterly_activity_plans plan
   where plan.workspace_id = target_workspace_id
     and plan.create_idempotency_key = target_create_idempotency_key;
  if found then
    if existing_brand_id <> target_brand_profile_id then
      raise exception 'saga_quarterly_idempotency_conflict' using errcode = 'P0001';
    end if;
    plan_id := created_plan_id;
    reused := true;
    return next;
    return;
  end if;

  completed_onboarding_id := saga_quarterly_require_completed_brand(target_workspace_id, target_brand_profile_id);
  if exists (
    select 1 from saga_quarterly_activity_plans plan
     where plan.workspace_id = target_workspace_id and plan.brand_profile_id = target_brand_profile_id
  ) then
    raise exception 'saga_quarterly_plan_already_exists' using errcode = 'P0001';
  end if;

  insert into saga_quarterly_activity_plans (
    workspace_id, brand_profile_id, onboarding_id, created_by_user_id, updated_by_user_id,
    create_idempotency_key, horizon_start_date, timezone, plan_input
  ) values (
    target_workspace_id, target_brand_profile_id, completed_onboarding_id, target_user_id, target_user_id,
    target_create_idempotency_key, (target_plan ->> 'horizonStartDate')::date, target_plan ->> 'timezone', target_plan
  ) returning id into created_plan_id;

  insert into saga_quarterly_activity_plan_revisions (
    workspace_id, plan_id, revision, saved_by_user_id, plan_input, horizon_start_date, timezone
  ) values (
    target_workspace_id, created_plan_id, 1, target_user_id, target_plan,
    (target_plan ->> 'horizonStartDate')::date, target_plan ->> 'timezone'
  );

  insert into saga_quarterly_activity_plan_slots (
    workspace_id, plan_id, plan_revision, slot_key, channel_plan_id, week_index,
    planned_at, planned_local_date, planned_local_time, timezone, channel, content_type,
    theme, objective, content_direction, desired_call_to_action, image_direction, target_length, planning_label
  )
  select
    target_workspace_id, created_plan_id, 1, slot."slotKey", slot."channelPlanId", slot."weekIndex",
    slot."plannedAt"::timestamptz, slot."plannedLocalDate"::date, slot."plannedLocalTime"::time,
    slot.timezone, slot.channel, slot."contentType", slot.theme, slot.objective,
    slot."contentDirection", coalesce(slot."desiredCallToAction", ''), coalesce(slot."imageDirection", ''),
    coalesce(slot."targetLength", 'medium'), slot."planningLabel"
  from jsonb_to_recordset(target_slots) as slot(
    "slotKey" text, "channelPlanId" text, "weekIndex" integer,
    "plannedAt" text, "plannedLocalDate" text, "plannedLocalTime" text,
    timezone text, channel text, "contentType" text, theme jsonb, objective text,
    "contentDirection" text, "desiredCallToAction" text, "imageDirection" text, "targetLength" text,
    "planningLabel" text
  );

  plan_id := created_plan_id;
  reused := false;
  return next;
end;
$$;

create or replace function saga_update_quarterly_activity_plan(
  target_workspace_id uuid,
  target_user_id uuid,
  target_brand_profile_id uuid,
  target_expected_revision integer,
  target_plan jsonb,
  target_slots jsonb
)
returns table (plan_id uuid, revision integer)
language plpgsql
set search_path = public
as $$
declare
  current_plan_id uuid;
  current_revision integer;
  next_revision integer;
begin
  perform saga_quarterly_plan_assert_payload(target_plan, target_slots);
  perform saga_quarterly_require_completed_brand(target_workspace_id, target_brand_profile_id);
  select plan.id, plan.revision
    into current_plan_id, current_revision
    from saga_quarterly_activity_plans plan
   where plan.workspace_id = target_workspace_id
     and plan.brand_profile_id = target_brand_profile_id
     and plan.active = true
   for update;
  if not found then
    raise exception 'saga_quarterly_plan_not_found' using errcode = 'P0001';
  end if;
  if current_revision <> target_expected_revision then
    raise exception 'saga_quarterly_plan_revision_conflict' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from saga_quarterly_activity_plan_batches batch
     where batch.workspace_id = target_workspace_id
       and batch.plan_id = current_plan_id
       and batch.state not in ('resolved', 'stale')
  ) then
    raise exception 'saga_quarterly_open_batch_blocks_plan_update' using errcode = 'P0001';
  end if;

  update saga_quarterly_activity_plan_slots
     set state = 'cancelled', revision = revision + 1
   where workspace_id = target_workspace_id
     and plan_id = current_plan_id
     and plan_revision = current_revision
     and state = 'planned';

  update saga_quarterly_activity_plans
     set updated_by_user_id = target_user_id,
         horizon_start_date = (target_plan ->> 'horizonStartDate')::date,
         timezone = target_plan ->> 'timezone',
         plan_input = target_plan,
         revision = revision + 1
   where workspace_id = target_workspace_id
     and id = current_plan_id
     and revision = target_expected_revision
  returning revision into next_revision;
  if next_revision is null then
    raise exception 'saga_quarterly_plan_revision_conflict' using errcode = 'P0001';
  end if;

  insert into saga_quarterly_activity_plan_revisions (
    workspace_id, plan_id, revision, saved_by_user_id, plan_input, horizon_start_date, timezone
  ) values (
    target_workspace_id, current_plan_id, next_revision, target_user_id, target_plan,
    (target_plan ->> 'horizonStartDate')::date, target_plan ->> 'timezone'
  );

  insert into saga_quarterly_activity_plan_slots (
    workspace_id, plan_id, plan_revision, slot_key, channel_plan_id, week_index,
    planned_at, planned_local_date, planned_local_time, timezone, channel, content_type,
    theme, objective, content_direction, desired_call_to_action, image_direction, target_length, planning_label
  )
  select
    target_workspace_id, current_plan_id, next_revision, slot."slotKey", slot."channelPlanId", slot."weekIndex",
    slot."plannedAt"::timestamptz, slot."plannedLocalDate"::date, slot."plannedLocalTime"::time,
    slot.timezone, slot.channel, slot."contentType", slot.theme, slot.objective,
    slot."contentDirection", coalesce(slot."desiredCallToAction", ''), coalesce(slot."imageDirection", ''),
    coalesce(slot."targetLength", 'medium'), slot."planningLabel"
  from jsonb_to_recordset(target_slots) as slot(
    "slotKey" text, "channelPlanId" text, "weekIndex" integer,
    "plannedAt" text, "plannedLocalDate" text, "plannedLocalTime" text,
    timezone text, channel text, "contentType" text, theme jsonb, objective text,
    "contentDirection" text, "desiredCallToAction" text, "imageDirection" text, "targetLength" text,
    "planningLabel" text
  );

  plan_id := current_plan_id;
  revision := next_revision;
  return next;
end;
$$;

create or replace function saga_request_quarterly_activity_plan_batch(
  target_workspace_id uuid,
  target_user_id uuid,
  target_brand_profile_id uuid,
  target_expected_plan_revision integer,
  target_idempotency_key uuid,
  target_plan_slot_ids uuid[]
)
returns table (batch_id uuid, reused boolean)
language plpgsql
set search_path = public
as $$
declare
  current_plan_id uuid;
  current_revision integer;
  existing_batch_id uuid;
  selected_count integer;
begin
  selected_count := coalesce(array_length(target_plan_slot_ids, 1), 0);
  if selected_count < 1 or selected_count > 10 or cardinality(array(select distinct unnest(target_plan_slot_ids))) <> selected_count then
    raise exception 'saga_quarterly_batch_size_invalid' using errcode = '23514';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(target_workspace_id::text || ':' || target_idempotency_key::text, 0));

  select batch.id into existing_batch_id
    from saga_quarterly_activity_plan_batches batch
   where batch.workspace_id = target_workspace_id and batch.idempotency_key = target_idempotency_key;
  if found then
    batch_id := existing_batch_id;
    reused := true;
    return next;
    return;
  end if;

  perform saga_quarterly_require_completed_brand(target_workspace_id, target_brand_profile_id);
  select plan.id, plan.revision
    into current_plan_id, current_revision
    from saga_quarterly_activity_plans plan
   where plan.workspace_id = target_workspace_id
     and plan.brand_profile_id = target_brand_profile_id
     and plan.active = true
   for update;
  if not found then
    raise exception 'saga_quarterly_plan_not_found' using errcode = 'P0001';
  end if;
  if current_revision <> target_expected_plan_revision then
    raise exception 'saga_quarterly_plan_revision_conflict' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from saga_quarterly_activity_plan_batches batch
     where batch.workspace_id = target_workspace_id
       and batch.plan_id = current_plan_id
       and batch.state not in ('resolved', 'stale')
  ) then
    raise exception 'saga_quarterly_prior_batch_requires_review' using errcode = 'P0001';
  end if;
  if (select count(*) from saga_quarterly_activity_plan_slots slot
       where slot.workspace_id = target_workspace_id
         and slot.plan_id = current_plan_id
         and slot.plan_revision = current_revision
         and slot.id = any(target_plan_slot_ids)
         and slot.state = 'planned') <> selected_count then
    raise exception 'saga_quarterly_batch_slots_unavailable' using errcode = 'P0001';
  end if;

  insert into saga_quarterly_activity_plan_batches (
    workspace_id, plan_id, plan_revision, requested_by_user_id, idempotency_key, requested_count
  ) values (
    target_workspace_id, current_plan_id, current_revision, target_user_id, target_idempotency_key, selected_count
  ) returning id into existing_batch_id;

  insert into saga_quarterly_activity_plan_batch_items (
    workspace_id, batch_id, plan_slot_id, ordinal
  )
  select target_workspace_id, existing_batch_id, selected.slot_id, selected.ordinal::integer
    from unnest(target_plan_slot_ids) with ordinality as selected(slot_id, ordinal);

  insert into saga_quarterly_activity_plan_jobs (
    workspace_id, batch_id, batch_item_id, plan_revision
  )
  select target_workspace_id, existing_batch_id, item.id, current_revision
    from saga_quarterly_activity_plan_batch_items item
   where item.workspace_id = target_workspace_id and item.batch_id = existing_batch_id;

  update saga_quarterly_activity_plan_slots
     set state = 'in_batch', revision = revision + 1
   where workspace_id = target_workspace_id and id = any(target_plan_slot_ids);

  batch_id := existing_batch_id;
  reused := false;
  return next;
end;
$$;

create or replace function saga_prepare_quarterly_activity_plan_batch(
  target_workspace_id uuid,
  target_brand_profile_id uuid,
  target_batch_id uuid,
  target_idempotency_key uuid,
  target_expected_plan_revision integer,
  target_expected_batch_revision integer,
  target_retry_failed boolean
)
returns table (batch_id uuid, revision integer, state text, materialization_receipt_id uuid, reused boolean)
language plpgsql
set search_path = public
as $$
declare
  current_plan_id uuid;
  current_plan_revision integer;
  current_batch_revision integer;
  current_batch_state text;
  next_revision integer;
  current_receipt_id uuid;
  reserved_count integer;
begin
  perform saga_quarterly_require_completed_brand(target_workspace_id, target_brand_profile_id);
  select plan.id, plan.revision
    into current_plan_id, current_plan_revision
    from saga_quarterly_activity_plans plan
   where plan.workspace_id = target_workspace_id and plan.brand_profile_id = target_brand_profile_id and plan.active = true
   for update;
  if not found then raise exception 'saga_quarterly_plan_not_found' using errcode = 'P0001'; end if;
  if current_plan_revision <> target_expected_plan_revision then raise exception 'saga_quarterly_plan_revision_conflict' using errcode = 'P0001'; end if;

  select batch.revision, batch.state
    into current_batch_revision, current_batch_state
    from saga_quarterly_activity_plan_batches batch
   where batch.workspace_id = target_workspace_id and batch.id = target_batch_id and batch.plan_id = current_plan_id
   for update;
  if not found then raise exception 'saga_quarterly_batch_not_found' using errcode = 'P0001'; end if;
  select receipt.id into current_receipt_id
    from saga_quarterly_activity_plan_materialization_receipts receipt
   where receipt.workspace_id = target_workspace_id
     and receipt.batch_id = target_batch_id
     and receipt.idempotency_key = target_idempotency_key
   limit 1;
  if current_receipt_id is not null then
    batch_id := target_batch_id;
    revision := current_batch_revision;
    state := current_batch_state;
    materialization_receipt_id := current_receipt_id;
    reused := true;
    return next;
    return;
  end if;
  if current_batch_revision <> target_expected_batch_revision then raise exception 'saga_quarterly_batch_revision_conflict' using errcode = 'P0001'; end if;
  if current_batch_state = 'resolved' then raise exception 'saga_quarterly_batch_already_resolved' using errcode = 'P0001'; end if;
  if current_batch_state = 'ready_for_review' then raise exception 'saga_quarterly_batch_requires_human_review' using errcode = 'P0001'; end if;
  if current_batch_state = 'rework_required' then raise exception 'saga_quarterly_batch_requires_rework' using errcode = 'P0001'; end if;
  if current_batch_state = 'failed' and not target_retry_failed then raise exception 'saga_quarterly_batch_retry_required' using errcode = 'P0001'; end if;
  if exists (
    select 1 from saga_quarterly_activity_plan_materialization_receipts receipt
     where receipt.workspace_id = target_workspace_id and receipt.batch_id = target_batch_id and receipt.state = 'running'
  ) then
    raise exception 'saga_quarterly_materialization_already_running' using errcode = 'P0001';
  end if;
  if current_batch_state = 'failed' and target_retry_failed then
    -- A retry must never overtake a still-valid worker lease.  Expired leases
    -- are made terminal here so this explicit retry can safely reserve them.
    update saga_quarterly_activity_plan_jobs
       set state = 'failed', completed_at = now(), claim_token = null, locked_by = null, lease_expires_at = null,
           failure_code = coalesce(failure_code, 'lease_expired'),
           failure_message = coalesce(failure_message, 'Arbetet tappade sin lease och behöver köras om.')
     where workspace_id = target_workspace_id and batch_id = target_batch_id
       and state = 'processing' and lease_expires_at <= now();
    if exists (
      select 1 from saga_quarterly_activity_plan_jobs job
       where job.workspace_id = target_workspace_id and job.batch_id = target_batch_id
         and job.state = 'processing'
    ) then
      raise exception 'saga_quarterly_materialization_still_processing' using errcode = 'P0001';
    end if;
    if exists (
      select 1 from saga_quarterly_activity_plan_jobs job
       where job.workspace_id = target_workspace_id and job.batch_id = target_batch_id
         and job.state = 'failed' and job.attempt_count >= job.max_attempt_count
    ) then
      raise exception 'saga_quarterly_job_attempts_exhausted' using errcode = 'P0001';
    end if;
    update saga_quarterly_activity_plan_jobs
       set state = 'queued', claim_token = null, locked_by = null, lease_expires_at = null,
           completed_at = null, failure_code = null, failure_message = null, materialization_receipt_id = null
     where workspace_id = target_workspace_id and batch_id = target_batch_id and state = 'failed';
    update saga_quarterly_activity_plan_batch_items
       set state = 'queued', error_message = null, revision = revision + 1
     where workspace_id = target_workspace_id and batch_id = target_batch_id
       and id in (
         select job.batch_item_id
           from saga_quarterly_activity_plan_jobs job
          where job.workspace_id = target_workspace_id and job.batch_id = target_batch_id and job.state = 'queued'
       );
  end if;

  select count(*) into reserved_count
    from saga_quarterly_activity_plan_jobs job
   where job.workspace_id = target_workspace_id and job.batch_id = target_batch_id and job.state = 'queued';
  if reserved_count < 1 then
    raise exception 'saga_quarterly_no_jobs_to_materialize' using errcode = 'P0001';
  end if;

  insert into saga_quarterly_activity_plan_materialization_receipts (
    workspace_id, batch_id, idempotency_key, plan_revision, expected_batch_revision, job_count
  ) values (
    target_workspace_id, target_batch_id, target_idempotency_key, current_plan_revision, current_batch_revision,
    reserved_count
  );
  select receipt.id into current_receipt_id
    from saga_quarterly_activity_plan_materialization_receipts receipt
   where receipt.workspace_id = target_workspace_id and receipt.batch_id = target_batch_id and receipt.idempotency_key = target_idempotency_key;
  update saga_quarterly_activity_plan_jobs
     set materialization_receipt_id = current_receipt_id
   where workspace_id = target_workspace_id and batch_id = target_batch_id and state = 'queued' and materialization_receipt_id is null;
  update saga_quarterly_activity_plan_batches
     set state = 'generating', failure_message = null, revision = revision + 1
   where workspace_id = target_workspace_id and id = target_batch_id
  returning revision into next_revision;
  batch_id := target_batch_id;
  revision := next_revision;
  state := 'generating';
  materialization_receipt_id := current_receipt_id;
  reused := false;
  return next;
end;
$$;

create or replace function saga_claim_quarterly_activity_plan_job(
  target_workspace_id uuid,
  target_brand_profile_id uuid,
  target_batch_id uuid,
  target_materialization_receipt_id uuid,
  target_worker_id text,
  target_lease_seconds integer
)
returns table (
  job_id uuid,
  claim_token uuid,
  batch_id uuid,
  batch_item_id uuid,
  materialization_receipt_id uuid,
  plan_id uuid,
  plan_revision integer,
  author_user_id uuid,
  timezone text,
  brand_name text,
  brand_summary text,
  brand_voice jsonb,
  slot_id uuid,
  slot_revision integer,
  slot_key text,
  channel_plan_id text,
  week_index integer,
  planned_at timestamptz,
  planned_local_date date,
  planned_local_time time,
  channel text,
  content_type text,
  theme jsonb,
  objective text,
  content_direction text,
  desired_call_to_action text,
  image_direction text,
  target_length text,
  planning_label text
)
language plpgsql
set search_path = public
as $$
declare
  candidate_job_id uuid;
  candidate_plan_id uuid;
  candidate_plan_revision integer;
  candidate_batch_revision integer;
  candidate_batch_state text;
  candidate_receipt_state text;
  new_claim_token uuid := gen_random_uuid();
begin
  if target_lease_seconds < 30 or target_lease_seconds > 300 then
    raise exception 'saga_quarterly_invalid_lease' using errcode = '23514';
  end if;
  perform saga_quarterly_require_completed_brand(target_workspace_id, target_brand_profile_id);
  select plan.id, plan.revision, batch.revision, batch.state
    into candidate_plan_id, candidate_plan_revision, candidate_batch_revision, candidate_batch_state
    from saga_quarterly_activity_plans plan
    join saga_quarterly_activity_plan_batches batch
      on batch.workspace_id = plan.workspace_id and batch.plan_id = plan.id
   where plan.workspace_id = target_workspace_id
     and plan.brand_profile_id = target_brand_profile_id
     and plan.active = true
     and batch.id = target_batch_id
   for update of plan, batch;
  if not found then return; end if;

  select receipt.state into candidate_receipt_state
    from saga_quarterly_activity_plan_materialization_receipts receipt
   where receipt.workspace_id = target_workspace_id
     and receipt.id = target_materialization_receipt_id
     and receipt.batch_id = target_batch_id
   for update;
  if not found or candidate_receipt_state <> 'running' then return; end if;

  if candidate_plan_revision <> (select plan_revision from saga_quarterly_activity_plan_batches where workspace_id = target_workspace_id and id = target_batch_id) then
    update saga_quarterly_activity_plan_jobs
       set state = 'cancelled', completed_at = now(), failure_code = 'stale_plan_revision', failure_message = 'Planen ändrades innan innehållet skapades.'
     where workspace_id = target_workspace_id and batch_id = target_batch_id
       and materialization_receipt_id = target_materialization_receipt_id and state in ('queued', 'processing');
    update saga_quarterly_activity_plan_batch_items
       set state = 'cancelled', error_message = 'Planen ändrades innan innehållet skapades.', revision = revision + 1
     where workspace_id = target_workspace_id and batch_id = target_batch_id and state in ('queued', 'generating');
    update saga_quarterly_activity_plan_batches
     set state = 'stale', failure_message = 'Planen ändrades innan batchen hann skapa utkast.', revision = revision + 1
     where workspace_id = target_workspace_id and id = target_batch_id;
    update saga_quarterly_activity_plan_materialization_receipts
       set state = 'stale', failure_message = 'Planen ändrades innan batchen hann skapa utkast.', completed_at = now()
     where workspace_id = target_workspace_id and id = target_materialization_receipt_id and state = 'running';
    return;
  end if;
  if candidate_batch_state <> 'generating' then return; end if;

  -- A later invocation can safely reclaim a crashed worker's expired lease.
  -- Once its bounded attempt budget is exhausted, the batch is failed honestly
  -- rather than remaining stuck in "generating" forever.
  with exhausted as (
    update saga_quarterly_activity_plan_jobs job
       set state = 'failed', completed_at = now(), claim_token = null, locked_by = null, lease_expires_at = null,
           failure_code = 'lease_attempts_exhausted',
           failure_message = 'Arbetet tappade sin lease för många gånger.'
     where job.workspace_id = target_workspace_id
       and job.batch_id = target_batch_id
       and job.materialization_receipt_id = target_materialization_receipt_id
       and job.state = 'processing'
       and job.lease_expires_at <= now()
       and job.attempt_count >= job.max_attempt_count
     returning job.batch_item_id
  )
  update saga_quarterly_activity_plan_batch_items item
     set state = 'failed', error_message = 'Arbetet tappade sin lease för många gånger.', revision = item.revision + 1
    from exhausted
   where item.workspace_id = target_workspace_id and item.id = exhausted.batch_item_id;

  with reclaimed as (
    update saga_quarterly_activity_plan_jobs job
       set state = 'queued', claim_token = null, locked_by = null, lease_expires_at = null,
           failure_code = 'lease_reclaimed',
           failure_message = 'En tidigare worker avslutades. Arbetet tas upp igen.'
     where job.workspace_id = target_workspace_id
       and job.batch_id = target_batch_id
       and job.materialization_receipt_id = target_materialization_receipt_id
       and job.state = 'processing'
       and job.lease_expires_at <= now()
       and job.attempt_count < job.max_attempt_count
     returning job.batch_item_id
  )
  update saga_quarterly_activity_plan_batch_items item
     set state = 'queued', error_message = null, revision = item.revision + 1
    from reclaimed
   where item.workspace_id = target_workspace_id and item.id = reclaimed.batch_item_id;

  if exists (
    select 1 from saga_quarterly_activity_plan_jobs job
     where job.workspace_id = target_workspace_id and job.batch_id = target_batch_id
       and job.materialization_receipt_id = target_materialization_receipt_id and job.state = 'failed'
  ) then
    update saga_quarterly_activity_plan_batches
       set state = 'failed', failure_message = 'Minst ett utkast kunde inte skapas.', revision = revision + 1
     where workspace_id = target_workspace_id and id = target_batch_id;
    update saga_quarterly_activity_plan_materialization_receipts
       set state = 'failed', failure_message = 'Minst ett utkast kunde inte skapas.', completed_at = now()
     where workspace_id = target_workspace_id and id = target_materialization_receipt_id and state = 'running';
    return;
  end if;

  select job.id into candidate_job_id
    from saga_quarterly_activity_plan_jobs job
   where job.workspace_id = target_workspace_id
     and job.batch_id = target_batch_id
     and job.materialization_receipt_id = target_materialization_receipt_id
     and job.state = 'queued'
     and job.attempt_count < job.max_attempt_count
   order by job.created_at, job.id
   for update skip locked
   limit 1;
  if candidate_job_id is null then
    update saga_quarterly_activity_plan_materialization_receipts receipt
       set state = case
         when exists (select 1 from saga_quarterly_activity_plan_jobs job where job.workspace_id = target_workspace_id and job.materialization_receipt_id = receipt.id and job.state = 'failed') then 'failed'
         when not exists (select 1 from saga_quarterly_activity_plan_jobs job where job.workspace_id = target_workspace_id and job.materialization_receipt_id = receipt.id and job.state in ('queued', 'processing')) then 'completed'
         else 'running'
       end,
       completed_at = case when not exists (select 1 from saga_quarterly_activity_plan_jobs job where job.workspace_id = target_workspace_id and job.materialization_receipt_id = receipt.id and job.state in ('queued', 'processing')) then now() else null end
     where receipt.workspace_id = target_workspace_id and receipt.id = target_materialization_receipt_id and receipt.state = 'running';
    return;
  end if;

  update saga_quarterly_activity_plan_jobs
     set state = 'processing', claim_token = new_claim_token, locked_by = left(target_worker_id, 160),
         lease_expires_at = now() + make_interval(secs => target_lease_seconds), attempt_count = attempt_count + 1
   where workspace_id = target_workspace_id and id = candidate_job_id;
  update saga_quarterly_activity_plan_batch_items item
     set state = 'generating', revision = revision + 1
    from saga_quarterly_activity_plan_jobs job
   where item.workspace_id = target_workspace_id and item.id = job.batch_item_id and job.id = candidate_job_id;

  return query
  select
    job.id, job.claim_token, batch.id, item.id, job.materialization_receipt_id, plan.id, batch.plan_revision,
    batch.requested_by_user_id, plan.timezone, profile.name, profile.summary, profile.voice,
    slot.id, slot.revision, slot.slot_key, slot.channel_plan_id, slot.week_index,
    slot.planned_at, slot.planned_local_date, slot.planned_local_time, slot.channel, slot.content_type,
    slot.theme, slot.objective, slot.content_direction, slot.desired_call_to_action, slot.image_direction,
    slot.target_length, slot.planning_label
  from saga_quarterly_activity_plan_jobs job
  join saga_quarterly_activity_plan_batch_items item
    on item.workspace_id = job.workspace_id and item.id = job.batch_item_id
  join saga_quarterly_activity_plan_batches batch
    on batch.workspace_id = job.workspace_id and batch.id = job.batch_id
  join saga_quarterly_activity_plans plan
    on plan.workspace_id = batch.workspace_id and plan.id = batch.plan_id
  join content_engine_brand_profiles profile
    on profile.workspace_id = plan.workspace_id and profile.id = plan.brand_profile_id
  join saga_quarterly_activity_plan_slots slot
    on slot.workspace_id = item.workspace_id and slot.id = item.plan_slot_id
  where job.workspace_id = target_workspace_id and job.id = candidate_job_id and job.claim_token = new_claim_token;
end;
$$;

create or replace function saga_complete_quarterly_activity_plan_job(
  target_workspace_id uuid,
  target_job_id uuid,
  target_claim_token uuid,
  target_draft jsonb
)
returns table (studio_draft_id uuid, stale boolean)
language plpgsql
set search_path = public
as $$
declare
  current_batch_id uuid;
  current_item_id uuid;
  current_plan_id uuid;
  current_plan_revision integer;
  current_batch_plan_revision integer;
  current_batch_state text;
  current_receipt_id uuid;
  current_receipt_state text;
  author_id uuid;
  current_slot_channel text;
  current_slot_content_type text;
  current_slot_timezone text;
  current_slot_planned_at timestamptz;
  current_slot_planned_local_date date;
  current_slot_planned_local_time time;
  new_draft_id uuid;
begin
  if jsonb_typeof(target_draft) <> 'object'
     or jsonb_typeof(target_draft -> 'channels') <> 'array'
     or jsonb_typeof(target_draft -> 'hashtags') <> 'array'
     or jsonb_typeof(target_draft -> 'quality') <> 'object'
     or coalesce(target_draft ->> 'contentType', '') not in ('social_post', 'newsletter')
     or char_length(trim(coalesce(target_draft ->> 'title', ''))) < 1
     or char_length(coalesce(target_draft ->> 'body', '')) < 1
     or content_engine_json_has_forbidden_secret_key(target_draft)
     or target_draft ? 'scheduledAt'
     or target_draft ? 'publishAt' then
    raise exception 'saga_quarterly_invalid_private_draft' using errcode = '23514';
  end if;

  select batch.id, item.id, plan.id, plan.revision, batch.plan_revision, batch.state, batch.requested_by_user_id,
         job.materialization_receipt_id, slot.channel, slot.content_type, slot.timezone,
         slot.planned_at, slot.planned_local_date, slot.planned_local_time
    into current_batch_id, current_item_id, current_plan_id, current_plan_revision, current_batch_plan_revision, current_batch_state, author_id,
         current_receipt_id, current_slot_channel, current_slot_content_type, current_slot_timezone,
         current_slot_planned_at, current_slot_planned_local_date, current_slot_planned_local_time
    from saga_quarterly_activity_plan_jobs job
    join saga_quarterly_activity_plan_batch_items item
      on item.workspace_id = job.workspace_id and item.id = job.batch_item_id
    join saga_quarterly_activity_plan_batches batch
      on batch.workspace_id = job.workspace_id and batch.id = job.batch_id
    join saga_quarterly_activity_plans plan
      on plan.workspace_id = batch.workspace_id and plan.id = batch.plan_id
    join saga_quarterly_activity_plan_slots slot
      on slot.workspace_id = item.workspace_id and slot.id = item.plan_slot_id
   where job.workspace_id = target_workspace_id
     and job.id = target_job_id
     and job.state = 'processing'
     and job.claim_token = target_claim_token
     and job.lease_expires_at > now()
   for update of job, item, batch, plan;
  if not found then return; end if;

  select receipt.state into current_receipt_state
    from saga_quarterly_activity_plan_materialization_receipts receipt
   where receipt.workspace_id = target_workspace_id and receipt.id = current_receipt_id
   for update;
  if current_batch_state <> 'generating' or coalesce(current_receipt_state, '') <> 'running' then
    update saga_quarterly_activity_plan_jobs
       set state = 'cancelled', completed_at = now(), lease_expires_at = null, locked_by = null,
           failure_code = 'materialization_no_longer_active', failure_message = 'Batchen avslutades innan utkastet hann sparas.'
     where workspace_id = target_workspace_id and id = target_job_id and claim_token = target_claim_token;
    update saga_quarterly_activity_plan_batch_items
       set state = 'cancelled', error_message = 'Batchen avslutades innan utkastet hann sparas.', revision = revision + 1
     where workspace_id = target_workspace_id and id = current_item_id and state in ('queued', 'generating');
    studio_draft_id := null;
    stale := true;
    return next;
    return;
  end if;

  if target_draft ->> 'contentType' <> current_slot_content_type
     or target_draft -> 'channels' <> jsonb_build_array(current_slot_channel)
     or coalesce(target_draft ->> 'timezone', '') <> current_slot_timezone
     or coalesce((target_draft -> 'quality' ->> 'canCreatePrivateDraft')::boolean, false) is not true
     or coalesce(target_draft -> 'quality' ->> 'decision', 'blocked') = 'blocked'
     or coalesce((target_draft -> 'quality' ->> 'canDeliver')::boolean, true) is not false then
    raise exception 'saga_quarterly_private_draft_does_not_match_slot' using errcode = '23514';
  end if;

  if current_plan_revision <> current_batch_plan_revision then
    update saga_quarterly_activity_plan_jobs
       set state = 'cancelled', completed_at = now(), failure_code = 'stale_plan_revision', failure_message = 'Planen ändrades innan utkastet sparades.'
     where workspace_id = target_workspace_id and id = target_job_id;
    update saga_quarterly_activity_plan_batch_items
       set state = 'cancelled', error_message = 'Planen ändrades innan utkastet sparades.', revision = revision + 1
     where workspace_id = target_workspace_id and id = current_item_id;
    update saga_quarterly_activity_plan_batches
       set state = 'stale', failure_message = 'Planen ändrades innan utkastet sparades.', revision = revision + 1
     where workspace_id = target_workspace_id and id = current_batch_id;
    update saga_quarterly_activity_plan_materialization_receipts
       set state = 'stale', failure_message = 'Planen ändrades innan utkastet sparades.', completed_at = now()
     where workspace_id = target_workspace_id and id = current_receipt_id and state = 'running';
    studio_draft_id := null;
    stale := true;
    return next;
    return;
  end if;

  insert into studio_drafts (
    workspace_id, author_user_id, content_type, status, title, body, excerpt, publication_channels, metadata, scheduled_at
  ) values (
    target_workspace_id,
    author_id,
    target_draft ->> 'contentType',
    'in_review',
    target_draft ->> 'title',
    target_draft ->> 'body',
    nullif(target_draft ->> 'excerpt', ''),
    target_draft -> 'channels',
    jsonb_build_object(
      'headline', nullif(target_draft ->> 'headline', ''),
      'subject', nullif(target_draft ->> 'subject', ''),
      'cta', nullif(target_draft ->> 'cta', ''),
      'hashtags', target_draft -> 'hashtags',
      'generationPrompt', nullif(target_draft ->> 'generationPrompt', ''),
      'imagePrompt', nullif(target_draft ->> 'imagePrompt', ''),
      'language', 'sv',
      'timezone', target_draft ->> 'timezone',
      'scheduledLocalDate', null,
      'scheduledLocalTime', null,
      'approvalRequired', true,
      'automationRuleId', null,
      'newsletterAudienceId', null,
      'approvedAt', null,
      'sagaProductionQuality', target_draft -> 'quality',
      'sagaProductionQualityContext', jsonb_build_object(
        'targetLength', coalesce(target_draft ->> 'targetLength', 'medium'),
        'editorialLens', null,
        'seriesReference', null
      ),
      'sagaQuarterlyActivityPlan', jsonb_build_object(
        'planId', current_plan_id,
        'planRevision', current_batch_plan_revision,
        'batchId', current_batch_id,
        'batchItemId', current_item_id,
        'privateOnly', true,
        'calendarScheduled', false,
        'imageCreated', false,
        'reviewPlannedAt', current_slot_planned_at::text,
        'reviewPlannedLocalDate', current_slot_planned_local_date::text,
        'reviewPlannedLocalTime', to_char(current_slot_planned_local_time, 'HH24:MI'),
        'reviewTimezone', current_slot_timezone
      )
    ),
    null
  ) returning id into new_draft_id;

  update saga_quarterly_activity_plan_batch_items
     set state = 'ready_for_review', studio_draft_id = new_draft_id, error_message = null, revision = revision + 1
   where workspace_id = target_workspace_id and id = current_item_id;
  update saga_quarterly_activity_plan_jobs
     set state = 'completed', completed_at = now(), lease_expires_at = null, locked_by = null
   where workspace_id = target_workspace_id and id = target_job_id and claim_token = target_claim_token;
  update saga_quarterly_activity_plan_slots
     set state = 'draft_ready', revision = revision + 1
   where workspace_id = target_workspace_id
     and id = (select plan_slot_id from saga_quarterly_activity_plan_batch_items where workspace_id = target_workspace_id and id = current_item_id);

  update saga_quarterly_activity_plan_batches batch
     set state = case
       when exists (select 1 from saga_quarterly_activity_plan_jobs job where job.workspace_id = target_workspace_id and job.batch_id = batch.id and job.state = 'failed') then 'failed'
       when exists (select 1 from saga_quarterly_activity_plan_jobs job where job.workspace_id = target_workspace_id and job.batch_id = batch.id and job.state in ('queued', 'processing')) then 'generating'
       when exists (select 1 from saga_quarterly_activity_plan_batch_items item where item.workspace_id = target_workspace_id and item.batch_id = batch.id and item.review_resolution is null) then 'ready_for_review'
       else 'resolved'
     end,
     revision = revision + 1
   where batch.workspace_id = target_workspace_id and batch.id = current_batch_id;

  update saga_quarterly_activity_plan_materialization_receipts receipt
     set state = case
       when exists (select 1 from saga_quarterly_activity_plan_jobs job where job.workspace_id = target_workspace_id and job.materialization_receipt_id = receipt.id and job.state = 'failed') then 'failed'
       when not exists (select 1 from saga_quarterly_activity_plan_jobs job where job.workspace_id = target_workspace_id and job.materialization_receipt_id = receipt.id and job.state in ('queued', 'processing')) then 'completed'
       else 'running'
     end,
     completed_at = case when not exists (select 1 from saga_quarterly_activity_plan_jobs job where job.workspace_id = target_workspace_id and job.materialization_receipt_id = receipt.id and job.state in ('queued', 'processing')) then now() else null end
   where receipt.workspace_id = target_workspace_id and receipt.id = current_receipt_id and receipt.state = 'running';

  studio_draft_id := new_draft_id;
  stale := false;
  return next;
end;
$$;

create or replace function saga_fail_quarterly_activity_plan_job(
  target_workspace_id uuid,
  target_job_id uuid,
  target_claim_token uuid,
  target_error_code text,
  target_error_message text
)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  current_batch_id uuid;
  current_item_id uuid;
  current_receipt_id uuid;
begin
  select job.batch_id, job.batch_item_id, job.materialization_receipt_id
    into current_batch_id, current_item_id, current_receipt_id
    from saga_quarterly_activity_plan_jobs job
   where job.workspace_id = target_workspace_id
     and job.id = target_job_id
     and job.state = 'processing'
     and job.claim_token = target_claim_token
   for update;
  if not found then return false; end if;
  update saga_quarterly_activity_plan_jobs
     set state = 'failed', completed_at = now(), lease_expires_at = null,
         failure_code = left(coalesce(target_error_code, 'generation_failed'), 120),
         failure_message = left(coalesce(target_error_message, 'AI-utkastet kunde inte skapas.'), 1200)
   where workspace_id = target_workspace_id and id = target_job_id and claim_token = target_claim_token;
  update saga_quarterly_activity_plan_batch_items
     set state = 'failed', error_message = left(coalesce(target_error_message, 'AI-utkastet kunde inte skapas.'), 1200), revision = revision + 1
   where workspace_id = target_workspace_id and id = current_item_id;
  update saga_quarterly_activity_plan_batches
     set state = 'failed', failure_message = left(coalesce(target_error_message, 'AI-utkastet kunde inte skapas.'), 1200), revision = revision + 1
   where workspace_id = target_workspace_id and id = current_batch_id;
  update saga_quarterly_activity_plan_materialization_receipts
     set state = 'failed',
         failure_message = left(coalesce(target_error_message, 'AI-utkastet kunde inte skapas.'), 1200),
         completed_at = now()
   where workspace_id = target_workspace_id and id = current_receipt_id and state = 'running';
  return true;
end;
$$;

-- Human recovery for a permanently failed receipt. This preserves any real
-- private drafts for audit, cancels only unfinished work, and makes no
-- schedule, delivery or publication call.
create or replace function saga_abandon_failed_quarterly_activity_plan_batch(
  target_workspace_id uuid,
  target_user_id uuid,
  target_brand_profile_id uuid,
  target_batch_id uuid,
  target_idempotency_key uuid,
  target_expected_plan_revision integer,
  target_expected_batch_revision integer,
  target_note text
)
returns table (batch_id uuid, batch_revision integer, reused boolean)
language plpgsql
set search_path = public
as $$
declare
  current_plan_id uuid;
  current_plan_revision integer;
  current_batch_revision integer;
  current_batch_state text;
  current_abandon_key uuid;
  next_batch_revision integer;
begin
  if char_length(trim(coalesce(target_note, ''))) < 3 then
    raise exception 'saga_quarterly_abandon_requires_note' using errcode = '23514';
  end if;
  perform saga_quarterly_require_completed_brand(target_workspace_id, target_brand_profile_id);
  select plan.id, plan.revision, batch.revision, batch.state, batch.abandon_idempotency_key
    into current_plan_id, current_plan_revision, current_batch_revision, current_batch_state, current_abandon_key
    from saga_quarterly_activity_plans plan
    join saga_quarterly_activity_plan_batches batch
      on batch.workspace_id = plan.workspace_id and batch.plan_id = plan.id
   where plan.workspace_id = target_workspace_id
     and plan.brand_profile_id = target_brand_profile_id
     and batch.id = target_batch_id
   for update of plan, batch;
  if not found then raise exception 'saga_quarterly_batch_not_found' using errcode = 'P0001'; end if;
  if current_batch_state = 'stale' and current_abandon_key = target_idempotency_key then
    batch_id := target_batch_id;
    batch_revision := current_batch_revision;
    reused := true;
    return next;
    return;
  end if;
  if current_plan_revision <> target_expected_plan_revision then raise exception 'saga_quarterly_plan_revision_conflict' using errcode = 'P0001'; end if;
  if current_batch_revision <> target_expected_batch_revision then raise exception 'saga_quarterly_batch_revision_conflict' using errcode = 'P0001'; end if;
  if current_batch_state <> 'failed' then raise exception 'saga_quarterly_batch_not_failed' using errcode = 'P0001'; end if;
  if exists (
    select 1 from saga_quarterly_activity_plan_jobs job
     where job.workspace_id = target_workspace_id and job.batch_id = target_batch_id
       and job.state = 'processing' and job.lease_expires_at > now()
  ) then
    raise exception 'saga_quarterly_materialization_still_processing' using errcode = 'P0001';
  end if;

  update saga_quarterly_activity_plan_jobs
     set state = 'cancelled', completed_at = coalesce(completed_at, now()), claim_token = null, locked_by = null,
         lease_expires_at = null,
         failure_code = coalesce(failure_code, 'batch_abandoned_by_human'),
         failure_message = coalesce(failure_message, left(trim(target_note), 1200))
   where workspace_id = target_workspace_id and batch_id = target_batch_id
     and state in ('queued', 'processing', 'failed');
  update saga_quarterly_activity_plan_batch_items
     set state = 'cancelled', review_resolution = null, review_idempotency_key = null,
         reviewed_by_user_id = null, reviewed_at = null, returned_draft_revision = null,
         error_message = coalesce(error_message, left(trim(target_note), 1200)), revision = revision + 1
   where workspace_id = target_workspace_id and batch_id = target_batch_id and review_resolution is null;
  update saga_quarterly_activity_plan_slots slot
     set state = 'cancelled', revision = revision + 1
    from saga_quarterly_activity_plan_batch_items item
   where slot.workspace_id = target_workspace_id and item.workspace_id = slot.workspace_id
     and item.batch_id = target_batch_id and item.plan_slot_id = slot.id
     and slot.state <> 'review_resolved';
  update saga_quarterly_activity_plan_materialization_receipts
     set state = case when state = 'running' then 'stale' else state end,
         failure_message = coalesce(failure_message, left(trim(target_note), 1200)),
         completed_at = coalesce(completed_at, now())
   where workspace_id = target_workspace_id and batch_id = target_batch_id;
  update saga_quarterly_activity_plan_batches
     set state = 'stale', failure_message = left(trim(target_note), 1200),
         abandon_idempotency_key = target_idempotency_key, abandoned_by_user_id = target_user_id, abandoned_at = now(),
         revision = revision + 1
   where workspace_id = target_workspace_id and id = target_batch_id and revision = target_expected_batch_revision
  returning revision into next_batch_revision;
  if next_batch_revision is null then raise exception 'saga_quarterly_batch_revision_conflict' using errcode = 'P0001'; end if;
  batch_id := target_batch_id;
  batch_revision := next_batch_revision;
  reused := false;
  return next;
end;
$$;

create or replace function saga_review_quarterly_activity_plan_batch_item(
  target_workspace_id uuid,
  target_user_id uuid,
  target_brand_profile_id uuid,
  target_batch_id uuid,
  target_batch_item_id uuid,
  target_idempotency_key uuid,
  target_expected_plan_revision integer,
  target_expected_batch_revision integer,
  target_expected_item_revision integer,
  target_expected_draft_revision integer,
  target_resolution text,
  target_note text
)
returns table (batch_id uuid, batch_revision integer, item_id uuid, item_revision integer, reused boolean)
language plpgsql
set search_path = public
as $$
declare
  current_plan_id uuid;
  current_plan_revision integer;
  current_batch_revision integer;
  current_batch_state text;
  current_item_revision integer;
  current_item_state text;
  current_item_resolution text;
  current_review_idempotency_key uuid;
  current_draft_id uuid;
  current_draft_revision integer;
  current_draft_status text;
  next_draft_revision integer;
  next_batch_revision integer;
  next_item_revision integer;
begin
  if target_resolution not in ('approved', 'returned', 'rejected') then
    raise exception 'saga_quarterly_invalid_review_resolution' using errcode = '23514';
  end if;
  if target_resolution = 'returned' and char_length(trim(coalesce(target_note, ''))) = 0 then
    raise exception 'saga_quarterly_return_requires_note' using errcode = '23514';
  end if;
  perform saga_quarterly_require_completed_brand(target_workspace_id, target_brand_profile_id);
  select plan.id, plan.revision, batch.revision, batch.state, item.revision, item.state, item.review_resolution,
         item.review_idempotency_key, item.studio_draft_id, draft.revision, draft.status
    into current_plan_id, current_plan_revision, current_batch_revision, current_batch_state, current_item_revision,
         current_item_state, current_item_resolution, current_review_idempotency_key, current_draft_id,
         current_draft_revision, current_draft_status
    from saga_quarterly_activity_plans plan
    join saga_quarterly_activity_plan_batches batch
      on batch.workspace_id = plan.workspace_id and batch.plan_id = plan.id
    join saga_quarterly_activity_plan_batch_items item
      on item.workspace_id = batch.workspace_id and item.batch_id = batch.id
    join studio_drafts draft
      on draft.workspace_id = item.workspace_id and draft.id = item.studio_draft_id
   where plan.workspace_id = target_workspace_id
     and plan.brand_profile_id = target_brand_profile_id
     and batch.id = target_batch_id
     and item.id = target_batch_item_id
   for update of plan, batch, item, draft;
  if not found then raise exception 'saga_quarterly_batch_item_not_found' using errcode = 'P0001'; end if;

  if (current_item_resolution = target_resolution
      or (current_item_state = 'returned' and target_resolution = 'returned'))
     and current_review_idempotency_key = target_idempotency_key then
      batch_id := target_batch_id;
      batch_revision := current_batch_revision;
      item_id := target_batch_item_id;
      item_revision := current_item_revision;
      reused := true;
      return next;
      return;
  end if;
  if current_item_resolution is not null or current_item_state = 'returned' then
    raise exception 'saga_quarterly_batch_item_already_resolved' using errcode = 'P0001';
  end if;
  if current_plan_revision <> target_expected_plan_revision then raise exception 'saga_quarterly_plan_revision_conflict' using errcode = 'P0001'; end if;
  if current_batch_revision <> target_expected_batch_revision then raise exception 'saga_quarterly_batch_revision_conflict' using errcode = 'P0001'; end if;
  if current_batch_state <> 'ready_for_review' then raise exception 'saga_quarterly_batch_not_ready_for_review' using errcode = 'P0001'; end if;
  if current_item_revision <> target_expected_item_revision then raise exception 'saga_quarterly_batch_item_revision_conflict' using errcode = 'P0001'; end if;
  if current_draft_revision <> target_expected_draft_revision then raise exception 'saga_quarterly_draft_revision_conflict' using errcode = 'P0001'; end if;
  if current_draft_status not in ('draft', 'in_review') then raise exception 'saga_quarterly_draft_not_reviewable' using errcode = 'P0001'; end if;
  if exists (select 1 from studio_drafts where workspace_id = target_workspace_id and id = current_draft_id and scheduled_at is not null) then
    raise exception 'saga_quarterly_draft_already_calendar_scheduled' using errcode = 'P0001';
  end if;

  if target_resolution = 'approved' then
    update studio_drafts
       set status = 'approved', metadata = metadata || jsonb_build_object('approvedAt', now()::text), revision = revision + 1
     where workspace_id = target_workspace_id and id = current_draft_id and revision = target_expected_draft_revision
    returning revision into next_draft_revision;
  elsif target_resolution = 'rejected' then
    update studio_drafts
       set status = 'cancelled', metadata = metadata || jsonb_build_object('approvedAt', null), revision = revision + 1
     where workspace_id = target_workspace_id and id = current_draft_id and revision = target_expected_draft_revision
    returning revision into next_draft_revision;
  else
    update studio_drafts
       set status = 'in_review',
           metadata = metadata || jsonb_build_object(
             'approvedAt', null,
             'sagaQuarterlyReturn', jsonb_build_object('note', left(trim(target_note), 2000), 'returnedAt', now()::text)
           ),
           revision = revision + 1
     where workspace_id = target_workspace_id and id = current_draft_id and revision = target_expected_draft_revision
    returning revision into next_draft_revision;
  end if;
  if next_draft_revision is null then raise exception 'saga_quarterly_draft_revision_conflict' using errcode = 'P0001'; end if;

  update saga_quarterly_activity_plan_batch_items
     set state = target_resolution,
         review_resolution = case when target_resolution = 'returned' then null else target_resolution end,
         review_note = left(coalesce(target_note, ''), 2000),
         review_idempotency_key = target_idempotency_key,
         reviewed_by_user_id = target_user_id,
         reviewed_at = now(),
         returned_draft_revision = case when target_resolution = 'returned' then next_draft_revision else null end,
         revision = revision + 1
   where workspace_id = target_workspace_id and id = target_batch_item_id and revision = target_expected_item_revision
  returning revision into next_item_revision;
  if next_item_revision is null then raise exception 'saga_quarterly_batch_item_revision_conflict' using errcode = 'P0001'; end if;
  if target_resolution <> 'returned' then
    update saga_quarterly_activity_plan_slots
       set state = 'review_resolved', revision = revision + 1
     where workspace_id = target_workspace_id
       and id = (select plan_slot_id from saga_quarterly_activity_plan_batch_items where workspace_id = target_workspace_id and id = target_batch_item_id);
  end if;
  update saga_quarterly_activity_plan_batches batch
     set state = case
       when exists (select 1 from saga_quarterly_activity_plan_batch_items item where item.workspace_id = target_workspace_id and item.batch_id = batch.id and item.state = 'returned') then 'rework_required'
       when exists (select 1 from saga_quarterly_activity_plan_batch_items item where item.workspace_id = target_workspace_id and item.batch_id = batch.id and item.review_resolution is null) then 'ready_for_review'
       else 'resolved'
     end,
     revision = revision + 1
   where batch.workspace_id = target_workspace_id and batch.id = target_batch_id and batch.revision = target_expected_batch_revision
  returning revision into next_batch_revision;
  if next_batch_revision is null then raise exception 'saga_quarterly_batch_revision_conflict' using errcode = 'P0001'; end if;
  batch_id := target_batch_id;
  batch_revision := next_batch_revision;
  item_id := target_batch_item_id;
  item_revision := next_item_revision;
  reused := false;
  return next;
end;
$$;

-- A return is deliberately non-terminal.  The draft stays private and
-- in_review while a person edits it, then this explicit action puts the same
-- real draft back into the review queue.  It is never regenerated silently.
create or replace function saga_resubmit_quarterly_activity_plan_batch_item(
  target_workspace_id uuid,
  target_user_id uuid,
  target_brand_profile_id uuid,
  target_batch_id uuid,
  target_batch_item_id uuid,
  target_idempotency_key uuid,
  target_expected_plan_revision integer,
  target_expected_batch_revision integer,
  target_expected_item_revision integer,
  target_expected_draft_revision integer
)
returns table (batch_id uuid, batch_revision integer, item_id uuid, item_revision integer, reused boolean)
language plpgsql
set search_path = public
as $$
declare
  current_plan_revision integer;
  current_batch_revision integer;
  current_batch_state text;
  current_item_revision integer;
  current_item_state text;
  current_resubmit_key uuid;
  current_returned_draft_revision integer;
  current_draft_revision integer;
  current_draft_status text;
  next_batch_revision integer;
  next_item_revision integer;
begin
  perform saga_quarterly_require_completed_brand(target_workspace_id, target_brand_profile_id);
  select plan.revision, batch.revision, batch.state, item.revision, item.state,
         item.resubmit_idempotency_key, item.returned_draft_revision, draft.revision, draft.status
    into current_plan_revision, current_batch_revision, current_batch_state, current_item_revision,
         current_item_state, current_resubmit_key, current_returned_draft_revision, current_draft_revision, current_draft_status
    from saga_quarterly_activity_plans plan
    join saga_quarterly_activity_plan_batches batch
      on batch.workspace_id = plan.workspace_id and batch.plan_id = plan.id
    join saga_quarterly_activity_plan_batch_items item
      on item.workspace_id = batch.workspace_id and item.batch_id = batch.id
    join studio_drafts draft
      on draft.workspace_id = item.workspace_id and draft.id = item.studio_draft_id
   where plan.workspace_id = target_workspace_id
     and plan.brand_profile_id = target_brand_profile_id
     and batch.id = target_batch_id
     and item.id = target_batch_item_id
   for update of plan, batch, item, draft;
  if not found then raise exception 'saga_quarterly_batch_item_not_found' using errcode = 'P0001'; end if;
  if current_item_state = 'ready_for_review' and current_resubmit_key = target_idempotency_key then
    batch_id := target_batch_id;
    batch_revision := current_batch_revision;
    item_id := target_batch_item_id;
    item_revision := current_item_revision;
    reused := true;
    return next;
    return;
  end if;
  if current_plan_revision <> target_expected_plan_revision then raise exception 'saga_quarterly_plan_revision_conflict' using errcode = 'P0001'; end if;
  if current_batch_revision <> target_expected_batch_revision then raise exception 'saga_quarterly_batch_revision_conflict' using errcode = 'P0001'; end if;
  if current_batch_state <> 'rework_required' then raise exception 'saga_quarterly_batch_not_waiting_for_rework' using errcode = 'P0001'; end if;
  if current_item_state <> 'returned' then raise exception 'saga_quarterly_batch_item_not_returned' using errcode = 'P0001'; end if;
  if current_item_revision <> target_expected_item_revision then raise exception 'saga_quarterly_batch_item_revision_conflict' using errcode = 'P0001'; end if;
  if current_draft_revision <> target_expected_draft_revision then raise exception 'saga_quarterly_draft_revision_conflict' using errcode = 'P0001'; end if;
  if current_returned_draft_revision is null or current_draft_revision <= current_returned_draft_revision then
    raise exception 'saga_quarterly_returned_draft_not_edited' using errcode = 'P0001';
  end if;
  if current_draft_status <> 'in_review' then raise exception 'saga_quarterly_draft_not_reviewable' using errcode = 'P0001'; end if;
  if exists (select 1 from studio_drafts where workspace_id = target_workspace_id and id = (
    select studio_draft_id from saga_quarterly_activity_plan_batch_items where workspace_id = target_workspace_id and id = target_batch_item_id
  ) and scheduled_at is not null) then
    raise exception 'saga_quarterly_draft_already_calendar_scheduled' using errcode = 'P0001';
  end if;

  update saga_quarterly_activity_plan_batch_items
     set state = 'ready_for_review', review_resolution = null, review_idempotency_key = null,
         reviewed_by_user_id = null, reviewed_at = null,
         returned_draft_revision = null,
         resubmit_idempotency_key = target_idempotency_key, resubmitted_by_user_id = target_user_id,
         resubmitted_at = now(), error_message = null, revision = revision + 1
   where workspace_id = target_workspace_id and id = target_batch_item_id and revision = target_expected_item_revision
  returning revision into next_item_revision;
  if next_item_revision is null then raise exception 'saga_quarterly_batch_item_revision_conflict' using errcode = 'P0001'; end if;
  update saga_quarterly_activity_plan_batches
     set state = 'ready_for_review', failure_message = null, revision = revision + 1
   where workspace_id = target_workspace_id and id = target_batch_id and revision = target_expected_batch_revision
  returning revision into next_batch_revision;
  if next_batch_revision is null then raise exception 'saga_quarterly_batch_revision_conflict' using errcode = 'P0001'; end if;
  batch_id := target_batch_id;
  batch_revision := next_batch_revision;
  item_id := target_batch_item_id;
  item_revision := next_item_revision;
  reused := false;
  return next;
end;
$$;

drop trigger if exists saga_quarterly_activity_plans_set_updated_at on saga_quarterly_activity_plans;
create trigger saga_quarterly_activity_plans_set_updated_at
before update on saga_quarterly_activity_plans
for each row execute function app_set_updated_at();
drop trigger if exists saga_quarterly_activity_plan_slots_set_updated_at on saga_quarterly_activity_plan_slots;
create trigger saga_quarterly_activity_plan_slots_set_updated_at
before update on saga_quarterly_activity_plan_slots
for each row execute function app_set_updated_at();
drop trigger if exists saga_quarterly_activity_plan_batches_set_updated_at on saga_quarterly_activity_plan_batches;
create trigger saga_quarterly_activity_plan_batches_set_updated_at
before update on saga_quarterly_activity_plan_batches
for each row execute function app_set_updated_at();
drop trigger if exists saga_quarterly_activity_plan_batch_items_set_updated_at on saga_quarterly_activity_plan_batch_items;
create trigger saga_quarterly_activity_plan_batch_items_set_updated_at
before update on saga_quarterly_activity_plan_batch_items
for each row execute function app_set_updated_at();
drop trigger if exists saga_quarterly_activity_plan_jobs_set_updated_at on saga_quarterly_activity_plan_jobs;
create trigger saga_quarterly_activity_plan_jobs_set_updated_at
before update on saga_quarterly_activity_plan_jobs
for each row execute function app_set_updated_at();
drop trigger if exists saga_quarterly_activity_plan_materialization_receipts_set_updated_at on saga_quarterly_activity_plan_materialization_receipts;
create trigger saga_quarterly_activity_plan_materialization_receipts_set_updated_at
before update on saga_quarterly_activity_plan_materialization_receipts
for each row execute function app_set_updated_at();

commit;
