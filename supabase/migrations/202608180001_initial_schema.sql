-- Personal Daily Brief V1: persistent event register, not a news feed.
create extension if not exists pgcrypto;

create type public.event_status as enum (
  'rumor', 'reported', 'proposed', 'negotiating', 'announced', 'signed',
  'adopted', 'effective', 'implemented', 'changed', 'reversed'
);
create type public.event_category as enum (
  'economy', 'technology', 'regulation', 'geopolitics_trade', 'security',
  'energy_logistics', 'payments', 'infrastructure'
);
create type public.source_type as enum ('primary', 'secondary');
create type public.confidence_level as enum ('high', 'medium', 'low');
create type public.recommendation as enum ('act', 'monitor', 'no_action');
create type public.update_kind as enum (
  'new_event', 'status_change', 'terms_change', 'effective_date_change',
  'impact_change', 'verification_change', 'no_material_change'
);
create type public.brief_state as enum ('complete', 'failed', 'partial');
create type public.run_state as enum ('running', 'complete', 'failed');
create type public.feedback_type as enum ('important', 'not_relevant', 'more_like_this', 'less_like_this');

create table public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'Erik' check (char_length(display_name) between 1 and 80),
  timezone text not null default 'Europe/Stockholm',
  base_region text not null default 'Sverige',
  economy_weight smallint not null default 75 check (economy_weight between 0 and 100),
  technology_weight smallint not null default 90 check (technology_weight between 0 and 100),
  regulation_weight smallint not null default 85 check (regulation_weight between 0 and 100),
  geopolitics_weight smallint not null default 75 check (geopolitics_weight between 0 and 100),
  sweden_eu_weight smallint not null default 100 check (sweden_eu_weight between 0 and 100),
  usa_weight smallint not null default 90 check (usa_weight between 0 and 100),
  gulf_weight smallint not null default 70 check (gulf_weight between 0 and 100),
  max_items smallint not null default 5 check (max_items between 0 and 5),
  brief_depth text not null default 'short' check (brief_depth in ('short', 'deep')),
  relevance_threshold smallint not null default 65 check (relevance_threshold between 0 and 100),
  alert_threshold smallint not null default 85 check (alert_threshold between 0 and 100),
  daily_brief_time time not null default '07:00',
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table public.processing_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  local_brief_date date not null,
  triggered_by text not null check (triggered_by in ('cron', 'manual', 'retry')),
  state public.run_state not null default 'running',
  phase text not null default 'discovery' check (phase in ('discovery', 'editorial', 'persisting', 'complete', 'failed')),
  started_at timestamptz not null default timezone('utc', now()),
  finished_at timestamptz,
  coverage_from timestamptz,
  coverage_to timestamptz,
  candidate_count integer not null default 0 check (candidate_count >= 0),
  published_count integer not null default 0 check (published_count between 0 and 5),
  model_name text,
  token_metadata jsonb not null default '{}'::jsonb,
  search_metadata jsonb not null default '{}'::jsonb,
  validation_errors jsonb not null default '[]'::jsonb,
  error_message text
);

create index processing_runs_user_date_idx on public.processing_runs(user_id, local_brief_date desc);
create unique index processing_runs_one_active_per_day_idx
  on public.processing_runs(user_id, local_brief_date) where state = 'running';

create table public.model_calls (
  id uuid primary key default gen_random_uuid(),
  processing_run_id uuid not null references public.processing_runs(id) on delete cascade,
  stage text not null check (stage in ('discovery', 'editorial')),
  model_name text not null,
  response_id text,
  state public.run_state not null,
  input_tokens integer,
  output_tokens integer,
  cached_tokens integer,
  metadata jsonb not null default '{}'::jsonb,
  error_message text,
  created_at timestamptz not null default timezone('utc', now())
);

create table public.events (
  id uuid primary key default gen_random_uuid(),
  canonical_key text not null check (char_length(canonical_key) between 8 and 240),
  title text not null check (char_length(title) between 8 and 180),
  category public.event_category not null,
  actors jsonb not null default '[]'::jsonb,
  regions jsonb not null default '[]'::jsonb,
  status public.event_status not null,
  first_detected_at timestamptz not null default timezone('utc', now()),
  last_status_changed_at timestamptz not null default timezone('utc', now()),
  event_date date,
  effective_date date,
  latest_terms_summary text,
  latest_short_term_impact text,
  latest_long_term_impact text,
  confidence public.confidence_level not null default 'medium',
  latest_relevance_score smallint check (latest_relevance_score between 0 and 100),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (canonical_key)
);

