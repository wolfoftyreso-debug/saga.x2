-- Durable request commands for Adobe-simple authoring generation.
--
-- A generation receipt may contain up to ten candidate jobs, but one HTTP
-- command must advance at most one job.  This migration makes a duplicated or
-- lost client request a replay of the same command rather than permission to
-- claim the next candidate.

begin;

create table if not exists saga_adobe_authoring_generation_commands (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app_workspaces(id) on delete cascade,
  run_id uuid not null,
  generation_receipt_id uuid not null,
  state text not null default 'running'
    check (state in ('running', 'completed', 'stale')),
  claim_token uuid,
  lease_expires_at timestamptz,
  attempt_count smallint not null default 0 check (attempt_count >= 0),
  processed_job_id uuid,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, run_id)
    references saga_adobe_authoring_runs(workspace_id, id)
    on delete cascade,
  foreign key (workspace_id, generation_receipt_id)
    references saga_adobe_authoring_generation_receipts(workspace_id, id)
    on delete cascade,
  foreign key (workspace_id, processed_job_id)
    references saga_adobe_authoring_generation_jobs(workspace_id, id)
    on delete set null,
  check ((state = 'running' and claim_token is not null and lease_expires_at is not null)
      or state in ('completed', 'stale')),
  check ((state in ('completed', 'stale') and completed_at is not null)
      or state = 'running')
);

create unique index if not exists saga_adobe_authoring_one_active_command_idx
  on saga_adobe_authoring_generation_commands(workspace_id, generation_receipt_id)
  where state = 'running';
create index if not exists saga_adobe_authoring_commands_expiry_idx
  on saga_adobe_authoring_generation_commands(lease_expires_at)
  where state = 'running';

create table if not exists saga_adobe_authoring_generation_command_keys (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app_workspaces(id) on delete cascade,
  run_id uuid not null,
  generation_command_id uuid not null,
  idempotency_key uuid not null,
  expected_run_revision integer not null check (expected_run_revision > 0),
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, idempotency_key),
  foreign key (workspace_id, run_id)
    references saga_adobe_authoring_runs(workspace_id, id)
    on delete cascade,
  foreign key (workspace_id, generation_command_id)
    references saga_adobe_authoring_generation_commands(workspace_id, id)
    on delete cascade
);

drop trigger if exists saga_adobe_authoring_generation_commands_set_updated_at
  on saga_adobe_authoring_generation_commands;
create trigger saga_adobe_authoring_generation_commands_set_updated_at
before update on saga_adobe_authoring_generation_commands
for each row execute function app_set_updated_at();

-- Safely bridge an already-applied 025 in staging: the first explicit
-- continuation may reclaim this expired command, but no cron path can do so.
insert into saga_adobe_authoring_generation_commands (
  workspace_id, run_id, generation_receipt_id, state, claim_token,
  lease_expires_at, attempt_count
)
select receipt.workspace_id, receipt.run_id, receipt.id, 'running',
       gen_random_uuid(), now() - interval '1 second', 0
  from saga_adobe_authoring_generation_receipts receipt
 where receipt.state = 'running'
   and not exists (
     select 1
       from saga_adobe_authoring_generation_commands command
      where command.workspace_id = receipt.workspace_id
        and command.generation_receipt_id = receipt.id
        and command.state = 'running'
   )
on conflict do nothing;

-- The signatures below deliberately supersede the pre-command functions.
-- No browser route calls the old overloads after this migration.
drop function if exists saga_prepare_adobe_authoring_run_generation(uuid, uuid, uuid, uuid, integer, boolean);
drop function if exists saga_claim_adobe_authoring_generation_job(uuid, uuid, uuid, text, integer);
drop function if exists saga_complete_adobe_authoring_generation_job(uuid, uuid, uuid, jsonb);
drop function if exists saga_block_adobe_authoring_generation_job(uuid, uuid, uuid, jsonb, text);
drop function if exists saga_fail_adobe_authoring_generation_job(uuid, uuid, uuid, text, text);

