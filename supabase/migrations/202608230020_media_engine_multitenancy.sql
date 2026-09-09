-- Media engine V1 is a workspace product.  The existing personal Brief and
-- Content Studio tables deliberately remain user-owned; this migration adds a
-- tenant boundary around the research-to-content pipeline without attempting a
-- destructive ownership rewrite.
--
-- Credentials are represented only by an opaque server-managed `credential_ref`.
-- No browser-facing policy grants access to it and application routes return a
-- boolean (`hasCredential`) instead of the reference.

create or replace function public.media_text_array_is_valid(p_values text[], p_allowed text[] default null)
returns boolean
language sql
immutable
set search_path = public
as $$
  select p_values is not null
    and array_position(p_values, null) is null
    and cardinality(p_values) = (select count(distinct value) from unnest(p_values) as entry(value))
    and (p_allowed is null or p_values <@ p_allowed);
$$;

create table if not exists public.media_tenants (
  id uuid primary key default gen_random_uuid(),
  slug text not null check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' and char_length(slug) between 3 and 80),
  name text not null check (char_length(btrim(name)) between 2 and 160),
  -- V1 has no ownership-transfer workflow yet.  Cascading avoids orphaned
  -- tenants (and a blocked auth-user deletion) when an owner is removed.
  owner_user_id uuid not null references public.profiles(user_id) on delete cascade,
  timezone text not null default 'Europe/Stockholm' check (char_length(timezone) between 3 and 80),
  is_default boolean not null default false,
  settings jsonb not null default '{}'::jsonb check (jsonb_typeof(settings) = 'object'),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (slug)
);
create unique index if not exists media_tenants_one_default_per_owner_idx
  on public.media_tenants(owner_user_id) where is_default;

create table if not exists public.media_tenant_members (
  tenant_id uuid not null references public.media_tenants(id) on delete cascade,
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'editor', 'viewer')),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (tenant_id, user_id)
);
create unique index if not exists media_tenant_members_single_owner_idx
  on public.media_tenant_members(tenant_id) where role = 'owner';
create index if not exists media_tenant_members_user_idx
  on public.media_tenant_members(user_id, tenant_id);

-- A source describes a connector configuration, never the underlying secret.
-- `config_public` is intentionally limited to display/sync configuration; API
-- tokens and OAuth material belong in a server secret store referenced here.
create table if not exists public.media_source_connections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.media_tenants(id) on delete cascade,
  kind text not null check (kind in ('rss', 'api', 'webhook', 'manual', 'web_search')),
  provider text not null check (char_length(btrim(provider)) between 2 and 120),
  display_name text not null check (char_length(btrim(display_name)) between 2 and 160),
  base_url text check (char_length(base_url) between 8 and 2000),
  config_public jsonb not null default '{}'::jsonb check (jsonb_typeof(config_public) = 'object'),
  -- V1 resolves only a server environment-variable reference.  A raw API key
  -- cannot be persisted through this table or posted from the browser.
  credential_ref text check (credential_ref is null or credential_ref ~ '^MEDIA_ENGINE_API_TOKEN_[A-Z][A-Z0-9_]{1,80}$'),
  active boolean not null default true,
  sync_interval_minutes integer not null default 60 check (sync_interval_minutes between 5 and 10080),
  last_synced_at timestamptz,
  last_error text check (last_error is null or char_length(last_error) <= 4000),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);
create index if not exists media_source_connections_tenant_active_idx
  on public.media_source_connections(tenant_id, active, updated_at desc);

