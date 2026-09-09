-- SAGA Series References: immutable, workspace-scoped snapshots of a saved
-- Studio example. This is editorial context only: no provider credential,
-- scheduling, delivery or public Blob locator is stored here.
--
-- Apply after the Vercel/Neon Studio and Content Engine migrations.

begin;

create or replace function saga_series_reference_controls_are_valid(payload jsonb)
returns boolean
language plpgsql
immutable
as $$
declare
  key_count integer;
  required_count integer;
  forbidden_count integer;
  channel_count integer;
  required_distinct integer;
  forbidden_distinct integer;
  channel_distinct integer;
begin
  if jsonb_typeof(payload) <> 'object' then return false; end if;
  if not (payload ?& array['objective', 'audience', 'tone', 'requiredElements', 'forbiddenElements', 'defaultChannels', 'reviewRequired']) then return false; end if;
  select count(*) into key_count from jsonb_object_keys(payload);
  if key_count <> 7 then return false; end if;
  if payload ->> 'objective' not in ('educate', 'inspire', 'convert', 'community') then return false; end if;
  if payload ->> 'tone' not in ('direct', 'warm', 'insightful') then return false; end if;
  if jsonb_typeof(payload -> 'audience') <> 'string' or char_length(btrim(payload ->> 'audience')) not between 1 and 160 then return false; end if;
  if payload -> 'reviewRequired' <> 'true'::jsonb then return false; end if;
  if jsonb_typeof(payload -> 'requiredElements') <> 'array' or jsonb_typeof(payload -> 'forbiddenElements') <> 'array' or jsonb_typeof(payload -> 'defaultChannels') <> 'array' then return false; end if;

  required_count := jsonb_array_length(payload -> 'requiredElements');
  forbidden_count := jsonb_array_length(payload -> 'forbiddenElements');
  channel_count := jsonb_array_length(payload -> 'defaultChannels');
  if required_count > 6 or forbidden_count > 6 or channel_count > 4 then return false; end if;

  if exists (
    select 1 from jsonb_array_elements_text(payload -> 'requiredElements') value
    where char_length(btrim(value)) not between 1 and 200
  ) or exists (
    select 1 from jsonb_array_elements_text(payload -> 'forbiddenElements') value
    where char_length(btrim(value)) not between 1 and 200
  ) or exists (
    select 1 from jsonb_array_elements_text(payload -> 'defaultChannels') value
    where value not in ('facebook_page', 'instagram', 'linkedin', 'newsletter')
  ) then return false; end if;

  select count(distinct lower(btrim(value))) into required_distinct from jsonb_array_elements_text(payload -> 'requiredElements') value;
  select count(distinct lower(btrim(value))) into forbidden_distinct from jsonb_array_elements_text(payload -> 'forbiddenElements') value;
  select count(distinct value) into channel_distinct from jsonb_array_elements_text(payload -> 'defaultChannels') value;
  if required_count <> required_distinct or forbidden_count <> forbidden_distinct or channel_count <> channel_distinct then return false; end if;

  if exists (
    select 1
    from jsonb_array_elements_text(payload -> 'requiredElements') required_value
    join jsonb_array_elements_text(payload -> 'forbiddenElements') forbidden_value
      on lower(btrim(required_value)) = lower(btrim(forbidden_value))
  ) then return false; end if;

  return true;
end;
$$;

create or replace function saga_series_reference_channels_are_valid(payload jsonb)
returns boolean
language plpgsql
immutable
as $$
declare
  channel_count integer;
  channel_distinct integer;
begin
  if jsonb_typeof(payload) <> 'array' then return false; end if;
  channel_count := jsonb_array_length(payload);
  if channel_count > 4 then return false; end if;
  if exists (
    select 1 from jsonb_array_elements_text(payload) value
    where value not in ('facebook_page', 'instagram', 'linkedin', 'newsletter')
  ) then return false; end if;
  select count(distinct value) into channel_distinct from jsonb_array_elements_text(payload) value;
  return channel_count = channel_distinct;
end;
$$;

