-- SAGA News Core: Vercel + Neon foundation for high-volume public news/RSS
-- ingestion, provenance, evidence-backed signals, and safe retries.
--
-- This migration deliberately stores source definitions and normalized public
-- material only. Provider credentials, OAuth data, request headers, cookies,
-- and raw signed URLs remain in Vercel environment variables / server-owned
-- connector code and are rejected at the database boundary.
--
-- Apply after 202608240006_neon_content_engine.sql and
-- 202608240007_neon_saga_editorial_lens.sql.

begin;

create or replace function saga_news_json_has_forbidden_secret_key(payload jsonb)
returns boolean
language plpgsql
immutable
as $$
declare
  entry record;
  normalized_key text;
  string_value text;
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
      or normalized_key like '%credential'
      or normalized_key like '%token' then
        return true;
      end if;
      if saga_news_json_has_forbidden_secret_key(entry.value) then
        return true;
      end if;
    end loop;
  elsif jsonb_typeof(payload) = 'array' then
    for entry in select value from jsonb_array_elements(payload) loop
      if saga_news_json_has_forbidden_secret_key(entry.value) then
        return true;
      end if;
    end loop;
  elsif jsonb_typeof(payload) = 'string' then
    string_value := payload #>> '{}';
    -- Config/provenance may contain public links, but never a URL that embeds
    -- a credential-like query parameter. API adapters attach secrets only at
    -- runtime from Vercel environment variables.
    if string_value ~* '^https?://'
      and string_value ~* '[?&](api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|bearer[_-]?token|auth[_-]?token|id[_-]?token|token|password|secret|credential)[^=]*=' then
      return true;
    end if;
  end if;

  return false;
end;
$$;

create or replace function saga_news_valid_domain(value text)
returns boolean
language sql
immutable
as $$
  select lower(trim(value)) ~ '^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$';
$$;

create or replace function saga_news_valid_domain_list(values_list text[], max_items integer)
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
       select bool_and(saga_news_valid_domain(value))
       from unnest(values_list) value
     ), true);
$$;

create or replace function saga_news_valid_text_list(values_list text[], max_items integer, max_length integer)
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

create or replace function saga_news_domain_lists_disjoint(first_values text[], second_values text[])
returns boolean
language sql
immutable
as $$
  select not exists (
    select 1
    from unnest(first_values) first_value
    join unnest(second_values) second_value
      on lower(trim(first_value)) = lower(trim(second_value))
      or lower(trim(first_value)) like '%.' || lower(trim(second_value))
      or lower(trim(second_value)) like '%.' || lower(trim(first_value))
  );
$$;

create or replace function saga_news_safe_https_url(value text)
returns boolean
language sql
immutable
as $$
  select value ~ '^https://'
     and value !~ '^https://[^/]*@'
     and char_length(value) <= 2000
     and value !~* '[?&](api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|bearer[_-]?token|auth[_-]?token|id[_-]?token|token|password|secret|credential)[^=]*=';
$$;

create or replace function saga_news_safe_diagnostic_text(value text)
returns boolean
language sql
immutable
as $$
  select char_length(value) <= 1000
     and value !~* '[?&](api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|bearer[_-]?token|auth[_-]?token|id[_-]?token|token|password|secret|credential)[^=]*='
     and value !~* '(api[[:space:]_-]?key|access[[:space:]_-]?token|refresh[[:space:]_-]?token|client[[:space:]_-]?secret|bearer[[:space:]_-]?token|auth[[:space:]_-]?token|id[[:space:]_-]?token|password|credential|token|secret)[[:space:]]*[:=]';
$$;

