-- Repairs for databases that already applied the original authoring functions.
-- Keep existing tables, receipts and privileges. Only executable function bodies
-- are replaced: unambiguous column references and live command/job fencing.
begin;

create or replace function saga_create_adobe_authoring_run(
  target_workspace_id uuid,
  target_user_id uuid,
  target_idempotency_key uuid,
  target_reference_draft_id uuid,
  target_expected_reference_revision integer,
  target_objective text,
  target_author_prompt text,
  target_include_author_name boolean,
  target_knowledge_entry_ids uuid[],
  target_candidate_count integer
)
returns table (run_id uuid, reused boolean)
language plpgsql
set search_path = public
as $$
declare
  existing_run_id uuid;
  existing_reference_draft_id uuid;
  existing_reference_revision integer;
  existing_objective text;
  existing_author_prompt text;
  existing_include_author_name boolean;
  existing_candidate_count smallint;
  existing_knowledge_ids uuid[];
  source_draft record;
  selected_entry_count integer;
  captured_author_name text;
begin
  select id, reference_draft_id, reference_draft_revision, objective, author_prompt,
         include_author_name, candidate_count
    into existing_run_id, existing_reference_draft_id, existing_reference_revision,
         existing_objective, existing_author_prompt, existing_include_author_name,
         existing_candidate_count
    from saga_adobe_authoring_runs
   where workspace_id = target_workspace_id and create_idempotency_key = target_idempotency_key;
  if existing_run_id is not null then
    select coalesce(array_agg(entry.source_entry_id order by entry.ordinal), '{}'::uuid[])
      into existing_knowledge_ids
      from saga_adobe_authoring_run_knowledge_entries entry
     where entry.workspace_id = target_workspace_id and entry.run_id = existing_run_id;
    if existing_reference_draft_id <> target_reference_draft_id
       or existing_reference_revision <> target_expected_reference_revision
       or existing_objective <> target_objective
       or existing_author_prompt <> target_author_prompt
       or existing_include_author_name <> target_include_author_name
       or existing_candidate_count <> target_candidate_count
       or existing_knowledge_ids is distinct from coalesce(target_knowledge_entry_ids, '{}'::uuid[]) then
      raise exception 'saga_adobe_authoring_create_idempotency_conflict' using errcode = 'P0001';
    end if;
    run_id := existing_run_id;
    reused := true;
    return next;
    return;
  end if;
  if target_candidate_count < 1 or target_candidate_count > 10 then
    raise exception 'saga_adobe_authoring_invalid_candidate_count' using errcode = '23514';
  end if;
  if coalesce(cardinality(target_knowledge_entry_ids), 0) > 12 then
    raise exception 'saga_adobe_authoring_too_many_knowledge_entries' using errcode = '23514';
  end if;
  if cardinality(target_knowledge_entry_ids) <> cardinality(array(select distinct selected.entry_id from unnest(coalesce(target_knowledge_entry_ids, '{}'::uuid[])) as selected(entry_id))) then
    raise exception 'saga_adobe_authoring_duplicate_knowledge_entry' using errcode = '23514';
  end if;

  select draft.id, draft.revision, draft.content_type, draft.publication_channels,
         draft.title, draft.body, draft.metadata, draft.status
    into source_draft
    from studio_drafts draft
   where draft.workspace_id = target_workspace_id and draft.id = target_reference_draft_id
   for update;
  if not found then raise exception 'saga_adobe_authoring_reference_not_found' using errcode = 'P0001'; end if;
  if source_draft.revision <> target_expected_reference_revision then
    raise exception 'saga_adobe_authoring_reference_revision_conflict' using errcode = 'P0001';
  end if;
  if source_draft.status in ('publishing', 'published', 'cancelled')
     or char_length(trim(source_draft.title)) < 1
     or char_length(trim(source_draft.body)) < 1
     or jsonb_typeof(source_draft.publication_channels) <> 'array'
     or (case when jsonb_typeof(source_draft.publication_channels) = 'array' then jsonb_array_length(source_draft.publication_channels) else 0 end) < 1 then
    raise exception 'saga_adobe_authoring_reference_unsuitable' using errcode = 'P0001';
  end if;

  select count(*) into selected_entry_count
    from saga_daily_knowledge_entries entry
   where entry.workspace_id = target_workspace_id
     and entry.id = any(coalesce(target_knowledge_entry_ids, '{}'::uuid[]))
     and entry.retention_expires_at > now();
  if selected_entry_count <> coalesce(cardinality(target_knowledge_entry_ids), 0) then
    raise exception 'saga_adobe_authoring_knowledge_entry_not_found_or_expired' using errcode = 'P0001';
  end if;

  if target_include_author_name then
    select nullif(trim(display_name), '') into captured_author_name
      from app_users where id = target_user_id;
  end if;

  insert into saga_adobe_authoring_runs (
    workspace_id, created_by_user_id, create_idempotency_key,
    reference_draft_id, reference_draft_revision, reference_snapshot,
    objective, author_prompt, include_author_name, author_name_snapshot, candidate_count
  ) values (
    target_workspace_id, target_user_id, target_idempotency_key,
    source_draft.id, source_draft.revision,
    jsonb_build_object(
      'sourceDraftId', source_draft.id::text,
      'sourceDraftRevision', source_draft.revision,
      'contentType', source_draft.content_type,
      'channels', source_draft.publication_channels,
      'title', source_draft.title,
      'body', source_draft.body,
      'language', coalesce(nullif(source_draft.metadata ->> 'language', ''), 'sv'),
      'timezone', coalesce(nullif(source_draft.metadata ->> 'timezone', ''), 'Europe/Stockholm'),
      'capturedAt', now()::text
    ),
    target_objective, target_author_prompt, target_include_author_name,
    case when target_include_author_name then captured_author_name else null end,
    target_candidate_count
  ) returning id into existing_run_id;

  insert into saga_adobe_authoring_run_knowledge_entries (
    workspace_id, run_id, source_entry_id, ordinal, snapshot
  )
  select target_workspace_id, existing_run_id, entry.id, ranked.ordinal::smallint,
    jsonb_build_object(
      'entryId', entry.id::text,
      'policyRevision', entry.policy_revision,
      'knowledgeDate', entry.knowledge_date::text,
      'topic', entry.topic,
      'headline', entry.headline,
      'summary', entry.summary,
      'evidenceCount', entry.evidence_count,
      'independentPublisherCount', entry.independent_publisher_count,
      'capturedAt', now()::text
    )
  from unnest(coalesce(target_knowledge_entry_ids, '{}'::uuid[])) with ordinality as ranked(entry_id, ordinal)
  join saga_daily_knowledge_entries entry
    on entry.workspace_id = target_workspace_id and entry.id = ranked.entry_id;

  insert into saga_adobe_authoring_candidates (workspace_id, run_id, ordinal)
  select target_workspace_id, existing_run_id, series::smallint
    from generate_series(1, target_candidate_count) as series;
  insert into saga_adobe_authoring_generation_jobs (workspace_id, run_id, candidate_id, run_revision)
  select candidate.workspace_id, candidate.run_id, candidate.id, 1
    from saga_adobe_authoring_candidates candidate
   where candidate.workspace_id = target_workspace_id and candidate.run_id = existing_run_id;

  run_id := existing_run_id;
  reused := false;
  return next;
