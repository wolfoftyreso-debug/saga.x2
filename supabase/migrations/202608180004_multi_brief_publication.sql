-- Publish a completed brief for a specific definition. This mirrors the
-- established daily-publication transaction while preserving delivery state
-- independently for each brief definition.

-- A failed or partial historical record must not prevent a later complete
-- publication for the same definition and local date.
drop index if exists public.briefs_definition_date_idx;
create unique index if not exists briefs_one_complete_per_definition_date_idx
  on public.briefs(brief_definition_id, brief_date)
  where state = 'complete';

update public.processing_runs r
set brief_definition_id = d.id
from public.brief_definitions d
where d.user_id = r.user_id
  and d.is_primary
  and r.brief_definition_id is null;

-- Existing main-brief deliveries become definition-scoped state before the new
-- runner starts, so an upgrade does not re-deliver an unchanged event once.
insert into public.brief_event_state (
  user_id, brief_definition_id, event_id, last_considered_update_id,
  last_published_update_id, last_published_at, last_score
)
select
  b.user_id, b.brief_definition_id, bi.event_id, bi.event_update_id,
  bi.event_update_id, b.created_at, bi.relevance_score
from public.briefs b
join public.brief_items bi on bi.brief_id = b.id
where b.brief_definition_id is not null
on conflict (user_id, brief_definition_id, event_id) do update set
  last_considered_update_id = excluded.last_considered_update_id,
  last_published_update_id = excluded.last_published_update_id,
  last_published_at = greatest(public.brief_event_state.last_published_at, excluded.last_published_at),
  last_score = excluded.last_score;

create or replace function public.publish_defined_brief(
  p_user_id uuid,
  p_brief_definition_id uuid,
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
  if coalesce(jsonb_typeof(p_items), '') <> 'array' or jsonb_array_length(p_items) > 5 then
    raise exception 'A brief must contain between 0 and 5 items';
  end if;
  if coalesce(jsonb_typeof(p_watchlist), '') <> 'array' or jsonb_array_length(p_watchlist) > 3 then
    raise exception 'A watchlist must contain at most 3 items';
  end if;
  if coalesce(jsonb_typeof(p_registry_items), '') <> 'array' or jsonb_array_length(p_registry_items) > 60 then
    raise exception 'The event registry must contain between 0 and 60 items';
  end if;

  if not exists (
    select 1
    from public.brief_definitions
    where id = p_brief_definition_id and user_id = p_user_id
  ) then
    raise exception 'Brief definition is not available to this user';
  end if;

  if not exists (
    select 1
    from public.processing_runs
    where id = p_run_id
      and user_id = p_user_id
      and brief_definition_id = p_brief_definition_id
      and state = 'running'
  ) then
    raise exception 'Run is not publishable for this brief definition';
  end if;

  if exists (
    select 1
    from public.briefs
    where brief_definition_id = p_brief_definition_id
      and brief_date = p_brief_date
      and state = 'complete'
  ) then
    raise exception 'A complete brief already exists for this definition and date';
  end if;

  insert into public.briefs (
    user_id, brief_definition_id, processing_run_id, brief_date, timezone, state,
    assessment, item_count, no_material_changes, watchlist
  ) values (
    p_user_id, p_brief_definition_id, p_run_id, p_brief_date, p_timezone, 'complete',
    p_assessment, jsonb_array_length(p_items), jsonb_array_length(p_items) = 0, p_watchlist
  ) returning id into v_brief_id;

  -- Persist every verified, material event update first. It is intentionally
  -- broader than this definition's 0–5 selected brief items.
  for v_item in select value from jsonb_array_elements(p_registry_items)
  loop
    if coalesce(v_item ->> 'canonicalKey', '') = '' then
      raise exception 'A registry item needs a canonical key';
    end if;
    if coalesce(v_item ->> 'materialFingerprint', '') = '' then
      raise exception 'A registry item needs a material fingerprint';
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

    -- Retain the legacy, user-level registry state for compatibility with the
    -- daily runner and the broader event register.
    insert into public.user_event_state (
      user_id, event_id, last_considered_update_id
    ) values (
      p_user_id, v_event_id, v_update_id
    ) on conflict (user_id, event_id) do update set
      last_considered_update_id = excluded.last_considered_update_id;
  end loop;

  -- Only the selected subset is delivered in this particular brief definition.
  v_position := 0;
  for v_item in select value from jsonb_array_elements(p_items)
  loop
    v_position := v_position + 1;
    if coalesce(v_item ->> 'canonicalKey', '') = ''
       or coalesce(v_item ->> 'materialFingerprint', '') = '' then
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
    where event_id = v_event_id
      and material_fingerprint = v_item ->> 'materialFingerprint';
    if v_event_id is null or v_update_id is null then
      raise exception 'Registry event or update is missing for a brief item';
    end if;

    insert into public.brief_items (
      brief_id, event_id, event_update_id, position, relevance_score, relevance_factors,
      title_snapshot, category_snapshot, status_snapshot, event_date_snapshot, what_changed,
      why_relevant, short_term_impact, long_term_impact, recommendation, confidence,
      systemic_override, direct_alert
    ) values (
      v_brief_id, v_event_id, v_update_id, v_position, (v_item ->> 'relevanceScore')::smallint,
      v_item -> 'relevanceFactors', v_item ->> 'title', (v_item ->> 'category')::public.event_category,
      (v_item ->> 'status')::public.event_status, nullif(v_item ->> 'eventDate', '')::date,
      v_item ->> 'whatChanged', v_item ->> 'whyRelevant', v_item ->> 'shortTermImpact',
      v_item ->> 'longTermImpact', (v_item ->> 'recommendation')::public.recommendation,
      (v_item ->> 'confidence')::public.confidence_level,
      coalesce((v_item ->> 'systemicOverride')::boolean, false),
      coalesce((v_item ->> 'directAlert')::boolean, false)
    );

    insert into public.user_event_state (
      user_id, event_id, last_considered_update_id, last_published_update_id,
      last_published_at, last_score
    ) values (
      p_user_id, v_event_id, v_update_id, v_update_id, timezone('utc', now()),
      (v_item ->> 'relevanceScore')::smallint
    ) on conflict (user_id, event_id) do update set
      last_considered_update_id = excluded.last_considered_update_id,
      last_published_update_id = excluded.last_published_update_id,
      last_published_at = excluded.last_published_at,
      last_score = excluded.last_score;

    -- Delivery is definition-specific: a technology brief can report an event
    -- without suppressing it from a later company or regulatory brief.
    insert into public.brief_event_state (
      user_id, brief_definition_id, event_id, last_considered_update_id,
      last_published_update_id, last_published_at, last_score
    ) values (
      p_user_id, p_brief_definition_id, v_event_id, v_update_id, v_update_id,
      timezone('utc', now()), (v_item ->> 'relevanceScore')::smallint
    ) on conflict (user_id, brief_definition_id, event_id) do update set
      last_considered_update_id = excluded.last_considered_update_id,
      last_published_update_id = excluded.last_published_update_id,
      last_published_at = excluded.last_published_at,
      last_score = excluded.last_score;
  end loop;

  update public.processing_runs set
    state = 'complete',
    phase = 'complete',
    published_count = jsonb_array_length(p_items),
    finished_at = timezone('utc', now()),
    coverage_to = timezone('utc', now())
  where id = p_run_id;

  return v_brief_id;
end;
$$;

revoke all on function public.publish_defined_brief(uuid, uuid, uuid, date, text, text, jsonb, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.publish_defined_brief(uuid, uuid, uuid, date, text, text, jsonb, jsonb, jsonb)
  to service_role;
