-- Reusable Vercel + Neon Content Engine foundation.
--
-- This migration is intentionally configuration-only. It models each
-- workspace's editorial system (brand, allowed sources, model routing,
-- recipes and destinations) but it does not store provider credentials, run
-- a model, fetch a source, send a newsletter or publish a post. Those effects
-- remain server-owned workers behind explicit approval and audit boundaries.
--
-- Apply after 202608230001_neon_studio_core.sql through
-- 202608230005_neon_social_publish_attempts.sql.

begin;

-- Generic JSON configuration is useful for a plugin, but it must never turn
-- into an accidental credential store. The application validates the same
-- invariant before SQL; this database check protects imports and future
-- writers too. Values are deliberately not inspected so normal editorial copy
-- can contain words such as "secret" without being rejected.
create or replace function content_engine_json_has_forbidden_secret_key(payload jsonb)
returns boolean
language plpgsql
immutable
as $$
declare
  entry record;
  normalized_key text;
begin
  if payload is null then
    return false;
  end if;

  if jsonb_typeof(payload) = 'object' then
    for entry in select key, value from jsonb_each(payload) loop
      normalized_key := lower(regexp_replace(entry.key, '[^a-zA-Z0-9]+', '', 'g'));
      if normalized_key in (
        'apikey', 'accesstoken', 'refreshtoken', 'clientsecret', 'secret',
        'password', 'authorization', 'privatekey', 'credential',
        'credentials', 'bearertoken', 'serviceaccount', 'token', 'idtoken',
        'authtoken', 'sessiontoken', 'webhooksecret'
      )
      or normalized_key like '%apikey'
      or normalized_key like '%accesstoken'
      or normalized_key like '%refreshtoken'
      or normalized_key like '%clientsecret'
      or normalized_key like '%privatekey'
      or normalized_key like '%bearertoken'
      or normalized_key like '%token'
      or normalized_key like '%credential' then
        return true;
      end if;
      if content_engine_json_has_forbidden_secret_key(entry.value) then
        return true;
      end if;
    end loop;
  elsif jsonb_typeof(payload) = 'array' then
    for entry in select value from jsonb_array_elements(payload) loop
      if content_engine_json_has_forbidden_secret_key(entry.value) then
        return true;
      end if;
    end loop;
  end if;

  return false;
end;
$$;

create or replace function content_engine_valid_tag_list(tags text[])
returns boolean
language sql
immutable
as $$
  select cardinality(tags) <= 30
     and coalesce((
       select bool_and(char_length(trim(tag)) between 1 and 80)
       from unnest(tags) tag
     ), true);
$$;

create table if not exists content_engine_brand_profiles (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app_workspaces(id) on delete cascade,
  created_by_user_id uuid not null,
  slug text not null check (slug = lower(slug) and slug ~ '^[a-z0-9][a-z0-9-]{1,78}$'),
  name text not null check (char_length(trim(name)) between 2 and 160),
  organization_name text not null default '' check (char_length(organization_name) <= 240),
  summary text not null default '' check (char_length(summary) <= 6000),
  default_language text not null default 'sv' check (default_language ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  voice jsonb not null default '{}'::jsonb
    check (jsonb_typeof(voice) = 'object')
    check (not content_engine_json_has_forbidden_secret_key(voice)),
  profile_config jsonb not null default '{}'::jsonb
    check (jsonb_typeof(profile_config) = 'object')
    check (not content_engine_json_has_forbidden_secret_key(profile_config)),
  active boolean not null default true,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, slug),
  foreign key (workspace_id, created_by_user_id)
    references app_workspace_memberships(workspace_id, user_id)
    on delete restrict
);

