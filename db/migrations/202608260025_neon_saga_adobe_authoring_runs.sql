-- SAGA Adobe-simple authoring runs.
--
-- A run snapshots a saved Studio draft and selected Daily Knowledge entries on
-- the server, then creates up to ten private, immutable copy candidates. A
-- human explicitly selects exactly one candidate before a normal editable
-- Studio review draft exists. This migration contains no schedule, provider
-- account, publication, media or delivery path.

begin;

create table if not exists saga_adobe_authoring_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app_workspaces(id) on delete cascade,
  created_by_user_id uuid not null,
  create_idempotency_key uuid not null,
  reference_draft_id uuid not null,
  reference_draft_revision integer not null check (reference_draft_revision > 0),
  reference_snapshot jsonb not null default '{}'::jsonb
    check (jsonb_typeof(reference_snapshot) = 'object'),
  objective text not null check (char_length(trim(objective)) between 12 and 1200),
  author_prompt text not null check (char_length(trim(author_prompt)) between 1 and 4000),
  include_author_name boolean not null default false,
  author_name_snapshot text check (author_name_snapshot is null or char_length(trim(author_name_snapshot)) between 1 and 160),
  candidate_count smallint not null check (candidate_count between 1 and 10),
  state text not null default 'queued'
    check (state in ('queued', 'generating', 'ready_to_select', 'selected', 'failed', 'stale')),
  selected_candidate_id uuid,
  selected_draft_id uuid,
  failure_message text check (failure_message is null or char_length(failure_message) <= 1200),
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, create_idempotency_key),
  foreign key (workspace_id, created_by_user_id)
    references app_workspace_memberships(workspace_id, user_id)
    on delete restrict,
  foreign key (workspace_id, reference_draft_id)
    references studio_drafts(workspace_id, id)
    on delete restrict,
  foreign key (workspace_id, selected_draft_id)
    references studio_drafts(workspace_id, id)
    on delete restrict
);

-- The Daily Knowledge product owns the live entry tables. This immutable,
-- deliberately URL-free copy means retention may safely remove a source entry
-- later without altering an already requested authoring run.
create table if not exists saga_adobe_authoring_run_knowledge_entries (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app_workspaces(id) on delete cascade,
  run_id uuid not null,
  source_entry_id uuid not null,
  ordinal smallint not null check (ordinal between 1 and 12),
  snapshot jsonb not null default '{}'::jsonb
    check (jsonb_typeof(snapshot) = 'object'),
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, run_id, source_entry_id),
  unique (workspace_id, run_id, ordinal),
  foreign key (workspace_id, run_id)
    references saga_adobe_authoring_runs(workspace_id, id)
    on delete cascade
);

create table if not exists saga_adobe_authoring_candidates (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app_workspaces(id) on delete cascade,
  run_id uuid not null,
  ordinal smallint not null check (ordinal between 1 and 10),
  state text not null default 'queued'
    check (state in ('queued', 'generating', 'ready', 'blocked', 'failed', 'selected', 'not_selected')),
  generated_content jsonb,
  quality jsonb,
  -- Server-only provenance. It deliberately excludes prompts, provider raw
  -- payloads, source URLs and credentials while retaining an auditable model
  -- receipt for a selected private candidate.
  generation_metadata jsonb,
  error_message text check (error_message is null or char_length(error_message) <= 1200),
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, run_id, ordinal),
  foreign key (workspace_id, run_id)
    references saga_adobe_authoring_runs(workspace_id, id)
    on delete cascade,
  check ((state = 'ready' and generated_content is not null and quality is not null) or state <> 'ready'),
  check ((generated_content is null or jsonb_typeof(generated_content) = 'object') and (quality is null or jsonb_typeof(quality) = 'object') and (generation_metadata is null or jsonb_typeof(generation_metadata) = 'object'))
);

alter table saga_adobe_authoring_runs
  drop constraint if exists saga_adobe_authoring_runs_selected_candidate_fkey;
alter table saga_adobe_authoring_runs
  add constraint saga_adobe_authoring_runs_selected_candidate_fkey
  foreign key (workspace_id, selected_candidate_id)
  references saga_adobe_authoring_candidates(workspace_id, id)
  on delete restrict;

