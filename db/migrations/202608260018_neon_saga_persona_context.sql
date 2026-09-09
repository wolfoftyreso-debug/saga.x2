-- SAGA Persona Context: a private, owner-scoped, self-described record.
--
-- This migration intentionally follows 017 without changing prior migration
-- history. Persona data can include sensitive identity context, so it is not
-- an editorial profile, a publication field, or an implicit AI prompt. The
-- only future-facing model seam is an explicit private visual consent flag;
-- there is no model worker or publishing integration in this migration.

begin;

create or replace function saga_persona_context_text_or_null_is_valid(value jsonb, max_length integer)
returns boolean
language plpgsql
immutable
as $$
begin
  return value = 'null'::jsonb
    or (
      jsonb_typeof(value) = 'string'
      and char_length(btrim(value #>> '{}')) between 1 and max_length
    );
end;
$$;

create or replace function saga_persona_context_text_list_is_valid(value jsonb, max_items integer, max_length integer)
returns boolean
language plpgsql
immutable
as $$
declare
  item_count integer;
  distinct_count integer;
begin
  if jsonb_typeof(value) <> 'array' then return false; end if;
  item_count := jsonb_array_length(value);
  if item_count > max_items then return false; end if;
  if exists (
    select 1
    from jsonb_array_elements(value) item
    where jsonb_typeof(item) <> 'string'
      or char_length(btrim(item #>> '{}')) not between 1 and max_length
  ) then return false; end if;
  select count(distinct lower(btrim(item #>> '{}')))
    into distinct_count
    from jsonb_array_elements(value) item;
  return item_count = distinct_count;
end;
$$;

create or replace function saga_persona_context_stance_is_valid(value jsonb)
returns boolean
language plpgsql
immutable
as $$
declare
  mode text;
  description jsonb;
  key_count integer;
begin
  if jsonb_typeof(value) <> 'object' then return false; end if;
  select count(*) into key_count from jsonb_object_keys(value);
  if key_count <> 2 or not (value ?& array['mode', 'description']) then return false; end if;
  mode := value ->> 'mode';
  description := value -> 'description';
  if mode = 'self_described' then
    return jsonb_typeof(description) = 'string'
      and char_length(btrim(description #>> '{}')) between 1 and 800;
  end if;
  return mode in ('not_specified', 'neutral') and description = 'null'::jsonb;
end;
$$;

create or replace function saga_persona_context_organizations_are_valid(value jsonb)
returns boolean
language plpgsql
immutable
as $$
declare
  entry jsonb;
  key_count integer;
  item_count integer;
  distinct_count integer;
begin
  if jsonb_typeof(value) <> 'array' then return false; end if;
  item_count := jsonb_array_length(value);
  if item_count > 12 then return false; end if;
  for entry in select item from jsonb_array_elements(value) as values_row(item) loop
    if jsonb_typeof(entry) <> 'object' then return false; end if;
    select count(*) into key_count from jsonb_object_keys(entry);
    if key_count <> 2 or not (entry ?& array['name', 'role']) then return false; end if;
    if jsonb_typeof(entry -> 'name') <> 'string'
      or char_length(btrim(entry ->> 'name')) not between 1 and 160 then return false; end if;
    if not saga_persona_context_text_or_null_is_valid(entry -> 'role', 160) then return false; end if;
  end loop;
  select count(distinct lower(btrim(entry ->> 'name')))
    into distinct_count
    from jsonb_array_elements(value) entry;
  return item_count = distinct_count;
end;
$$;

create or replace function saga_persona_context_websites_are_valid(value jsonb)
returns boolean
language plpgsql
immutable
as $$
declare
  entry jsonb;
  key_count integer;
  item_count integer;
  distinct_count integer;
  homepage text;
begin
  if jsonb_typeof(value) <> 'array' then return false; end if;
  item_count := jsonb_array_length(value);
  if item_count > 12 then return false; end if;
  for entry in select item from jsonb_array_elements(value) as values_row(item) loop
    if jsonb_typeof(entry) <> 'object' then return false; end if;
    select count(*) into key_count from jsonb_object_keys(entry);
    if key_count <> 2 or not (entry ?& array['label', 'url']) then return false; end if;
    if jsonb_typeof(entry -> 'label') <> 'string'
      or char_length(btrim(entry ->> 'label')) not between 1 and 120 then return false; end if;
    if jsonb_typeof(entry -> 'url') <> 'string'
      or char_length(entry ->> 'url') not between 9 and 2048 then return false; end if;
    homepage := entry ->> 'url';
    -- Application validation is stricter and canonicalizes with URL. This
    -- backstop preserves only display-only HTTPS origins, never query strings,
    -- credentials, IP literals, localhost or arbitrary paths.
    if homepage !~ '^https://([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}/$' then return false; end if;
  end loop;
  select count(distinct entry ->> 'url')
    into distinct_count
    from jsonb_array_elements(value) entry;
  return item_count = distinct_count;
end;
$$;

create or replace function saga_persona_context_payload_is_valid(payload jsonb)
returns boolean
language plpgsql
immutable
as $$
declare
  key_count integer;
  height_text text;
begin
  if jsonb_typeof(payload) <> 'object' then return false; end if;
  select count(*) into key_count from jsonb_object_keys(payload);
  if key_count <> 15 then return false; end if;
  if not (payload ?& array[
    'selfDescription', 'heightCm', 'clothing', 'environments', 'visualCountries',
    'interests', 'workSummary', 'roles', 'organizations', 'websites', 'political',
    'religion', 'origin', 'birthCountry', 'visualContextConsent'
  ]) then return false; end if;

  if not saga_persona_context_text_or_null_is_valid(payload -> 'selfDescription', 2000)
    or not saga_persona_context_text_or_null_is_valid(payload -> 'workSummary', 2000)
    or not saga_persona_context_text_or_null_is_valid(payload -> 'origin', 800)
    or not saga_persona_context_text_or_null_is_valid(payload -> 'birthCountry', 120) then return false; end if;

  if (payload -> 'heightCm') <> 'null'::jsonb then
    if jsonb_typeof(payload -> 'heightCm') <> 'number' then return false; end if;
    height_text := payload ->> 'heightCm';
    if height_text !~ '^[0-9]+$' or height_text::integer not between 80 and 250 then return false; end if;
  end if;

  if not saga_persona_context_text_list_is_valid(payload -> 'clothing', 12, 120)
    or not saga_persona_context_text_list_is_valid(payload -> 'environments', 12, 120)
    or not saga_persona_context_text_list_is_valid(payload -> 'visualCountries', 12, 120)
    or not saga_persona_context_text_list_is_valid(payload -> 'interests', 20, 120)
    or not saga_persona_context_text_list_is_valid(payload -> 'roles', 12, 120)
    or not saga_persona_context_organizations_are_valid(payload -> 'organizations')
    or not saga_persona_context_websites_are_valid(payload -> 'websites')
    or not saga_persona_context_stance_is_valid(payload -> 'political')
    or not saga_persona_context_stance_is_valid(payload -> 'religion') then return false; end if;

  return (payload -> 'visualContextConsent') in ('true'::jsonb, 'false'::jsonb);
end;
$$;

create table if not exists saga_persona_contexts (
  workspace_id uuid not null references app_workspaces(id) on delete cascade,
  owner_user_id uuid not null,
  revision integer not null default 1 check (revision > 0),
  -- Contains the full private self-description. It must never be selected by
  -- a model or publishing worker. The reader below selects only three allowed
  -- visual fields after explicit consent.
  payload jsonb not null check (saga_persona_context_payload_is_valid(payload)),
  visual_context_consent boolean generated always as ((payload ->> 'visualContextConsent')::boolean) stored,
  model_integration_status text not null default 'disabled'
    check (model_integration_status = 'disabled'),
  publication_scope text not null default 'excluded'
    check (publication_scope = 'excluded'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, owner_user_id),
  foreign key (workspace_id, owner_user_id)
    references app_workspace_memberships(workspace_id, user_id)
    on delete cascade
);

-- Revisions make edits auditable without allowing the history itself to be
-- rewritten. Deleting the owner record intentionally clears all revisions.
create table if not exists saga_persona_context_revisions (
  workspace_id uuid not null,
  owner_user_id uuid not null,
  revision integer not null check (revision > 0),
  payload jsonb not null check (saga_persona_context_payload_is_valid(payload)),
  created_at timestamptz not null default now(),
  primary key (workspace_id, owner_user_id, revision),
  foreign key (workspace_id, owner_user_id)
    references saga_persona_contexts(workspace_id, owner_user_id)
    on delete cascade
);

create or replace function saga_persona_context_revision_is_immutable()
returns trigger
language plpgsql
as $$
begin
  raise exception 'saga_persona_context_revisions are immutable';
end;
$$;

drop trigger if exists saga_persona_context_revision_immutable on saga_persona_context_revisions;
create trigger saga_persona_context_revision_immutable
before update on saga_persona_context_revisions
for each row execute function saga_persona_context_revision_is_immutable();

create or replace function saga_persona_contexts_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists saga_persona_contexts_set_updated_at on saga_persona_contexts;
create trigger saga_persona_contexts_set_updated_at
before update on saga_persona_contexts
for each row execute function saga_persona_contexts_set_updated_at();

-- The only supported write path. It derives ownership from server parameters,
-- verifies that the caller is an owner in this workspace, appends an immutable
-- snapshot, and accepts an optional optimistic-concurrency revision.
create or replace function saga_persona_context_write(
  target_workspace_id uuid,
  target_owner_user_id uuid,
  target_payload jsonb,
  expected_revision integer default null
)
returns integer
language plpgsql
as $$
declare
  current_revision integer;
  next_revision integer;
begin
  if not saga_persona_context_payload_is_valid(target_payload) then
    raise exception 'SAGA persona context payload is invalid' using errcode = 'P0001';
  end if;
  if not exists (
    select 1
    from app_workspace_memberships membership
    where membership.workspace_id = target_workspace_id
      and membership.user_id = target_owner_user_id
      and membership.role = 'owner'
  ) then
    raise exception 'SAGA persona context requires workspace owner' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(target_workspace_id::text || ':' || target_owner_user_id::text, 0));
  select revision into current_revision
    from saga_persona_contexts
   where workspace_id = target_workspace_id and owner_user_id = target_owner_user_id
   for update;

  if found then
    if expected_revision is not null and expected_revision <> current_revision then return null; end if;
    next_revision := current_revision + 1;
    update saga_persona_contexts
       set revision = next_revision,
           payload = target_payload
     where workspace_id = target_workspace_id and owner_user_id = target_owner_user_id;
  else
    if expected_revision is not null then return null; end if;
    next_revision := 1;
    insert into saga_persona_contexts (workspace_id, owner_user_id, revision, payload)
    values (target_workspace_id, target_owner_user_id, next_revision, target_payload);
  end if;

  insert into saga_persona_context_revisions (workspace_id, owner_user_id, revision, payload)
  values (target_workspace_id, target_owner_user_id, next_revision, target_payload);
  return next_revision;
end;
$$;

create index if not exists saga_persona_contexts_owner_updated_idx
  on saga_persona_contexts(workspace_id, owner_user_id, updated_at desc);
create index if not exists saga_persona_contexts_private_visual_idx
  on saga_persona_contexts(workspace_id, owner_user_id)
  where visual_context_consent = true;

commit;
