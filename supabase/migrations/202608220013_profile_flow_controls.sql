-- Flow controls are user-owned switches for independently sourced brief
-- layers and in-app direct-alert timing. They never lower publication or
-- source-verification requirements; disabling a layer merely prevents that
-- one layer from being searched, generated and persisted on future briefs.
create table if not exists public.profile_flow_controls (
  user_id uuid primary key references public.profiles(user_id) on delete cascade,
  world_pulse_enabled boolean not null default true,
  weekly_recap_enabled boolean not null default true,
  strategic_radar_enabled boolean not null default true,
  market_snapshot_enabled boolean not null default true,
  company_focus_enabled boolean not null default true,
  direct_alerts_enabled boolean not null default true,
  quiet_hours_enabled boolean not null default false,
  quiet_hours_start time not null default '22:00',
  quiet_hours_end time not null default '07:00',
  allow_systemic_during_quiet_hours boolean not null default true,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint profile_flow_controls_quiet_hours_check
    check (not quiet_hours_enabled or quiet_hours_start <> quiet_hours_end)
);

-- Existing users keep the complete, current product behaviour until they
-- intentionally change a control. New users are covered by the workspace
-- trigger below and by the fallback in the server reader.
insert into public.profile_flow_controls (user_id)
select p.user_id
from public.profiles p
where not exists (
  select 1 from public.profile_flow_controls c where c.user_id = p.user_id
);