create table if not exists content_engine_sources (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app_workspaces(id) on delete cascade,
  created_by_user_id uuid not null,
  slug text not null check (slug = lower(slug) and slug ~ '^[a-z0-9][a-z0-9-]{1,78}$'),
  name text not null check (char_length(trim(name)) between 2 and 240),
  source_kind text not null check (source_kind in ('website', 'rss', 'social_profile', 'document', 'manual')),
  source_url text
    check (source_url is null or (source_url ~ '^https://' and source_url !~ '^https://[^/]*@' and char_length(source_url) <= 2000)),
  reference_text text not null default '' check (char_length(reference_text) <= 120000),
  description text not null default '' check (char_length(description) <= 6000),
  trust_level smallint not null default 3 check (trust_level between 1 and 5),
  tags text[] not null default '{}'::text[]
    check (content_engine_valid_tag_list(tags)),
  source_config jsonb not null default '{}'::jsonb
    check (jsonb_typeof(source_config) = 'object')
    check (not content_engine_json_has_forbidden_secret_key(source_config)),
  is_allowed boolean not null default true,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, slug),
  foreign key (workspace_id, created_by_user_id)
    references app_workspace_memberships(workspace_id, user_id)
    on delete restrict,
  check (source_url is not null or char_length(trim(reference_text)) > 0)
);

create table if not exists content_engine_model_presets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app_workspaces(id) on delete cascade,
  created_by_user_id uuid not null,
  slug text not null check (slug = lower(slug) and slug ~ '^[a-z0-9][a-z0-9-]{1,78}$'),
  name text not null check (char_length(trim(name)) between 2 and 160),
  provider text not null check (provider in ('openai', 'anthropic', 'google', 'xai', 'other')),
  model_id text not null
    check (model_id ~ '^[a-z0-9][a-z0-9-]*/[A-Za-z0-9][A-Za-z0-9._:-]{0,260}$')
    check (
      (provider = 'openai' and model_id like 'openai/%')
      or (provider = 'anthropic' and model_id like 'anthropic/%')
      or (provider = 'google' and model_id like 'google/%')
      or (provider = 'xai' and model_id like 'xai/%')
      or (provider = 'other' and model_id ~ '^(mistral|cohere|perplexity|deepseek|meta|amazon-bedrock)/')
    ),
  task_kinds text[] not null
    check (cardinality(task_kinds) between 1 and 5)
    check (task_kinds <@ array['writing', 'research', 'image', 'vision', 'summarization']::text[]),
  gateway_settings jsonb not null default '{}'::jsonb
    check (jsonb_typeof(gateway_settings) = 'object')
    check (not content_engine_json_has_forbidden_secret_key(gateway_settings)),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, slug),
  foreign key (workspace_id, created_by_user_id)
    references app_workspace_memberships(workspace_id, user_id)
    on delete restrict
);

create table if not exists content_engine_model_policies (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app_workspaces(id) on delete cascade,
  created_by_user_id uuid not null,
  slug text not null check (slug = lower(slug) and slug ~ '^[a-z0-9][a-z0-9-]{1,78}$'),
  name text not null check (char_length(trim(name)) between 2 and 160),
  task_kind text not null check (task_kind in ('writing', 'research', 'image', 'vision', 'summarization')),
  selection_mode text not null default 'primary_then_fallback'
    check (selection_mode in ('primary_then_fallback', 'quality_first', 'cost_aware', 'manual')),
  policy_config jsonb not null default '{}'::jsonb
    check (jsonb_typeof(policy_config) = 'object')
    check (not content_engine_json_has_forbidden_secret_key(policy_config)),
  active boolean not null default true,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, slug),
  foreign key (workspace_id, created_by_user_id)
    references app_workspace_memberships(workspace_id, user_id)
    on delete restrict
);

create table if not exists content_engine_model_policy_steps (
  workspace_id uuid not null references app_workspaces(id) on delete cascade,
  policy_id uuid not null,
  preset_id uuid not null,
  priority smallint not null check (priority between 1 and 20),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, policy_id, preset_id),
  unique (workspace_id, policy_id, priority),
  foreign key (workspace_id, policy_id)
    references content_engine_model_policies(workspace_id, id)
    on delete cascade,
  foreign key (workspace_id, preset_id)
    references content_engine_model_presets(workspace_id, id)
    on delete restrict
);