-- A snapshot may carry visual continuity metadata, never a storage locator,
-- hash, source filename or raw media metadata. Keep it bounded so this safe
-- projection can be used by server-only AI and quality callers without an
-- unbounded prompt payload.
create or replace function saga_series_reference_media_metadata_is_valid(payload jsonb)
returns boolean
language plpgsql
immutable
as $$
declare
  entry jsonb;
  key_count integer;
begin
  if jsonb_typeof(payload) <> 'array' or jsonb_array_length(payload) > 12 then return false; end if;
  if content_engine_json_has_forbidden_secret_key(payload) then return false; end if;

  for entry in select item from jsonb_array_elements(payload) as values_row(item) loop
    if jsonb_typeof(entry) <> 'object' then return false; end if;
    select count(*) into key_count from jsonb_object_keys(entry);
    if key_count <> 6
      or not (entry ?& array['kind', 'contentType', 'width', 'height', 'altText', 'status']) then
      return false;
    end if;
    if entry ->> 'kind' not in ('upload', 'generated', 'derived')
      or entry ->> 'status' not in ('processing', 'ready', 'failed', 'deleted') then
      return false;
    end if;
    if jsonb_typeof(entry -> 'contentType') <> 'string'
      or char_length(btrim(entry ->> 'contentType')) not between 1 and 120 then
      return false;
    end if;
    if (entry -> 'width') <> 'null'::jsonb then
      if jsonb_typeof(entry -> 'width') <> 'number' or entry ->> 'width' !~ '^[1-9][0-9]{0,4}$' then return false; end if;
      if (entry ->> 'width')::integer > 20000 then return false; end if;
    end if;
    if (entry -> 'height') <> 'null'::jsonb then
      if jsonb_typeof(entry -> 'height') <> 'number' or entry ->> 'height' !~ '^[1-9][0-9]{0,4}$' then return false; end if;
      if (entry ->> 'height')::integer > 20000 then return false; end if;
    end if;
    if jsonb_typeof(entry -> 'altText') not in ('string', 'null')
      or (jsonb_typeof(entry -> 'altText') = 'string' and char_length(entry ->> 'altText') > 1000) then
      return false;
    end if;
  end loop;
  return true;
end;
$$;

create table if not exists saga_series_references (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app_workspaces(id) on delete cascade,
  created_by_user_id uuid not null,
  updated_by_user_id uuid not null,
  slug text not null check (slug = lower(slug) and slug ~ '^[a-z0-9][a-z0-9-]{1,78}$'),
  name text not null check (char_length(trim(name)) between 2 and 160),
  active boolean not null default false,
  revision integer not null default 1 check (revision > 0),
  current_reference_revision integer not null default 1 check (current_reference_revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, slug),
  check (revision = current_reference_revision),
  foreign key (workspace_id, created_by_user_id)
    references app_workspace_memberships(workspace_id, user_id)
    on delete restrict,
  foreign key (workspace_id, updated_by_user_id)
    references app_workspace_memberships(workspace_id, user_id)
    on delete restrict
);

create table if not exists saga_series_reference_revisions (
  workspace_id uuid not null references app_workspaces(id) on delete cascade,
  series_id uuid not null,
  revision integer not null check (revision > 0),
  source_draft_id uuid not null,
  source_draft_revision integer not null check (source_draft_revision > 0),
  content_type text not null check (content_type in ('social_post', 'newsletter', 'article')),
  reference_title text not null check (char_length(btrim(reference_title)) between 1 and 240),
  reference_body text not null check (char_length(btrim(reference_body)) between 1 and 60000),
  reference_channels jsonb not null default '[]'::jsonb
    check (saga_series_reference_channels_are_valid(reference_channels)),
  media_safe_metadata jsonb not null default '[]'::jsonb
    check (saga_series_reference_media_metadata_is_valid(media_safe_metadata)),
  controls_snapshot jsonb not null
    check (saga_series_reference_controls_are_valid(controls_snapshot))
    check (not content_engine_json_has_forbidden_secret_key(controls_snapshot)),
  captured_at timestamptz not null default now(),
  created_by_user_id uuid not null,
  primary key (workspace_id, series_id, revision),
  foreign key (workspace_id, series_id)
    references saga_series_references(workspace_id, id)
    on delete cascade,
  foreign key (workspace_id, created_by_user_id)
    references app_workspace_memberships(workspace_id, user_id)
    on delete restrict
);

