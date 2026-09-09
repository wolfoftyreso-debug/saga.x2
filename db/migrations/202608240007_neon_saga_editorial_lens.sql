-- SAGA Editorial Lens: a single, editable editorial doctrine per workspace.
--
-- The lens composes with the Vercel/Neon Content Engine introduced in
-- 202608240006. It does not store model credentials, delivery credentials,
-- raw OAuth material, or a second copy of the brand/source system.

begin;

create or replace function saga_editorial_lens_valid_text_list(values_list text[], max_items integer, max_length integer)
returns boolean
language sql
immutable
as $$
  select cardinality(values_list) <= max_items
     and cardinality(values_list) = coalesce((
       select count(distinct lower(trim(value)))
       from unnest(values_list) value
     ), 0)
     and coalesce((
       select bool_and(char_length(trim(value)) between 1 and max_length)
       from unnest(values_list) value
     ), true);
$$;

create or replace function saga_editorial_lens_text_lists_disjoint(first_values text[], second_values text[])
returns boolean
language sql
immutable
as $$
  select not exists (
    select 1
    from unnest(first_values) first_value
    join unnest(second_values) second_value
      on lower(trim(first_value)) = lower(trim(second_value))
  );
$$;

create table if not exists saga_editorial_lenses (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app_workspaces(id) on delete cascade,
  created_by_user_id uuid not null,
  updated_by_user_id uuid not null,
  -- Reuse the existing Content Engine voice/profile when a company has one;
  -- the Lens adds doctrine and evidence controls instead of duplicating it.
  brand_profile_id uuid,
  name text not null default 'SAGA Editorial Lens'
    check (char_length(trim(name)) between 2 and 160),
  mission text not null default '' check (char_length(mission) <= 6000),
  strategic_perspective text not null default '' check (char_length(strategic_perspective) <= 6000),
  industry text not null default '' check (char_length(industry) <= 240),
  audience text not null default '' check (char_length(audience) <= 3000),
  themes text[] not null default '{}'::text[]
    check (saga_editorial_lens_valid_text_list(themes, 40, 160)),
  forbidden_themes text[] not null default '{}'::text[]
    check (saga_editorial_lens_valid_text_list(forbidden_themes, 40, 160)),
  tone_config jsonb not null default '{}'::jsonb
    check (jsonb_typeof(tone_config) = 'object')
    check (not content_engine_json_has_forbidden_secret_key(tone_config)),
  construction_config jsonb not null default '{}'::jsonb
    check (jsonb_typeof(construction_config) = 'object')
    check (not content_engine_json_has_forbidden_secret_key(construction_config)),
  evidence_threshold text not null default 'one_primary_or_two_independent'
    check (evidence_threshold in (
      'one_allowed_source',
      'one_primary_or_two_independent',
      'two_independent_sources',
      'primary_source_required'
    )),
  source_rules jsonb not null default '{}'::jsonb
    check (jsonb_typeof(source_rules) = 'object')
    check (not content_engine_json_has_forbidden_secret_key(source_rules)),
  control_mode text not null default 'review_required'
    check (control_mode in ('advisory', 'review_required', 'strict')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A Lens is the doctrine for an entire workspace, never a record picked by
  -- an untrusted client or a competing tenant.
  unique (workspace_id),
  unique (workspace_id, id),
  foreign key (workspace_id, created_by_user_id)
    references app_workspace_memberships(workspace_id, user_id)
    on delete restrict,
  foreign key (workspace_id, updated_by_user_id)
    references app_workspace_memberships(workspace_id, user_id)
    on delete restrict,
  foreign key (workspace_id, brand_profile_id)
    references content_engine_brand_profiles(workspace_id, id)
    on delete restrict,
  check (saga_editorial_lens_text_lists_disjoint(themes, forbidden_themes))
);

create table if not exists saga_editorial_lens_sources (
  workspace_id uuid not null references app_workspaces(id) on delete cascade,
  lens_id uuid not null,
  source_id uuid not null,
  role text not null check (role in ('required', 'preferred')),
  priority smallint not null check (priority between 1 and 50),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, lens_id, source_id),
  unique (workspace_id, lens_id, priority),
  foreign key (workspace_id, lens_id)
    references saga_editorial_lenses(workspace_id, id)
    on delete cascade,
  foreign key (workspace_id, source_id)
    references content_engine_sources(workspace_id, id)
    on delete restrict
);

