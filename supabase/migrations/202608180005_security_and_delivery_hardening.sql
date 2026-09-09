-- Security, ownership and durable-delivery hardening.
--
-- This migration is deliberately forward-only. It removes client-side paths
-- that could turn a guessed event id into access, keeps source blocking true at
-- the database boundary, and makes a delivery retryable until a chat message
-- has actually been written.

-- A user may read an event because it appeared in their brief or because a
-- trusted server-side watch delivery explicitly granted access. A watch row by
-- itself is never an access grant.
create table if not exists public.user_event_access_grants (
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  event_id uuid not null references public.events(id) on delete cascade,
  grant_reason text not null check (grant_reason in ('brief', 'watch_delivery')),
  brief_id uuid references public.briefs(id) on delete set null,
  watch_delivery_id uuid,
  created_at timestamptz not null default timezone('utc', now()),
  primary key (user_id, event_id)
);
create index if not exists user_event_access_grants_event_idx
  on public.user_event_access_grants(event_id, user_id);

-- Backfill only from a brief that was already actually delivered to the user.
insert into public.user_event_access_grants (user_id, event_id, grant_reason, brief_id)
select distinct b.user_id, bi.event_id, 'brief', b.id
from public.briefs b
join public.brief_items bi on bi.brief_id = b.id
where b.state = 'complete'
on conflict (user_id, event_id) do nothing;

-- Delivery rows used to be created before their conversation message. Make the
-- intermediate state explicit, so a failed message write can be retried rather
-- than permanently consuming the unique (watch, event_update) key.
alter table public.watch_deliveries add column if not exists delivery_state text;
alter table public.watch_deliveries add column if not exists attempt_count integer not null default 0;
alter table public.watch_deliveries add column if not exists last_attempt_at timestamptz;
alter table public.watch_deliveries add column if not exists next_attempt_at timestamptz;
alter table public.watch_deliveries add column if not exists last_error text;

update public.watch_deliveries
set delivery_state = case when conversation_message_id is null then 'pending' else 'delivered' end
where delivery_state is null;
alter table public.watch_deliveries alter column delivery_state set default 'pending';
alter table public.watch_deliveries alter column delivery_state set not null;
alter table public.user_event_access_grants
  add constraint user_event_access_grants_watch_delivery_id_fkey
  foreign key (watch_delivery_id) references public.watch_deliveries(id) on delete set null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'watch_deliveries_state_check'
      and conrelid = 'public.watch_deliveries'::regclass
  ) then
    alter table public.watch_deliveries add constraint watch_deliveries_state_check
      check (delivery_state in ('pending', 'delivered', 'failed'));
  end if;
end;
$$;

create index if not exists watch_deliveries_retry_idx
  on public.watch_deliveries(delivery_state, next_attempt_at)
  where delivery_state in ('pending', 'failed');

create or replace function public.validate_watch_delivery_state()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.delivery_state = 'delivered' and new.conversation_message_id is null then
    raise exception 'A delivered watch row must reference its conversation message';
  end if;
  if new.delivery_state = 'delivered' then
    if tg_op = 'INSERT' or old.delivery_state is distinct from 'delivered' then
      new.delivered_at = timezone('utc', now());
    end if;
    new.next_attempt_at = null;
    new.last_error = null;
  end if;
  return new;
end;
$$;

drop trigger if exists watch_deliveries_validate_state_before_write on public.watch_deliveries;
create trigger watch_deliveries_validate_state_before_write
before insert or update of delivery_state, conversation_message_id on public.watch_deliveries
for each row execute function public.validate_watch_delivery_state();

create or replace function public.grant_event_access_from_brief_item()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
begin
  select user_id into v_user_id from public.briefs where id = new.brief_id;
  if v_user_id is not null then
    insert into public.user_event_access_grants (user_id, event_id, grant_reason, brief_id)
    values (v_user_id, new.event_id, 'brief', new.brief_id)
    on conflict (user_id, event_id) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists brief_items_grant_event_access_after_insert on public.brief_items;