create table if not exists saga_news_sources (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app_workspaces(id) on delete cascade,
  created_by_user_id uuid not null,
  updated_by_user_id uuid not null,
  slug text not null check (slug = lower(slug) and slug ~ '^[a-z0-9][a-z0-9-]{1,78}$'),
  name text not null check (char_length(trim(name)) between 2 and 240),
  source_kind text not null check (source_kind in ('rss', 'news_api', 'public_api', 'website', 'manual')),
  -- Adapter identity only. It is not an API key and is resolved by server code.
  connector_key text not null check (connector_key = lower(connector_key) and connector_key ~ '^[a-z0-9][a-z0-9._-]{1,80}$'),
  endpoint_url text not null check (saga_news_safe_https_url(endpoint_url)),
  publisher_allowlist text[] not null default '{}'::text[]
    check (saga_news_valid_domain_list(publisher_allowlist, 120)),
  publisher_blocklist text[] not null default '{}'::text[]
    check (saga_news_valid_domain_list(publisher_blocklist, 120)),
  allowlist_mode text not null default 'strict'
    check (allowlist_mode in ('strict', 'prefer', 'open')),
  topics text[] not null default '{}'::text[]
    check (saga_news_valid_text_list(topics, 40, 240)),
  languages text[] not null default array['sv']::text[]
    check (saga_news_valid_text_list(languages, 20, 12)),
  countries text[] not null default '{}'::text[]
    check (saga_news_valid_text_list(countries, 20, 2)),
  trust_level smallint not null default 3 check (trust_level between 1 and 5),
  source_weight smallint not null default 50 check (source_weight between 1 and 100),
  minimum_interval_minutes integer not null default 60 check (minimum_interval_minutes between 5 and 43200),
  max_items_per_run smallint not null default 100 check (max_items_per_run between 1 and 250),
  max_item_text_chars integer not null default 30000 check (max_item_text_chars between 500 and 120000),
  source_policy jsonb not null default '{}'::jsonb
    check (jsonb_typeof(source_policy) = 'object')
    check (not saga_news_json_has_forbidden_secret_key(source_policy)),
  is_allowed boolean not null default true,
  active boolean not null default true,
  last_ingestion_at timestamptz,
  last_successful_ingestion_at timestamptz,
  last_failure_at timestamptz,
  last_failure_code text check (last_failure_code is null or last_failure_code ~ '^[a-z0-9][a-z0-9._:-]{0,119}$'),
  -- Short server-only lease used by the Vercel Cron worker. It is not an
  -- account credential and is never returned by browser-facing APIs.
  next_ingestion_at timestamptz not null default now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  leased_by text check (leased_by is null or char_length(trim(leased_by)) between 2 and 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, slug),
  foreign key (workspace_id, created_by_user_id)
    references app_workspace_memberships(workspace_id, user_id)
    on delete restrict,
  foreign key (workspace_id, updated_by_user_id)
    references app_workspace_memberships(workspace_id, user_id)
    on delete restrict,
  check (saga_news_domain_lists_disjoint(publisher_allowlist, publisher_blocklist)),
  -- Broad public APIs must be visibly constrained before they can be placed in
  -- strict mode. RSS/manual adapters can use their own publisher provenance.
  check (
    allowlist_mode <> 'strict'
    or source_kind in ('rss', 'manual')
    or cardinality(publisher_allowlist) > 0
  ),
  check ((lease_token is null and lease_expires_at is null and leased_by is null)
     or (lease_token is not null and lease_expires_at is not null and leased_by is not null))
);

create table if not exists saga_news_ingestion_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app_workspaces(id) on delete cascade,
  source_id uuid not null,
  requested_by_user_id uuid not null,
  connector_key text not null check (connector_key = lower(connector_key) and connector_key ~ '^[a-z0-9][a-z0-9._-]{1,80}$'),
  idempotency_key uuid not null,
  request_fingerprint text not null check (request_fingerprint ~ '^[a-f0-9]{64}$'),
  worker_id text not null check (char_length(trim(worker_id)) between 2 and 120),
  status text not null default 'running' check (status in ('running', 'completed', 'failed', 'cancelled')),
  items_received integer not null default 0 check (items_received >= 0),
  items_inserted integer not null default 0 check (items_inserted >= 0),
  items_duplicate integer not null default 0 check (items_duplicate >= 0),
  items_rejected integer not null default 0 check (items_rejected >= 0),
  failure_code text check (failure_code is null or failure_code ~ '^[a-z0-9][a-z0-9._:-]{0,119}$'),
  failure_summary text check (failure_summary is null or saga_news_safe_diagnostic_text(failure_summary)),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, source_id, id),
  unique (workspace_id, source_id, idempotency_key),
  foreign key (workspace_id, source_id)
    references saga_news_sources(workspace_id, id)
    on delete restrict,
  foreign key (workspace_id, requested_by_user_id)
    references app_workspace_memberships(workspace_id, user_id)
    on delete restrict,
  check ((status = 'running' and completed_at is null) or status <> 'running'),
  check ((status in ('completed', 'failed', 'cancelled') and completed_at is not null) or status = 'running')
);

