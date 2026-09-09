-- SAGA private avatar references.
--
-- Source photographs are biometric personal data.  This schema stores only
-- server-owned private Vercel Blob metadata, explicit consent receipts, and
-- a hard invariant that generated output may never be configured for a fully
-- visible face.  No public URL, model job, or social delivery is created here.

begin;

create table if not exists saga_avatar_profiles (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app_workspaces(id) on delete cascade,
  created_by_user_id uuid not null,
  label text not null check (char_length(trim(label)) between 1 and 120),
  -- This is intentionally a constant policy, not a setting exposed to users.
  output_visibility_policy text not null default 'obscured_noir_only'
    check (output_visibility_policy = 'obscured_noir_only'),
  full_face_allowed boolean not null default false
    check (full_face_allowed = false),
  -- Upload consent and provider-processing consent are separate on purpose.
  reference_consent_version text not null
    check (char_length(trim(reference_consent_version)) between 1 and 120),
  reference_consented_at timestamptz not null default now(),
  provider_processing_enabled boolean not null default false,
  provider_processing_provider text,
  provider_processing_consent_version text,
  provider_processing_consented_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, created_by_user_id)
    references app_workspace_memberships(workspace_id, user_id)
    on delete restrict,
  check (
    (
      provider_processing_enabled = false
      and provider_processing_provider is null
      and provider_processing_consent_version is null
      and provider_processing_consented_at is null
    )
    or (
      provider_processing_enabled = true
      and provider_processing_provider = 'vercel_ai_gateway'
      and char_length(trim(provider_processing_consent_version)) between 1 and 120
      and provider_processing_consented_at is not null
    )
  )
);

create table if not exists saga_avatar_reference_images (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app_workspaces(id) on delete cascade,
  profile_id uuid not null,
  created_by_user_id uuid not null,
  -- `front` is allowed as a private model reference, but it is never served
  -- through the UI or permitted as a generated/public output.
  angle text not null check (angle in (
    'front',
    'three_quarter_left',
    'three_quarter_right',
    'left_profile',
    'right_profile',
    'back',
    'other'
  )),
  position smallint not null check (position between 1 and 6),
  storage_provider text not null default 'vercel_blob'
    check (storage_provider = 'vercel_blob'),
  -- Internal server metadata only.  API projections must never return either.
  blob_url text not null check (blob_url ~ '^https://'),
  blob_pathname text not null check (char_length(trim(blob_pathname)) between 1 and 1024),
  content_type text not null check (content_type in ('image/jpeg', 'image/png', 'image/webp')),
  byte_size bigint not null check (byte_size > 0 and byte_size <= 20971520),
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, blob_pathname),
  unique (workspace_id, profile_id, position),
  foreign key (workspace_id, profile_id)
    references saga_avatar_profiles(workspace_id, id)
    on delete cascade,
  foreign key (workspace_id, created_by_user_id)
    references app_workspace_memberships(workspace_id, user_id)
    on delete restrict
);

-- Consent history is deliberately separate from the current profile switches.
-- It supports an auditable opt-in and opt-out history without retaining image
-- metadata after a user deletes the profile.
create table if not exists saga_avatar_consent_records (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app_workspaces(id) on delete cascade,
  profile_id uuid not null,
  consent_kind text not null check (consent_kind in ('reference_upload', 'provider_processing')),
  provider text,
  consent_version text not null check (char_length(trim(consent_version)) between 1 and 120),
  granted boolean not null,
  consented_by_user_id uuid not null,
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, profile_id)
    references saga_avatar_profiles(workspace_id, id)
    on delete cascade,
  foreign key (workspace_id, consented_by_user_id)
    references app_workspace_memberships(workspace_id, user_id)
    on delete restrict,
  check (
    (consent_kind = 'reference_upload' and provider is null and granted = true)
    or (consent_kind = 'provider_processing' and provider = 'vercel_ai_gateway')
  )
);

-- A profile may never exceed six source photographs.  The advisory lock
-- serializes concurrent inserts for the same profile, including multi-request
-- uploads, while allowing independent workspaces to proceed concurrently.
create or replace function saga_avatar_reference_images_enforce_capacity()
returns trigger
language plpgsql
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(new.profile_id::text, 0));
  if (
    select count(*)
    from saga_avatar_reference_images
    where workspace_id = new.workspace_id
      and profile_id = new.profile_id
  ) >= 6 then
    raise exception 'SAGA avatar profile may contain at most six reference images';
  end if;
  return new;
end;
$$;

drop trigger if exists saga_avatar_reference_images_enforce_capacity on saga_avatar_reference_images;
create trigger saga_avatar_reference_images_enforce_capacity
before insert on saga_avatar_reference_images
for each row execute function saga_avatar_reference_images_enforce_capacity();

create index if not exists saga_avatar_profiles_workspace_updated_idx
  on saga_avatar_profiles(workspace_id, updated_at desc);
create index if not exists saga_avatar_reference_images_profile_position_idx
  on saga_avatar_reference_images(workspace_id, profile_id, position);
create index if not exists saga_avatar_consent_records_profile_created_idx
  on saga_avatar_consent_records(workspace_id, profile_id, created_at desc);

drop trigger if exists saga_avatar_profiles_set_updated_at on saga_avatar_profiles;
create trigger saga_avatar_profiles_set_updated_at
before update on saga_avatar_profiles
for each row execute function app_set_updated_at();

commit;