create table if not exists saga_adobe_authoring_generation_receipts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app_workspaces(id) on delete cascade,
  run_id uuid not null,
  idempotency_key uuid not null,
  requested_run_revision integer not null check (requested_run_revision > 0),
  run_revision integer not null check (run_revision > 0),
  state text not null default 'running'
    check (state in ('running', 'completed', 'failed', 'stale')),
  job_count smallint not null check (job_count between 1 and 10),
  failure_message text check (failure_message is null or char_length(failure_message) <= 1200),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, idempotency_key),
  foreign key (workspace_id, run_id)
    references saga_adobe_authoring_runs(workspace_id, id)
    on delete cascade,
  check ((state in ('completed', 'failed', 'stale') and completed_at is not null) or state = 'running')
);

create unique index if not exists saga_adobe_authoring_one_active_receipt_idx
  on saga_adobe_authoring_generation_receipts(workspace_id, run_id)
  where state = 'running';

create table if not exists saga_adobe_authoring_generation_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app_workspaces(id) on delete cascade,
  run_id uuid not null,
  candidate_id uuid not null,
  generation_receipt_id uuid,
  run_revision integer not null check (run_revision > 0),
  state text not null default 'queued'
    check (state in ('queued', 'processing', 'completed', 'failed', 'cancelled')),
  claim_token uuid,
  locked_by text,
  lease_expires_at timestamptz,
  attempt_count smallint not null default 0 check (attempt_count >= 0),
  max_attempt_count smallint not null default 3 check (max_attempt_count between 1 and 5),
  failure_code text,
  failure_message text,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, candidate_id),
  foreign key (workspace_id, run_id)
    references saga_adobe_authoring_runs(workspace_id, id)
    on delete cascade,
  foreign key (workspace_id, candidate_id)
    references saga_adobe_authoring_candidates(workspace_id, id)
    on delete cascade,
  foreign key (workspace_id, generation_receipt_id)
    references saga_adobe_authoring_generation_receipts(workspace_id, id)
    on delete restrict,
  check ((state = 'processing' and claim_token is not null and lease_expires_at is not null) or state <> 'processing'),
  check ((state in ('completed', 'failed', 'cancelled') and completed_at is not null) or state in ('queued', 'processing'))
);

create table if not exists saga_adobe_authoring_selection_receipts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app_workspaces(id) on delete cascade,
  run_id uuid not null,
  candidate_id uuid not null,
  idempotency_key uuid not null,
  expected_run_revision integer not null check (expected_run_revision > 0),
  expected_candidate_revision integer not null check (expected_candidate_revision > 0),
  selected_by_user_id uuid not null,
  studio_draft_id uuid not null,
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, idempotency_key),
  unique (workspace_id, run_id),
  foreign key (workspace_id, run_id)
    references saga_adobe_authoring_runs(workspace_id, id)
    on delete cascade,
  foreign key (workspace_id, candidate_id)
    references saga_adobe_authoring_candidates(workspace_id, id)
    on delete restrict,
  foreign key (workspace_id, selected_by_user_id)
    references app_workspace_memberships(workspace_id, user_id)
    on delete restrict,
  foreign key (workspace_id, studio_draft_id)
    references studio_drafts(workspace_id, id)
    on delete restrict
);

create index if not exists saga_adobe_authoring_runs_workspace_recent_idx
  on saga_adobe_authoring_runs(workspace_id, updated_at desc);
create index if not exists saga_adobe_authoring_jobs_claimable_idx
  on saga_adobe_authoring_generation_jobs(workspace_id, generation_receipt_id, created_at)
  where state = 'queued';
create index if not exists saga_adobe_authoring_jobs_lease_idx
  on saga_adobe_authoring_generation_jobs(lease_expires_at)
  where state = 'processing';

