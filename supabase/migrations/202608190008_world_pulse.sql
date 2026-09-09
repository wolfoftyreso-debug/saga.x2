-- A daily world pulse is a separate, compact orientation layer. It is stored
-- with the brief rather than in the event register, because a stable lens
-- must never manufacture an event update merely to be visible to the user.
alter table public.briefs
  add column if not exists world_pulse jsonb;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'briefs_world_pulse_object_check'
      and conrelid = 'public.briefs'::regclass
  ) then
    alter table public.briefs
      add constraint briefs_world_pulse_object_check
      check (world_pulse is null or jsonb_typeof(world_pulse) = 'object');
  end if;
end;
$$;

-- Keep the existing event-publication transaction intact and wrap it in the
-- pulse write. PostgreSQL executes the nested function in the same enclosing
-- transaction, so a pulse validation/write failure cannot leave a complete
-- brief without its claimed daily orientation.
create or replace function public.publish_defined_brief_with_pulse(
  p_user_id uuid,
  p_brief_definition_id uuid,
  p_run_id uuid,
  p_brief_date date,
  p_timezone text,
  p_assessment text,
  p_watchlist jsonb,
  p_registry_items jsonb,
  p_items jsonb,
  p_world_pulse jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_brief_id uuid;
  v_section text;
begin
  if coalesce(jsonb_typeof(p_world_pulse), '') <> 'object' then
    raise exception 'A world pulse must be a JSON object';
  end if;
  -- In V1 only a fully verified scan can create a `complete` daily brief.
  -- Partial/unavailable scans are deliberately failed in TypeScript before
  -- this RPC, and are rejected here as defense in depth.
  if coalesce(p_world_pulse ->> 'coverage', '') <> 'complete' then
    raise exception 'A complete brief requires complete world-pulse coverage';
  end if;
  if coalesce(p_world_pulse ->> 'overallStatus', '') not in ('calm', 'changed') then
    raise exception 'A complete world pulse must be calm or changed';
  end if;
  if coalesce(p_world_pulse ->> 'asOf', '') = '' or coalesce(p_world_pulse ->> 'summary', '') = '' then
    raise exception 'A world pulse needs an as-of time and summary';
  end if;

  foreach v_section in array array['conflictSecurity', 'economy', 'personalExposure']
  loop
    if coalesce(jsonb_typeof(p_world_pulse -> v_section), '') <> 'object' then
      raise exception 'A world pulse needs the % section', v_section;
    end if;
    if coalesce(p_world_pulse -> v_section ->> 'status', '') not in ('changed', 'stable') then
      raise exception 'A complete world pulse section must be changed or stable';
    end if;
    if coalesce(jsonb_typeof(p_world_pulse -> v_section -> 'sources'), '') <> 'array'
       or jsonb_array_length(p_world_pulse -> v_section -> 'sources') = 0 then
      raise exception 'A complete world pulse section needs source evidence';
    end if;
  end loop;

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
    -- A changed pulse is itself a material change even when no event passed
    -- the personal relevance gate and the brief has zero event cards.
    no_material_changes = jsonb_array_length(p_items) = 0
      and (p_world_pulse ->> 'overallStatus') = 'calm'
  where id = v_brief_id;

  return v_brief_id;
end;
$$;

revoke all on function public.publish_defined_brief_with_pulse(uuid, uuid, uuid, date, text, text, jsonb, jsonb, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.publish_defined_brief_with_pulse(uuid, uuid, uuid, date, text, text, jsonb, jsonb, jsonb, jsonb)
  to service_role;