-- A threshold rule answers: when enough independent sources mention the same
-- thing, should the engine create a researched, transparent content proposal?
create table if not exists public.media_research_rules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.media_tenants(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 2 and 160),
  active boolean not null default true,
  query text not null check (char_length(btrim(query)) between 2 and 4000),
  include_domains text[] not null default array[]::text[] check (
    array_position(include_domains, null) is null and cardinality(include_domains) <= 100
  ),
  exclude_domains text[] not null default array[]::text[] check (
    array_position(exclude_domains, null) is null and cardinality(exclude_domains) <= 100
  ),
  min_mentions smallint not null default 3 check (min_mentions between 1 and 100),
  min_unique_domains smallint not null default 2 check (min_unique_domains between 1 and 50),
  window_hours integer not null default 72 check (window_hours between 1 and 8760),
  content_type text not null default 'social_post' check (content_type in ('social_post', 'newsletter', 'article')),
  channels text[] not null default array['linkedin']::text[] check (
    public.media_text_array_is_valid(channels, array['facebook_page', 'instagram', 'linkedin', 'newsletter']::text[])
    and cardinality(channels) between 1 and 4
  ),
  framework_key text not null default 'transparent-analysis' check (char_length(btrim(framework_key)) between 2 and 120),
  image_style text not null default 'editorial' check (char_length(btrim(image_style)) between 2 and 240),
  prompt text not null default '' check (char_length(prompt) <= 12000),
  schedule_mode text not null default 'threshold' check (schedule_mode in ('threshold', 'cron')),
  cadence text not null default 'hourly' check (cadence in ('continuous', 'hourly', 'daily', 'weekly', 'cron')),
  cron_expression text check (cron_expression is null or char_length(btrim(cron_expression)) between 9 and 160),
  next_run_at timestamptz,
  last_run_at timestamptz,
  last_checked_at timestamptz,
  approval_required boolean not null default true,
  auto_create_handoff boolean not null default true,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint media_research_rules_schedule_shape_check check (
    (schedule_mode = 'threshold' and cron_expression is null)
    or (schedule_mode = 'cron' and cron_expression is not null)
  ),
  constraint media_research_rules_newsletter_channel_check check (
    (content_type = 'newsletter' and channels = array['newsletter']::text[])
    or (content_type <> 'newsletter' and not ('newsletter' = any(channels)))
  )
);
create index if not exists media_research_rules_tenant_due_idx
  on public.media_research_rules(tenant_id, active, next_run_at);

create table if not exists public.media_research_rule_sources (
  tenant_id uuid not null references public.media_tenants(id) on delete cascade,
  rule_id uuid not null references public.media_research_rules(id) on delete cascade,
  source_connection_id uuid not null references public.media_source_connections(id) on delete cascade,
  created_at timestamptz not null default timezone('utc', now()),
  primary key (rule_id, source_connection_id)
);
create index if not exists media_research_rule_sources_source_idx
  on public.media_research_rule_sources(source_connection_id, rule_id);

create table if not exists public.media_research_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.media_tenants(id) on delete cascade,
  rule_id uuid not null references public.media_research_rules(id) on delete cascade,
  trigger_kind text not null check (trigger_kind in ('manual', 'scheduled')),
  idempotency_key uuid not null,
  state text not null default 'queued' check (state in ('queued', 'running', 'completed', 'failed')),
  phase text not null default 'discovery' check (phase in ('discovery', 'clustering', 'research', 'handoff', 'complete', 'failed')),
  started_at timestamptz,
  finished_at timestamptz,
  candidate_count integer not null default 0 check (candidate_count >= 0),
  cluster_count integer not null default 0 check (cluster_count >= 0),
  handoff_count integer not null default 0 check (handoff_count >= 0),
  token_metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(token_metadata) = 'object'),
  search_metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(search_metadata) = 'object'),
  error_message text check (error_message is null or char_length(error_message) <= 4000),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (tenant_id, rule_id, idempotency_key),
  constraint media_research_runs_terminal_shape_check check (
    (state in ('queued', 'running') and finished_at is null)
    or (state in ('completed', 'failed') and finished_at is not null)
  )
);
create index if not exists media_research_runs_tenant_created_idx
  on public.media_research_runs(tenant_id, created_at desc);
create index if not exists media_research_runs_due_idx
  on public.media_research_runs(state, created_at)
  where state in ('queued', 'running');

-- The item table holds one fetched item.  A null source_connection_id means a
-- built-in provider such as OpenAI web search produced it.  The canonical URL
-- is idempotent per tenant; a content hash helps the worker spot copied text
-- without treating it as a cross-tenant global identity.
create table if not exists public.media_research_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.media_tenants(id) on delete cascade,
  source_connection_id uuid references public.media_source_connections(id) on delete set null,
  external_id text check (external_id is null or char_length(external_id) between 1 and 512),
  canonical_url text not null check (char_length(canonical_url) between 8 and 2000),
  title text not null check (char_length(btrim(title)) between 3 and 500),
  summary text not null default '' check (char_length(summary) <= 8000),
  content_text text check (content_text is null or char_length(content_text) <= 250000),
  content_hash text check (content_hash is null or content_hash ~ '^[a-f0-9]{64}$'),
  source_name text not null check (char_length(btrim(source_name)) between 2 and 240),
  source_type text not null check (source_type in ('primary', 'secondary', 'rss', 'api', 'web_search')),
  source_domain text not null check (char_length(btrim(source_domain)) between 1 and 255),
  published_at timestamptz,
  event_date timestamptz,
  fetched_at timestamptz not null default timezone('utc', now()),
  raw_metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(raw_metadata) = 'object'),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);