end;
$$;

create or replace function saga_select_adobe_authoring_candidate(
  target_workspace_id uuid,
  target_user_id uuid,
  target_run_id uuid,
  target_candidate_id uuid,
  target_idempotency_key uuid,
  target_expected_run_revision integer,
  target_expected_candidate_revision integer
)
returns table (run_id uuid, candidate_id uuid, studio_draft_id uuid, reused boolean)
language plpgsql
set search_path = public
as $$
declare
  existing_selection saga_adobe_authoring_selection_receipts%rowtype;
  run_row saga_adobe_authoring_runs%rowtype;
  candidate_row saga_adobe_authoring_candidates%rowtype;
  materialized_draft_id uuid;
  draft_metadata jsonb;
begin
  select * into existing_selection from saga_adobe_authoring_selection_receipts
   where workspace_id = target_workspace_id and idempotency_key = target_idempotency_key;
  if found then
    if existing_selection.run_id <> target_run_id
       or existing_selection.candidate_id <> target_candidate_id
       or existing_selection.expected_run_revision <> target_expected_run_revision
       or existing_selection.expected_candidate_revision <> target_expected_candidate_revision then
      raise exception 'saga_adobe_authoring_selection_idempotency_conflict' using errcode = 'P0001';
    end if;
    run_id := existing_selection.run_id;
    candidate_id := existing_selection.candidate_id;
    studio_draft_id := existing_selection.studio_draft_id;
    reused := true;
    return next;
    return;
  end if;
  select * into run_row from saga_adobe_authoring_runs
   where workspace_id = target_workspace_id and id = target_run_id for update;
  if not found then raise exception 'saga_adobe_authoring_run_not_found' using errcode = 'P0001'; end if;
  if run_row.revision <> target_expected_run_revision then raise exception 'saga_adobe_authoring_run_revision_conflict' using errcode = 'P0001'; end if;
  if run_row.state <> 'ready_to_select' or run_row.selected_draft_id is not null then
    raise exception 'saga_adobe_authoring_selection_not_available' using errcode = 'P0001';
  end if;
  select * into candidate_row from saga_adobe_authoring_candidates candidate
   where candidate.workspace_id = target_workspace_id and candidate.id = target_candidate_id and candidate.run_id = target_run_id for update;
  if not found then raise exception 'saga_adobe_authoring_candidate_not_found' using errcode = 'P0001'; end if;
  if candidate_row.revision <> target_expected_candidate_revision then raise exception 'saga_adobe_authoring_candidate_revision_conflict' using errcode = 'P0001'; end if;
  if candidate_row.state <> 'ready' or candidate_row.generated_content is null or candidate_row.quality is null then
    raise exception 'saga_adobe_authoring_candidate_not_selectable' using errcode = 'P0001';
  end if;
  if coalesce((candidate_row.quality ->> 'canCreatePrivateDraft')::boolean, false) is not true
     or coalesce(candidate_row.quality ->> 'decision', 'blocked') = 'blocked'
     or coalesce((candidate_row.quality ->> 'canDeliver')::boolean, true) is true then
    raise exception 'saga_adobe_authoring_candidate_quality_rejected' using errcode = 'P0001';
  end if;
  draft_metadata := jsonb_build_object(
    'headline', nullif(candidate_row.generated_content ->> 'headline', ''),
    'subject', nullif(candidate_row.generated_content ->> 'subject', ''),
    'cta', nullif(candidate_row.generated_content ->> 'callToAction', ''),
    'hashtags', coalesce(candidate_row.generated_content -> 'hashtags', '[]'::jsonb),
    'generationPrompt', run_row.objective,
    'imagePrompt', nullif(candidate_row.generated_content ->> 'imagePrompt', ''),
    'language', coalesce(nullif(run_row.reference_snapshot ->> 'language', ''), 'sv'),
    'timezone', coalesce(nullif(run_row.reference_snapshot ->> 'timezone', ''), 'Europe/Stockholm'),
    'scheduledLocalDate', null,
    'scheduledLocalTime', null,
    'approvalRequired', true,
    'sagaProductionQuality', candidate_row.quality,
    'sagaProductionQualityContext', jsonb_build_object('targetLength', 'medium', 'editorialLens', null, 'seriesReference', null),
    'sagaAdobeAuthoring', jsonb_build_object(
      'runId', run_row.id::text,
      'candidateId', candidate_row.id::text,
      'referenceDraftId', run_row.reference_draft_id::text,
      'referenceDraftRevision', run_row.reference_draft_revision,
      'privateOnly', true,
      'selectedAt', now()::text
    )
  );
  insert into studio_drafts (
    workspace_id, author_user_id, content_type, status, title, body, excerpt,
    publication_channels, metadata, scheduled_at
  ) values (
    target_workspace_id, target_user_id, run_row.reference_snapshot ->> 'contentType', 'in_review',
    candidate_row.generated_content ->> 'title', candidate_row.generated_content ->> 'body',
    nullif(candidate_row.generated_content ->> 'excerpt', ''),
    run_row.reference_snapshot -> 'channels', draft_metadata, null
  ) returning id into materialized_draft_id;
  update saga_adobe_authoring_candidates candidate
     set state = case when candidate.id = target_candidate_id then 'selected' else case when candidate.state = 'ready' then 'not_selected' else candidate.state end end,
         revision = candidate.revision + 1
   where candidate.workspace_id = target_workspace_id and candidate.run_id = target_run_id;
  update saga_adobe_authoring_runs
     set state = 'selected', selected_candidate_id = target_candidate_id, selected_draft_id = materialized_draft_id,
         failure_message = null, revision = revision + 1
   where workspace_id = target_workspace_id and id = target_run_id;
  insert into saga_adobe_authoring_selection_receipts (
    workspace_id, run_id, candidate_id, idempotency_key, expected_run_revision,
    expected_candidate_revision, selected_by_user_id, studio_draft_id
  ) values (
    target_workspace_id, target_run_id, target_candidate_id, target_idempotency_key,
    target_expected_run_revision, target_expected_candidate_revision, target_user_id, materialized_draft_id
  );
  run_id := target_run_id;
  candidate_id := target_candidate_id;
  studio_draft_id := materialized_draft_id;
  reused := false;
  return next;