create table if not exists saga_news_source_items (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app_workspaces(id) on delete cascade,
  source_id uuid not null,
  first_ingestion_run_id uuid not null,
  last_ingestion_run_id uuid not null,
  identity_fingerprint text not null check (identity_fingerprint ~ '^[a-f0-9]{64}$'),
  content_fingerprint text not null check (content_fingerprint ~ '^[a-f0-9]{64}$'),
  story_fingerprint text not null check (story_fingerprint ~ '^[a-f0-9]{64}$'),
  external_id text check (external_id is null or char_length(external_id) <= 512),
  canonical_url text not null check (saga_news_safe_https_url(canonical_url)),
  title text not null check (char_length(trim(title)) between 1 and 1000),
  summary text not null default '' check (char_length(summary) <= 12000),
  body_text text not null default '' check (char_length(body_text) <= 120000),
  publisher_name text not null default '' check (char_length(publisher_name) <= 320),
  publisher_domain text not null check (saga_news_valid_domain(publisher_domain)),
  authors text[] not null default '{}'::text[]
    check (saga_news_valid_text_list(authors, 20, 240)),
  language text check (language is null or language ~ '^[a-z]{2,3}(-[a-z0-9]{2,8})?$'),
  published_at timestamptz,
  discovered_at timestamptz not null default now(),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  provenance jsonb not null default '{}'::jsonb
    check (jsonb_typeof(provenance) = 'object')
    check (not saga_news_json_has_forbidden_secret_key(provenance)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, source_id, id),
  unique (workspace_id, source_id, identity_fingerprint),
  foreign key (workspace_id, source_id)
    references saga_news_sources(workspace_id, id)
    on delete restrict,
  foreign key (workspace_id, source_id, first_ingestion_run_id)
    references saga_news_ingestion_runs(workspace_id, source_id, id)
    on delete restrict,
  foreign key (workspace_id, source_id, last_ingestion_run_id)
    references saga_news_ingestion_runs(workspace_id, source_id, id)
    on delete restrict
);

create table if not exists saga_news_signal_candidates (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app_workspaces(id) on delete cascade,
  created_by_user_id uuid not null,
  updated_by_user_id uuid not null,
  signal_key text not null check (signal_key = lower(signal_key) and signal_key ~ '^[a-z0-9][a-z0-9._:-]{2,158}$'),
  topic text not null check (char_length(trim(topic)) between 2 and 240),
  headline text not null check (char_length(trim(headline)) between 2 and 500),
  summary text not null default '' check (char_length(summary) <= 6000),
  editorial_angle text not null default '' check (char_length(editorial_angle) <= 3000),
  content_fingerprint text not null check (content_fingerprint ~ '^[a-f0-9]{64}$'),
  source_credibility_score smallint not null check (source_credibility_score between 0 and 100),
  topical_relevance_score smallint not null check (topical_relevance_score between 0 and 100),
  mission_alignment_score smallint not null check (mission_alignment_score between 0 and 100),
  trend_momentum_score smallint not null check (trend_momentum_score between 0 and 100),
  channel_suitability_score smallint not null check (channel_suitability_score between 0 and 100),
  evidence_count integer not null default 0 check (evidence_count >= 0),
  independent_source_count integer not null default 0 check (independent_source_count >= 0),
  distinct_publisher_count integer not null default 0 check (distinct_publisher_count >= 0),
  policy_snapshot jsonb not null default '{}'::jsonb
    check (jsonb_typeof(policy_snapshot) = 'object')
    check (not saga_news_json_has_forbidden_secret_key(policy_snapshot)),
  state text not null default 'candidate'
    check (state in ('candidate', 'qualified', 'in_review', 'dismissed')),
  requires_human_review boolean not null default true,
  active boolean not null default true,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, signal_key),
  foreign key (workspace_id, created_by_user_id)
    references app_workspace_memberships(workspace_id, user_id)
    on delete restrict,
  foreign key (workspace_id, updated_by_user_id)
    references app_workspace_memberships(workspace_id, user_id)
    on delete restrict
);