drop trigger if exists saga_adobe_authoring_runs_set_updated_at on saga_adobe_authoring_runs;
create trigger saga_adobe_authoring_runs_set_updated_at
before update on saga_adobe_authoring_runs
for each row execute function app_set_updated_at();
drop trigger if exists saga_adobe_authoring_candidates_set_updated_at on saga_adobe_authoring_candidates;
create trigger saga_adobe_authoring_candidates_set_updated_at
before update on saga_adobe_authoring_candidates
for each row execute function app_set_updated_at();
drop trigger if exists saga_adobe_authoring_generation_receipts_set_updated_at on saga_adobe_authoring_generation_receipts;
create trigger saga_adobe_authoring_generation_receipts_set_updated_at
before update on saga_adobe_authoring_generation_receipts
for each row execute function app_set_updated_at();
drop trigger if exists saga_adobe_authoring_generation_jobs_set_updated_at on saga_adobe_authoring_generation_jobs;
create trigger saga_adobe_authoring_generation_jobs_set_updated_at
before update on saga_adobe_authoring_generation_jobs
for each row execute function app_set_updated_at();

-- Marks the durable receipt terminal once all of its jobs have settled. At
-- least one quality-passed candidate is enough for a human to choose; a
-- worker failure never fabricates a replacement candidate.
create or replace function saga_adobe_authoring_finalize_receipt(
  target_workspace_id uuid,
  target_run_id uuid,
  target_receipt_id uuid
)
returns void
language plpgsql
set search_path = public
as $$
declare
  active_job_count integer;
  ready_candidate_count integer;
  failed_job_count integer;
begin
  select count(*) into active_job_count
    from saga_adobe_authoring_generation_jobs job
   where job.workspace_id = target_workspace_id
     and job.run_id = target_run_id
     and job.generation_receipt_id = target_receipt_id
     and job.state in ('queued', 'processing');
  if active_job_count > 0 then return; end if;

  select count(*) into ready_candidate_count
    from saga_adobe_authoring_candidates candidate
   where candidate.workspace_id = target_workspace_id
     and candidate.run_id = target_run_id
     and candidate.state = 'ready';
  select count(*) into failed_job_count
    from saga_adobe_authoring_generation_jobs job
   where job.workspace_id = target_workspace_id
     and job.run_id = target_run_id
     and job.generation_receipt_id = target_receipt_id
     and job.state = 'failed';

  update saga_adobe_authoring_generation_receipts
     set state = case when ready_candidate_count > 0 then 'completed' else 'failed' end,
         failure_message = case
           when ready_candidate_count > 0 and failed_job_count > 0 then 'En eller flera kandidater kunde inte skapas. De färdiga privata kandidaterna går fortfarande att granska.'
           when ready_candidate_count = 0 then 'Inga privata kandidater klarade produktionen. Inget Studio-utkast skapades.'
           else null
         end,
         completed_at = now()
   where workspace_id = target_workspace_id and id = target_receipt_id and state = 'running';

  update saga_adobe_authoring_runs
     set state = case when ready_candidate_count > 0 then 'ready_to_select' else 'failed' end,
         failure_message = case
           when ready_candidate_count > 0 and failed_job_count > 0 then 'En eller flera kandidater kunde inte skapas.'
           when ready_candidate_count = 0 then 'Inga privata kandidater klarade produktionen. Inget Studio-utkast skapades.'
           else null
         end,
         revision = revision + 1
   where workspace_id = target_workspace_id
     and id = target_run_id
     and state = 'generating';
end;
$$;

-- Captures reference and Daily Knowledge values on the server. It accepts only
-- record IDs, an expected saved-draft revision and a bounded writing brief.
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

-- Creates or resumes a durable receipt. A retry after a lost browser response
-- may use a fresh idempotency key while the run remains queued and has no
-- active receipt; generation itself is still only requested explicitly.
create or replace function saga_prepare_adobe_authoring_run_generation(
  target_workspace_id uuid,
  target_user_id uuid,
  target_run_id uuid,
  target_idempotency_key uuid,
  target_expected_run_revision integer,
  target_retry_failed boolean
)
returns table (run_id uuid, receipt_id uuid, reused boolean)
language plpgsql
set search_path = public
as $$
declare
  run_row saga_adobe_authoring_runs%rowtype;
  existing_receipt saga_adobe_authoring_generation_receipts%rowtype;
  active_receipt_id uuid;
  next_run_revision integer;
  eligible_job_count integer;
