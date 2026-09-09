-- The strategic radar is an auditable, source-backed companion to the primary
-- daily brief. It is not part of the durable event register: future model
-- capabilities, open business paths and dated contexts can be useful before
-- they are a material change in the user's operating environment.
alter table public.briefs
  add column if not exists strategic_radar jsonb;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'briefs_strategic_radar_object_check'
      and conrelid = 'public.briefs'::regclass
  ) then
    alter table public.briefs
      add constraint briefs_strategic_radar_object_check
      check (strategic_radar is null or jsonb_typeof(strategic_radar) = 'object');
  end if;
end;
$$;

-- This is deliberately a wrapper around migration 010's atomic publication
-- transaction. A radar validation or write failure therefore rolls back the
-- weekly recap, market snapshot, pulse, event registry and completed brief as
-- one unit.
create or replace function public.publish_defined_brief_with_pulse_market_weekly_recap_and_strategic_radar(
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
  v_section_name text;
  v_section jsonb;
  v_item jsonb;
  v_primary_sources integer;
  v_secondary_publishers integer;
  v_unavailable_sections integer := 0;
begin
  if not exists (
    select 1
    from public.brief_definitions
    where id = p_brief_definition_id
      and user_id = p_user_id
      and is_primary
  ) then
    raise exception 'A strategic radar may only be published on the primary brief';
  end if;
  if coalesce(jsonb_typeof(p_strategic_radar), '') <> 'object' then
    raise exception 'A strategic radar must be a JSON object';
  end if;
  if coalesce(p_strategic_radar ->> 'coverage', '') not in ('complete', 'partial', 'unavailable') then
    raise exception 'A strategic radar needs an explicit coverage state';
  end if;
  if coalesce(p_strategic_radar ->> 'asOf', '') = '' then
    raise exception 'A strategic radar needs an as-of time';
  end if;

  foreach v_section_name in array array['aiRoadmap', 'businessOpportunities', 'contexts']
  loop
    v_section := p_strategic_radar -> v_section_name;
    if coalesce(jsonb_typeof(v_section), '') <> 'object' then
      raise exception 'A strategic radar needs the % section', v_section_name;
    end if;
    if coalesce(v_section ->> 'status', '') not in ('items_found', 'none_relevant', 'unavailable') then
      raise exception 'A strategic radar section needs an explicit status';
    end if;
    if coalesce(v_section ->> 'summary', '') = '' then
      raise exception 'A strategic radar section needs a summary';
    end if;
    if coalesce(jsonb_typeof(v_section -> 'items'), '') <> 'array'
       or jsonb_array_length(v_section -> 'items') > 3 then
      raise exception 'A strategic radar section needs between 0 and 3 items';
    end if;
    if (v_section ->> 'status') = 'items_found' and jsonb_array_length(v_section -> 'items') = 0 then
      raise exception 'A strategic radar section with items_found needs at least one item';
    end if;
    if (v_section ->> 'status') = 'none_relevant'
       and (jsonb_array_length(v_section -> 'items') <> 0 or v_section ->> 'summary' <> 'Ingen relevant post.') then
      raise exception 'An empty strategic radar section must say Ingen relevant post.';
    end if;
    if (v_section ->> 'status') = 'unavailable' and jsonb_array_length(v_section -> 'items') <> 0 then
      raise exception 'An unavailable strategic radar section cannot include items';
    end if;
    if (v_section ->> 'status') = 'unavailable' then
      v_unavailable_sections := v_unavailable_sections + 1;
    end if;

    for v_item in select value from jsonb_array_elements(v_section -> 'items')
    loop
      if coalesce(v_item ->> 'kind', '') = ''
         or coalesce(v_item ->> 'title', '') = ''
         or coalesce(v_item ->> 'status', '') = ''
         or coalesce(v_item ->> 'whatChanged', '') = ''
         or coalesce(v_item ->> 'whyRelevant', '') = ''
         or coalesce(v_item ->> 'nextStep', '') = '' then
        raise exception 'A strategic radar item is missing required content';
      end if;
      if coalesce(jsonb_typeof(v_item -> 'sources'), '') <> 'array'
         or jsonb_array_length(v_item -> 'sources') = 0
         or jsonb_array_length(v_item -> 'sources') > 3 then
        raise exception 'A strategic radar item needs between 1 and 3 sources';
      end if;

      if v_section_name = 'aiRoadmap'
         and ((v_item ->> 'kind') <> 'ai_roadmap' or (v_item ->> 'status') not in ('officially_announced', 'official_roadmap')) then
        raise exception 'The AI roadmap only accepts officially announced or official-roadmap model capabilities';
      end if;
      if v_section_name = 'businessOpportunities'
         and ((v_item ->> 'kind') <> 'business_opportunity' or (v_item ->> 'status') not in ('announced', 'open', 'deadline')) then
        raise exception 'The business radar item does not match its section';
      end if;
      if v_section_name = 'contexts'
         and ((v_item ->> 'kind') <> 'context' or (v_item ->> 'status') not in ('upcoming', 'registration_open', 'deadline')
           or nullif(v_item ->> 'date', '') is null or nullif(v_item ->> 'location', '') is null) then
        raise exception 'A context needs type, status, date and location or Digitalt';
      end if;

      select count(*) into v_primary_sources
      from jsonb_array_elements(v_item -> 'sources') source
      where source ->> 'sourceType' = 'primary';
      select count(distinct lower(regexp_replace(
        split_part(split_part(source ->> 'url', '//', 2), '/', 1), '^www\.', ''
      ))) into v_secondary_publishers
      from jsonb_array_elements(v_item -> 'sources') source
      where source ->> 'sourceType' = 'secondary';
      if v_primary_sources = 0 and v_secondary_publishers < 2 then
        raise exception 'A strategic radar item lacks sufficient source verification';
      end if;
      if v_section_name = 'aiRoadmap' and v_primary_sources = 0 then
        raise exception 'An AI roadmap item requires an official primary source';
      end if;
    end loop;
  end loop;

  if (p_strategic_radar ->> 'coverage') = 'complete' and v_unavailable_sections <> 0 then
    raise exception 'Complete strategic radar coverage cannot include unavailable sections';
  end if;
  if (p_strategic_radar ->> 'coverage') = 'partial' and v_unavailable_sections = 0 then
    raise exception 'Partial strategic radar coverage requires an unavailable section';
  end if;
  if (p_strategic_radar ->> 'coverage') = 'unavailable' and v_unavailable_sections <> 3 then
    raise exception 'Unavailable strategic radar coverage requires all sections to be unavailable';
  end if;

  v_brief_id := public.publish_defined_brief_with_pulse_market_and_weekly_recap(
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
    p_market_snapshot,
    p_weekly_recap
  );

  update public.briefs
  set strategic_radar = p_strategic_radar
  where id = v_brief_id;

  return v_brief_id;
end;
$$;

revoke all on function public.publish_defined_brief_with_pulse_market_weekly_recap_and_strategic_radar(uuid, uuid, uuid, date, text, text, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.publish_defined_brief_with_pulse_market_weekly_recap_and_strategic_radar(uuid, uuid, uuid, date, text, text, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb)
  to service_role;
