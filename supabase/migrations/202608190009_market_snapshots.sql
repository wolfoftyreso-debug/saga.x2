-- A market snapshot is a factual reference layer. It belongs to a completed
-- brief, never to the event registry: an ordinary price move is not a new
-- decision event and must not create an alert or status transition.
alter table public.briefs
  add column if not exists market_snapshot jsonb;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'briefs_market_snapshot_object_check'
      and conrelid = 'public.briefs'::regclass
  ) then
    alter table public.briefs
      add constraint briefs_market_snapshot_object_check
      check (market_snapshot is null or jsonb_typeof(market_snapshot) = 'object');
  end if;
end;
$$;

-- This wrapper retains the publication transaction created for the world
-- pulse. A market snapshot is only committed after the base brief and pulse
-- passed their own server-side validation.
create or replace function public.publish_defined_brief_with_pulse_and_market(
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
  p_market_snapshot jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_brief_id uuid;
  v_instrument jsonb;
  v_available_count integer := 0;
begin
  if coalesce(jsonb_typeof(p_market_snapshot), '') <> 'object' then
    raise exception 'A market snapshot must be a JSON object';
  end if;
  if coalesce(p_market_snapshot ->> 'coverage', '') not in ('complete', 'partial', 'unavailable') then
    raise exception 'A market snapshot needs an explicit coverage state';
  end if;
  if coalesce(p_market_snapshot ->> 'fetchedAt', '') = '' then
    raise exception 'A market snapshot needs a fetched-at time';
  end if;
  if coalesce(jsonb_typeof(p_market_snapshot -> 'instruments'), '') <> 'array'
     or jsonb_array_length(p_market_snapshot -> 'instruments') <> 6 then
    raise exception 'A market snapshot needs exactly six standard instruments';
  end if;

  for v_instrument in select value from jsonb_array_elements(p_market_snapshot -> 'instruments')
  loop
    if coalesce(v_instrument ->> 'availability', '') = 'available' then
      v_available_count := v_available_count + 1;
      if nullif(v_instrument ->> 'value', '') is null
         or nullif(v_instrument ->> 'currency', '') is null
         or nullif(v_instrument ->> 'symbol', '') is null then
        raise exception 'An available market instrument needs value, currency and provider symbol';
      end if;
    elsif coalesce(v_instrument ->> 'availability', '') <> 'unavailable' then
      raise exception 'A market instrument needs an explicit availability state';
    end if;
  end loop;

  if (p_market_snapshot ->> 'coverage') = 'complete' and v_available_count <> 6 then
    raise exception 'Complete market coverage requires all six instruments';
  end if;
  if (p_market_snapshot ->> 'coverage') = 'partial' and (v_available_count = 0 or v_available_count = 6) then
    raise exception 'Partial market coverage requires both available and unavailable instruments';
  end if;
  if (p_market_snapshot ->> 'coverage') = 'unavailable' and v_available_count <> 0 then
    raise exception 'Unavailable market coverage cannot contain prices';
  end if;

  v_brief_id := public.publish_defined_brief_with_pulse(
    p_user_id,
    p_brief_definition_id,
    p_run_id,
    p_brief_date,
    p_timezone,
    p_assessment,
    p_watchlist,
    p_registry_items,
    p_items,
    p_world_pulse
  );

  update public.briefs
  set market_snapshot = p_market_snapshot
  where id = v_brief_id;

  return v_brief_id;
end;
$$;

revoke all on function public.publish_defined_brief_with_pulse_and_market(uuid, uuid, uuid, date, text, text, jsonb, jsonb, jsonb, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.publish_defined_brief_with_pulse_and_market(uuid, uuid, uuid, date, text, text, jsonb, jsonb, jsonb, jsonb, jsonb)
  to service_role;