create index if not exists saga_editorial_lens_sources_source_idx
  on saga_editorial_lens_sources (workspace_id, source_id);

-- Replaces explicit trusted source selections atomically. A source from
-- another workspace, a paused source, or a disallowed source causes the whole
-- statement to fail without leaving a partial editorial doctrine behind.
create or replace function saga_editorial_lens_replace_sources(
  target_workspace_id uuid,
  target_lens_id uuid,
  requested_sources jsonb
)
returns void
language plpgsql
as $$
declare
  requested_count integer;
  distinct_sources integer;
  distinct_priorities integer;
  valid_count integer;
begin
  if requested_sources is null or jsonb_typeof(requested_sources) <> 'array' then
    raise exception 'saga_editorial_lens_sources must be an array';
  end if;

  if jsonb_array_length(requested_sources) > 50 then
    raise exception 'saga_editorial_lens_sources must contain at most 50 entries';
  end if;

  if exists (
    select 1
      from jsonb_array_elements(requested_sources) as selection(value)
     where jsonb_typeof(selection.value) <> 'object'
        or not (selection.value ? 'sourceId')
        or not (selection.value ? 'role')
        or not (selection.value ? 'priority')
        or (selection.value ->> 'sourceId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        or (selection.value ->> 'role') not in ('required', 'preferred')
        or not case
          when (selection.value ->> 'priority') ~ '^[0-9]{1,2}$'
            then (selection.value ->> 'priority')::integer between 1 and 50
          else false
        end
  ) then
    raise exception 'saga_editorial_lens_sources contains an invalid selection';
  end if;

  select
    count(*),
    count(distinct selection.value ->> 'sourceId'),
    count(distinct (selection.value ->> 'priority')::integer)
  into requested_count, distinct_sources, distinct_priorities
  from jsonb_array_elements(requested_sources) as selection(value);
  if requested_count <> distinct_sources or requested_count <> distinct_priorities then
    raise exception 'saga_editorial_lens_sources has duplicate sources or priorities';
  end if;

  if not exists (
    select 1
    from saga_editorial_lenses
    where workspace_id = target_workspace_id and id = target_lens_id
  ) then
    raise exception 'saga_editorial_lens does not exist in this workspace';
  end if;

  select count(*) into valid_count
  from content_engine_sources source
  join jsonb_array_elements(requested_sources) as selection(value)
    on source.id::text = selection.value ->> 'sourceId'
  where source.workspace_id = target_workspace_id
    and source.is_allowed = true
    and source.active = true;
  if valid_count <> requested_count then
    raise exception 'Every Lens source must be active, allowed, and belong to the same workspace';
  end if;

  delete from saga_editorial_lens_sources
  where workspace_id = target_workspace_id and lens_id = target_lens_id;

  insert into saga_editorial_lens_sources (workspace_id, lens_id, source_id, role, priority)
  select
    target_workspace_id,
    target_lens_id,
    (selection.value ->> 'sourceId')::uuid,
    selection.value ->> 'role',
    (selection.value ->> 'priority')::smallint
  from jsonb_array_elements(requested_sources) as selection(value);
end;
$$;

drop trigger if exists saga_editorial_lenses_set_updated_at on saga_editorial_lenses;
create trigger saga_editorial_lenses_set_updated_at
before update on saga_editorial_lenses
for each row execute function app_set_updated_at();

drop trigger if exists saga_editorial_lens_sources_set_updated_at on saga_editorial_lens_sources;
create trigger saga_editorial_lens_sources_set_updated_at
before update on saga_editorial_lens_sources
for each row execute function app_set_updated_at();

commit;