create index events_status_idx on public.events(status);
create index events_updated_idx on public.events(updated_at desc);

create table public.event_updates (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  processing_run_id uuid references public.processing_runs(id) on delete set null,
  previous_status public.event_status,
  new_status public.event_status not null,
  kind public.update_kind not null,
  change_summary text not null,
  terms_summary text,
  effective_date date,
  short_term_impact text,
  long_term_impact text,
  confidence public.confidence_level not null,
  event_date date,
  material_fingerprint text not null,
  occurred_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now()),
  unique (event_id, material_fingerprint)
);

create index event_updates_event_occurred_idx on public.event_updates(event_id, occurred_at desc);
create index event_updates_run_idx on public.event_updates(processing_run_id);

create table public.event_sources (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  event_update_id uuid references public.event_updates(id) on delete cascade,
  source_name text not null,
  url text not null,
  source_type public.source_type not null,
  published_at date,
  event_date date,
  supports_claim text not null,
  created_at timestamptz not null default timezone('utc', now()),
  unique (event_update_id, url)
);

create index event_sources_event_idx on public.event_sources(event_id);
create index event_sources_update_idx on public.event_sources(event_update_id);

create table public.briefs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  processing_run_id uuid references public.processing_runs(id) on delete set null,
  brief_date date not null,
  timezone text not null,
  state public.brief_state not null,
  assessment text,
  item_count smallint not null default 0 check (item_count between 0 and 5),
  no_material_changes boolean not null default false,
  watchlist jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (user_id, brief_date)
);

create index briefs_user_date_idx on public.briefs(user_id, brief_date desc);

create table public.brief_items (
  id uuid primary key default gen_random_uuid(),
  brief_id uuid not null references public.briefs(id) on delete cascade,
  event_id uuid not null references public.events(id) on delete restrict,
  event_update_id uuid references public.event_updates(id) on delete set null,
  position smallint not null check (position between 1 and 5),
  relevance_score smallint not null check (relevance_score between 0 and 100),
  relevance_factors jsonb not null,
  title_snapshot text not null,
  category_snapshot public.event_category not null,
  status_snapshot public.event_status not null,
  event_date_snapshot date,
  what_changed text not null,
  why_relevant text not null,
  short_term_impact text not null,
  long_term_impact text not null,
  recommendation public.recommendation not null,
  confidence public.confidence_level not null,
  systemic_override boolean not null default false,
  direct_alert boolean not null default false,
  created_at timestamptz not null default timezone('utc', now()),
  unique (brief_id, event_id),
  unique (brief_id, position)
);

create index brief_items_event_idx on public.brief_items(event_id);

-- Per-user delivery state lets one shared event register serve multiple profiles later.
create table public.user_event_state (
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  event_id uuid not null references public.events(id) on delete cascade,
  last_considered_update_id uuid references public.event_updates(id) on delete set null,
  last_published_update_id uuid references public.event_updates(id) on delete set null,
  last_published_at timestamptz,
  last_score smallint check (last_score between 0 and 100),
  is_muted boolean not null default false,
  primary key (user_id, event_id)
);

create index user_event_state_user_idx on public.user_event_state(user_id);

create table public.feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  event_id uuid not null references public.events(id) on delete cascade,
  brief_item_id uuid references public.brief_items(id) on delete set null,
  type public.feedback_type not null,
  comment text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (user_id, event_id, type)
);

create index feedback_user_event_idx on public.feedback(user_id, event_id);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

create trigger profiles_updated_at before update on public.profiles
for each row execute function public.set_updated_at();
create trigger events_updated_at before update on public.events
for each row execute function public.set_updated_at();
create trigger briefs_updated_at before update on public.briefs
for each row execute function public.set_updated_at();
create trigger feedback_updated_at before update on public.feedback
for each row execute function public.set_updated_at();