create unique index if not exists media_research_items_tenant_canonical_url_idx
  on public.media_research_items(tenant_id, canonical_url);
create unique index if not exists media_research_items_source_external_idx
  on public.media_research_items(tenant_id, source_connection_id, external_id)
  where source_connection_id is not null and external_id is not null;
create index if not exists media_research_items_tenant_hash_idx
  on public.media_research_items(tenant_id, content_hash)
  where content_hash is not null;
create index if not exists media_research_items_tenant_domain_idx
  on public.media_research_items(tenant_id, source_domain, published_at desc);

create table if not exists public.media_research_clusters (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.media_tenants(id) on delete cascade,
  canonical_key text not null check (char_length(btrim(canonical_key)) between 3 and 280),
  title text not null check (char_length(btrim(title)) between 3 and 500),
  status text not null default 'pending' check (status in ('pending', 'researching', 'ready', 'dismissed', 'published')),
  mention_count integer not null default 0 check (mention_count >= 0),
  unique_domain_count integer not null default 0 check (unique_domain_count >= 0),
  significance_score smallint check (significance_score between 0 and 100),
  first_seen_at timestamptz not null default timezone('utc', now()),
  last_seen_at timestamptz not null default timezone('utc', now()),
  summary text check (summary is null or char_length(summary) <= 8000),
  framework_key text check (framework_key is null or char_length(framework_key) <= 120),
  image_brief text check (image_brief is null or char_length(image_brief) <= 1500),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (tenant_id, canonical_key)
);
create index if not exists media_research_clusters_tenant_status_idx
  on public.media_research_clusters(tenant_id, status, last_seen_at desc);

create table if not exists public.media_research_cluster_items (
  tenant_id uuid not null references public.media_tenants(id) on delete cascade,
  cluster_id uuid not null references public.media_research_clusters(id) on delete cascade,
  item_id uuid not null references public.media_research_items(id) on delete cascade,
  created_at timestamptz not null default timezone('utc', now()),
  primary key (cluster_id, item_id)
);
create index if not exists media_research_cluster_items_item_idx
  on public.media_research_cluster_items(item_id, cluster_id);

create table if not exists public.media_research_evidence (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.media_tenants(id) on delete cascade,
  cluster_id uuid not null references public.media_research_clusters(id) on delete cascade,
  item_id uuid references public.media_research_items(id) on delete set null,
  source_name text not null check (char_length(btrim(source_name)) between 2 and 240),
  source_url text not null check (char_length(source_url) between 8 and 2000),
  source_domain text not null check (char_length(btrim(source_domain)) between 1 and 255),
  source_type text not null check (source_type in ('primary', 'secondary', 'rss', 'api', 'web_search')),
  published_at timestamptz,
  event_date timestamptz,
  claim text not null check (char_length(btrim(claim)) between 8 and 2000),
  stance text not null default 'supports' check (stance in ('supports', 'conflicts', 'context')),
  quote text check (quote is null or char_length(quote) <= 2000),
  confidence smallint not null default 50 check (confidence between 0 and 100),
  created_at timestamptz not null default timezone('utc', now()),
  unique (cluster_id, source_url, claim)
);
create index if not exists media_research_evidence_cluster_idx
  on public.media_research_evidence(cluster_id, created_at desc);