begin
  select * into existing_receipt
    from saga_adobe_authoring_generation_receipts receipt
   where receipt.workspace_id = target_workspace_id and receipt.idempotency_key = target_idempotency_key;
  if found then
    if existing_receipt.run_id <> target_run_id
       or target_expected_run_revision not in (existing_receipt.requested_run_revision, existing_receipt.run_revision) then
      raise exception 'saga_adobe_authoring_generation_idempotency_conflict' using errcode = 'P0001';
    end if;
    run_id := existing_receipt.run_id;
    receipt_id := existing_receipt.id;
    reused := true;
    return next;
    return;
  end if;

  select * into run_row
    from saga_adobe_authoring_runs
   where workspace_id = target_workspace_id and id = target_run_id
   for update;
  if not found then raise exception 'saga_adobe_authoring_run_not_found' using errcode = 'P0001'; end if;
  if run_row.revision <> target_expected_run_revision then raise exception 'saga_adobe_authoring_run_revision_conflict' using errcode = 'P0001'; end if;
  if run_row.state in ('selected', 'stale') then raise exception 'saga_adobe_authoring_run_closed' using errcode = 'P0001'; end if;
  if run_row.state = 'ready_to_select' then raise exception 'saga_adobe_authoring_candidates_ready' using errcode = 'P0001'; end if;
  select receipt.id into active_receipt_id
    from saga_adobe_authoring_generation_receipts receipt
   where receipt.workspace_id = target_workspace_id and receipt.run_id = target_run_id and receipt.state = 'running'
   for update;
  if active_receipt_id is not null then
    -- A reload has no old browser idempotency key. Re-attaching the current
    -- run revision is safe: no new job/receipt is created and the worker
    -- lease still claims one existing candidate at a time.
    run_id := target_run_id;
    receipt_id := active_receipt_id;
    reused := true;
    return next;
  end if;
  if run_row.state = 'failed' and not target_retry_failed then
    raise exception 'saga_adobe_authoring_retry_required' using errcode = 'P0001';
  end if;

  if run_row.state = 'failed' then
    if exists (
      select 1 from saga_adobe_authoring_generation_jobs job
       where job.workspace_id = target_workspace_id and job.run_id = target_run_id
         and job.state = 'failed' and job.attempt_count >= job.max_attempt_count
    ) then raise exception 'saga_adobe_authoring_attempts_exhausted' using errcode = 'P0001'; end if;
    update saga_adobe_authoring_generation_jobs
       set state = 'queued', generation_receipt_id = null, claim_token = null,
           locked_by = null, lease_expires_at = null, completed_at = null,
           failure_code = null, failure_message = null
     where workspace_id = target_workspace_id and run_id = target_run_id
       and state = 'failed' and attempt_count < max_attempt_count;
    update saga_adobe_authoring_candidates candidate
       set state = 'queued', error_message = null, revision = revision + 1
      from saga_adobe_authoring_generation_jobs job
     where candidate.workspace_id = target_workspace_id and candidate.id = job.candidate_id
       and job.workspace_id = target_workspace_id and job.run_id = target_run_id and job.state = 'queued';
  end if;

  select count(*) into eligible_job_count
    from saga_adobe_authoring_generation_jobs job
   where job.workspace_id = target_workspace_id and job.run_id = target_run_id and job.state = 'queued';
  if eligible_job_count < 1 then raise exception 'saga_adobe_authoring_no_candidates_to_generate' using errcode = 'P0001'; end if;

  update saga_adobe_authoring_runs
     set state = 'generating', failure_message = null, revision = revision + 1
   where workspace_id = target_workspace_id and id = target_run_id
  returning revision into next_run_revision;
  insert into saga_adobe_authoring_generation_receipts (
    workspace_id, run_id, idempotency_key, requested_run_revision, run_revision, job_count
  ) values (
    target_workspace_id, target_run_id, target_idempotency_key, target_expected_run_revision, next_run_revision, eligible_job_count
  ) returning id into receipt_id;
  update saga_adobe_authoring_generation_jobs
     set generation_receipt_id = receipt_id, run_revision = next_run_revision
   where workspace_id = target_workspace_id and run_id = target_run_id and state = 'queued' and generation_receipt_id is null;
  run_id := target_run_id;
  reused := false;
  return next;