create table if not exists content_engine_recipes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app_workspaces(id) on delete cascade,
  created_by_user_id uuid not null,
  slug text not null check (slug = lower(slug) and slug ~ '^[a-z0-9][a-z0-9-]{1,78}$'),
  name text not null check (char_length(trim(name)) between 2 and 160),
  description text not null default '' check (char_length(description) <= 6000),
  content_type text not null check (content_type in ('newsletter', 'social_post', 'article', 'campaign')),
  brand_profile_id uuid,
  model_policy_id uuid,
  instructions text not null default '' check (char_length(instructions) <= 30000),
  rendering_config jsonb not null default '{}'::jsonb
    check (jsonb_typeof(rendering_config) = 'object')
    check (not content_engine_json_has_forbidden_secret_key(rendering_config)),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, slug),
  foreign key (workspace_id, created_by_user_id)
    references app_workspace_memberships(workspace_id, user_id)
    on delete restrict,
  foreign key (workspace_id, brand_profile_id)
    references content_engine_brand_profiles(workspace_id, id)
    on delete restrict,
  foreign key (workspace_id, model_policy_id)
    references content_engine_model_policies(workspace_id, id)
    on delete restrict
);

create table if not exists content_engine_recipe_sources (
  workspace_id uuid not null references app_workspaces(id) on delete cascade,
  recipe_id uuid not null,
  source_id uuid not null,
  purpose text not null default 'research'
    check (purpose in ('research', 'inspiration', 'fact_check', 'style')),
  priority smallint not null default 1 check (priority between 1 and 50),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, recipe_id, source_id),
  unique (workspace_id, recipe_id, priority),
  foreign key (workspace_id, recipe_id)
    references content_engine_recipes(workspace_id, id)
    on delete cascade,
  foreign key (workspace_id, source_id)
    references content_engine_sources(workspace_id, id)
    on delete restrict
);

create table if not exists content_engine_destinations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app_workspaces(id) on delete cascade,
  created_by_user_id uuid not null,
  slug text not null check (slug = lower(slug) and slug ~ '^[a-z0-9][a-z0-9-]{1,78}$'),
  name text not null check (char_length(trim(name)) between 2 and 160),
  destination_kind text not null check (destination_kind in ('newsletter', 'rss', 'social', 'website')),
  social_connection_id uuid,
  newsletter_audience_id uuid,
  destination_config jsonb not null default '{}'::jsonb
    check (jsonb_typeof(destination_config) = 'object')
    check (not content_engine_json_has_forbidden_secret_key(destination_config)),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, slug),
  foreign key (workspace_id, created_by_user_id)
    references app_workspace_memberships(workspace_id, user_id)
    on delete restrict,
  foreign key (workspace_id, social_connection_id)
    references social_connections(workspace_id, id)
    on delete restrict,
  foreign key (workspace_id, newsletter_audience_id)
    references newsletter_audiences(workspace_id, id)
    on delete restrict,
  check ((destination_kind = 'social') = (social_connection_id is not null)),
  check ((destination_kind = 'newsletter') = (newsletter_audience_id is not null)),
  check (
    destination_kind not in ('rss', 'website')
    or (
      trim(coalesce(destination_config ->> 'route', '')) ~ '^/'
      and trim(coalesce(destination_config ->> 'route', '')) !~ '^//'
      and position(chr(92) in trim(coalesce(destination_config ->> 'route', ''))) = 0
      and position(chr(10) in trim(coalesce(destination_config ->> 'route', ''))) = 0
      and position(chr(13) in trim(coalesce(destination_config ->> 'route', ''))) = 0
    )
    or (
      trim(coalesce(destination_config ->> 'target', '')) ~ '^/'
      and trim(coalesce(destination_config ->> 'target', '')) !~ '^//'
      and position(chr(92) in trim(coalesce(destination_config ->> 'target', ''))) = 0
      and position(chr(10) in trim(coalesce(destination_config ->> 'target', ''))) = 0
      and position(chr(13) in trim(coalesce(destination_config ->> 'target', ''))) = 0
    )
    or (
      trim(coalesce(destination_config ->> 'targetUrl', '')) ~ '^https://'
      and trim(coalesce(destination_config ->> 'targetUrl', '')) !~ '^https://[^/]*@'
    )
  )
);