-- A cluster is detection state.  Its dossier is the current, transparent
-- editorial reasoning: known/unknown, uncertainty, conflict and source-backed
-- angle are separated so generated copy cannot quietly pose as a fact.
create table if not exists public.media_research_dossiers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.media_tenants(id) on delete cascade,
  cluster_id uuid not null references public.media_research_clusters(id) on delete cascade,
  status text not null default 'draft' check (status in ('draft', 'ready', 'failed')),
  what_we_know jsonb not null default '[]'::jsonb check (jsonb_typeof(what_we_know) = 'array'),
  what_we_dont_know jsonb not null default '[]'::jsonb check (jsonb_typeof(what_we_dont_know) = 'array'),
  why_it_matters text not null default '' check (char_length(why_it_matters) <= 1500),
  suggested_angle text not null default '' check (char_length(suggested_angle) <= 900),
  transparent_reflection text not null default '' check (char_length(transparent_reflection) <= 5000),
  uncertainties jsonb not null default '[]'::jsonb check (jsonb_typeof(uncertainties) = 'array'),
  conflicts jsonb not null default '[]'::jsonb check (jsonb_typeof(conflicts) = 'array'),
  source_synthesis text not null default '' check (char_length(source_synthesis) <= 5000),
  structured_data jsonb not null default '{}'::jsonb check (jsonb_typeof(structured_data) = 'object'),
  evidence_count integer not null default 0 check (evidence_count >= 0),
  model_name text check (model_name is null or char_length(model_name) <= 160),
  model_metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(model_metadata) = 'object'),
  generated_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (cluster_id)
);
create index if not exists media_research_dossiers_tenant_updated_idx
  on public.media_research_dossiers(tenant_id, updated_at desc);

-- The handoff is the only link to legacy Content Studio.  The database checks
-- that a linked draft belongs to a member of the same tenant.  It is not a
-- publication command: publishing remains in the existing provider layer.
create table if not exists public.media_content_handoffs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.media_tenants(id) on delete cascade,
  cluster_id uuid not null references public.media_research_clusters(id) on delete cascade,
  run_id uuid references public.media_research_runs(id) on delete set null,
  content_draft_id uuid references public.content_drafts(id) on delete set null,
  state text not null default 'queued' check (state in ('queued', 'drafted', 'in_review', 'approved', 'scheduled', 'published', 'rejected', 'failed')),
  draft_idempotency_key uuid,
  draft_snapshot jsonb not null default '{}'::jsonb check (jsonb_typeof(draft_snapshot) = 'object'),
  scheduled_for timestamptz,
  created_by uuid references public.profiles(user_id) on delete set null,
  approved_by uuid references public.profiles(user_id) on delete set null,
  approved_at timestamptz,
  failure_reason text check (failure_reason is null or char_length(failure_reason) <= 4000),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (cluster_id),
  constraint media_content_handoffs_schedule_shape_check check (
    state <> 'scheduled' or scheduled_for is not null
  )
);
create unique index if not exists media_content_handoffs_draft_idx
  on public.media_content_handoffs(content_draft_id) where content_draft_id is not null;
create unique index if not exists media_content_handoffs_draft_idempotency_idx
  on public.media_content_handoffs(tenant_id, draft_idempotency_key) where draft_idempotency_key is not null;
create index if not exists media_content_handoffs_tenant_state_idx
  on public.media_content_handoffs(tenant_id, state, updated_at desc);

create table if not exists public.media_content_handoff_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.media_tenants(id) on delete cascade,
  handoff_id uuid not null references public.media_content_handoffs(id) on delete cascade,
  actor_user_id uuid references public.profiles(user_id) on delete set null,
  from_state text check (from_state is null or from_state in ('queued', 'drafted', 'in_review', 'approved', 'scheduled', 'published', 'rejected', 'failed')),
  to_state text not null check (to_state in ('queued', 'drafted', 'in_review', 'approved', 'scheduled', 'published', 'rejected', 'failed')),
  note text check (note is null or char_length(note) <= 2000),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default timezone('utc', now())
);
create index if not exists media_content_handoff_events_handoff_idx
  on public.media_content_handoff_events(handoff_id, created_at desc);

-- Tenant-scoped foreign-key checks.  A normal FK cannot express "both records
-- belong to the same tenant", so the trigger layer makes cross-tenant joins a
-- database error even when a trusted service-role route makes a mistake.
create or replace function public.validate_media_tenant_member()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
begin
  select owner_user_id into v_owner from public.media_tenants where id = new.tenant_id;
  if v_owner is null then
    raise exception 'Media tenant does not exist';
  end if;
  if tg_op = 'UPDATE' and old.role = 'owner' and (new.role <> 'owner' or new.user_id <> old.user_id) then
    raise exception 'The tenant owner membership cannot be changed in V1';
  end if;
  if new.role = 'owner' and new.user_id <> v_owner then
    raise exception 'Only the tenant owner may have the owner role';
  end if;
  return new;
end;
$$;

create or replace function public.prevent_media_tenant_owner_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.owner_user_id is distinct from old.owner_user_id then
    raise exception 'Media tenant ownership cannot be reassigned in V1';
  end if;
  return new;