end;
$$;

create or replace function saga_complete_adobe_authoring_generation_job(
  target_workspace_id uuid,
  target_command_id uuid,
  target_command_claim_token uuid,
  target_job_id uuid,
  target_claim_token uuid,
  target_materialization jsonb
)
returns table (candidate_id uuid, stale boolean)
language plpgsql
set search_path = public
as $$
declare
  job_row saga_adobe_authoring_generation_jobs%rowtype;
  run_row saga_adobe_authoring_runs%rowtype;
  receipt_row saga_adobe_authoring_generation_receipts%rowtype;
  command_row saga_adobe_authoring_generation_commands%rowtype;
  title_value text;
  body_value text;
begin
  if jsonb_typeof(target_materialization) <> 'object'
     or jsonb_typeof(target_materialization -> 'content') <> 'object'
     or jsonb_typeof(target_materialization -> 'quality') <> 'object' then
    raise exception 'saga_adobe_authoring_invalid_materialization' using errcode = '23514';
  end if;
  title_value := trim(coalesce(target_materialization #>> '{content,title}', ''));
  body_value := trim(coalesce(target_materialization #>> '{content,body}', ''));
  if char_length(title_value) < 1 or char_length(title_value) > 140
     or char_length(body_value) < 1 or char_length(body_value) > 12000
     or char_length(trim(coalesce(target_materialization ->> 'model', ''))) < 1
     or char_length(trim(coalesce(target_materialization ->> 'responseId', ''))) < 1
     or coalesce((target_materialization #>> '{quality,canCreatePrivateDraft}')::boolean, false) is not true
     or coalesce(target_materialization #>> '{quality,decision}', 'blocked') = 'blocked'
     or coalesce((target_materialization #>> '{quality,canDeliver}')::boolean, true) is true then
    raise exception 'saga_adobe_authoring_quality_rejected' using errcode = '23514';
  end if;
  select * into job_row
    from saga_adobe_authoring_generation_jobs job
   where job.workspace_id = target_workspace_id
     and job.id = target_job_id
     and job.state = 'processing'
     and job.claim_token = target_claim_token
     and job.lease_expires_at > now()
   for update;
  if not found then candidate_id := null; stale := true; return next; return; end if;
  select * into run_row from saga_adobe_authoring_runs run
   where run.workspace_id = target_workspace_id and run.id = job_row.run_id for update;
  select * into receipt_row from saga_adobe_authoring_generation_receipts receipt
   where receipt.workspace_id = target_workspace_id
     and receipt.id = job_row.generation_receipt_id for update;
  select * into command_row from saga_adobe_authoring_generation_commands command
   where command.workspace_id = target_workspace_id
     and command.id = target_command_id
     and command.run_id = job_row.run_id
     and command.generation_receipt_id = job_row.generation_receipt_id
     and command.state = 'running'
     and command.claim_token = target_command_claim_token
     and command.lease_expires_at > now()
   for update;
  -- A caller that no longer owns the command cannot cancel another owner's
  -- job. Only a live command may settle a genuinely stale run revision.
  if not found then candidate_id := null; stale := true; return next; return; end if;
  if run_row.revision <> job_row.run_revision
     or receipt_row.state <> 'running'
     or run_row.state <> 'generating' then
    update saga_adobe_authoring_generation_jobs job
       set state = 'cancelled', completed_at = now(), claim_token = null,
           locked_by = null, lease_expires_at = null,
           failure_code = 'stale_run_revision',
           failure_message = 'Körningen ändrades före den privata kandidaten kunde sparas.'
     where job.workspace_id = target_workspace_id and job.id = target_job_id;
    update saga_adobe_authoring_candidates candidate
       set state = 'failed',
           error_message = 'Körningen ändrades före den privata kandidaten kunde sparas.',
           revision = candidate.revision + 1
     where candidate.workspace_id = target_workspace_id
       and candidate.id = job_row.candidate_id
       and candidate.state = 'generating';
    if command_row.id is not null then
      update saga_adobe_authoring_generation_commands command
         set state = 'stale', completed_at = now()
       where command.workspace_id = target_workspace_id
         and command.id = target_command_id
         and command.claim_token = target_command_claim_token;
    end if;
    candidate_id := null; stale := true; return next; return;
  end if;
  update saga_adobe_authoring_candidates candidate
     set state = 'ready',
         generated_content = target_materialization -> 'content',
         quality = target_materialization -> 'quality',
         generation_metadata = jsonb_build_object(
           'model', left(target_materialization ->> 'model', 160),
           'responseId', left(target_materialization ->> 'responseId', 240),
           'inputTokens', case when (target_materialization ->> 'inputTokens') ~ '^[0-9]+$' then (target_materialization ->> 'inputTokens')::integer else null end,
           'outputTokens', case when (target_materialization ->> 'outputTokens') ~ '^[0-9]+$' then (target_materialization ->> 'outputTokens')::integer else null end,
           'promptPolicyVersion', 'saga-adobe-authoring/v1',
           'completedAt', now()::text
         ),
         error_message = null,
         revision = candidate.revision + 1
   where candidate.workspace_id = target_workspace_id
     and candidate.id = job_row.candidate_id
     and candidate.state = 'generating';
  if not found then candidate_id := null; stale := true; return next; return; end if;
  update saga_adobe_authoring_generation_jobs job
     set state = 'completed', completed_at = now(), claim_token = null,
         locked_by = null, lease_expires_at = null,
         failure_code = null, failure_message = null
   where job.workspace_id = target_workspace_id
     and job.id = target_job_id
     and job.claim_token = target_claim_token;
  update saga_adobe_authoring_generation_commands command
     set state = 'completed', completed_at = now(), processed_job_id = target_job_id
   where command.workspace_id = target_workspace_id
     and command.id = target_command_id
     and command.state = 'running'
     and command.claim_token = target_command_claim_token;
  perform saga_adobe_authoring_finalize_receipt(
    target_workspace_id, job_row.run_id, job_row.generation_receipt_id
  );
  candidate_id := job_row.candidate_id; stale := false; return next;
end;
$$;

create or replace function saga_block_adobe_authoring_generation_job(
  target_workspace_id uuid,
  target_command_id uuid,
  target_command_claim_token uuid,
  target_job_id uuid,
  target_claim_token uuid,
  target_quality jsonb,
  target_message text
)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  job_row saga_adobe_authoring_generation_jobs%rowtype;
  command_row saga_adobe_authoring_generation_commands%rowtype;
begin
  select * into job_row from saga_adobe_authoring_generation_jobs job
   where job.workspace_id = target_workspace_id
     and job.id = target_job_id
     and job.state = 'processing'
     and job.claim_token = target_claim_token
     and job.lease_expires_at > now()
   for update;
  if not found then return false; end if;
  select * into command_row from saga_adobe_authoring_generation_commands command
   where command.workspace_id = target_workspace_id
     and command.id = target_command_id
     and command.run_id = job_row.run_id
     and command.generation_receipt_id = job_row.generation_receipt_id
     and command.state = 'running'
     and command.claim_token = target_command_claim_token
     and command.lease_expires_at > now()
   for update;
  if not found then return false; end if;
  update saga_adobe_authoring_candidates candidate
     set state = 'blocked', quality = target_quality,
         error_message = left(target_message, 1200),
         revision = candidate.revision + 1
   where candidate.workspace_id = target_workspace_id
     and candidate.id = job_row.candidate_id
     and candidate.state = 'generating';
  update saga_adobe_authoring_generation_jobs job
     set state = 'completed', completed_at = now(), claim_token = null,
         locked_by = null, lease_expires_at = null,
         failure_code = 'production_quality_rejected',
         failure_message = left(target_message, 1200)
   where job.workspace_id = target_workspace_id
     and job.id = target_job_id
     and job.claim_token = target_claim_token;
  update saga_adobe_authoring_generation_commands command
     set state = 'completed', completed_at = now(), processed_job_id = target_job_id
   where command.workspace_id = target_workspace_id
     and command.id = target_command_id
     and command.claim_token = target_command_claim_token;
  perform saga_adobe_authoring_finalize_receipt(
    target_workspace_id, job_row.run_id, job_row.generation_receipt_id
  );
  return true;
end;
$$;

create or replace function saga_fail_adobe_authoring_generation_job(
  target_workspace_id uuid,
  target_command_id uuid,
  target_command_claim_token uuid,
  target_job_id uuid,
  target_claim_token uuid,
  target_error_code text,
  target_error_message text
)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  job_row saga_adobe_authoring_generation_jobs%rowtype;
  command_row saga_adobe_authoring_generation_commands%rowtype;
begin
  select * into job_row from saga_adobe_authoring_generation_jobs job
   where job.workspace_id = target_workspace_id
     and job.id = target_job_id
     and job.state = 'processing'
     and job.claim_token = target_claim_token
     and job.lease_expires_at > now()
   for update;
  if not found then return false; end if;
  select * into command_row from saga_adobe_authoring_generation_commands command
   where command.workspace_id = target_workspace_id
     and command.id = target_command_id
     and command.run_id = job_row.run_id
     and command.generation_receipt_id = job_row.generation_receipt_id
     and command.state = 'running'
     and command.claim_token = target_command_claim_token
     and command.lease_expires_at > now()
   for update;
  if not found then return false; end if;
  update saga_adobe_authoring_candidates candidate
     set state = 'failed', error_message = left(target_error_message, 1200),
         revision = candidate.revision + 1
   where candidate.workspace_id = target_workspace_id
     and candidate.id = job_row.candidate_id
     and candidate.state = 'generating';
  update saga_adobe_authoring_generation_jobs job
     set state = 'failed', completed_at = now(), claim_token = null,
         locked_by = null, lease_expires_at = null,
         failure_code = left(target_error_code, 120),
         failure_message = left(target_error_message, 1200)
   where job.workspace_id = target_workspace_id
     and job.id = target_job_id
     and job.claim_token = target_claim_token;
  update saga_adobe_authoring_generation_commands command
     set state = 'completed', completed_at = now(), processed_job_id = target_job_id
   where command.workspace_id = target_workspace_id
     and command.id = target_command_id
     and command.claim_token = target_command_claim_token;
  perform saga_adobe_authoring_finalize_receipt(
    target_workspace_id, job_row.run_id, job_row.generation_receipt_id
  );
  return true;
end;
$$;

commit;