create table if not exists content_engine_distribution_rules (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app_workspaces(id) on delete cascade,
  created_by_user_id uuid not null,
  slug text not null check (slug = lower(slug) and slug ~ '^[a-z0-9][a-z0-9-]{1,78}$'),
  name text not null check (char_length(trim(name)) between 2 and 160),
  recipe_id uuid not null,
  destination_id uuid not null,
  delivery_mode text not null default 'manual' check (delivery_mode in ('manual', 'scheduled', 'event')),
  schedule_config jsonb not null default '{}'::jsonb
    check (jsonb_typeof(schedule_config) = 'object')
    check (not content_engine_json_has_forbidden_secret_key(schedule_config)),
  approval_required boolean not null default true,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, slug),
  foreign key (workspace_id, created_by_user_id)
    references app_workspace_memberships(workspace_id, user_id)
    on delete restrict,
  foreign key (workspace_id, recipe_id)
    references content_engine_recipes(workspace_id, id)
    on delete restrict,
  foreign key (workspace_id, destination_id)
    references content_engine_destinations(workspace_id, id)
    on delete restrict,
  check (delivery_mode <> 'scheduled' or schedule_config <> '{}'::jsonb)
);

-- A foreign key proves ownership, not usability. Keep direct SQL imports from
-- attaching an inactive account or audience that the application would refuse.
create or replace function content_engine_validate_destination_reference()
returns trigger
language plpgsql
as $$
begin
  if new.destination_kind = 'social' and not exists (
    select 1
      from social_connections connection
     where connection.workspace_id = new.workspace_id
       and connection.id = new.social_connection_id
       and connection.state = 'active'
       and connection.last_verified_at is not null
  ) then
    raise exception 'content_engine social destination needs an active, verified connection'
      using errcode = '23514';
  end if;

  if new.destination_kind = 'newsletter' and not exists (
    select 1
      from newsletter_audiences audience
     where audience.workspace_id = new.workspace_id
       and audience.id = new.newsletter_audience_id
       and audience.active = true
  ) then
    raise exception 'content_engine newsletter destination needs an active audience'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists content_engine_destinations_validate_reference on content_engine_destinations;
create trigger content_engine_destinations_validate_reference
before insert or update of workspace_id, destination_kind, social_connection_id, newsletter_audience_id
on content_engine_destinations
for each row execute function content_engine_validate_destination_reference();

-- Exactly one default brand profile is allowed per workspace, and exactly one
-- default model policy per task. The trigger safely demotes the old default
-- in the same database transaction before the unique index is checked.
create unique index if not exists content_engine_brand_profiles_default_idx
  on content_engine_brand_profiles (workspace_id)
  where is_default;
create unique index if not exists content_engine_model_policies_default_idx
  on content_engine_model_policies (workspace_id, task_kind)
  where is_default;
create unique index if not exists content_engine_sources_workspace_url_idx
  on content_engine_sources (workspace_id, source_url)
  where source_url is not null;

create index if not exists content_engine_brand_profiles_workspace_active_idx
  on content_engine_brand_profiles (workspace_id, active, updated_at desc);
create index if not exists content_engine_sources_workspace_allowed_idx
  on content_engine_sources (workspace_id, is_allowed, active, updated_at desc);
create index if not exists content_engine_model_presets_workspace_enabled_idx
  on content_engine_model_presets (workspace_id, enabled, updated_at desc);
create index if not exists content_engine_model_policies_workspace_task_idx
  on content_engine_model_policies (workspace_id, task_kind, active, updated_at desc);
create index if not exists content_engine_model_policy_steps_preset_idx
  on content_engine_model_policy_steps (workspace_id, preset_id);
create index if not exists content_engine_recipes_workspace_active_idx
  on content_engine_recipes (workspace_id, active, updated_at desc);
create index if not exists content_engine_recipe_sources_source_idx
  on content_engine_recipe_sources (workspace_id, source_id);
create index if not exists content_engine_destinations_workspace_active_idx
  on content_engine_destinations (workspace_id, active, updated_at desc);
create index if not exists content_engine_distribution_rules_workspace_active_idx
  on content_engine_distribution_rules (workspace_id, active, delivery_mode, updated_at desc);