end;
$$;

create or replace function public.validate_media_research_rule_source_scope()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rule_tenant uuid;
  v_source_tenant uuid;
begin
  select tenant_id into v_rule_tenant from public.media_research_rules where id = new.rule_id;
  select tenant_id into v_source_tenant from public.media_source_connections where id = new.source_connection_id;
  if v_rule_tenant is null or v_source_tenant is null or new.tenant_id <> v_rule_tenant or new.tenant_id <> v_source_tenant then
    raise exception 'Rule and source must belong to the same media tenant';
  end if;
  return new;
end;
$$;

create or replace function public.validate_media_research_run_scope()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_rule_tenant uuid;
begin
  select tenant_id into v_rule_tenant from public.media_research_rules where id = new.rule_id;
  if v_rule_tenant is null or v_rule_tenant <> new.tenant_id then
    raise exception 'Research run must belong to its rule tenant';
  end if;
  return new;
end;
$$;

create or replace function public.validate_media_research_item_scope()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_source_tenant uuid;
begin
  if new.source_connection_id is null then return new; end if;
  select tenant_id into v_source_tenant from public.media_source_connections where id = new.source_connection_id;
  if v_source_tenant is null or v_source_tenant <> new.tenant_id then
    raise exception 'Research item source must belong to the same media tenant';
  end if;
  return new;
end;
$$;

create or replace function public.validate_media_cluster_item_scope()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cluster_tenant uuid;
  v_item_tenant uuid;
begin
  select tenant_id into v_cluster_tenant from public.media_research_clusters where id = new.cluster_id;
  select tenant_id into v_item_tenant from public.media_research_items where id = new.item_id;
  if v_cluster_tenant is null or v_item_tenant is null or new.tenant_id <> v_cluster_tenant or new.tenant_id <> v_item_tenant then
    raise exception 'Cluster and item must belong to the same media tenant';
  end if;
  return new;
end;
$$;

create or replace function public.validate_media_evidence_scope()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cluster_tenant uuid;
  v_item_tenant uuid;
begin
  select tenant_id into v_cluster_tenant from public.media_research_clusters where id = new.cluster_id;
  if v_cluster_tenant is null or v_cluster_tenant <> new.tenant_id then
    raise exception 'Evidence cluster must belong to the same media tenant';
  end if;
  if new.item_id is not null then
    select tenant_id into v_item_tenant from public.media_research_items where id = new.item_id;
    if v_item_tenant is null or v_item_tenant <> new.tenant_id then
      raise exception 'Evidence item must belong to the same media tenant';
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.validate_media_dossier_scope()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_cluster_tenant uuid;
begin
  select tenant_id into v_cluster_tenant from public.media_research_clusters where id = new.cluster_id;
  if v_cluster_tenant is null or v_cluster_tenant <> new.tenant_id then
    raise exception 'Dossier cluster must belong to the same media tenant';
  end if;
  return new;
end;
$$;

create or replace function public.validate_media_content_handoff_scope()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cluster_tenant uuid;
  v_run_tenant uuid;
  v_draft_owner uuid;
begin
  select tenant_id into v_cluster_tenant from public.media_research_clusters where id = new.cluster_id;
  if v_cluster_tenant is null or v_cluster_tenant <> new.tenant_id then
    raise exception 'Content handoff cluster must belong to the same media tenant';
  end if;
  if new.run_id is not null then
    select tenant_id into v_run_tenant from public.media_research_runs where id = new.run_id;
    if v_run_tenant is null or v_run_tenant <> new.tenant_id then
      raise exception 'Content handoff run must belong to the same media tenant';
    end if;
  end if;
  if new.content_draft_id is not null then
    select user_id into v_draft_owner from public.content_drafts where id = new.content_draft_id;
    if v_draft_owner is null or not exists (
      select 1 from public.media_tenant_members m
      where m.tenant_id = new.tenant_id and m.user_id = v_draft_owner
    ) then
      raise exception 'Linked content draft must belong to a member of the media tenant';
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.validate_media_content_handoff_event_scope()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_handoff_tenant uuid;
begin
  select tenant_id into v_handoff_tenant from public.media_content_handoffs where id = new.handoff_id;
  if v_handoff_tenant is null or v_handoff_tenant <> new.tenant_id then
    raise exception 'Content handoff event must belong to the same media tenant';
  end if;
  if new.actor_user_id is not null and not exists (
    select 1 from public.media_tenant_members m
    where m.tenant_id = new.tenant_id and m.user_id = new.actor_user_id
  ) then
    raise exception 'Content handoff actor must be a media tenant member';
  end if;
  return new;