create trigger brief_items_grant_event_access_after_insert
after insert on public.brief_items
for each row execute function public.grant_event_access_from_brief_item();

create or replace function public.grant_event_access_from_watch_delivery()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_event_id uuid;
begin
  if new.delivery_state <> 'delivered'
     or (tg_op = 'UPDATE' and old.delivery_state = 'delivered') then
    return new;
  end if;

  select w.user_id, u.event_id into v_user_id, v_event_id
  from public.watches w
  join public.event_updates u on u.id = new.event_update_id
  where w.id = new.watch_id;

  if v_user_id is not null and v_event_id is not null then
    insert into public.user_event_access_grants (user_id, event_id, grant_reason, watch_delivery_id)
    values (v_user_id, v_event_id, 'watch_delivery', new.id)
    on conflict (user_id, event_id) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists watch_deliveries_grant_event_access_after_delivery on public.watch_deliveries;
create trigger watch_deliveries_grant_event_access_after_delivery
after insert or update of delivery_state on public.watch_deliveries
for each row execute function public.grant_event_access_from_watch_delivery();

insert into public.user_event_access_grants (user_id, event_id, grant_reason, watch_delivery_id)
select w.user_id, u.event_id, 'watch_delivery', d.id
from public.watch_deliveries d
join public.watches w on w.id = d.watch_id
join public.event_updates u on u.id = d.event_update_id
where d.delivery_state = 'delivered'
on conflict (user_id, event_id) do nothing;

-- A brief definition is a durable delivery contract. Historical records must
-- not silently lose their definition if a client tries to delete a row.
alter table public.briefs drop constraint if exists briefs_brief_definition_id_fkey;
alter table public.briefs add constraint briefs_brief_definition_id_fkey
  foreign key (brief_definition_id) references public.brief_definitions(id) on delete restrict;
alter table public.processing_runs drop constraint if exists processing_runs_brief_definition_id_fkey;
alter table public.processing_runs add constraint processing_runs_brief_definition_id_fkey
  foreign key (brief_definition_id) references public.brief_definitions(id) on delete restrict;
alter table public.brief_event_state drop constraint if exists brief_event_state_brief_definition_id_fkey;
alter table public.brief_event_state add constraint brief_event_state_brief_definition_id_fkey
  foreign key (brief_definition_id) references public.brief_definitions(id) on delete restrict;

create or replace function public.protect_primary_brief_definition()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' and old.is_primary then
    raise exception 'The primary brief definition cannot be deleted';
  end if;
  if tg_op = 'UPDATE' and old.is_primary and (not new.is_primary or not new.active or new.kind <> 'main') then
    raise exception 'The primary brief definition must remain active, primary and of kind main';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists brief_definitions_protect_primary_before_write on public.brief_definitions;
create trigger brief_definitions_protect_primary_before_write
before update or delete on public.brief_definitions
for each row execute function public.protect_primary_brief_definition();

-- A service-role bug must not be able to attach another user's definition to a
-- brief, run or per-definition delivery state.
create or replace function public.enforce_brief_definition_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_definition_user_id uuid;
begin
  if new.brief_definition_id is null then
    return new;
  end if;
  select user_id into v_definition_user_id
  from public.brief_definitions
  where id = new.brief_definition_id;
  if v_definition_user_id is null or v_definition_user_id <> new.user_id then
    raise exception 'Brief definition must belong to the same user';
  end if;
  return new;
end;
$$;

drop trigger if exists briefs_enforce_definition_owner_before_write on public.briefs;
create trigger briefs_enforce_definition_owner_before_write
before insert or update of user_id, brief_definition_id on public.briefs
for each row execute function public.enforce_brief_definition_owner();
drop trigger if exists processing_runs_enforce_definition_owner_before_write on public.processing_runs;
create trigger processing_runs_enforce_definition_owner_before_write
before insert or update of user_id, brief_definition_id on public.processing_runs
for each row execute function public.enforce_brief_definition_owner();
drop trigger if exists brief_event_state_enforce_definition_owner_before_write on public.brief_event_state;
create trigger brief_event_state_enforce_definition_owner_before_write
before insert or update of user_id, brief_definition_id on public.brief_event_state
for each row execute function public.enforce_brief_definition_owner();