end;
$$;

-- Claims a single candidate job with a bounded lease. This is intentionally
-- not called from cron: the request route invokes a bounded worker slice.
create or replace function saga_claim_adobe_authoring_generation_job(
  target_workspace_id uuid,
  target_run_id uuid,
  target_receipt_id uuid,
  target_worker_id text,
  target_lease_seconds integer
)
returns table (
  job_id uuid,
  claim_token uuid,
  receipt_id uuid,
  run_id uuid,
  run_revision integer,
  candidate_id uuid,
  candidate_ordinal smallint,
  reference_snapshot jsonb,
  objective text,
  author_prompt text,
  include_author_name boolean,
  author_name_snapshot text,
  knowledge_entries jsonb
)
language plpgsql
set search_path = public
as $$
declare
  run_row saga_adobe_authoring_runs%rowtype;
  receipt_row saga_adobe_authoring_generation_receipts%rowtype;
  candidate_job_id uuid;
  new_claim_token uuid := gen_random_uuid();
begin
  if target_lease_seconds < 30 or target_lease_seconds > 300 then
    raise exception 'saga_adobe_authoring_invalid_lease' using errcode = '23514';
  end if;
  select * into run_row from saga_adobe_authoring_runs
   where workspace_id = target_workspace_id and id = target_run_id for update;
  if not found or run_row.state <> 'generating' then return; end if;
  select * into receipt_row from saga_adobe_authoring_generation_receipts
   where workspace_id = target_workspace_id and id = target_receipt_id and run_id = target_run_id for update;
  if not found or receipt_row.state <> 'running' then return; end if;
  if run_row.revision <> receipt_row.run_revision then
    update saga_adobe_authoring_generation_jobs
       set state = 'cancelled', completed_at = now(), claim_token = null, locked_by = null, lease_expires_at = null,
           failure_code = 'stale_run_revision', failure_message = 'Författarkörningen ändrades innan kandidaten kunde skapas.'
     where workspace_id = target_workspace_id and run_id = target_run_id and generation_receipt_id = target_receipt_id
       and state in ('queued', 'processing');
    update saga_adobe_authoring_generation_receipts
       set state = 'stale', failure_message = 'Författarkörningen ändrades innan kandidaten kunde skapas.', completed_at = now()
     where workspace_id = target_workspace_id and id = target_receipt_id;
    update saga_adobe_authoring_runs
       set state = 'stale', failure_message = 'Författarkörningen ändrades innan kandidaten kunde skapas.', revision = revision + 1
     where workspace_id = target_workspace_id and id = target_run_id;
    return;
  end if;

  -- A function timeout cannot strand a run forever. Expired work is either
  -- reclaimed below its attempt cap or terminally recorded without pretending
  -- that a candidate exists.
  with exhausted as (
    update saga_adobe_authoring_generation_jobs job
       set state = 'failed', completed_at = now(), claim_token = null, locked_by = null, lease_expires_at = null,
           failure_code = 'lease_attempts_exhausted', failure_message = 'AI-arbetet tappade sin lease för många gånger.'
     where job.workspace_id = target_workspace_id and job.run_id = target_run_id
       and job.generation_receipt_id = target_receipt_id and job.state = 'processing'
       and job.lease_expires_at <= now() and job.attempt_count >= job.max_attempt_count
     returning job.candidate_id
  ) update saga_adobe_authoring_candidates candidate
       set state = 'failed', error_message = 'AI-arbetet tappade sin lease för många gånger.', revision = revision + 1
    from exhausted where candidate.workspace_id = target_workspace_id and candidate.id = exhausted.candidate_id;
  with reclaimed as (
    update saga_adobe_authoring_generation_jobs job
       set state = 'queued', claim_token = null, locked_by = null, lease_expires_at = null,
           failure_code = 'lease_reclaimed', failure_message = 'En tidigare worker avslutades. Kandidaten tas upp igen.'
     where job.workspace_id = target_workspace_id and job.run_id = target_run_id
       and job.generation_receipt_id = target_receipt_id and job.state = 'processing'
       and job.lease_expires_at <= now() and job.attempt_count < job.max_attempt_count
     returning job.candidate_id
  ) update saga_adobe_authoring_candidates candidate
       set state = 'queued', error_message = null, revision = revision + 1
    from reclaimed where candidate.workspace_id = target_workspace_id and candidate.id = reclaimed.candidate_id;

  select job.id into candidate_job_id
    from saga_adobe_authoring_generation_jobs job
   where job.workspace_id = target_workspace_id and job.run_id = target_run_id
     and job.generation_receipt_id = target_receipt_id and job.state = 'queued'
     and job.attempt_count < job.max_attempt_count
   order by job.created_at, job.id
   for update skip locked
   limit 1;
  if candidate_job_id is null then
    perform saga_adobe_authoring_finalize_receipt(target_workspace_id, target_run_id, target_receipt_id);
    return;
  end if;
  update saga_adobe_authoring_generation_jobs
     set state = 'processing', claim_token = new_claim_token, locked_by = left(target_worker_id, 160),
         lease_expires_at = now() + make_interval(secs => target_lease_seconds), attempt_count = attempt_count + 1
   where workspace_id = target_workspace_id and id = candidate_job_id;
  update saga_adobe_authoring_candidates candidate
     set state = 'generating', error_message = null, revision = revision + 1
    from saga_adobe_authoring_generation_jobs job
   where candidate.workspace_id = target_workspace_id and candidate.id = job.candidate_id and job.id = candidate_job_id;

  return query
  select job.id, job.claim_token, receipt.id, run.id, receipt.run_revision,
    candidate.id, candidate.ordinal, run.reference_snapshot, run.objective,
    run.author_prompt, run.include_author_name, run.author_name_snapshot,
    coalesce(jsonb_agg(entry.snapshot order by entry.ordinal) filter (where entry.id is not null), '[]'::jsonb)
  from saga_adobe_authoring_generation_jobs job
  join saga_adobe_authoring_generation_receipts receipt
    on receipt.workspace_id = job.workspace_id and receipt.id = job.generation_receipt_id
  join saga_adobe_authoring_runs run
    on run.workspace_id = job.workspace_id and run.id = job.run_id
  join saga_adobe_authoring_candidates candidate
    on candidate.workspace_id = job.workspace_id and candidate.id = job.candidate_id
  left join saga_adobe_authoring_run_knowledge_entries entry
    on entry.workspace_id = run.workspace_id and entry.run_id = run.id
  where job.workspace_id = target_workspace_id and job.id = candidate_job_id and job.claim_token = new_claim_token
  group by job.id, job.claim_token, receipt.id, run.id, receipt.run_revision, candidate.id,
    candidate.ordinal, run.reference_snapshot, run.objective, run.author_prompt,
    run.include_author_name, run.author_name_snapshot;