end;
$$;

drop trigger if exists media_tenants_updated_at on public.media_tenants;
create trigger media_tenants_updated_at before update on public.media_tenants
for each row execute function public.set_updated_at();
drop trigger if exists media_tenants_owner_immutable on public.media_tenants;
create trigger media_tenants_owner_immutable before update on public.media_tenants
for each row execute function public.prevent_media_tenant_owner_change();
drop trigger if exists media_tenant_members_updated_at on public.media_tenant_members;
create trigger media_tenant_members_updated_at before update on public.media_tenant_members
for each row execute function public.set_updated_at();
drop trigger if exists media_tenant_members_scope on public.media_tenant_members;
create trigger media_tenant_members_scope before insert or update on public.media_tenant_members
for each row execute function public.validate_media_tenant_member();

drop trigger if exists media_source_connections_updated_at on public.media_source_connections;
create trigger media_source_connections_updated_at before update on public.media_source_connections
for each row execute function public.set_updated_at();
drop trigger if exists media_research_rules_updated_at on public.media_research_rules;
create trigger media_research_rules_updated_at before update on public.media_research_rules
for each row execute function public.set_updated_at();
drop trigger if exists media_research_runs_updated_at on public.media_research_runs;
create trigger media_research_runs_updated_at before update on public.media_research_runs
for each row execute function public.set_updated_at();
drop trigger if exists media_research_items_updated_at on public.media_research_items;
create trigger media_research_items_updated_at before update on public.media_research_items
for each row execute function public.set_updated_at();
drop trigger if exists media_research_clusters_updated_at on public.media_research_clusters;
create trigger media_research_clusters_updated_at before update on public.media_research_clusters
for each row execute function public.set_updated_at();
drop trigger if exists media_research_dossiers_updated_at on public.media_research_dossiers;
create trigger media_research_dossiers_updated_at before update on public.media_research_dossiers
for each row execute function public.set_updated_at();
drop trigger if exists media_content_handoffs_updated_at on public.media_content_handoffs;
create trigger media_content_handoffs_updated_at before update on public.media_content_handoffs
for each row execute function public.set_updated_at();

drop trigger if exists media_research_rule_sources_scope on public.media_research_rule_sources;
create trigger media_research_rule_sources_scope before insert or update on public.media_research_rule_sources
for each row execute function public.validate_media_research_rule_source_scope();
drop trigger if exists media_research_runs_scope on public.media_research_runs;
create trigger media_research_runs_scope before insert or update on public.media_research_runs
for each row execute function public.validate_media_research_run_scope();
drop trigger if exists media_research_items_scope on public.media_research_items;
create trigger media_research_items_scope before insert or update on public.media_research_items
for each row execute function public.validate_media_research_item_scope();
drop trigger if exists media_research_cluster_items_scope on public.media_research_cluster_items;
create trigger media_research_cluster_items_scope before insert or update on public.media_research_cluster_items
for each row execute function public.validate_media_cluster_item_scope();
drop trigger if exists media_research_evidence_scope on public.media_research_evidence;
create trigger media_research_evidence_scope before insert or update on public.media_research_evidence
for each row execute function public.validate_media_evidence_scope();
drop trigger if exists media_research_dossiers_scope on public.media_research_dossiers;
create trigger media_research_dossiers_scope before insert or update on public.media_research_dossiers
for each row execute function public.validate_media_dossier_scope();
drop trigger if exists media_content_handoffs_scope on public.media_content_handoffs;
create trigger media_content_handoffs_scope before insert or update on public.media_content_handoffs
for each row execute function public.validate_media_content_handoff_scope();
drop trigger if exists media_content_handoff_events_scope on public.media_content_handoff_events;
create trigger media_content_handoff_events_scope before insert or update on public.media_content_handoff_events
for each row execute function public.validate_media_content_handoff_event_scope();

