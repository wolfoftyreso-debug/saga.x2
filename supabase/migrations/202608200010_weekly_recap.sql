-- The weekly recap is a durable view over already published, source-backed
-- event updates. It is intentionally stored on the brief rather than in the
-- global event register: selecting five earlier updates must never create a
-- new event or a second status transition.
alter table public.briefs
  add column if not exists weekly_recap jsonb;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'briefs_weekly_recap_object_check'
      and conrelid = 'public.briefs'::regclass
  ) then
    alter table public.briefs
      add constraint briefs_weekly_recap_object_check
      check (weekly_recap is null or jsonb_typeof(weekly_recap) = 'object');
  end if;
end;
$$;

-- Extend the established 009 publication transaction. The recap references
-- only events, updates, brief snapshots and sources that already exist before
-- this call, while the new daily event cards are saved by the nested wrapper.
-- Any invalid recap rolls the whole transaction back.
create or replace function public.publish_defined_brief_with_pulse_market_and_weekly_recap(
  p_user_id uuid,
  p_brief_definition_id uuid,
  p_run_id uuid,
  p_brief_date date,
  p_timezone text,
  p_assessment text,
  p_watchlist jsonb,
  p_registry_items jsonb,
  p_items jsonb,
  p_world_pulse jsonb,
  p_market_snapshot jsonb,
  p_weekly_recap jsonb
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
  v_expected_event_id uuid;
  v_update_id uuid;
  v_item_date date;
  v_update_date date;
  v_period_start date;
  v_period_end date;
  v_source_count integer;
begin
  if coalesce(jsonb_typeof(p_weekly_recap), '') <> 'object' then
    raise exception 'A weekly recap must be a JSON object';
  end if;
  if coalesce(p_weekly_recap ->> 'periodStart', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
     or coalesce(p_weekly_recap ->> 'periodEnd', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    raise exception 'A weekly recap needs ISO start and end dates';
  end if;
  v_period_start := (p_weekly_recap ->> 'periodStart')::date;
  v_period_end := (p_weekly_recap ->> 'periodEnd')::date;
  if v_period_start > v_period_end
     or v_period_end <> p_brief_date
     or v_period_end - v_period_start > 6 then
    raise exception 'A weekly recap must cover at most the current local week through the brief date';
  end if;
  if char_length(btrim(coalesce(p_weekly_recap ->> 'summary', ''))) < 8 then
    raise exception 'A weekly recap needs a direct summary';
  end if;
  if coalesce(jsonb_typeof(p_weekly_recap -> 'items'), '') <> 'array'
     or jsonb_array_length(p_weekly_recap -> 'items') > 5 then
    raise exception 'A weekly recap needs between 0 and 5 items';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_weekly_recap -> 'items') item
    group by item ->> 'eventUpdateId'
    having count(*) > 1
  ) then
    raise exception 'A weekly recap cannot repeat the same event update';
  end if;

  for v_item in select value from jsonb_array_elements(p_weekly_recap -> 'items')
  loop
    if coalesce(v_item ->> 'eventId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or coalesce(v_item ->> 'eventUpdateId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'A weekly recap item needs event and event-update IDs';
    end if;
    if coalesce(v_item ->> 'date', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
      raise exception 'A weekly recap item needs an ISO date';
    end if;
    if char_length(btrim(coalesce(v_item ->> 'title', ''))) < 8
       or char_length(btrim(coalesce(v_item ->> 'whatChanged', ''))) < 12
       or char_length(btrim(coalesce(v_item ->> 'whyItMatters', ''))) < 8 then
      raise exception 'A weekly recap item needs the stored brief text';
    end if;
    if coalesce(jsonb_typeof(v_item -> 'sources'), '') <> 'array'
       or jsonb_array_length(v_item -> 'sources') = 0
       or jsonb_array_length(v_item -> 'sources') > 3 then
      raise exception 'A weekly recap item needs one to three sources';
    end if;

    v_expected_event_id := (v_item ->> 'eventId')::uuid;
    v_update_id := (v_item ->> 'eventUpdateId')::uuid;
    v_item_date := (v_item ->> 'date')::date;
    if v_item_date < v_period_start or v_item_date > v_period_end then
      raise exception 'A weekly recap item date must lie within the recap period';
    end if;

    select eu.event_id, timezone(p_timezone, eu.occurred_at)::date
    into v_event_id, v_update_date
    from public.event_updates eu
    where eu.id = v_update_id;
    if v_event_id is null or v_event_id <> v_expected_event_id or v_update_date <> v_item_date then
      raise exception 'A weekly recap item must reference its exact persisted event update and local date';
    end if;

    -- Prevent the recap from smuggling in model-written prose. Every display
    -- string must be an exact snapshot from one of this user's older briefs.
    if not exists (
      select 1
      from public.brief_items bi
      join public.briefs b on b.id = bi.brief_id
      where b.user_id = p_user_id
        and b.state = 'complete'
        and bi.event_id = v_event_id
        and bi.event_update_id = v_update_id
        and bi.title_snapshot = v_item ->> 'title'
        and bi.what_changed = v_item ->> 'whatChanged'
        and bi.why_relevant = v_item ->> 'whyItMatters'
    ) then
      raise exception 'A weekly recap item must reuse an owned, persisted brief snapshot';
    end if;

    for v_source in select value from jsonb_array_elements(v_item -> 'sources')
    loop
      if coalesce(v_source ->> 'sourceType', '') not in ('primary', 'secondary')
         or coalesce(v_source ->> 'sourceName', '') = ''
         or coalesce(v_source ->> 'url', '') = ''
         or coalesce(v_source ->> 'supportsClaim', '') = '' then
        raise exception 'A weekly recap source is incomplete';
      end if;
      if not exists (
        select 1
        from public.event_sources es
        where es.event_id = v_event_id
          and es.event_update_id = v_update_id
          and es.source_name = v_source ->> 'sourceName'
          and es.url = v_source ->> 'url'
          and es.source_type = (v_source ->> 'sourceType')::public.source_type
          and coalesce(es.published_at::text, '') = coalesce(v_source ->> 'publishedAt', '')
          and coalesce(es.event_date::text, '') = coalesce(v_source ->> 'eventDate', '')
          and es.supports_claim = v_source ->> 'supportsClaim'
      ) then
        raise exception 'A weekly recap source must match a persisted event source';
      end if;
    end loop;

    -- Preserve the normal source threshold independently of the runner's
    -- policy filter. The function is the final atomic publication boundary.
    select count(*) into v_source_count
    from jsonb_array_elements(v_item -> 'sources') source
    where source ->> 'sourceType' = 'primary';
    if v_source_count = 0 then
      select count(distinct lower(regexp_replace(
        split_part(split_part(source ->> 'url', '//', 2), '/', 1), '^www\.', ''
      ))) into v_source_count
      from jsonb_array_elements(v_item -> 'sources') source
      where source ->> 'sourceType' = 'secondary';
      if v_source_count < 2 then
        raise exception 'A weekly recap item lacks sufficient source verification';
      end if;
    end if;
  end loop;

  v_brief_id := public.publish_defined_brief_with_pulse_and_market(
    p_user_id,
    p_brief_definition_id,
    p_run_id,
    p_brief_date,
    p_timezone,
    p_assessment,
    p_watchlist,
    p_registry_items,
    p_items,
    p_world_pulse,
    p_market_snapshot
  );

  update public.briefs
  set weekly_recap = p_weekly_recap
  where id = v_brief_id;

  return v_brief_id;
end;
$$;

revoke all on function public.publish_defined_brief_with_pulse_market_and_weekly_recap(uuid, uuid, uuid, date, text, text, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.publish_defined_brief_with_pulse_market_and_weekly_recap(uuid, uuid, uuid, date, text, text, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb)
  to service_role;