create or replace function content_engine_demote_default_brand_profile()
returns trigger
language plpgsql
as $$
begin
  if new.is_default then
    update content_engine_brand_profiles
       set is_default = false
     where workspace_id = new.workspace_id
       and id <> new.id
       and is_default = true;
  end if;
  return new;
end;
$$;

create or replace function content_engine_demote_default_model_policy()
returns trigger
language plpgsql
as $$
begin
  if new.is_default then
    update content_engine_model_policies
       set is_default = false
     where workspace_id = new.workspace_id
       and task_kind = new.task_kind
       and id <> new.id
       and is_default = true;
  end if;
  return new;
end;
$$;

-- The link replacement functions deliberately validate every referenced row
-- in the same SQL operation. A source/preset from another workspace can never
-- be linked by a stale browser tab, and an invalid request cannot leave a
-- partially replaced list behind.
create or replace function content_engine_replace_recipe_sources(
  target_workspace_id uuid,
  target_recipe_id uuid,
  requested_source_ids jsonb
)
returns void
language plpgsql
as $$
declare
  requested_count integer;
  valid_count integer;
begin
  if jsonb_typeof(requested_source_ids) <> 'array' or jsonb_array_length(requested_source_ids) > 50 then
    raise exception 'content_engine_recipe_sources must contain at most 50 entries';
  end if;

  if exists (
    select 1
      from jsonb_array_elements_text(requested_source_ids) as source_value(value)
     where source_value.value !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ) then
    raise exception 'content_engine_recipe_sources contains an invalid UUID';
  end if;

  select count(*), count(distinct source_value.value)
    into requested_count, valid_count
    from jsonb_array_elements_text(requested_source_ids) as source_value(value);
  if requested_count <> valid_count then
    raise exception 'content_engine_recipe_sources contains duplicate source IDs';
  end if;

  if not exists (
    select 1 from content_engine_recipes
     where workspace_id = target_workspace_id and id = target_recipe_id
  ) then
    raise exception 'content_engine_recipe does not exist in this workspace';
  end if;

  select count(*) into valid_count
    from content_engine_sources source
    join jsonb_array_elements_text(requested_source_ids) requested(source_id)
      on source.id::text = requested.source_id
   where source.workspace_id = target_workspace_id
     and source.is_allowed = true
     and source.active = true;
  if valid_count <> requested_count then
    raise exception 'Every recipe source must be an active allowed source in the same workspace';
  end if;

  delete from content_engine_recipe_sources
   where workspace_id = target_workspace_id and recipe_id = target_recipe_id;

  insert into content_engine_recipe_sources (workspace_id, recipe_id, source_id, priority)
  select target_workspace_id, target_recipe_id, requested.source_id::uuid, requested.ordinality::smallint
    from jsonb_array_elements_text(requested_source_ids) with ordinality as requested(source_id, ordinality);
end;
$$;

create or replace function content_engine_replace_model_policy_steps(
  target_workspace_id uuid,
  target_policy_id uuid,
  requested_steps jsonb
)
returns void
language plpgsql
as $$
declare
  requested_count integer;
  distinct_presets integer;
  distinct_priorities integer;
  valid_count integer;