-- Deterministic bootstrap for existing single-user profiles and new users.
-- The advisory lock makes concurrent first requests return the same default
-- workspace instead of racing into a duplicate setup or a fake client fallback.
create or replace function public.create_media_tenant(
  p_owner_user_id uuid,
  p_name text,
  p_slug text,
  p_timezone text default 'Europe/Stockholm',
  p_is_default boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare v_tenant_id uuid;
begin
  if p_owner_user_id is null or not exists (select 1 from public.profiles where user_id = p_owner_user_id) then
    raise exception 'A media tenant needs an existing profile owner';
  end if;
  if p_slug !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' or char_length(p_slug) not between 3 and 80 then
    raise exception 'Invalid media tenant slug';
  end if;
  if char_length(btrim(p_name)) not between 2 and 160 then
    raise exception 'Invalid media tenant name';
  end if;
  if p_is_default then
    perform pg_advisory_xact_lock(hashtext('media-default:' || p_owner_user_id::text));
    select id into v_tenant_id from public.media_tenants
    where owner_user_id = p_owner_user_id and is_default;
    if v_tenant_id is not null then return v_tenant_id; end if;
  end if;
  insert into public.media_tenants (slug, name, owner_user_id, timezone, is_default)
  values (p_slug, btrim(p_name), p_owner_user_id, p_timezone, p_is_default)
  returning id into v_tenant_id;
  insert into public.media_tenant_members (tenant_id, user_id, role)
  values (v_tenant_id, p_owner_user_id, 'owner');
  return v_tenant_id;
end;
$$;

create or replace function public.ensure_default_media_tenant(p_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_display_name text;
  v_tenant_id uuid;
begin
  if p_user_id is null then raise exception 'A user is required'; end if;
  select display_name into v_display_name from public.profiles where user_id = p_user_id;
  if v_display_name is null then raise exception 'Profile not found'; end if;
  select id into v_tenant_id from public.media_tenants
  where owner_user_id = p_user_id and is_default;
  if v_tenant_id is not null then return v_tenant_id; end if;
  return public.create_media_tenant(
    p_user_id,
    left(btrim(v_display_name) || ' — arbetsyta', 160),
    'workspace-' || replace(p_user_id::text, '-', ''),
    'Europe/Stockholm',
    true
  );
end;
$$;

create or replace function public.handle_new_profile_media_tenant()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.ensure_default_media_tenant(new.user_id);
  return new;
end;
$$;

drop trigger if exists profiles_create_default_media_tenant on public.profiles;
create trigger profiles_create_default_media_tenant
after insert on public.profiles
for each row execute function public.handle_new_profile_media_tenant();

-- RLS is membership-based.  Application APIs use a service-role client only
-- after checking these same roles server-side; direct browser grants are
-- revoked so neither credential references nor raw item text can escape via
-- the generated client by accident.
create or replace function public.media_tenant_has_role(p_tenant_id uuid, p_required_role text default 'viewer')
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.media_tenant_members m
    where m.tenant_id = p_tenant_id
      and m.user_id = auth.uid()
      and case p_required_role
        when 'viewer' then m.role in ('owner', 'admin', 'editor', 'viewer')
        when 'editor' then m.role in ('owner', 'admin', 'editor')
        when 'admin' then m.role in ('owner', 'admin')
        when 'owner' then m.role = 'owner'
        else false
      end
  );
$$;

alter table public.media_tenants enable row level security;
alter table public.media_tenant_members enable row level security;
alter table public.media_source_connections enable row level security;
alter table public.media_research_rules enable row level security;
alter table public.media_research_rule_sources enable row level security;
alter table public.media_research_runs enable row level security;
alter table public.media_research_items enable row level security;
alter table public.media_research_clusters enable row level security;
alter table public.media_research_cluster_items enable row level security;
alter table public.media_research_evidence enable row level security;
alter table public.media_research_dossiers enable row level security;
alter table public.media_content_handoffs enable row level security;
alter table public.media_content_handoff_events enable row level security;

revoke all on table public.media_tenants, public.media_tenant_members,
  public.media_source_connections, public.media_research_rules,
  public.media_research_rule_sources, public.media_research_runs,
  public.media_research_items, public.media_research_clusters,
  public.media_research_cluster_items, public.media_research_evidence,
  public.media_research_dossiers, public.media_content_handoffs,
  public.media_content_handoff_events from anon, authenticated;
grant all on table public.media_tenants, public.media_tenant_members,
  public.media_source_connections, public.media_research_rules,
  public.media_research_rule_sources, public.media_research_runs,
  public.media_research_items, public.media_research_clusters,
  public.media_research_cluster_items, public.media_research_evidence,
  public.media_research_dossiers, public.media_content_handoffs,
  public.media_content_handoff_events to service_role;

drop policy if exists "Members view media tenants" on public.media_tenants;
create policy "Members view media tenants" on public.media_tenants
  for select using (public.media_tenant_has_role(id, 'viewer'));
drop policy if exists "Admins update media tenants" on public.media_tenants;
create policy "Admins update media tenants" on public.media_tenants
  for update using (public.media_tenant_has_role(id, 'admin'))
  with check (public.media_tenant_has_role(id, 'admin'));
drop policy if exists "Owners delete media tenants" on public.media_tenants;
create policy "Owners delete media tenants" on public.media_tenants
  for delete using (public.media_tenant_has_role(id, 'owner'));

drop policy if exists "Members view media tenant memberships" on public.media_tenant_members;
create policy "Members view media tenant memberships" on public.media_tenant_members
  for select using (public.media_tenant_has_role(tenant_id, 'viewer'));

drop policy if exists "Members view media source connections" on public.media_source_connections;
create policy "Members view media source connections" on public.media_source_connections
  for select using (public.media_tenant_has_role(tenant_id, 'viewer'));
drop policy if exists "Editors manage media source connections" on public.media_source_connections;
create policy "Editors manage media source connections" on public.media_source_connections
  for all using (public.media_tenant_has_role(tenant_id, 'editor'))
  with check (public.media_tenant_has_role(tenant_id, 'editor'));

drop policy if exists "Members view media research rules" on public.media_research_rules;
create policy "Members view media research rules" on public.media_research_rules
  for select using (public.media_tenant_has_role(tenant_id, 'viewer'));
drop policy if exists "Editors manage media research rules" on public.media_research_rules;
create policy "Editors manage media research rules" on public.media_research_rules
  for all using (public.media_tenant_has_role(tenant_id, 'editor'))
  with check (public.media_tenant_has_role(tenant_id, 'editor'));
drop policy if exists "Members view media research rule sources" on public.media_research_rule_sources;
create policy "Members view media research rule sources" on public.media_research_rule_sources
  for select using (public.media_tenant_has_role(tenant_id, 'viewer'));

drop policy if exists "Members view media research runs" on public.media_research_runs;
create policy "Members view media research runs" on public.media_research_runs
  for select using (public.media_tenant_has_role(tenant_id, 'viewer'));
drop policy if exists "Members view media research items" on public.media_research_items;
create policy "Members view media research items" on public.media_research_items
  for select using (public.media_tenant_has_role(tenant_id, 'viewer'));
drop policy if exists "Members view media research clusters" on public.media_research_clusters;
create policy "Members view media research clusters" on public.media_research_clusters
  for select using (public.media_tenant_has_role(tenant_id, 'viewer'));
drop policy if exists "Members view media research cluster items" on public.media_research_cluster_items;
create policy "Members view media research cluster items" on public.media_research_cluster_items
  for select using (public.media_tenant_has_role(tenant_id, 'viewer'));
drop policy if exists "Members view media research evidence" on public.media_research_evidence;
create policy "Members view media research evidence" on public.media_research_evidence
  for select using (public.media_tenant_has_role(tenant_id, 'viewer'));
drop policy if exists "Members view media research dossiers" on public.media_research_dossiers;
create policy "Members view media research dossiers" on public.media_research_dossiers
  for select using (public.media_tenant_has_role(tenant_id, 'viewer'));
drop policy if exists "Members view media content handoffs" on public.media_content_handoffs;
create policy "Members view media content handoffs" on public.media_content_handoffs
  for select using (public.media_tenant_has_role(tenant_id, 'viewer'));
drop policy if exists "Members view media content handoff events" on public.media_content_handoff_events;
create policy "Members view media content handoff events" on public.media_content_handoff_events
  for select using (public.media_tenant_has_role(tenant_id, 'viewer'));

revoke all on function public.create_media_tenant(uuid, text, text, text, boolean) from public, anon, authenticated;
revoke all on function public.ensure_default_media_tenant(uuid) from public, anon, authenticated;
grant execute on function public.create_media_tenant(uuid, text, text, text, boolean) to service_role;
grant execute on function public.ensure_default_media_tenant(uuid) to service_role;
-- The membership predicate is used by RLS policies.  It returns only a boolean
-- for the caller's own auth.uid and exposes neither member lists nor secrets.
grant execute on function public.media_tenant_has_role(uuid, text) to authenticated, service_role;