-- A profile is available as soon as a user is created; all later tuning is user-owned.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (user_id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'name', 'Erik'))
  on conflict (user_id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.processing_runs enable row level security;
alter table public.model_calls enable row level security;
alter table public.events enable row level security;
alter table public.event_updates enable row level security;
alter table public.event_sources enable row level security;
alter table public.briefs enable row level security;
alter table public.brief_items enable row level security;
alter table public.user_event_state enable row level security;
alter table public.feedback enable row level security;

create policy "Users manage their profile" on public.profiles
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users read their runs" on public.processing_runs
  for select using (auth.uid() = user_id);
create policy "Users read their model calls" on public.model_calls
  for select using (exists (
    select 1 from public.processing_runs r where r.id = model_calls.processing_run_id and r.user_id = auth.uid()
  ));
create policy "Users read events included in their briefs" on public.events
  for select using (exists (
    select 1
    from public.brief_items bi
    join public.briefs b on b.id = bi.brief_id
    where bi.event_id = events.id and b.user_id = auth.uid()
  ));
create policy "Users read updates included in their briefs" on public.event_updates
  for select using (exists (
    select 1
    from public.brief_items bi
    join public.briefs b on b.id = bi.brief_id
    where bi.event_id = event_updates.event_id and b.user_id = auth.uid()
  ));
create policy "Users read their sources" on public.event_sources
  for select using (exists (
    select 1
    from public.brief_items bi
    join public.briefs b on b.id = bi.brief_id
    where bi.event_id = event_sources.event_id and b.user_id = auth.uid()
  ));
create policy "Users read their briefs" on public.briefs
  for select using (auth.uid() = user_id);
create policy "Users read their brief items" on public.brief_items
  for select using (exists (
    select 1 from public.briefs b where b.id = brief_items.brief_id and b.user_id = auth.uid()
  ));
create policy "Users read their event delivery state" on public.user_event_state
  for select using (auth.uid() = user_id);
create policy "Users manage their feedback" on public.feedback
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Publication is atomic: a failed run can never leave a partially visible brief.
-- It is deliberately callable only by the server-side service-role cron endpoint.
create or replace function public.publish_daily_brief(
  p_user_id uuid,
  p_run_id uuid,
  p_brief_date date,
  p_timezone text,
  p_assessment text,
  p_watchlist jsonb,
  p_registry_items jsonb,
  p_items jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_brief_id uuid;
  v_item jsonb;
  v_source jsonb;
  v_event_id uuid;
  v_update_id uuid;
  v_existing_status public.event_status;
  v_position integer := 0;
  v_source_count integer;
begin
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 5 then
    raise exception 'A brief must contain between 0 and 5 items';
  end if;
  if jsonb_typeof(p_watchlist) <> 'array' or jsonb_array_length(p_watchlist) > 3 then
    raise exception 'A watchlist must contain at most 3 items';
  end if;
  if jsonb_typeof(p_registry_items) <> 'array' or jsonb_array_length(p_registry_items) > 60 then
    raise exception 'The event registry must contain between 0 and 60 items';
  end if;
  if not exists (select 1 from public.processing_runs where id = p_run_id and user_id = p_user_id and state = 'running') then
    raise exception 'Run is not publishable';
  end if;
  if exists (
    select 1 from public.briefs
    where user_id = p_user_id and brief_date = p_brief_date and state = 'complete'
  ) then
    raise exception 'A complete brief already exists for this date';
  end if;

  insert into public.briefs (
    user_id, processing_run_id, brief_date, timezone, state, assessment, item_count,
    no_material_changes, watchlist
  ) values (
    p_user_id, p_run_id, p_brief_date, p_timezone, 'complete', p_assessment,
    jsonb_array_length(p_items), jsonb_array_length(p_items) = 0, p_watchlist
  ) returning id into v_brief_id;

  -- Persist every verified, material event update first. It is intentionally
  -- broader than the user's 0–5 selected brief items.
  for v_item in select value from jsonb_array_elements(p_registry_items)
  loop
    v_position := v_position + 1;
    if coalesce(v_item ->> 'canonicalKey', '') = '' then
      raise exception 'A brief item needs a canonical key';
    end if;
    if coalesce(v_item ->> 'materialFingerprint', '') = '' then
      raise exception 'A brief item needs a material fingerprint';
    end if;

    -- A primary source or two independently published secondary sources is mandatory.
    select count(*) into v_source_count
    from jsonb_array_elements(coalesce(v_item -> 'sources', '[]'::jsonb)) source
    where source ->> 'sourceType' = 'primary';
    if v_source_count = 0 then
      select count(distinct lower(regexp_replace(
        split_part(split_part(source ->> 'url', '//', 2), '/', 1), '^www\.', ''
      ))) into v_source_count
      from jsonb_array_elements(coalesce(v_item -> 'sources', '[]'::jsonb)) source
      where source ->> 'sourceType' = 'secondary';
      if v_source_count < 2 then
        raise exception 'Published item lacks sufficient source verification';
      end if;
    end if;

    select id, status into v_event_id, v_existing_status
    from public.events
    where canonical_key = v_item ->> 'canonicalKey'
    for update;

    if v_event_id is null then
      insert into public.events (
        canonical_key, title, category, actors, regions, status, event_date, effective_date,
        latest_terms_summary, latest_short_term_impact, latest_long_term_impact,
        confidence, latest_relevance_score
      ) values (
        v_item ->> 'canonicalKey', v_item ->> 'title', (v_item ->> 'category')::public.event_category,
        coalesce(v_item -> 'actors', '[]'::jsonb), coalesce(v_item -> 'regions', '[]'::jsonb),
        (v_item ->> 'status')::public.event_status, nullif(v_item ->> 'eventDate', '')::date,
        nullif(v_item ->> 'effectiveDate', '')::date, v_item ->> 'termsSummary',
        v_item ->> 'shortTermImpact', v_item ->> 'longTermImpact',
        (v_item ->> 'confidence')::public.confidence_level, (v_item ->> 'relevanceScore')::smallint
      ) returning id into v_event_id;
    else
      update public.events set
        title = v_item ->> 'title',
        category = (v_item ->> 'category')::public.event_category,
        actors = coalesce(v_item -> 'actors', '[]'::jsonb),
        regions = coalesce(v_item -> 'regions', '[]'::jsonb),
        status = (v_item ->> 'status')::public.event_status,
        event_date = nullif(v_item ->> 'eventDate', '')::date,
        effective_date = nullif(v_item ->> 'effectiveDate', '')::date,
        latest_terms_summary = v_item ->> 'termsSummary',
        latest_short_term_impact = v_item ->> 'shortTermImpact',
        latest_long_term_impact = v_item ->> 'longTermImpact',
        confidence = (v_item ->> 'confidence')::public.confidence_level,
        latest_relevance_score = (v_item ->> 'relevanceScore')::smallint,
        last_status_changed_at = case
          when v_existing_status is distinct from (v_item ->> 'status')::public.event_status then timezone('utc', now())
          else last_status_changed_at
        end
      where id = v_event_id;
    end if;

    insert into public.event_updates (
      event_id, processing_run_id, previous_status, new_status, kind, change_summary,
      terms_summary, effective_date, short_term_impact, long_term_impact, confidence,
      event_date, material_fingerprint
    ) values (
      v_event_id, p_run_id, nullif(v_item ->> 'previousStatus', '')::public.event_status,
      (v_item ->> 'status')::public.event_status, (v_item ->> 'updateKind')::public.update_kind,
      v_item ->> 'whatChanged', v_item ->> 'termsSummary', nullif(v_item ->> 'effectiveDate', '')::date,
      v_item ->> 'shortTermImpact', v_item ->> 'longTermImpact',
      (v_item ->> 'confidence')::public.confidence_level, nullif(v_item ->> 'eventDate', '')::date,
      v_item ->> 'materialFingerprint'
    ) on conflict (event_id, material_fingerprint) do nothing
    returning id into v_update_id;

    if v_update_id is null then
      select id into v_update_id from public.event_updates
      where event_id = v_event_id and material_fingerprint = v_item ->> 'materialFingerprint';
    end if;

    for v_source in select value from jsonb_array_elements(coalesce(v_item -> 'sources', '[]'::jsonb))
    loop
      insert into public.event_sources (
        event_id, event_update_id, source_name, url, source_type, published_at, event_date, supports_claim
      ) values (
        v_event_id, v_update_id, v_source ->> 'sourceName', v_source ->> 'url',
        (v_source ->> 'sourceType')::public.source_type, nullif(v_source ->> 'publishedAt', '')::date,
        nullif(v_source ->> 'eventDate', '')::date, v_source ->> 'supportsClaim'
      ) on conflict (event_update_id, url) do update set
        source_name = excluded.source_name,
        source_type = excluded.source_type,
        published_at = excluded.published_at,
        event_date = excluded.event_date,
        supports_claim = excluded.supports_claim;
    end loop;

    insert into public.user_event_state (
      user_id, event_id, last_considered_update_id
    ) values (
      p_user_id, v_event_id, v_update_id
    ) on conflict (user_id, event_id) do update set
      last_considered_update_id = excluded.last_considered_update_id;
  end loop;

  -- Only a subset of registry updates is delivered to this user's brief.
  v_position := 0;
  for v_item in select value from jsonb_array_elements(p_items)
  loop
    v_position := v_position + 1;
    if coalesce(v_item ->> 'canonicalKey', '') = '' or coalesce(v_item ->> 'materialFingerprint', '') = '' then
      raise exception 'A brief item needs a canonical key and material fingerprint';
    end if;
    if not exists (
      select 1
      from jsonb_array_elements(p_registry_items) registry_item
      where registry_item ->> 'canonicalKey' = v_item ->> 'canonicalKey'
        and registry_item ->> 'materialFingerprint' = v_item ->> 'materialFingerprint'
    ) then
      raise exception 'A brief item must reference a verified registry update';
    end if;

    select id into v_event_id
    from public.events
    where canonical_key = v_item ->> 'canonicalKey';
    select id into v_update_id
    from public.event_updates
    where event_id = v_event_id and material_fingerprint = v_item ->> 'materialFingerprint';
    if v_event_id is null or v_update_id is null then
      raise exception 'Registry event or update is missing for a brief item';
    end if;

    insert into public.brief_items (
      brief_id, event_id, event_update_id, position, relevance_score, relevance_factors,
      title_snapshot, category_snapshot, status_snapshot, event_date_snapshot, what_changed,
      why_relevant, short_term_impact, long_term_impact, recommendation, confidence, systemic_override, direct_alert
    ) values (
      v_brief_id, v_event_id, v_update_id, v_position, (v_item ->> 'relevanceScore')::smallint,
      v_item -> 'relevanceFactors', v_item ->> 'title', (v_item ->> 'category')::public.event_category,
      (v_item ->> 'status')::public.event_status, nullif(v_item ->> 'eventDate', '')::date,
      v_item ->> 'whatChanged', v_item ->> 'whyRelevant', v_item ->> 'shortTermImpact',
      v_item ->> 'longTermImpact', (v_item ->> 'recommendation')::public.recommendation,
      (v_item ->> 'confidence')::public.confidence_level, coalesce((v_item ->> 'systemicOverride')::boolean, false),
      coalesce((v_item ->> 'directAlert')::boolean, false)
    );

    insert into public.user_event_state (
      user_id, event_id, last_considered_update_id, last_published_update_id, last_published_at, last_score
    ) values (
      p_user_id, v_event_id, v_update_id, v_update_id, timezone('utc', now()),
      (v_item ->> 'relevanceScore')::smallint
    ) on conflict (user_id, event_id) do update set
      last_considered_update_id = excluded.last_considered_update_id,
      last_published_update_id = excluded.last_published_update_id,
      last_published_at = excluded.last_published_at,
      last_score = excluded.last_score;
  end loop;

  update public.processing_runs set
    state = 'complete', phase = 'complete', published_count = jsonb_array_length(p_items),
    finished_at = timezone('utc', now()), coverage_to = timezone('utc', now())
  where id = p_run_id;

  return v_brief_id;
end;
$$;

revoke all on function public.publish_daily_brief(uuid, uuid, date, text, text, jsonb, jsonb, jsonb) from public;
grant execute on function public.publish_daily_brief(uuid, uuid, date, text, text, jsonb, jsonb, jsonb) to service_role;