end;
$$;

create or replace function saga_complete_adobe_authoring_generation_job(
  target_workspace_id uuid,
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
  select * into job_row from saga_adobe_authoring_generation_jobs
   where workspace_id = target_workspace_id and id = target_job_id and state = 'processing' and claim_token = target_claim_token
   for update;
  if not found then candidate_id := null; stale := true; return next; return; end if;
  select * into run_row from saga_adobe_authoring_runs
   where workspace_id = target_workspace_id and id = job_row.run_id for update;
  select * into receipt_row from saga_adobe_authoring_generation_receipts
   where workspace_id = target_workspace_id and id = job_row.generation_receipt_id for update;
  if not found or run_row.revision <> job_row.run_revision or receipt_row.state <> 'running' or run_row.state <> 'generating' then
    update saga_adobe_authoring_generation_jobs
       set state = 'cancelled', completed_at = now(), claim_token = null, locked_by = null, lease_expires_at = null,
           failure_code = 'stale_run_revision', failure_message = 'Körningen ändrades före den privata kandidaten kunde sparas.'
     where workspace_id = target_workspace_id and id = target_job_id;
    update saga_adobe_authoring_candidates
       set state = 'failed', error_message = 'Körningen ändrades före den privata kandidaten kunde sparas.', revision = revision + 1
     where workspace_id = target_workspace_id and id = job_row.candidate_id and state = 'generating';
    candidate_id := null; stale := true; return next; return;
  end if;
  update saga_adobe_authoring_candidates
     set state = 'ready', generated_content = target_materialization -> 'content', quality = target_materialization -> 'quality',
         generation_metadata = jsonb_build_object(
           'model', left(target_materialization ->> 'model', 160),
           'responseId', left(target_materialization ->> 'responseId', 240),
           'inputTokens', case when (target_materialization ->> 'inputTokens') ~ '^[0-9]+$' then (target_materialization ->> 'inputTokens')::integer else null end,
           'outputTokens', case when (target_materialization ->> 'outputTokens') ~ '^[0-9]+$' then (target_materialization ->> 'outputTokens')::integer else null end,
           'promptPolicyVersion', 'saga-adobe-authoring/v1',
           'completedAt', now()::text
         ),
         error_message = null, revision = revision + 1
   where workspace_id = target_workspace_id and id = job_row.candidate_id and state = 'generating';
  if not found then candidate_id := null; stale := true; return next; return; end if;
  update saga_adobe_authoring_generation_jobs
     set state = 'completed', completed_at = now(), claim_token = null, locked_by = null, lease_expires_at = null,
         failure_code = null, failure_message = null
   where workspace_id = target_workspace_id and id = target_job_id and claim_token = target_claim_token;
  perform saga_adobe_authoring_finalize_receipt(target_workspace_id, job_row.run_id, job_row.generation_receipt_id);
  candidate_id := job_row.candidate_id; stale := false; return next;
end;
$$;

create or replace function saga_block_adobe_authoring_generation_job(
  target_workspace_id uuid,
  target_job_id uuid,
  target_claim_token uuid,
  target_quality jsonb,
  target_message text
)
returns boolean
language plpgsql
set search_path = public
as $$
declare job_row saga_adobe_authoring_generation_jobs%rowtype;
begin
  select * into job_row from saga_adobe_authoring_generation_jobs
   where workspace_id = target_workspace_id and id = target_job_id and state = 'processing' and claim_token = target_claim_token
   for update;
  if not found then return false; end if;
  update saga_adobe_authoring_candidates
     set state = 'blocked', quality = target_quality, error_message = left(target_message, 1200), revision = revision + 1
   where workspace_id = target_workspace_id and id = job_row.candidate_id and state = 'generating';
  update saga_adobe_authoring_generation_jobs
     set state = 'completed', completed_at = now(), claim_token = null, locked_by = null, lease_expires_at = null,
         failure_code = 'production_quality_rejected', failure_message = left(target_message, 1200)
   where workspace_id = target_workspace_id and id = target_job_id and claim_token = target_claim_token;
  perform saga_adobe_authoring_finalize_receipt(target_workspace_id, job_row.run_id, job_row.generation_receipt_id);
  return true;
end;
$$;

create or replace function saga_fail_adobe_authoring_generation_job(
  target_workspace_id uuid,
  target_job_id uuid,
  target_claim_token uuid,
  target_error_code text,
  target_error_message text
)
returns boolean
language plpgsql
set search_path = public
as $$
declare job_row saga_adobe_authoring_generation_jobs%rowtype;
begin
  select * into job_row from saga_adobe_authoring_generation_jobs
   where workspace_id = target_workspace_id and id = target_job_id and state = 'processing' and claim_token = target_claim_token
   for update;
  if not found then return false; end if;
  update saga_adobe_authoring_candidates
     set state = 'failed', error_message = left(target_error_message, 1200), revision = revision + 1
   where workspace_id = target_workspace_id and id = job_row.candidate_id and state = 'generating';
  update saga_adobe_authoring_generation_jobs
     set state = 'failed', completed_at = now(), claim_token = null, locked_by = null, lease_expires_at = null,
         failure_code = left(target_error_code, 120), failure_message = left(target_error_message, 1200)
   where workspace_id = target_workspace_id and id = target_job_id and claim_token = target_claim_token;
  perform saga_adobe_authoring_finalize_receipt(target_workspace_id, job_row.run_id, job_row.generation_receipt_id);
  return true;
end;
$$;

-- This is the only function that materializes a Studio draft. It inserts an
-- unscheduled `in_review` document and never calls an external provider.
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

commit;