-- Creates a request-key alias.  A key maps to exactly one command forever.
-- `should_process` is true only for the caller that owns the current command
-- lease.  A timed-out command can be reclaimed by another explicit request;
-- this is safe because the job claim below checks the same command token.
create function saga_prepare_adobe_authoring_run_generation(
  target_workspace_id uuid,
  target_user_id uuid,
  target_run_id uuid,
  target_idempotency_key uuid,
  target_expected_run_revision integer,
  target_retry_failed boolean
)
returns table (
  run_id uuid,
  receipt_id uuid,
  command_id uuid,
  command_claim_token uuid,
  reused boolean,
  should_process boolean
)
language plpgsql
set search_path = public
as $$
declare
  run_row saga_adobe_authoring_runs%rowtype;
  key_row saga_adobe_authoring_generation_command_keys%rowtype;
  command_row saga_adobe_authoring_generation_commands%rowtype;
  active_receipt_id uuid;
  active_receipt_run_revision integer;
  active_command_id uuid;
  active_command_claim_token uuid;
  active_command_lease_expires_at timestamptz;
  next_run_revision integer;
  eligible_job_count integer;
  next_command_token uuid;
begin
  -- Lock the run before looking up the key. That makes two simultaneous
  -- submissions for the same run serialize before either can insert an alias.
  -- A replay is still allowed to return after this lock even if the run's
  -- revision moved during the original command.
  select * into run_row
    from saga_adobe_authoring_runs run
   where run.workspace_id = target_workspace_id and run.id = target_run_id
   for update;
  if not found then raise exception 'saga_adobe_authoring_run_not_found' using errcode = 'P0001'; end if;

  select * into key_row
    from saga_adobe_authoring_generation_command_keys command_key
   where command_key.workspace_id = target_workspace_id
     and command_key.idempotency_key = target_idempotency_key
   for update;
  if found then
    select * into command_row
      from saga_adobe_authoring_generation_commands command
     where command.workspace_id = target_workspace_id
       and command.id = key_row.generation_command_id
     for update;
    if not found then
      raise exception 'saga_adobe_authoring_generation_command_not_found' using errcode = 'P0001';
    end if;
    if key_row.run_id <> target_run_id
       or key_row.expected_run_revision <> target_expected_run_revision then
      raise exception 'saga_adobe_authoring_generation_idempotency_conflict' using errcode = 'P0001';
    end if;
    run_id := key_row.run_id;
    receipt_id := command_row.generation_receipt_id;
    command_id := command_row.id;
    reused := true;
    if command_row.state = 'running' and command_row.lease_expires_at <= now() then
      next_command_token := gen_random_uuid();
      update saga_adobe_authoring_generation_commands command
         set claim_token = next_command_token,
             lease_expires_at = now() + interval '90 seconds',
             attempt_count = command.attempt_count + 1,
             completed_at = null,
             processed_job_id = null
       where command.workspace_id = target_workspace_id
         and command.id = command_row.id
         and command.state = 'running'
      returning command.claim_token into command_claim_token;
      should_process := command_claim_token is not null;
    else
      command_claim_token := null;
      should_process := false;
    end if;
    return next;
    return;
  end if;

  if run_row.revision <> target_expected_run_revision then
    raise exception 'saga_adobe_authoring_run_revision_conflict' using errcode = 'P0001';
  end if;
  if run_row.state in ('selected', 'stale') then
    raise exception 'saga_adobe_authoring_run_closed' using errcode = 'P0001';
  end if;
  if run_row.state = 'ready_to_select' then
    raise exception 'saga_adobe_authoring_candidates_ready' using errcode = 'P0001';
  end if;

  select receipt.id, receipt.run_revision
    into active_receipt_id, active_receipt_run_revision
    from saga_adobe_authoring_generation_receipts receipt
   where receipt.workspace_id = target_workspace_id
     and receipt.run_id = target_run_id
     and receipt.state = 'running'
   for update;

  if not found then
    if run_row.state = 'failed' and not target_retry_failed then
      raise exception 'saga_adobe_authoring_retry_required' using errcode = 'P0001';
    end if;
    if run_row.state = 'failed' then
      if exists (
        select 1
          from saga_adobe_authoring_generation_jobs job
         where job.workspace_id = target_workspace_id
           and job.run_id = target_run_id
           and job.state = 'failed'
           and job.attempt_count >= job.max_attempt_count
      ) then
        raise exception 'saga_adobe_authoring_attempts_exhausted' using errcode = 'P0001';
      end if;
      update saga_adobe_authoring_generation_jobs job
         set state = 'queued', generation_receipt_id = null, claim_token = null,
             locked_by = null, lease_expires_at = null, completed_at = null,
             failure_code = null, failure_message = null
       where job.workspace_id = target_workspace_id
         and job.run_id = target_run_id
         and job.state = 'failed'
         and job.attempt_count < job.max_attempt_count;
      update saga_adobe_authoring_candidates candidate
         set state = 'queued', error_message = null, revision = candidate.revision + 1
        from saga_adobe_authoring_generation_jobs job
       where candidate.workspace_id = target_workspace_id
         and candidate.id = job.candidate_id
         and job.workspace_id = target_workspace_id
         and job.run_id = target_run_id
         and job.state = 'queued';
    end if;

    select count(*) into eligible_job_count
      from saga_adobe_authoring_generation_jobs job
     where job.workspace_id = target_workspace_id
       and job.run_id = target_run_id
       and job.state = 'queued'
       and job.generation_receipt_id is null;
    if eligible_job_count < 1 then
      raise exception 'saga_adobe_authoring_no_candidates_to_generate' using errcode = 'P0001';
    end if;
    update saga_adobe_authoring_runs run
       set state = 'generating', failure_message = null, revision = run.revision + 1
     where run.workspace_id = target_workspace_id and run.id = target_run_id
    returning run.revision into next_run_revision;
    insert into saga_adobe_authoring_generation_receipts (
      workspace_id, run_id, idempotency_key, requested_run_revision,
      run_revision, job_count
    ) values (
      target_workspace_id, target_run_id, target_idempotency_key,
      target_expected_run_revision, next_run_revision, eligible_job_count
    ) returning id into active_receipt_id;
    active_receipt_run_revision := next_run_revision;
    update saga_adobe_authoring_generation_jobs job
       set generation_receipt_id = active_receipt_id,
           run_revision = next_run_revision
     where job.workspace_id = target_workspace_id
       and job.run_id = target_run_id
       and job.state = 'queued'
       and job.generation_receipt_id is null;
    reused := false;
  else
    reused := true;
  end if;

  select command.id, command.claim_token, command.lease_expires_at
    into active_command_id, active_command_claim_token, active_command_lease_expires_at
    from saga_adobe_authoring_generation_commands command
   where command.workspace_id = target_workspace_id
     and command.generation_receipt_id = active_receipt_id
     and command.state = 'running'
   for update;

  if found then
    command_id := active_command_id;
    if active_command_lease_expires_at <= now() then
      next_command_token := gen_random_uuid();
      update saga_adobe_authoring_generation_commands command
         set claim_token = next_command_token,
             lease_expires_at = now() + interval '90 seconds',
             attempt_count = command.attempt_count + 1,
             completed_at = null,
             processed_job_id = null
       where command.workspace_id = target_workspace_id
         and command.id = active_command_id
         and command.state = 'running'
      returning command.claim_token into command_claim_token;
      should_process := command_claim_token is not null;
    else
      command_claim_token := null;
      should_process := false;
    end if;
  else
    next_command_token := gen_random_uuid();
    insert into saga_adobe_authoring_generation_commands (
      workspace_id, run_id, generation_receipt_id, state, claim_token,
      lease_expires_at, attempt_count
    ) values (
      target_workspace_id, target_run_id, active_receipt_id, 'running',
      next_command_token, now() + interval '90 seconds', 1
    ) returning id, claim_token into command_id, command_claim_token;
    should_process := true;
  end if;

  insert into saga_adobe_authoring_generation_command_keys (
    workspace_id, run_id, generation_command_id, idempotency_key,
    expected_run_revision
  ) values (
    target_workspace_id, target_run_id, command_id, target_idempotency_key,
    target_expected_run_revision
  );
  run_id := target_run_id;
  receipt_id := active_receipt_id;
  return next;