create table if not exists saga_news_signal_evidence (
  workspace_id uuid not null references app_workspaces(id) on delete cascade,
  candidate_id uuid not null,
  source_id uuid not null,
  source_item_id uuid not null,
  source_trust_level smallint not null check (source_trust_level between 1 and 5),
  source_weight smallint not null check (source_weight between 1 and 100),
  publisher_domain text not null check (saga_news_valid_domain(publisher_domain)),
  content_fingerprint text not null check (content_fingerprint ~ '^[a-f0-9]{64}$'),
  added_at timestamptz not null default now(),
  primary key (workspace_id, candidate_id, source_item_id),
  foreign key (workspace_id, candidate_id)
    references saga_news_signal_candidates(workspace_id, id)
    on delete cascade,
  foreign key (workspace_id, source_id, source_item_id)
    references saga_news_source_items(workspace_id, source_id, id)
    on delete restrict
);

create index if not exists saga_news_sources_workspace_runnable_idx
  on saga_news_sources (workspace_id, active, is_allowed, next_ingestion_at);
create index if not exists saga_news_sources_due_idx
  on saga_news_sources (next_ingestion_at, id)
  where active = true and is_allowed = true;
create index if not exists saga_news_ingestion_runs_workspace_source_started_idx
  on saga_news_ingestion_runs (workspace_id, source_id, started_at desc);
create index if not exists saga_news_ingestion_runs_running_idx
  on saga_news_ingestion_runs (workspace_id, started_at)
  where status = 'running';
create index if not exists saga_news_source_items_workspace_story_idx
  on saga_news_source_items (workspace_id, story_fingerprint, published_at desc nulls last);
create index if not exists saga_news_source_items_workspace_source_seen_idx
  on saga_news_source_items (workspace_id, source_id, last_seen_at desc);
create index if not exists saga_news_source_items_workspace_publisher_idx
  on saga_news_source_items (workspace_id, publisher_domain, published_at desc nulls last);
create index if not exists saga_news_signal_candidates_workspace_state_idx
  on saga_news_signal_candidates (workspace_id, state, last_seen_at desc);
create index if not exists saga_news_signal_evidence_workspace_item_idx
  on saga_news_signal_evidence (workspace_id, source_item_id);

-- The database applies the same source policy as the server worker. A stale
-- UI/session cannot use a paused source or sneak an off-policy publisher into
-- a run after the worker has already started.
create or replace function saga_news_ingest_source_items(
  target_workspace_id uuid,
  target_source_id uuid,
  target_run_id uuid,
  incoming_items jsonb,
  expected_lease_token uuid default null
)
returns table(received_count integer, inserted_count integer, duplicate_count integer)
language plpgsql
as $$
declare
  source_row saga_news_sources%rowtype;
  run_row saga_news_ingestion_runs%rowtype;
  incoming_count integer;
  inserted_total integer;