-- A source catalog is a canonical registry. User policies and stored event
-- citations keep their source_id in sync when a matching catalog domain exists.
create or replace function public.catalog_domain_from_url(p_url text)
returns text
language sql
immutable
set search_path = public
as $$
  select lower(regexp_replace(
    regexp_replace(split_part(coalesce(p_url, ''), '://', 2), '/.*$', ''),
    '^www[.]', ''
  ));
$$;

create or replace function public.assign_source_catalog_reference()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_host text;
begin
  v_host := public.catalog_domain_from_url(new.url);
  select id into new.source_id
  from public.source_catalog
  where v_host = domain or v_host like ('%.' || domain)
  order by char_length(domain) desc
  limit 1;
  return new;
end;
$$;

drop trigger if exists event_sources_assign_catalog_before_write on public.event_sources;
create trigger event_sources_assign_catalog_before_write
before insert or update of url on public.event_sources
for each row execute function public.assign_source_catalog_reference();
update public.event_sources set url = url where source_id is null;

create or replace function public.sync_user_source_policy_catalog_reference()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_catalog_id uuid;
begin
  new.domain := lower(regexp_replace(new.domain, '^www[.]', ''));
  select id into v_catalog_id from public.source_catalog where domain = new.domain;
  new.source_id := v_catalog_id;
  return new;
end;
$$;

drop trigger if exists user_source_policies_sync_catalog_before_write on public.user_source_policies;
create trigger user_source_policies_sync_catalog_before_write
before insert or update of domain on public.user_source_policies
for each row execute function public.sync_user_source_policy_catalog_reference();
update public.user_source_policies set domain = domain;

-- Definition-scoped overrides inherit the user's global policy for any field
-- left NULL. This lets a technology brief use a stricter source set without
-- changing the user's main or local brief.
create table if not exists public.brief_source_policies (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  brief_definition_id uuid not null references public.brief_definitions(id) on delete cascade,
  source_id uuid references public.source_catalog(id) on delete set null,
  domain text not null check (char_length(domain) between 3 and 255),
  active boolean,
  blocked boolean,
  priority text check (priority is null or priority in ('high', 'normal', 'low')),
  roles jsonb check (roles is null or jsonb_typeof(roles) = 'array'),
  topic_filter text,
  verification_requirement text check (verification_requirement is null or verification_requirement in ('none', 'verify_material', 'primary_only', 'two_independent')),
  frequency text check (frequency is null or frequency in ('all_relevant', 'daily', 'weekly', 'material')),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (brief_definition_id, domain)
);
create index if not exists brief_source_policies_user_definition_idx
  on public.brief_source_policies(user_id, brief_definition_id);

create or replace function public.validate_brief_source_policy_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_definition_user_id uuid;
  v_catalog_id uuid;
begin
  new.domain := lower(regexp_replace(new.domain, '^www[.]', ''));
  select user_id into v_definition_user_id from public.brief_definitions where id = new.brief_definition_id;
  if v_definition_user_id is null or v_definition_user_id <> new.user_id then
    raise exception 'Brief source policy must belong to the definition owner';
  end if;
  select id into v_catalog_id from public.source_catalog where domain = new.domain;
  new.source_id := v_catalog_id;
  return new;
end;
$$;

drop trigger if exists brief_source_policies_validate_before_write on public.brief_source_policies;
create trigger brief_source_policies_validate_before_write
before insert or update of user_id, brief_definition_id, domain on public.brief_source_policies
for each row execute function public.validate_brief_source_policy_owner();
create trigger brief_source_policies_updated_at before update on public.brief_source_policies
for each row execute function public.set_updated_at();

-- Client RLS is deliberately read-mostly. Mutations go through authenticated
-- server routes that validate ownership and use service_role. This eliminates
-- direct role forgery, primary brief deletion and unvalidated source rows.
alter table public.user_event_access_grants enable row level security;
alter table public.brief_source_policies enable row level security;