create or replace function public.ensure_flow_controls_for_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profile_flow_controls (user_id)
  values (new.user_id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists profiles_flow_controls_after_insert on public.profiles;
create trigger profiles_flow_controls_after_insert
after insert on public.profiles
for each row execute function public.ensure_flow_controls_for_profile();

drop trigger if exists profile_flow_controls_updated_at on public.profile_flow_controls;
create trigger profile_flow_controls_updated_at
before update on public.profile_flow_controls
for each row execute function public.set_updated_at();

alter table public.profile_flow_controls enable row level security;
drop policy if exists "Users read their flow controls" on public.profile_flow_controls;
create policy "Users read their flow controls" on public.profile_flow_controls
  for select using (auth.uid() = user_id);

-- The service-owned route remains the only direct mutation path, matching the
-- hardening model used for profile/brief configuration in migration 005.

-- Existing publication wrappers were intentionally strict but assumed that
-- all primary-brief modules were always present. This optional-module wrapper
-- preserves atomic publication while allowing the user to disable one layer
-- without pretending its absence was a failed or complete scan.
create or replace function public.publish_defined_brief_with_optional_modules(
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
  p_weekly_recap jsonb,
  p_strategic_radar jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_brief_id uuid;
  v_section text;
  v_instrument jsonb;
  v_instrument_id text;
  v_instrument_count integer;
  v_available_count integer := 0;
  v_expected_ids text[];
  v_seen_ids text[] := array[]::text[];
  v_radar_section jsonb;
  v_recap_item jsonb;
begin
  if (p_world_pulse is not null or p_market_snapshot is not null or p_weekly_recap is not null or p_strategic_radar is not null)
     and not exists (
       select 1 from public.brief_definitions
       where id = p_brief_definition_id and user_id = p_user_id and is_primary
     ) then
    raise exception 'Optional daily modules may only be published on the primary brief';
  end if;

  if p_world_pulse is not null then
    if jsonb_typeof(p_world_pulse) <> 'object'
       or coalesce(p_world_pulse ->> 'coverage', '') <> 'complete'
       or coalesce(p_world_pulse ->> 'overallStatus', '') not in ('calm', 'changed')
       or coalesce(p_world_pulse ->> 'asOf', '') = ''
       or coalesce(p_world_pulse ->> 'summary', '') = '' then
      raise exception 'A stored world pulse must be a complete, sourced pulse';
    end if;
    foreach v_section in array array['conflictSecurity', 'economy', 'personalExposure']
    loop
      if coalesce(jsonb_typeof(p_world_pulse -> v_section), '') <> 'object'
         or coalesce(p_world_pulse -> v_section ->> 'status', '') not in ('changed', 'stable')
         or coalesce(jsonb_typeof(p_world_pulse -> v_section -> 'sources'), '') <> 'array'
         or jsonb_array_length(p_world_pulse -> v_section -> 'sources') = 0 then
        raise exception 'A complete world pulse needs a sourced % section', v_section;
      end if;
    end loop;
  end if;

  if p_market_snapshot is not null then
    if jsonb_typeof(p_market_snapshot) <> 'object'
       or coalesce(p_market_snapshot ->> 'coverage', '') not in ('complete', 'partial', 'unavailable')
       or coalesce(p_market_snapshot ->> 'fetchedAt', '') = ''
       or coalesce(jsonb_typeof(p_market_snapshot -> 'instruments'), '') <> 'array' then
      raise exception 'A market snapshot needs an explicit, timestamped instrument set';
    end if;
    v_instrument_count := jsonb_array_length(p_market_snapshot -> 'instruments');
    if v_instrument_count = 6 then
      v_expected_ids := array['omxs30', 'sp500', 'nasdaq_composite', 'stoxx_europe_600', 'usd_sek', 'eur_sek'];
    elsif v_instrument_count = 9 then
      v_expected_ids := array['omxs30', 'sp500', 'nasdaq_composite', 'stoxx_europe_600', 'usd_sek', 'eur_sek', 'tesla', 'alphabet', 'investor_ab'];
    else
      raise exception 'A market snapshot needs exactly six macro/FX or nine current standard instruments';
    end if;
    for v_instrument in select value from jsonb_array_elements(p_market_snapshot -> 'instruments')
    loop
      v_instrument_id := nullif(v_instrument ->> 'id', '');
      if v_instrument_id is null or not (v_instrument_id = any(v_expected_ids)) or v_instrument_id = any(v_seen_ids) then
        raise exception 'Market snapshot instruments must contain every expected ID exactly once';
      end if;
      v_seen_ids := array_append(v_seen_ids, v_instrument_id);
      if coalesce(v_instrument ->> 'availability', '') = 'available' then
        v_available_count := v_available_count + 1;
        if nullif(v_instrument ->> 'value', '') is null
           or nullif(v_instrument ->> 'currency', '') is null
           or nullif(v_instrument ->> 'symbol', '') is null then
          raise exception 'An available market instrument needs a value, currency and provider symbol';
        end if;
      elsif coalesce(v_instrument ->> 'availability', '') <> 'unavailable' then
        raise exception 'A market instrument needs an explicit availability state';
      end if;
    end loop;
    if (p_market_snapshot ->> 'coverage') = 'complete' and v_available_count <> v_instrument_count then
      raise exception 'Complete market coverage requires every included instrument';
    end if;
    if (p_market_snapshot ->> 'coverage') = 'partial'
       and (v_available_count = 0 or v_available_count = v_instrument_count) then
      raise exception 'Partial market coverage requires both available and unavailable instruments';
    end if;
    if (p_market_snapshot ->> 'coverage') = 'unavailable' and v_available_count <> 0 then
      raise exception 'Unavailable market coverage cannot contain prices';
    end if;
  end if;

  if p_weekly_recap is not null then
    if jsonb_typeof(p_weekly_recap) <> 'object'
       or coalesce(p_weekly_recap ->> 'periodStart', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
       or coalesce(p_weekly_recap ->> 'periodEnd', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
       or (p_weekly_recap ->> 'periodEnd')::date <> p_brief_date
       or (p_weekly_recap ->> 'periodStart')::date > (p_weekly_recap ->> 'periodEnd')::date
       or (p_weekly_recap ->> 'periodEnd')::date - (p_weekly_recap ->> 'periodStart')::date > 6
       or char_length(btrim(coalesce(p_weekly_recap ->> 'summary', ''))) < 8
       or coalesce(jsonb_typeof(p_weekly_recap -> 'items'), '') <> 'array'
       or jsonb_array_length(p_weekly_recap -> 'items') > 5 then
      raise exception 'A weekly recap needs a valid local-week period and up to five persisted items';
    end if;
    if exists (
      select 1 from jsonb_array_elements(p_weekly_recap -> 'items') recap_item
      group by recap_item ->> 'eventUpdateId' having count(*) > 1
    ) then
      raise exception 'A weekly recap cannot repeat an event update';
    end if;
    for v_recap_item in select value from jsonb_array_elements(p_weekly_recap -> 'items')
    loop
      if coalesce(v_recap_item ->> 'eventId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         or coalesce(v_recap_item ->> 'eventUpdateId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         or coalesce(jsonb_typeof(v_recap_item -> 'sources'), '') <> 'array'
         or jsonb_array_length(v_recap_item -> 'sources') = 0 then
        raise exception 'A weekly recap item needs persisted event/update references and sources';
      end if;
    end loop;
  end if;

  if p_strategic_radar is not null then
    if jsonb_typeof(p_strategic_radar) <> 'object'
       or coalesce(p_strategic_radar ->> 'coverage', '') not in ('complete', 'partial', 'unavailable')
       or coalesce(p_strategic_radar ->> 'asOf', '') = '' then
      raise exception 'A strategic radar needs an explicit coverage state and as-of time';
    end if;
    foreach v_section in array array['aiRoadmap', 'businessOpportunities', 'contexts']
    loop
      v_radar_section := p_strategic_radar -> v_section;
      if coalesce(jsonb_typeof(v_radar_section), '') <> 'object'
         or coalesce(v_radar_section ->> 'status', '') not in ('items_found', 'none_relevant', 'unavailable')
         or coalesce(v_radar_section ->> 'summary', '') = ''
         or coalesce(jsonb_typeof(v_radar_section -> 'items'), '') <> 'array'
         or jsonb_array_length(v_radar_section -> 'items') > 3 then
        raise exception 'A strategic radar needs a valid % section', v_section;
      end if;
      if (v_radar_section ->> 'status') = 'items_found' and jsonb_array_length(v_radar_section -> 'items') = 0 then
        raise exception 'A strategic radar section with items_found needs an item';
      end if;
      if (v_radar_section ->> 'status') = 'none_relevant'
         and (jsonb_array_length(v_radar_section -> 'items') <> 0 or v_radar_section ->> 'summary' <> 'Ingen relevant post.') then
        raise exception 'An empty strategic radar section must use its exact empty state';
      end if;
    end loop;
  end if;

  v_brief_id := public.publish_defined_brief(
    p_user_id,
    p_brief_definition_id,
    p_run_id,
    p_brief_date,
    p_timezone,
    p_assessment,
    p_watchlist,
    p_registry_items,
    p_items
  );

  update public.briefs
  set
    world_pulse = p_world_pulse,
    market_snapshot = p_market_snapshot,
    weekly_recap = p_weekly_recap,
    strategic_radar = p_strategic_radar,
    no_material_changes = case
      when p_world_pulse is not null then jsonb_array_length(p_items) = 0 and (p_world_pulse ->> 'overallStatus') = 'calm'
      else jsonb_array_length(p_items) = 0
    end
  where id = v_brief_id;

  return v_brief_id;
end;
$$;

revoke all on function public.publish_defined_brief_with_optional_modules(uuid, uuid, uuid, date, text, text, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.publish_defined_brief_with_optional_modules(uuid, uuid, uuid, date, text, text, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb)
  to service_role;