begin
  if incoming_items is null or jsonb_typeof(incoming_items) <> 'array' then
    raise exception 'saga_news incoming items must be an array';
  end if;
  incoming_count := jsonb_array_length(incoming_items);
  if incoming_count < 1 or incoming_count > 100 then
    raise exception 'saga_news accepts between 1 and 100 items per batch';
  end if;

  select source.* into source_row
  from saga_news_sources source
  where source.workspace_id = target_workspace_id
    and source.id = target_source_id
  for share;
  if not found or source_row.active is not true or source_row.is_allowed is not true then
    raise exception 'saga_news source is not active and allowed in this workspace';
  end if;
  if expected_lease_token is not null and (
    source_row.lease_token is distinct from expected_lease_token
    or source_row.lease_expires_at is null
    or source_row.lease_expires_at <= now()
  ) then
    raise exception 'saga_news source lease is no longer held by this worker';
  end if;

  select run.* into run_row
  from saga_news_ingestion_runs run
  where run.workspace_id = target_workspace_id
    and run.source_id = target_source_id
    and run.id = target_run_id
  for update;
  if not found or run_row.status <> 'running' then
    raise exception 'saga_news ingestion run is not active for this source';
  end if;

  if run_row.items_received + incoming_count > source_row.max_items_per_run then
    raise exception 'saga_news batch exceeds the source item limit for this run';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(incoming_items) as input(
      identity_fingerprint text,
      publisher_domain text
    )
    where input.identity_fingerprint is null
       or input.identity_fingerprint !~ '^[a-f0-9]{64}$'
       or input.publisher_domain is null
       or not saga_news_valid_domain(input.publisher_domain)
  ) then
    raise exception 'saga_news incoming item identifiers or publishers are invalid';
  end if;

  -- The repository applies these controls too, but the database is the final
  -- boundary for every future worker/import. A source may retain a body only
  -- after an explicitly approved policy change; normal News Core connector
  -- traffic is metadata and short excerpts only.
  if exists (
    select 1
    from jsonb_to_recordset(incoming_items) as input(
      summary text,
      body_text text,
      published_at timestamptz
    )
    where char_length(coalesce(input.summary, '')) + char_length(coalesce(input.body_text, ''))
            > source_row.max_item_text_chars
       or (
         coalesce(source_row.source_policy ->> 'retainFullText', 'false') <> 'true'
         and coalesce(input.body_text, '') <> ''
       )
       or (
         coalesce(source_row.source_policy ->> 'requirePublishedAt', 'false') = 'true'
         and input.published_at is null
       )
  ) then
    raise exception 'saga_news incoming items exceed source text or metadata policy';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(incoming_items) as input(identity_fingerprint text)
    group by input.identity_fingerprint
    having count(*) > 1
  ) then
    raise exception 'saga_news incoming batch contains duplicate item identities';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(incoming_items) as input(publisher_domain text)
    where exists (
      select 1 from unnest(source_row.publisher_blocklist) blocked_domain
      where lower(input.publisher_domain) = lower(blocked_domain)
         or lower(input.publisher_domain) like '%.' || lower(blocked_domain)
    )
       or (
         source_row.allowlist_mode = 'strict'
         and not exists (
           select 1 from unnest(source_row.publisher_allowlist) allowed_domain
           where lower(input.publisher_domain) = lower(allowed_domain)
              or lower(input.publisher_domain) like '%.' || lower(allowed_domain)
         )
       )
  ) then
    raise exception 'saga_news incoming item does not satisfy the source publisher policy';
  end if;

  with incoming as (
    select *
    from jsonb_to_recordset(incoming_items) as input(
      identity_fingerprint text,
      content_fingerprint text,
      story_fingerprint text,
      external_id text,
      canonical_url text,
      title text,
      summary text,
      body_text text,
      publisher_name text,
      publisher_domain text,
      authors text[],
      language text,
      published_at timestamptz,
      discovered_at timestamptz,
      provenance jsonb
    )
  ),
  upserted as (
    insert into saga_news_source_items (
      workspace_id, source_id, first_ingestion_run_id, last_ingestion_run_id,
      identity_fingerprint, content_fingerprint, story_fingerprint, external_id,
      canonical_url, title, summary, body_text, publisher_name, publisher_domain,
      authors, language, published_at, discovered_at, provenance
    )
    select
      target_workspace_id, target_source_id, target_run_id, target_run_id,
      input.identity_fingerprint, input.content_fingerprint, input.story_fingerprint, input.external_id,
      input.canonical_url, input.title, input.summary, input.body_text, input.publisher_name, input.publisher_domain,
      input.authors, input.language, input.published_at, input.discovered_at, input.provenance
    from incoming input
    on conflict (workspace_id, source_id, identity_fingerprint) do update set
      last_ingestion_run_id = excluded.last_ingestion_run_id,
      last_seen_at = now(),
      updated_at = now()
    returning (xmax = 0) as was_inserted
  )
  select count(*) filter (where was_inserted)::integer into inserted_total
  from upserted;

  update saga_news_ingestion_runs
     set items_received = items_received + incoming_count,
         items_inserted = items_inserted + coalesce(inserted_total, 0),
         items_duplicate = items_duplicate + incoming_count - coalesce(inserted_total, 0),
         updated_at = now()
   where workspace_id = target_workspace_id and id = target_run_id;

  update saga_news_sources
     set last_ingestion_at = now(),
         updated_at = now()
   where workspace_id = target_workspace_id and id = target_source_id;

  return query select incoming_count, coalesce(inserted_total, 0), incoming_count - coalesce(inserted_total, 0);
end;
$$;