-- Conversation messages are written by service routes, but ownership must still
-- be enforced in the database. This prevents an implementation error from
-- attaching one user's message, brief or watch to another user's thread.
create or replace function public.enforce_conversation_message_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conversation_user_id uuid;
  v_brief_user_id uuid;
  v_watch_user_id uuid;
begin
  select user_id into v_conversation_user_id
  from public.conversations
  where id = new.conversation_id;
  if v_conversation_user_id is null or v_conversation_user_id <> new.user_id then
    raise exception 'Conversation message must belong to its conversation owner';
  end if;

  if new.brief_id is not null then
    select user_id into v_brief_user_id from public.briefs where id = new.brief_id;
    if v_brief_user_id is null or v_brief_user_id <> new.user_id then
      raise exception 'Conversation brief must belong to the message owner';
    end if;
  end if;

  if new.watch_id is not null then
    select user_id into v_watch_user_id from public.watches where id = new.watch_id;
    if v_watch_user_id is null or v_watch_user_id <> new.user_id then
      raise exception 'Conversation watch must belong to the message owner';
    end if;
  end if;

  if new.event_id is not null and not exists (
    select 1 from public.user_event_access_grants g
    where g.user_id = new.user_id and g.event_id = new.event_id
  ) and not exists (
    select 1
    from public.brief_items bi
    join public.briefs b on b.id = bi.brief_id
    where bi.event_id = new.event_id and b.user_id = new.user_id
  ) and not exists (
    -- A pending trusted watch delivery must create its chat message before the
    -- delivery transition grants normal event access. This narrow exception is
    -- the only valid pre-grant event reference.
    select 1
    from public.watch_deliveries d
    join public.watches w on w.id = d.watch_id
    join public.event_updates u on u.id = d.event_update_id
    where d.watch_id = new.watch_id
      and w.user_id = new.user_id
      and u.event_id = new.event_id
      and d.delivery_state in ('pending', 'failed')
  ) then
    raise exception 'Conversation event has not been delivered to the message owner';
  end if;
  return new;
end;
$$;
drop trigger if exists conversation_messages_enforce_owner_before_write on public.conversation_messages;
create trigger conversation_messages_enforce_owner_before_write
before insert or update of conversation_id, user_id, brief_id, event_id, watch_id on public.conversation_messages
for each row execute function public.enforce_conversation_message_owner();

drop policy if exists "Users manage their watches" on public.watches;
create policy "Users read their watches" on public.watches
  for select using (auth.uid() = user_id);
create or replace function public.current_user_can_watch_event(p_event_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.brief_items bi
    join public.briefs b on b.id = bi.brief_id
    where bi.event_id = p_event_id and b.user_id = auth.uid()
  ) or exists (
    select 1 from public.user_event_access_grants g
    where g.event_id = p_event_id and g.user_id = auth.uid()
  );
$$;
revoke all on function public.current_user_can_watch_event(uuid) from public, anon;
grant execute on function public.current_user_can_watch_event(uuid) to authenticated, service_role;
create policy "Users create accessible watches" on public.watches
  for insert with check (
    auth.uid() = user_id
    and (event_id is null or public.current_user_can_watch_event(event_id))
  );
create policy "Users update their accessible watches" on public.watches
  for update using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and (event_id is null or public.current_user_can_watch_event(event_id))
  );
create policy "Users delete their watches" on public.watches
  for delete using (auth.uid() = user_id);

drop policy if exists "Users read watched events" on public.events;
drop policy if exists "Users read watched updates" on public.event_updates;
drop policy if exists "Users read sources for watched events" on public.event_sources;
drop policy if exists "Users read their sources" on public.event_sources;
create policy "Users read granted events" on public.events
  for select using (exists (
    select 1 from public.user_event_access_grants g
    where g.user_id = auth.uid() and g.event_id = events.id
  ));
create policy "Users read granted updates" on public.event_updates
  for select using (exists (
    select 1 from public.user_event_access_grants g
    where g.user_id = auth.uid() and g.event_id = event_updates.event_id
  ));
create policy "Users read their event access grants" on public.user_event_access_grants
  for select using (auth.uid() = user_id);

