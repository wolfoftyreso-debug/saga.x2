-- Explicit brand ownership for editorial direction, references and authoring.
-- Unknown historical ownership stays null and is never exposed by a selected-brand query.
begin;

create or replace function saga_single_completed_brand(target_workspace_id uuid)
returns uuid language sql stable as $$
  select case when count(*) = 1 then (array_agg(profile.id))[1] else null end
  from content_engine_brand_profiles profile
  join saga_brand_onboardings onboarding on onboarding.workspace_id = profile.workspace_id
    and onboarding.brand_profile_id = profile.id and onboarding.completion_state = 'completed'
  where profile.workspace_id = target_workspace_id and profile.active = true;
$$;

alter table studio_drafts add column if not exists brand_profile_id uuid;
alter table saga_adobe_authoring_runs add column if not exists brand_profile_id uuid;
alter table studio_drafts add constraint studio_drafts_brand_workspace_fk
  foreign key (workspace_id, brand_profile_id) references content_engine_brand_profiles(workspace_id, id) on delete restrict;
alter table saga_adobe_authoring_runs add constraint saga_authoring_runs_brand_workspace_fk
  foreign key (workspace_id, brand_profile_id) references content_engine_brand_profiles(workspace_id, id) on delete restrict;

-- Existing relational planning ownership is stronger evidence than workspace cardinality.
update studio_drafts draft set brand_profile_id = plan.brand_profile_id
from saga_quarterly_activity_plans plan
where draft.brand_profile_id is null and plan.workspace_id = draft.workspace_id
  and plan.id::text = draft.metadata #>> '{sagaQuarterlyActivityPlan,planId}';
update studio_drafts draft set brand_profile_id = saga_single_completed_brand(workspace_id)
where brand_profile_id is null and (select count(*) from content_engine_brand_profiles profile where profile.workspace_id = draft.workspace_id) = 1;
update saga_adobe_authoring_runs run set brand_profile_id = draft.brand_profile_id
from studio_drafts draft where draft.workspace_id = run.workspace_id and draft.id = run.reference_draft_id
  and run.brand_profile_id is null;
update saga_editorial_lenses lens set brand_profile_id = saga_single_completed_brand(workspace_id)
where brand_profile_id is null and (select count(*) from content_engine_brand_profiles profile where profile.workspace_id = lens.workspace_id) = 1;

alter table saga_editorial_lenses drop constraint saga_editorial_lenses_workspace_id_key;
alter table saga_editorial_lenses add constraint saga_editorial_lenses_workspace_brand_key unique(workspace_id, brand_profile_id);
create index studio_drafts_brand_idx on studio_drafts(workspace_id, brand_profile_id, updated_at desc);
create index saga_authoring_runs_brand_idx on saga_adobe_authoring_runs(workspace_id, brand_profile_id, updated_at desc);

create or replace function saga_guard_draft_brand()
returns trigger language plpgsql as $$
declare inherited_brand uuid;
begin
  if tg_op = 'UPDATE' then
    if old.brand_profile_id is distinct from new.brand_profile_id then
      raise exception 'saga_brand_ownership_is_immutable' using errcode = '23514';
    end if;
    return new;
  end if;
  if new.metadata #>> '{sagaAdobeAuthoring,runId}' is not null then
    select run.brand_profile_id into inherited_brand from saga_adobe_authoring_runs run
      where run.workspace_id = new.workspace_id and run.id::text = new.metadata #>> '{sagaAdobeAuthoring,runId}';
    if inherited_brand is null then raise exception 'saga_authoring_brand_required' using errcode = '23514'; end if;
  elsif new.metadata #>> '{sagaQuarterlyActivityPlan,planId}' is not null then
    select plan.brand_profile_id into inherited_brand from saga_quarterly_activity_plans plan
      where plan.workspace_id = new.workspace_id and plan.id::text = new.metadata #>> '{sagaQuarterlyActivityPlan,planId}';
    if inherited_brand is null then raise exception 'saga_planning_brand_required' using errcode = '23514'; end if;
  end if;
  if inherited_brand is not null and new.brand_profile_id is not null and inherited_brand <> new.brand_profile_id then
    raise exception 'saga_draft_brand_mismatch' using errcode = '23514';
  end if;
  new.brand_profile_id := coalesce(inherited_brand, new.brand_profile_id, saga_single_completed_brand(new.workspace_id));
  if new.brand_profile_id is null or not exists (
    select 1 from content_engine_brand_profiles profile join saga_brand_onboardings onboarding
      on onboarding.workspace_id = profile.workspace_id and onboarding.brand_profile_id = profile.id
    where profile.workspace_id = new.workspace_id and profile.id = new.brand_profile_id
      and profile.active = true and onboarding.completion_state = 'completed'
  ) then raise exception 'saga_completed_brand_required' using errcode = '23514'; end if;
  return new;