begin
  if jsonb_typeof(requested_steps) <> 'array' or jsonb_array_length(requested_steps) = 0 or jsonb_array_length(requested_steps) > 20 then
    raise exception 'content_engine_model_policy_steps must contain between one and 20 entries';
  end if;

  if exists (
    select 1
      from jsonb_array_elements(requested_steps) as step(value)
     where jsonb_typeof(step.value) <> 'object'
        or not (step.value ? 'presetId')
        or not (step.value ? 'priority')
        or (step.value ->> 'presetId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        or (step.value ->> 'priority') !~ '^[0-9]{1,2}$'
        or (step.value ->> 'priority')::integer not between 1 and 20
        or (step.value ? 'enabled' and (step.value ->> 'enabled') not in ('true', 'false'))
  ) then
    raise exception 'content_engine_model_policy_steps contains an invalid step';
  end if;

  select count(*), count(distinct step.value ->> 'presetId'), count(distinct (step.value ->> 'priority')::integer)
    into requested_count, distinct_presets, distinct_priorities
    from jsonb_array_elements(requested_steps) as step(value);
  if requested_count <> distinct_presets or requested_count <> distinct_priorities then
    raise exception 'content_engine_model_policy_steps has duplicate presets or priorities';
  end if;

  if not exists (
    select 1 from content_engine_model_policies
     where workspace_id = target_workspace_id and id = target_policy_id
  ) then
    raise exception 'content_engine_model_policy does not exist in this workspace';
  end if;

  select count(*) into valid_count
    from content_engine_model_presets preset
    join content_engine_model_policies policy
      on policy.workspace_id = preset.workspace_id and policy.id = target_policy_id
   join jsonb_array_elements(requested_steps) as step(value)
      on preset.id::text = step.value ->> 'presetId'
   where preset.workspace_id = target_workspace_id
     and policy.task_kind = any(preset.task_kinds);
  if valid_count <> requested_count then
    raise exception 'Every model policy step must use a compatible preset in the same workspace';
  end if;

  delete from content_engine_model_policy_steps
   where workspace_id = target_workspace_id and policy_id = target_policy_id;

  insert into content_engine_model_policy_steps (workspace_id, policy_id, preset_id, priority, enabled)
  select
    target_workspace_id,
    target_policy_id,
    (step.value ->> 'presetId')::uuid,
    (step.value ->> 'priority')::smallint,
    coalesce((step.value ->> 'enabled')::boolean, true)
  from jsonb_array_elements(requested_steps) as step(value);
end;
$$;

drop trigger if exists content_engine_brand_profiles_set_updated_at on content_engine_brand_profiles;
create trigger content_engine_brand_profiles_set_updated_at
before update on content_engine_brand_profiles
for each row execute function app_set_updated_at();

drop trigger if exists content_engine_sources_set_updated_at on content_engine_sources;
create trigger content_engine_sources_set_updated_at
before update on content_engine_sources
for each row execute function app_set_updated_at();

drop trigger if exists content_engine_model_presets_set_updated_at on content_engine_model_presets;
create trigger content_engine_model_presets_set_updated_at
before update on content_engine_model_presets
for each row execute function app_set_updated_at();

drop trigger if exists content_engine_model_policies_set_updated_at on content_engine_model_policies;
create trigger content_engine_model_policies_set_updated_at
before update on content_engine_model_policies
for each row execute function app_set_updated_at();

drop trigger if exists content_engine_model_policy_steps_set_updated_at on content_engine_model_policy_steps;
create trigger content_engine_model_policy_steps_set_updated_at
before update on content_engine_model_policy_steps
for each row execute function app_set_updated_at();

drop trigger if exists content_engine_recipes_set_updated_at on content_engine_recipes;
create trigger content_engine_recipes_set_updated_at
before update on content_engine_recipes
for each row execute function app_set_updated_at();

drop trigger if exists content_engine_recipe_sources_set_updated_at on content_engine_recipe_sources;
create trigger content_engine_recipe_sources_set_updated_at
before update on content_engine_recipe_sources
for each row execute function app_set_updated_at();

drop trigger if exists content_engine_destinations_set_updated_at on content_engine_destinations;
create trigger content_engine_destinations_set_updated_at
before update on content_engine_destinations
for each row execute function app_set_updated_at();

drop trigger if exists content_engine_distribution_rules_set_updated_at on content_engine_distribution_rules;
create trigger content_engine_distribution_rules_set_updated_at
before update on content_engine_distribution_rules
for each row execute function app_set_updated_at();

drop trigger if exists content_engine_brand_profiles_demote_default on content_engine_brand_profiles;
create trigger content_engine_brand_profiles_demote_default
before insert or update of is_default on content_engine_brand_profiles
for each row execute function content_engine_demote_default_brand_profile();

drop trigger if exists content_engine_model_policies_demote_default on content_engine_model_policies;
create trigger content_engine_model_policies_demote_default
before insert or update of is_default, task_kind on content_engine_model_policies
for each row execute function content_engine_demote_default_model_policy();

commit;