drop policy if exists "Users manage their conversations" on public.conversations;
create policy "Users read their conversations" on public.conversations
  for select using (auth.uid() = user_id);
drop policy if exists "Users manage their conversation messages" on public.conversation_messages;
create policy "Users read their own conversation messages" on public.conversation_messages
  for select using (
    auth.uid() = user_id
    and exists (
      select 1 from public.conversations c
      where c.id = conversation_messages.conversation_id
        and c.user_id = auth.uid()
    )
  );

drop policy if exists "Users manage their brief definitions" on public.brief_definitions;
create policy "Users read their brief definitions" on public.brief_definitions
  for select using (auth.uid() = user_id);
drop policy if exists "Users manage their source policies" on public.user_source_policies;
create policy "Users read their source policies" on public.user_source_policies
  for select using (auth.uid() = user_id);
create policy "Users read their brief source policies" on public.brief_source_policies
  for select using (auth.uid() = user_id);

-- A monitor pass can persist a verified registry update without manufacturing a
-- second daily brief. It mirrors the event/update/source portion of
-- publish_defined_brief and remains callable only by the server role.
alter table public.processing_runs drop constraint if exists processing_runs_triggered_by_check;
alter table public.processing_runs add constraint processing_runs_triggered_by_check
  check (triggered_by in ('cron', 'manual', 'retry', 'watch'));

create or replace function public.publish_registry_updates(
  p_user_id uuid,
  p_run_id uuid,
  p_registry_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item jsonb;
  v_source jsonb;
  v_event_id uuid;
  v_update_id uuid;
  v_existing_status public.event_status;
  v_source_count integer;
  v_results jsonb := '[]'::jsonb;
begin
  if coalesce(jsonb_typeof(p_registry_items), '') <> 'array' or jsonb_array_length(p_registry_items) > 60 then
    raise exception 'The event registry must contain between 0 and 60 items';
  end if;
  if not exists (
    select 1 from public.processing_runs
    where id = p_run_id and user_id = p_user_id and state = 'running'
  ) then
    raise exception 'Run is not publishable';
  end if;

  for v_item in select value from jsonb_array_elements(p_registry_items)
  loop
    if coalesce(v_item ->> 'canonicalKey', '') = ''
       or coalesce(v_item ->> 'materialFingerprint', '') = '' then
      raise exception 'A registry item needs a canonical key and material fingerprint';
    end if;

    select count(*) into v_source_count
    from jsonb_array_elements(coalesce(v_item -> 'sources', '[]'::jsonb)) source
    where source ->> 'sourceType' = 'primary';
    if v_source_count = 0 then
      select count(distinct lower(regexp_replace(
        split_part(split_part(source ->> 'url', '//', 2), '/', 1), '^www[.]', ''
      ))) into v_source_count
      from jsonb_array_elements(coalesce(v_item -> 'sources', '[]'::jsonb)) source
      where source ->> 'sourceType' = 'secondary';
      if v_source_count < 2 then
        raise exception 'Registry item lacks sufficient source verification';
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
      select id into v_update_id
      from public.event_updates
      where event_id = v_event_id
        and material_fingerprint = v_item ->> 'materialFingerprint';
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

    insert into public.user_event_state (user_id, event_id, last_considered_update_id)
    values (p_user_id, v_event_id, v_update_id)
    on conflict (user_id, event_id) do update set
      last_considered_update_id = excluded.last_considered_update_id;

    v_results := v_results || jsonb_build_array(jsonb_build_object(
      'canonicalKey', v_item ->> 'canonicalKey',
      'eventId', v_event_id,
      'eventUpdateId', v_update_id
    ));
  end loop;

  update public.processing_runs set
    state = 'complete',
    phase = 'complete',
    published_count = 0,
    finished_at = timezone('utc', now()),
    coverage_to = timezone('utc', now())
  where id = p_run_id;

  return v_results;
end;
$$;

revoke all on function public.publish_registry_updates(uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.publish_registry_updates(uuid, uuid, jsonb)
  to service_role;
