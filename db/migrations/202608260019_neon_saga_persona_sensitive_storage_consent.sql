-- SAGA Persona Context: explicit sensitive-data storage receipts.
--
-- Follow 018; never edit applied migrations. Political/religious stance,
-- origin and country of birth are optional private fields, but they require a
-- fresh owner acknowledgement on every revision that contains them.

begin;

create or replace function saga_persona_context_payload_has_sensitive_data(payload jsonb)
returns boolean
language sql
immutable
as $$
  select coalesce(payload -> 'political' ->> 'mode', 'not_specified') <> 'not_specified'
      or coalesce(payload -> 'religion' ->> 'mode', 'not_specified') <> 'not_specified'
      or (payload -> 'origin') <> 'null'::jsonb
      or (payload -> 'birthCountry') <> 'null'::jsonb;
$$;

create table if not exists saga_persona_sensitive_storage_consents (
  workspace_id uuid not null,
  owner_user_id uuid not null,
  context_revision integer not null check (context_revision > 0),
  consent_version text not null
    check (consent_version = 'saga_persona_sensitive_storage_v1'),
  consented_by_user_id uuid not null,
  consented_at timestamptz not null default now(),
  primary key (workspace_id, owner_user_id, context_revision),
  foreign key (workspace_id, owner_user_id, context_revision)
    references saga_persona_context_revisions(workspace_id, owner_user_id, revision)
    on delete cascade,
  foreign key (workspace_id, consented_by_user_id)
    references app_workspace_memberships(workspace_id, user_id)
    on delete restrict,
  check (consented_by_user_id = owner_user_id)
);

-- A receipt cannot be written for a blank/non-sensitive snapshot, even by a
-- future internal caller that bypasses the normal write function.
create or replace function saga_persona_sensitive_storage_consent_is_valid()
returns trigger
language plpgsql
as $$
declare
  revision_payload jsonb;
begin
  select payload into revision_payload
    from saga_persona_context_revisions
   where workspace_id = new.workspace_id
     and owner_user_id = new.owner_user_id
     and revision = new.context_revision;
  if not found or not saga_persona_context_payload_has_sensitive_data(revision_payload) then
    raise exception 'SAGA persona sensitive storage receipt requires sensitive self-described data';
  end if;
  return new;
end;
$$;

drop trigger if exists saga_persona_sensitive_storage_consent_guard on saga_persona_sensitive_storage_consents;
create trigger saga_persona_sensitive_storage_consent_guard
before insert or update on saga_persona_sensitive_storage_consents
for each row execute function saga_persona_sensitive_storage_consent_is_valid();

create or replace function saga_persona_sensitive_storage_consent_is_immutable()
returns trigger
language plpgsql
as $$
begin
  raise exception 'saga_persona_sensitive_storage_consents are immutable';
end;
$$;

drop trigger if exists saga_persona_sensitive_storage_consent_immutable on saga_persona_sensitive_storage_consents;
create trigger saga_persona_sensitive_storage_consent_immutable
before update on saga_persona_sensitive_storage_consents
for each row execute function saga_persona_sensitive_storage_consent_is_immutable();

-- Replace the 018 write function with a five-argument revision that receives
-- only the acknowledgement version. The server supplies actor/workspace;
-- timestamps and receipt ownership are generated in Postgres.
drop function if exists saga_persona_context_write(uuid, uuid, jsonb, integer);

create function saga_persona_context_write(
  target_workspace_id uuid,
  target_owner_user_id uuid,
  target_payload jsonb,
  expected_revision integer,
  target_sensitive_storage_consent_version text
)
returns integer
language plpgsql
as $$
declare
  current_revision integer;
  next_revision integer;
  payload_has_sensitive_data boolean;
begin
  if not saga_persona_context_payload_is_valid(target_payload) then
    raise exception 'SAGA persona context payload is invalid' using errcode = 'P0001';
  end if;
  if not exists (
    select 1
    from app_workspace_memberships membership
    where membership.workspace_id = target_workspace_id
      and membership.user_id = target_owner_user_id
      and membership.role = 'owner'
  ) then
    raise exception 'SAGA persona context requires workspace owner' using errcode = 'P0001';
  end if;

  payload_has_sensitive_data := saga_persona_context_payload_has_sensitive_data(target_payload);
  if payload_has_sensitive_data and target_sensitive_storage_consent_version is distinct from 'saga_persona_sensitive_storage_v1' then
    raise exception 'SAGA persona sensitive storage consent is required' using errcode = 'P0001';
  end if;
  if not payload_has_sensitive_data and target_sensitive_storage_consent_version is not null then
    raise exception 'SAGA persona sensitive storage consent has no sensitive data' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(target_workspace_id::text || ':' || target_owner_user_id::text, 0));
  select revision into current_revision
    from saga_persona_contexts
   where workspace_id = target_workspace_id and owner_user_id = target_owner_user_id
   for update;

  if found then
    if expected_revision is not null and expected_revision <> current_revision then return null; end if;
    next_revision := current_revision + 1;
    update saga_persona_contexts
       set revision = next_revision,
           payload = target_payload
     where workspace_id = target_workspace_id and owner_user_id = target_owner_user_id;
  else
    if expected_revision is not null then return null; end if;
    next_revision := 1;
    insert into saga_persona_contexts (workspace_id, owner_user_id, revision, payload)
    values (target_workspace_id, target_owner_user_id, next_revision, target_payload);
  end if;

  insert into saga_persona_context_revisions (workspace_id, owner_user_id, revision, payload)
  values (target_workspace_id, target_owner_user_id, next_revision, target_payload);

  if payload_has_sensitive_data then
    insert into saga_persona_sensitive_storage_consents (
      workspace_id, owner_user_id, context_revision, consent_version,
      consented_by_user_id
    ) values (
      target_workspace_id, target_owner_user_id, next_revision,
      target_sensitive_storage_consent_version, target_owner_user_id
    );
  end if;
  return next_revision;
end;
$$;

create index if not exists saga_persona_sensitive_storage_consents_owner_created_idx
  on saga_persona_sensitive_storage_consents(workspace_id, owner_user_id, consented_at desc);

commit;