end;
$$;

-- The job claim checks the command lease as well as the job lease. A command
-- that lost its Vercel response cannot wake up later and claim another item.
create function saga_claim_adobe_authoring_generation_job(
  target_workspace_id uuid,
  target_run_id uuid,
  target_receipt_id uuid,
  target_command_id uuid,
  target_command_claim_token uuid,
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
  command_row saga_adobe_authoring_generation_commands%rowtype;
  candidate_job_id uuid;
  new_claim_token uuid := gen_random_uuid();
begin
  if target_lease_seconds < 30 or target_lease_seconds > 300 then
    raise exception 'saga_adobe_authoring_invalid_lease' using errcode = '23514';
  end if;
  select * into run_row from saga_adobe_authoring_runs run
   where run.workspace_id = target_workspace_id and run.id = target_run_id for update;
  if not found or run_row.state <> 'generating' then return; end if;
  select * into receipt_row from saga_adobe_authoring_generation_receipts receipt
   where receipt.workspace_id = target_workspace_id and receipt.id = target_receipt_id
     and receipt.run_id = target_run_id for update;
  if not found or receipt_row.state <> 'running' then return; end if;
  select * into command_row from saga_adobe_authoring_generation_commands command
   where command.workspace_id = target_workspace_id
     and command.id = target_command_id
     and command.run_id = target_run_id
     and command.generation_receipt_id = target_receipt_id
     and command.state = 'running'
     and command.claim_token = target_command_claim_token
     and command.lease_expires_at > now()
   for update;
  if not found then return; end if;
  if run_row.revision <> receipt_row.run_revision then
    update saga_adobe_authoring_generation_jobs job
       set state = 'cancelled', completed_at = now(), claim_token = null,
           locked_by = null, lease_expires_at = null,
           failure_code = 'stale_run_revision',
           failure_message = 'Författarkörningen ändrades innan kandidaten kunde skapas.'
     where job.workspace_id = target_workspace_id
       and job.run_id = target_run_id
       and job.generation_receipt_id = target_receipt_id
       and job.state in ('queued', 'processing');
    update saga_adobe_authoring_generation_receipts receipt
       set state = 'stale',
           failure_message = 'Författarkörningen ändrades innan kandidaten kunde skapas.',
           completed_at = now()
     where receipt.workspace_id = target_workspace_id and receipt.id = target_receipt_id;
    update saga_adobe_authoring_generation_commands command
       set state = 'stale', completed_at = now()
     where command.workspace_id = target_workspace_id and command.id = target_command_id
       and command.claim_token = target_command_claim_token;
    update saga_adobe_authoring_runs run
       set state = 'stale',
           failure_message = 'Författarkörningen ändrades innan kandidaten kunde skapas.',
           revision = run.revision + 1
     where run.workspace_id = target_workspace_id and run.id = target_run_id;
    return;
  end if;

  with exhausted as (
    update saga_adobe_authoring_generation_jobs job
       set state = 'failed', completed_at = now(), claim_token = null,
           locked_by = null, lease_expires_at = null,
           failure_code = 'lease_attempts_exhausted',
           failure_message = 'AI-arbetet tappade sin lease för många gånger.'
     where job.workspace_id = target_workspace_id
       and job.run_id = target_run_id
       and job.generation_receipt_id = target_receipt_id
       and job.state = 'processing'
       and job.lease_expires_at <= now()
       and job.attempt_count >= job.max_attempt_count
     returning job.candidate_id
  ) update saga_adobe_authoring_candidates candidate
       set state = 'failed',
           error_message = 'AI-arbetet tappade sin lease för många gånger.',
           revision = candidate.revision + 1
    from exhausted
   where candidate.workspace_id = target_workspace_id
     and candidate.id = exhausted.candidate_id;
  with reclaimed as (
    update saga_adobe_authoring_generation_jobs job
       set state = 'queued', claim_token = null, locked_by = null,
           lease_expires_at = null, failure_code = 'lease_reclaimed',
           failure_message = 'En tidigare worker avslutades. Kandidaten tas upp igen.'
     where job.workspace_id = target_workspace_id
       and job.run_id = target_run_id
       and job.generation_receipt_id = target_receipt_id
       and job.state = 'processing'
       and job.lease_expires_at <= now()
       and job.attempt_count < job.max_attempt_count
     returning job.candidate_id
  ) update saga_adobe_authoring_candidates candidate
       set state = 'queued', error_message = null, revision = candidate.revision + 1
    from reclaimed
   where candidate.workspace_id = target_workspace_id
     and candidate.id = reclaimed.candidate_id;

  select job.id into candidate_job_id
    from saga_adobe_authoring_generation_jobs job
   where job.workspace_id = target_workspace_id
     and job.run_id = target_run_id
     and job.generation_receipt_id = target_receipt_id
     and job.state = 'queued'
     and job.attempt_count < job.max_attempt_count
   order by job.created_at, job.id
   for update skip locked
   limit 1;
  if candidate_job_id is null then
    perform saga_adobe_authoring_finalize_receipt(target_workspace_id, target_run_id, target_receipt_id);
    update saga_adobe_authoring_generation_commands command
       set state = 'completed', completed_at = now(), processed_job_id = null
     where command.workspace_id = target_workspace_id
       and command.id = target_command_id
       and command.state = 'running'
       and command.claim_token = target_command_claim_token;
    return;
  end if;
  update saga_adobe_authoring_generation_jobs job
     set state = 'processing', claim_token = new_claim_token,
         locked_by = left(target_worker_id, 160),
         lease_expires_at = now() + make_interval(secs => target_lease_seconds),
         attempt_count = job.attempt_count + 1
   where job.workspace_id = target_workspace_id and job.id = candidate_job_id;
  update saga_adobe_authoring_candidates candidate
     set state = 'generating', error_message = null, revision = candidate.revision + 1
    from saga_adobe_authoring_generation_jobs job
   where candidate.workspace_id = target_workspace_id
     and candidate.id = job.candidate_id
     and job.id = candidate_job_id;

  return query
  select job.id, job.claim_token, receipt.id, run.id, receipt.run_revision,
    candidate.id, candidate.ordinal, run.reference_snapshot, run.objective,
    run.author_prompt, run.include_author_name, run.author_name_snapshot,
    coalesce(jsonb_agg(entry.snapshot order by entry.ordinal)
      filter (where entry.id is not null), '[]'::jsonb)
  from saga_adobe_authoring_generation_jobs job
  join saga_adobe_authoring_generation_receipts receipt
    on receipt.workspace_id = job.workspace_id
   and receipt.id = job.generation_receipt_id
  join saga_adobe_authoring_runs run
    on run.workspace_id = job.workspace_id and run.id = job.run_id
  join saga_adobe_authoring_candidates candidate
    on candidate.workspace_id = job.workspace_id and candidate.id = job.candidate_id
  left join saga_adobe_authoring_run_knowledge_entries entry
    on entry.workspace_id = run.workspace_id and entry.run_id = run.id
 where job.workspace_id = target_workspace_id
   and job.id = candidate_job_id
   and job.claim_token = new_claim_token
 group by job.id, job.claim_token, receipt.id, run.id, receipt.run_revision,
   candidate.id, candidate.ordinal, run.reference_snapshot, run.objective,
   run.author_prompt, run.include_author_name, run.author_name_snapshot;
end;
$$;

create function saga_complete_adobe_authoring_generation_job(
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

create function saga_block_adobe_authoring_generation_job(
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

create function saga_fail_adobe_authoring_generation_job(
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

-- Completes a command that found no claimable job. It is safe when another
-- request has already advanced the receipt: the token prevents that caller
-- from releasing a newer command.
create function saga_finish_adobe_authoring_generation_command(
  target_workspace_id uuid,
  target_command_id uuid,
  target_command_claim_token uuid
)
returns boolean
language plpgsql
set search_path = public
as $$
declare command_row saga_adobe_authoring_generation_commands%rowtype;
begin
  select * into command_row from saga_adobe_authoring_generation_commands command
   where command.workspace_id = target_workspace_id
     and command.id = target_command_id
     and command.state = 'running'
     and command.claim_token = target_command_claim_token
     and command.lease_expires_at > now()
   for update;
  if not found then return false; end if;
  perform saga_adobe_authoring_finalize_receipt(
    target_workspace_id, command_row.run_id, command_row.generation_receipt_id
  );
  update saga_adobe_authoring_generation_commands command
     set state = 'completed', completed_at = now(), processed_job_id = null
   where command.workspace_id = target_workspace_id
     and command.id = target_command_id
     and command.claim_token = target_command_claim_token;
  return true;
end;
$$;

commit;