create index if not exists saga_series_references_workspace_active_idx
  on saga_series_references(workspace_id, active, lower(name), created_at);
create index if not exists saga_series_reference_revisions_source_draft_idx
  on saga_series_reference_revisions(workspace_id, source_draft_id, captured_at desc);

-- Revision rows are append-only. Deleting a whole series still cascades so a
-- user can intentionally remove the entity; no caller can mutate history.
create or replace function saga_series_reference_revision_is_immutable()
returns trigger
language plpgsql
as $$
begin
  raise exception 'saga_series_reference_revisions are immutable';
end;
$$;

drop trigger if exists saga_series_reference_revision_immutable on saga_series_reference_revisions;
create trigger saga_series_reference_revision_immutable
before update on saga_series_reference_revisions
for each row execute function saga_series_reference_revision_is_immutable();

-- An active series must point at a real snapshot. The create function inserts
-- the parent inactive, records revision 1, and only then enables it.
create or replace function saga_series_reference_active_requires_snapshot()
returns trigger
language plpgsql
as $$
begin
  if new.active and not exists (
    select 1 from saga_series_reference_revisions revision
    where revision.workspace_id = new.workspace_id
      and revision.series_id = new.id
      and revision.revision = new.current_reference_revision
  ) then
    raise exception 'An active SAGA series requires an immutable reference snapshot';
  end if;
  return new;
end;
$$;

drop trigger if exists saga_series_reference_active_guard on saga_series_references;
create trigger saga_series_reference_active_guard
before insert or update of active, current_reference_revision on saga_series_references
for each row execute function saga_series_reference_active_requires_snapshot();

drop trigger if exists saga_series_references_set_updated_at on saga_series_references;
create trigger saga_series_references_set_updated_at
before update on saga_series_references
for each row execute function app_set_updated_at();

create or replace function saga_series_reference_create(
  target_workspace_id uuid,
  actor_user_id uuid,
  target_slug text,
  target_name text,
  target_active boolean,
  target_reference_draft_id uuid,
  target_controls jsonb
)
returns uuid
language plpgsql
as $$
declare
  source_draft studio_drafts%rowtype;
  safe_media jsonb;
  created_series_id uuid;
begin
  if not saga_series_reference_controls_are_valid(target_controls)
    or content_engine_json_has_forbidden_secret_key(target_controls) then
    raise exception 'SAGA series controls are invalid' using errcode = 'P0001';
  end if;

  select draft.* into source_draft
  from studio_drafts draft
  where draft.workspace_id = target_workspace_id
    and draft.id = target_reference_draft_id
    and draft.status in ('draft', 'in_review', 'approved', 'scheduled', 'published')
    and char_length(btrim(draft.title)) > 0
    and char_length(btrim(draft.body)) > 0;
  if not found then
    raise exception 'SAGA series reference draft is missing or unsuitable' using errcode = 'P0001';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'kind', media.kind,
    'contentType', media.content_type,
    'width', media.width,
    'height', media.height,
    'altText', media.alt_text,
    'status', media.status
  ) order by media.created_at, media.id), '[]'::jsonb)
  into safe_media
  from (
    select kind, content_type, width, height, alt_text, status, created_at, id
    from studio_media
    where workspace_id = target_workspace_id
      and draft_id = source_draft.id
    order by created_at, id
    limit 12
  ) media;

  -- Start inactive so the active guard cannot ever observe a series without
  -- its first snapshot.
  insert into saga_series_references (
    workspace_id, created_by_user_id, updated_by_user_id, slug, name, active,
    revision, current_reference_revision
  ) values (
    target_workspace_id, actor_user_id, actor_user_id, target_slug, target_name,
    false, 1, 1
  ) returning id into created_series_id;

  insert into saga_series_reference_revisions (
    workspace_id, series_id, revision, source_draft_id, source_draft_revision,
    content_type, reference_title, reference_body, reference_channels,
    media_safe_metadata, controls_snapshot, created_by_user_id
  ) values (
    target_workspace_id, created_series_id, 1, source_draft.id, source_draft.revision,
    source_draft.content_type, source_draft.title, source_draft.body,
    source_draft.publication_channels, safe_media, target_controls, actor_user_id
  );

  if target_active then
    update saga_series_references
       set active = true, updated_by_user_id = actor_user_id
     where workspace_id = target_workspace_id and id = created_series_id;
  end if;

  return created_series_id;