-- Replaces the evidence set atomically and captures the source trust/weight at
-- the moment a signal is evaluated. This preserves explainability even if a
-- source policy changes later.
create or replace function saga_news_replace_signal_evidence(
  target_workspace_id uuid,
  target_candidate_id uuid,
  requested_item_ids jsonb
)
returns void
language plpgsql
as $$
declare
  requested_count integer;
  distinct_count integer;
  valid_count integer;
begin
  if requested_item_ids is null or jsonb_typeof(requested_item_ids) <> 'array' then
    raise exception 'saga_news signal evidence must be an array';
  end if;
  if jsonb_array_length(requested_item_ids) < 1 or jsonb_array_length(requested_item_ids) > 50 then
    raise exception 'saga_news signal evidence must contain between 1 and 50 items';
  end if;
  if exists (
    select 1
    from jsonb_array_elements_text(requested_item_ids) value
    where value !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ) then
    raise exception 'saga_news signal evidence contains an invalid item id';
  end if;

  select count(*), count(distinct value)
    into requested_count, distinct_count
    from jsonb_array_elements_text(requested_item_ids) value;
  if requested_count <> distinct_count then
    raise exception 'saga_news signal evidence contains duplicate items';
  end if;

  if not exists (
    select 1
    from saga_news_signal_candidates candidate
    where candidate.workspace_id = target_workspace_id and candidate.id = target_candidate_id
  ) then
    raise exception 'saga_news signal candidate does not exist in this workspace';
  end if;

  select count(*) into valid_count
  from saga_news_source_items item
  join saga_news_sources source
    on source.workspace_id = item.workspace_id and source.id = item.source_id
  join jsonb_array_elements_text(requested_item_ids) value
    on item.id::text = value
  where item.workspace_id = target_workspace_id
    and source.active = true
    and source.is_allowed = true;
  if valid_count <> requested_count then
    raise exception 'Every SAGA evidence item must belong to an active, allowed source in this workspace';
  end if;

  delete from saga_news_signal_evidence
  where workspace_id = target_workspace_id and candidate_id = target_candidate_id;

  insert into saga_news_signal_evidence (
    workspace_id, candidate_id, source_id, source_item_id,
    source_trust_level, source_weight, publisher_domain, content_fingerprint
  )
  select
    target_workspace_id,
    target_candidate_id,
    item.source_id,
    item.id,
    source.trust_level,
    source.source_weight,
    item.publisher_domain,
    item.content_fingerprint
  from saga_news_source_items item
  join saga_news_sources source
    on source.workspace_id = item.workspace_id and source.id = item.source_id
  join jsonb_array_elements_text(requested_item_ids) value
    on item.id::text = value
  where item.workspace_id = target_workspace_id;

  update saga_news_signal_candidates candidate
     set evidence_count = evidence.count_all,
         independent_source_count = evidence.count_sources,
         distinct_publisher_count = evidence.count_publishers,
         last_seen_at = now(),
         updated_at = now()
    from (
      select
        count(*)::integer as count_all,
        count(distinct source_id)::integer as count_sources,
        count(distinct publisher_domain)::integer as count_publishers
      from saga_news_signal_evidence
      where workspace_id = target_workspace_id and candidate_id = target_candidate_id
    ) evidence
   where candidate.workspace_id = target_workspace_id and candidate.id = target_candidate_id;
end;
$$;

drop trigger if exists saga_news_sources_set_updated_at on saga_news_sources;
create trigger saga_news_sources_set_updated_at
before update on saga_news_sources
for each row execute function app_set_updated_at();

drop trigger if exists saga_news_ingestion_runs_set_updated_at on saga_news_ingestion_runs;
create trigger saga_news_ingestion_runs_set_updated_at
before update on saga_news_ingestion_runs
for each row execute function app_set_updated_at();

drop trigger if exists saga_news_source_items_set_updated_at on saga_news_source_items;
create trigger saga_news_source_items_set_updated_at
before update on saga_news_source_items
for each row execute function app_set_updated_at();

drop trigger if exists saga_news_signal_candidates_set_updated_at on saga_news_signal_candidates;
create trigger saga_news_signal_candidates_set_updated_at
before update on saga_news_signal_candidates
for each row execute function app_set_updated_at();

commit;