end;
$$;
create trigger saga_draft_brand_guard before insert or update of brand_profile_id on studio_drafts
for each row execute function saga_guard_draft_brand();

create or replace function saga_guard_authoring_brand()
returns trigger language plpgsql as $$
declare reference_brand uuid;
begin
  if tg_op = 'UPDATE' then
    if old.brand_profile_id is distinct from new.brand_profile_id or old.reference_draft_id <> new.reference_draft_id then
      raise exception 'saga_brand_ownership_is_immutable' using errcode = '23514';
    end if;
    return new;
  end if;
  select brand_profile_id into reference_brand from studio_drafts
    where workspace_id = new.workspace_id and id = new.reference_draft_id;
  if reference_brand is null or (new.brand_profile_id is not null and new.brand_profile_id <> reference_brand) then
    raise exception 'saga_authoring_reference_brand_required' using errcode = '23514';
  end if;
  new.brand_profile_id := reference_brand;
  return new;
end;
$$;
create trigger saga_authoring_brand_guard before insert or update of brand_profile_id, reference_draft_id on saga_adobe_authoring_runs
for each row execute function saga_guard_authoring_brand();

-- A Lens belongs permanently to one brand; changing the editor selection creates/edits another Lens.
create or replace function saga_guard_lens_brand()
returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and old.brand_profile_id is distinct from new.brand_profile_id then
    raise exception 'saga_brand_ownership_is_immutable' using errcode = '23514';
  end if;
  if tg_op = 'INSERT' and new.brand_profile_id is null then
    raise exception 'saga_completed_brand_required' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger saga_lens_brand_guard before insert or update of brand_profile_id on saga_editorial_lenses
for each row execute function saga_guard_lens_brand();

-- Separate PL/pgSQL commands see this transaction's writes. A data-modifying
-- CTE joined back to the base table would return no row on first creation and
-- old values on updates, so persist doctrine and sources inside one function.
create or replace function saga_upsert_brand_editorial_lens(
  target_workspace_id uuid, target_user_id uuid, target_brand_id uuid, target_lens jsonb
)
returns uuid language plpgsql as $$
declare saved_lens_id uuid;
begin
  if not exists (select 1 from app_workspace_memberships
    where workspace_id = target_workspace_id and user_id = target_user_id and role = 'owner') then
    raise exception 'saga_lens_owner_required' using errcode = '42501';
  end if;
  if not exists (select 1 from content_engine_brand_profiles profile
    join saga_brand_onboardings onboarding on onboarding.workspace_id = profile.workspace_id and onboarding.brand_profile_id = profile.id
    where profile.workspace_id = target_workspace_id and profile.id = target_brand_id
      and profile.active = true and onboarding.completion_state = 'completed') then
    raise exception 'saga_completed_brand_required' using errcode = '23514';
  end if;
  insert into saga_editorial_lenses (
    workspace_id, created_by_user_id, updated_by_user_id, brand_profile_id,
    name, mission, strategic_perspective, industry, audience, themes, forbidden_themes,
    tone_config, construction_config, evidence_threshold, source_rules, control_mode, active
  ) values (
    target_workspace_id, target_user_id, target_user_id, target_brand_id,
    target_lens->>'name', target_lens->>'mission', target_lens->>'strategicPerspective',
    target_lens->>'industry', target_lens->>'audience',
    array(select jsonb_array_elements_text(target_lens->'themes')),
    array(select jsonb_array_elements_text(target_lens->'forbiddenThemes')),
    target_lens->'tone', target_lens->'construction', target_lens->>'evidenceThreshold',
    target_lens->'sourceRules', target_lens->>'controlMode', (target_lens->>'active')::boolean
  ) on conflict (workspace_id, brand_profile_id) do update set
    updated_by_user_id = excluded.updated_by_user_id, name = excluded.name, mission = excluded.mission,
    strategic_perspective = excluded.strategic_perspective, industry = excluded.industry, audience = excluded.audience,
    themes = excluded.themes, forbidden_themes = excluded.forbidden_themes, tone_config = excluded.tone_config,
    construction_config = excluded.construction_config, evidence_threshold = excluded.evidence_threshold,
    source_rules = excluded.source_rules, control_mode = excluded.control_mode, active = excluded.active
  returning id into saved_lens_id;
  perform saga_editorial_lens_replace_sources(target_workspace_id, saved_lens_id, target_lens->'sourceSelections');
  return saved_lens_id;
end;
$$;

commit;