end;
$$;

create or replace function saga_series_reference_update(
  target_workspace_id uuid,
  target_series_id uuid,
  actor_user_id uuid,
  expected_revision integer,
  target_slug text,
  target_name text,
  target_active boolean,
  replacement_reference_draft_id uuid,
  target_controls jsonb
)
returns uuid
language plpgsql
as $$
declare
  current_series saga_series_references%rowtype;
  next_revision integer;
  source_draft studio_drafts%rowtype;
  selected_source_draft_id uuid;
  selected_source_draft_revision integer;
  selected_content_type text;
  selected_title text;
  selected_body text;
  selected_channels jsonb;
  selected_media jsonb;
  updated_series_id uuid;
begin
  if not saga_series_reference_controls_are_valid(target_controls)
    or content_engine_json_has_forbidden_secret_key(target_controls) then
    raise exception 'SAGA series controls are invalid' using errcode = 'P0001';
  end if;

  select series.* into current_series
  from saga_series_references series
  where series.workspace_id = target_workspace_id
    and series.id = target_series_id
    and series.revision = expected_revision
  for update;
  if not found then return null; end if;

  next_revision := current_series.revision + 1;

  if replacement_reference_draft_id is null then
    select revision.source_draft_id, revision.source_draft_revision,
           revision.content_type, revision.reference_title, revision.reference_body,
           revision.reference_channels, revision.media_safe_metadata
      into selected_source_draft_id, selected_source_draft_revision,
           selected_content_type, selected_title, selected_body,
           selected_channels, selected_media
      from saga_series_reference_revisions revision
     where revision.workspace_id = target_workspace_id
       and revision.series_id = current_series.id
       and revision.revision = current_series.current_reference_revision;
    if not found then
      raise exception 'SAGA series reference snapshot is missing' using errcode = 'P0001';
    end if;
  else
    select draft.* into source_draft
    from studio_drafts draft
    where draft.workspace_id = target_workspace_id
      and draft.id = replacement_reference_draft_id
      and draft.status in ('draft', 'in_review', 'approved', 'scheduled', 'published')
      and char_length(btrim(draft.title)) > 0
      and char_length(btrim(draft.body)) > 0;
    if not found then
      raise exception 'SAGA series reference draft is missing or unsuitable' using errcode = 'P0001';
    end if;

    selected_source_draft_id := source_draft.id;
    selected_source_draft_revision := source_draft.revision;
    selected_content_type := source_draft.content_type;
    selected_title := source_draft.title;
    selected_body := source_draft.body;
    selected_channels := source_draft.publication_channels;
    select coalesce(jsonb_agg(jsonb_build_object(
      'kind', media.kind,
      'contentType', media.content_type,
      'width', media.width,
      'height', media.height,
      'altText', media.alt_text,
      'status', media.status
    ) order by media.created_at, media.id), '[]'::jsonb)
    into selected_media
    from (
      select kind, content_type, width, height, alt_text, status, created_at, id
      from studio_media
      where workspace_id = target_workspace_id
        and draft_id = source_draft.id
      order by created_at, id
      limit 12
    ) media;
  end if;

  -- The next snapshot is written before the current pointer advances. That
  -- lets the active trigger prove the new version exists during the update.
  insert into saga_series_reference_revisions (
    workspace_id, series_id, revision, source_draft_id, source_draft_revision,
    content_type, reference_title, reference_body, reference_channels,
    media_safe_metadata, controls_snapshot, created_by_user_id
  ) values (
    target_workspace_id, current_series.id, next_revision,
    selected_source_draft_id, selected_source_draft_revision, selected_content_type,
    selected_title, selected_body, selected_channels, selected_media,
    target_controls, actor_user_id
  );

  update saga_series_references
     set slug = target_slug,
         name = target_name,
         active = target_active,
         revision = next_revision,
         current_reference_revision = next_revision,
         updated_by_user_id = actor_user_id
   where workspace_id = target_workspace_id
     and id = current_series.id
     and revision = expected_revision
  returning id into updated_series_id;

  return updated_series_id;
end;
$$;

commit;
