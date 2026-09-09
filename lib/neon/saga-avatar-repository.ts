import "server-only";

import {
  SAGA_AVATAR_OUTPUT_VISIBILITY_POLICY,
  SAGA_AVATAR_PROVIDER,
  SAGA_AVATAR_PROVIDER_CONSENT_VERSION,
  SAGA_AVATAR_REFERENCE_CONSENT_VERSION,
  sagaAvatarProfileIdSchema,
  sagaAvatarReferenceAngleSchema,
  sagaAvatarReferenceIdSchema,
  type SagaAvatarProfileView,
  type SagaAvatarReferenceAngle,
  type SagaAvatarReferenceView,
} from "@/lib/domain/saga-avatar";
import type { AppActor } from "@/lib/neon/auth-repository";
import { createNeonSql, type NeonSql } from "@/lib/neon/database";
import type { AvatarReferenceBlobContentType, TrustedAvatarReferenceBlobPath } from "@/lib/vercel/avatar-reference-blob";

type AvatarProfileRow = {
  id: string;
  label: string;
  output_visibility_policy: string;
  full_face_allowed: boolean;
  provider_processing_enabled: boolean;
  provider_processing_provider: string | null;
  provider_processing_consent_version: string | null;
  provider_processing_consented_at: string | null;
  created_at: string;
  updated_at: string;
};

type AvatarReferenceRow = {
  id: string;
  profile_id: string;
  angle: string;
  position: number;
  blob_url: string;
  blob_pathname: string;
  content_type: string;
  byte_size: number | string;
  created_at: string;
};

export type SagaAvatarOwnedReference = {
  id: string;
  profileId: string;
  angle: SagaAvatarReferenceAngle;
  position: number;
  blobUrl: string;
  blobPathname: TrustedAvatarReferenceBlobPath;
  contentType: AvatarReferenceBlobContentType;
  byteSize: number;
  createdAt: string;
};

export type SagaAvatarPrivateModelProfile = {
  id: string;
  workspaceId: string;
  references: SagaAvatarOwnedReference[];
};

export type CreateSagaAvatarReferenceMetadataInput = {
  profileId: string;
  references: Array<{
    angle: SagaAvatarReferenceAngle;
    blobUrl: string;
    blobPathname: TrustedAvatarReferenceBlobPath;
    contentType: AvatarReferenceBlobContentType;
    byteSize: number;
  }>;
};

export class SagaAvatarAccessError extends Error {
  constructor(message = "Du har inte behörighet att ändra privata avatarreferenser i den här arbetsytan.") {
    super(message);
    this.name = "SagaAvatarAccessError";
  }
}

export class SagaAvatarNotFoundError extends Error {
  constructor(message = "Den privata avatarprofilen hittades inte i den här arbetsytan.") {
    super(message);
    this.name = "SagaAvatarNotFoundError";
  }
}

export class SagaAvatarValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SagaAvatarValidationError";
  }
}

/** A safe retry state, not a signal that a private Blob URL may be exposed. */
export class SagaAvatarConflictError extends Error {
  constructor(message = "Den privata referensen ändrades medan uppladdningen slutfördes. Försök igen.") {
    super(message);
    this.name = "SagaAvatarConflictError";
  }
}

/**
 * Safe projection only: source filenames, Blob URLs and Blob paths never
 * leave this module. A source-photo profile is personal, not a shared
 * workspace asset: a second member of the same workspace must not discover
 * that it exists or change its model consent.
 */
export async function listSagaAvatarProfiles(
  actor: AppActor,
  sql: NeonSql = createNeonSql(),
): Promise<SagaAvatarProfileView[]> {
  const profileRows = await sql.query(
    `select
       id::text,
       label,
       output_visibility_policy,
       full_face_allowed,
       provider_processing_enabled,
       provider_processing_provider,
       provider_processing_consent_version,
       provider_processing_consented_at::text,
       created_at::text,
       updated_at::text
     from saga_avatar_profiles
     where workspace_id = $1::uuid
       and created_by_user_id = $2::uuid
     order by updated_at desc`,
    [actor.workspaceId, actor.userId],
  ) as unknown as AvatarProfileRow[];
  if (!profileRows.length) return [];

  const profileIds = profileRows.map((profile) => profile.id);
  const referenceRows = await sql.query(
    `select
       reference.id::text,
       reference.profile_id::text,
       reference.angle,
       reference.position,
       reference.blob_url,
       reference.blob_pathname,
       reference.content_type,
       reference.byte_size,
       reference.created_at::text
     from saga_avatar_reference_images
     where workspace_id = $1::uuid
       and profile_id = any($2::uuid[])
     order by profile_id asc, position asc`,
    [actor.workspaceId, profileIds],
  ) as unknown as AvatarReferenceRow[];
  const referencesByProfile = new Map<string, AvatarReferenceRow[]>();
  for (const row of referenceRows) {
    const current = referencesByProfile.get(row.profile_id) ?? [];
    current.push(row);
    referencesByProfile.set(row.profile_id, current);
  }
  return profileRows.map((row) => mapProfile(row, referencesByProfile.get(row.id) ?? []));
}

export async function createSagaAvatarProfile(
  actor: AppActor,
  input: { label: string },
  sql: NeonSql = createNeonSql(),
): Promise<SagaAvatarProfileView> {
  assertCanWrite(actor);
  const label = normalizeLabel(input.label);
  const rows = await sql.query(
    `with inserted_profile as (
       insert into saga_avatar_profiles (
         workspace_id,
         created_by_user_id,
         label,
         output_visibility_policy,
         full_face_allowed,
         reference_consent_version,
         reference_consented_at,
         provider_processing_enabled,
         provider_processing_provider,
         provider_processing_consent_version,
         provider_processing_consented_at
       ) values (
         $1::uuid, $2::uuid, $3, '${SAGA_AVATAR_OUTPUT_VISIBILITY_POLICY}', false,
         $4, now(), false, null, null, null
       )
       returning
         id::text,
         label,
         output_visibility_policy,
         full_face_allowed,
         provider_processing_enabled,
         provider_processing_provider,
         provider_processing_consent_version,
         provider_processing_consented_at::text,
         created_at::text,
         updated_at::text
     ), recorded_consent as (
       insert into saga_avatar_consent_records (
         workspace_id, profile_id, consent_kind, provider, consent_version, granted, consented_by_user_id
       )
       select $1::uuid, id::uuid, 'reference_upload', null, $4, true, $2::uuid
       from inserted_profile
     )
     select * from inserted_profile`,
    [actor.workspaceId, actor.userId, label, SAGA_AVATAR_REFERENCE_CONSENT_VERSION],
  ) as unknown as AvatarProfileRow[];
  const profile = rows[0];
  if (!profile) throw new Error("Den privata avatarprofilen kunde inte sparas.");
  return mapProfile(profile, []);
}

/** Resolves a single safe profile projection before a route begins Blob work. */
export async function getSagaAvatarProfile(
  actor: AppActor,
  profileIdInput: string,
  sql: NeonSql = createNeonSql(),
): Promise<SagaAvatarProfileView | null> {
  const profileId = sagaAvatarProfileIdSchema.parse(profileIdInput);
  const profile = await getAvatarProfileRow(actor, profileId, sql);
  if (!profile) return null;
  const references = await listAvatarReferenceRows(actor, profileId, sql);
  return mapProfile(profile, references);
}

/**
 * Enables or revokes provider processing. This is intentionally not an upload
 * setting: a user must make a separate per-profile decision before a future
 * Gateway worker may read source image bytes.
 */
export async function updateSagaAvatarProviderProcessingConsent(
  actor: AppActor,
  input: { profileId: string; accepted: boolean },
  sql: NeonSql = createNeonSql(),
): Promise<SagaAvatarProfileView> {
  assertCanWrite(actor);
  const profileId = sagaAvatarProfileIdSchema.parse(input.profileId);
  const accepted = input.accepted === true;
  const rows = await sql.query(
    `with updated_profile as (
       update saga_avatar_profiles
          set provider_processing_enabled = $3::boolean,
              provider_processing_provider = case when $3::boolean then '${SAGA_AVATAR_PROVIDER}' else null end,
              provider_processing_consent_version = case when $3::boolean then $4 else null end,
              provider_processing_consented_at = case when $3::boolean then now() else null end
         where workspace_id = $1::uuid
           and id = $2::uuid
           and created_by_user_id = $5::uuid
       returning
         id::text,
         label,
         output_visibility_policy,
         full_face_allowed,
         provider_processing_enabled,
         provider_processing_provider,
         provider_processing_consent_version,
         provider_processing_consented_at::text,
         created_at::text,
         updated_at::text
     ), recorded_consent as (
       insert into saga_avatar_consent_records (
         workspace_id, profile_id, consent_kind, provider, consent_version, granted, consented_by_user_id
       )
       select $1::uuid, id::uuid, 'provider_processing', '${SAGA_AVATAR_PROVIDER}', $4, $3::boolean, $5::uuid
       from updated_profile
     )
     select * from updated_profile`,
    [actor.workspaceId, profileId, accepted, SAGA_AVATAR_PROVIDER_CONSENT_VERSION, actor.userId],
  ) as unknown as AvatarProfileRow[];
  const profile = rows[0];
  if (!profile) throw new SagaAvatarNotFoundError();
  const references = await listAvatarReferenceRows(actor, profileId, sql);
  return mapProfile(profile, references);
}

export async function updateSagaAvatarProfileLabel(
  actor: AppActor,
  input: { profileId: string; label: string },
  sql: NeonSql = createNeonSql(),
): Promise<SagaAvatarProfileView> {
  assertCanWrite(actor);
  const profileId = sagaAvatarProfileIdSchema.parse(input.profileId);
  const label = normalizeLabel(input.label);
  const rows = await sql.query(
    `update saga_avatar_profiles
        set label = $3
       where workspace_id = $1::uuid
         and id = $2::uuid
         and created_by_user_id = $4::uuid
      returning
        id::text,
        label,
        output_visibility_policy,
        full_face_allowed,
        provider_processing_enabled,
        provider_processing_provider,
        provider_processing_consent_version,
        provider_processing_consented_at::text,
        created_at::text,
        updated_at::text`,
    [actor.workspaceId, profileId, label, actor.userId],
  ) as unknown as AvatarProfileRow[];
  const profile = rows[0];
  if (!profile) throw new SagaAvatarNotFoundError();
  const references = await listAvatarReferenceRows(actor, profileId, sql);
  return mapProfile(profile, references);
}

/** Atomically applies a label change and/or the separate provider-consent decision. */
export async function updateSagaAvatarProfile(
  actor: AppActor,
  input: { profileId: string; label?: string; providerProcessingAccepted?: boolean },
  sql: NeonSql = createNeonSql(),
): Promise<SagaAvatarProfileView> {
  assertCanWrite(actor);
  const profileId = sagaAvatarProfileIdSchema.parse(input.profileId);
  const label = input.label === undefined ? null : normalizeLabel(input.label);
  const providerProcessingAccepted = input.providerProcessingAccepted === undefined ? null : input.providerProcessingAccepted === true;
  if (label === null && providerProcessingAccepted === null) {
    throw new SagaAvatarValidationError("Minst en profilinställning måste ändras.");
  }
  const rows = await sql.query(
    `with updated_profile as (
       update saga_avatar_profiles
          set label = coalesce($3, label),
              provider_processing_enabled = case when $4::boolean is null then provider_processing_enabled else $4::boolean end,
              provider_processing_provider = case
                when $4::boolean is null then provider_processing_provider
                when $4::boolean then '${SAGA_AVATAR_PROVIDER}'
                else null
              end,
              provider_processing_consent_version = case
                when $4::boolean is null then provider_processing_consent_version
                when $4::boolean then $5
                else null
              end,
              provider_processing_consented_at = case
                when $4::boolean is null then provider_processing_consented_at
                when $4::boolean then now()
                else null
              end
         where workspace_id = $1::uuid
           and id = $2::uuid
           and created_by_user_id = $6::uuid
       returning
         id::text,
         label,
         output_visibility_policy,
         full_face_allowed,
         provider_processing_enabled,
         provider_processing_provider,
         provider_processing_consent_version,
         provider_processing_consented_at::text,
         created_at::text,
         updated_at::text
     ), recorded_consent as (
       insert into saga_avatar_consent_records (
         workspace_id, profile_id, consent_kind, provider, consent_version, granted, consented_by_user_id
       )
       select $1::uuid, id::uuid, 'provider_processing', '${SAGA_AVATAR_PROVIDER}', $5, $4::boolean, $6::uuid
       from updated_profile
       where $4::boolean is not null
     )
     select * from updated_profile`,
    [
      actor.workspaceId,
      profileId,
      label,
      providerProcessingAccepted,
      SAGA_AVATAR_PROVIDER_CONSENT_VERSION,
      actor.userId,
    ],
  ) as unknown as AvatarProfileRow[];
  const profile = rows[0];
  if (!profile) throw new SagaAvatarNotFoundError();
  const references = await listAvatarReferenceRows(actor, profileId, sql);
  return mapProfile(profile, references);
}

/**
 * Writes metadata only after the upload route stored all bytes in private
 * Blob. It never accepts a workspace ID, a browser storage token, or a Blob
 * path from a request body.
 */
export async function createSagaAvatarReferenceMetadata(
  actor: AppActor,
  input: CreateSagaAvatarReferenceMetadataInput,
  sql: NeonSql = createNeonSql(),
): Promise<SagaAvatarProfileView> {
  assertCanWrite(actor);
  const profileId = sagaAvatarProfileIdSchema.parse(input.profileId);
  const refs = normalizeMetadataInput(input.references);
  const profile = await getAvatarProfileRow(actor, profileId, sql);
  if (!profile) throw new SagaAvatarNotFoundError();
  const existing = await listAvatarReferenceRows(actor, profileId, sql);
  assertUploadCapacity(existing.length, refs.length);

  // Positions are stable UI labels. Fill a removed slot before appending so a
  // profile that had e.g. 1,2,4,5,6 can safely accept one replacement.
  const availablePositions = [1, 2, 3, 4, 5, 6].filter(
    (position) => !existing.some((reference) => Number(reference.position) === position),
  );
  if (availablePositions.length < refs.length) {
    throw new SagaAvatarValidationError("En privat avatarprofil kan innehålla högst sex referensbilder.");
  }
  const values: unknown[] = [actor.workspaceId, profileId, actor.userId];
  const placeholders = refs.map((reference, index) => {
    const base = values.length + 1;
    values.push(
      reference.angle,
      availablePositions[index],
      reference.blobUrl,
      reference.blobPathname,
      reference.contentType,
      reference.byteSize,
    );
    return `($1::uuid, $2::uuid, $3::uuid, $${base}, $${base + 1}::smallint, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}::bigint)`;
  });
  const inserted = await sql.query(
    `insert into saga_avatar_reference_images (
       workspace_id, profile_id, created_by_user_id, angle, position,
       blob_url, blob_pathname, content_type, byte_size
     ) values ${placeholders.join(", ")}
     returning
       id::text,
       profile_id::text,
       angle,
       position,
       blob_url,
       blob_pathname,
       content_type,
       byte_size,
       created_at::text`,
    values,
  ) as unknown as AvatarReferenceRow[];
  if (inserted.length !== refs.length) throw new Error("Alla privata referensbilder kunde inte sparas.");
  return mapProfile(profile, [...existing, ...inserted]);
}

/**
 * Commits an already server-verified, direct-to-private-Blob batch. The same
 * signed grant may be finalized again after a lost response: when every path
 * is already present we return the safe profile projection instead of creating
 * duplicate reference rows. A mixed batch is rejected fail-closed.
 */
export async function finalizeSagaAvatarDirectReferenceUpload(
  actor: AppActor,
  input: CreateSagaAvatarReferenceMetadataInput,
  sql: NeonSql = createNeonSql(),
): Promise<SagaAvatarProfileView> {
  assertCanWrite(actor);
  const profileId = sagaAvatarProfileIdSchema.parse(input.profileId);
  const refs = normalizeMetadataInput(input.references);
  const profile = await getAvatarProfileRow(actor, profileId, sql);
  if (!profile) throw new SagaAvatarNotFoundError();
  const existing = await listAvatarReferenceRows(actor, profileId, sql);
  const requestedPaths = new Set(refs.map((reference) => reference.blobPathname));
  if (requestedPaths.size !== refs.length) {
    throw new SagaAvatarValidationError("Den privata uppladdningen innehåller samma bildfil flera gånger.");
  }
  const existingPaths = new Set(existing.map((reference) => reference.blob_pathname));
  const existingMatches = refs.filter((reference) => existingPaths.has(reference.blobPathname));
  if (existingMatches.length === refs.length) return mapProfile(profile, existing);
  if (existingMatches.length > 0) {
    throw new SagaAvatarConflictError("En del av den privata uppladdningen är redan sparad. Ladda om arbetsytan innan du försöker igen.");
  }
  assertUploadCapacity(existing.length, refs.length);

  const values: unknown[] = [actor.workspaceId, profileId, actor.userId];
  const placeholders = refs.map((reference, index) => {
    const base = values.length + 1;
    values.push(
      reference.angle,
      availableReferencePositions(existing)[index],
      reference.blobUrl,
      reference.blobPathname,
      reference.contentType,
      reference.byteSize,
    );
    return `($1::uuid, $2::uuid, $3::uuid, $${base}, $${base + 1}::smallint, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}::bigint)`;
  });
  const inserted = await sql.query(
    `insert into saga_avatar_reference_images (
       workspace_id, profile_id, created_by_user_id, angle, position,
       blob_url, blob_pathname, content_type, byte_size
     ) values ${placeholders.join(", ")}
     on conflict (workspace_id, blob_pathname) do nothing
     returning
       id::text,
       profile_id::text,
       angle,
       position,
       blob_url,
       blob_pathname,
       content_type,
       byte_size,
       created_at::text`,
    values,
  ) as unknown as AvatarReferenceRow[];
  if (inserted.length === refs.length) return mapProfile(profile, [...existing, ...inserted]);

  // A concurrent retry of the exact grant produces zero new rows. Re-read to
  // turn that benign race into an idempotent success; never accept a partial
  // insertion as a completed avatar reference set.
  const refreshedProfile = await getAvatarProfileRow(actor, profileId, sql);
  const refreshed = await listAvatarReferenceRows(actor, profileId, sql);
  const refreshedPaths = new Set(refreshed.map((reference) => reference.blob_pathname));
  if (refreshedProfile && refs.every((reference) => refreshedPaths.has(reference.blobPathname))) {
    return mapProfile(refreshedProfile, refreshed);
  }
  throw new SagaAvatarConflictError();
}

/** Returns Blob metadata only to server-side callers that already have actor scope. */
export async function getSagaAvatarOwnedReference(
  actor: AppActor,
  profileIdInput: string,
  referenceIdInput: string,
  sql: NeonSql = createNeonSql(),
): Promise<SagaAvatarOwnedReference | null> {
  assertCanWrite(actor);
  const profileId = sagaAvatarProfileIdSchema.parse(profileIdInput);
  const referenceId = sagaAvatarReferenceIdSchema.parse(referenceIdInput);
  const rows = await sql.query(
    `select
       id::text,
       profile_id::text,
       angle,
       position,
       blob_url,
       blob_pathname,
       content_type,
       byte_size,
       created_at::text
     from saga_avatar_reference_images as reference
     join saga_avatar_profiles as profile
       on profile.workspace_id = reference.workspace_id
      and profile.id = reference.profile_id
     where reference.workspace_id = $1::uuid
       and reference.profile_id = $2::uuid
       and reference.id = $3::uuid
       and profile.created_by_user_id = $4::uuid
     limit 1`,
    [actor.workspaceId, profileId, referenceId, actor.userId],
  ) as unknown as AvatarReferenceRow[];
  return rows[0] ? mapOwnedReference(rows[0]) : null;
}

/**
 * Server-only model seam. A future worker must derive `actor` from a durable,
 * authorized workspace job before calling this; user-provided workspace IDs
 * are never accepted. It returns no URL and does not call an AI provider.
 */
export async function getSagaAvatarProfileForPrivateModelUse(
  actor: AppActor,
  profileIdInput: string,
  sql: NeonSql = createNeonSql(),
): Promise<SagaAvatarPrivateModelProfile> {
  assertCanWrite(actor);
  const profileId = sagaAvatarProfileIdSchema.parse(profileIdInput);
  const profile = await getAvatarProfileRow(actor, profileId, sql);
  if (!profile) throw new SagaAvatarNotFoundError();
  if (
    profile.provider_processing_enabled !== true
    || profile.provider_processing_provider !== SAGA_AVATAR_PROVIDER
    || !profile.provider_processing_consented_at
    || !profile.provider_processing_consent_version
  ) {
    throw new SagaAvatarValidationError("Privat modellbearbetning är inte uttryckligen aktiverad för den här avatarprofilen.");
  }
  const references = await listAvatarReferenceRows(actor, profileId, sql);
  if (references.length < 3 || references.length > 6) {
    throw new SagaAvatarValidationError("Privat modellbearbetning kräver mellan tre och sex referensbilder.");
  }
  return {
    id: profileId,
    workspaceId: actor.workspaceId,
    references: references.map(mapOwnedReference),
  };
}

/** Removes one metadata row only from the actor's own private profile; call Blob cleanup after this succeeds. */
export async function deleteSagaAvatarReferenceMetadata(
  actor: AppActor,
  profileIdInput: string,
  referenceIdInput: string,
  sql: NeonSql = createNeonSql(),
): Promise<SagaAvatarOwnedReference | null> {
  assertCanWrite(actor);
  const profileId = sagaAvatarProfileIdSchema.parse(profileIdInput);
  const referenceId = sagaAvatarReferenceIdSchema.parse(referenceIdInput);
  const rows = await sql.query(
     `delete from saga_avatar_reference_images as reference
       using saga_avatar_profiles as profile
       where reference.workspace_id = $1::uuid
         and reference.profile_id = $2::uuid
         and reference.id = $3::uuid
         and profile.workspace_id = reference.workspace_id
         and profile.id = reference.profile_id
         and profile.created_by_user_id = $4::uuid
       returning
         reference.id::text,
         reference.profile_id::text,
         reference.angle,
         reference.position,
         reference.blob_url,
         reference.blob_pathname,
         reference.content_type,
         reference.byte_size,
         reference.created_at::text`,
    [actor.workspaceId, profileId, referenceId, actor.userId],
  ) as unknown as AvatarReferenceRow[];
  return rows[0] ? mapOwnedReference(rows[0]) : null;
}

/** Resolves source paths only for a write-capable actor immediately before deletion. */
export async function listSagaAvatarOwnedReferencesForDeletion(
  actor: AppActor,
  profileIdInput: string,
  sql: NeonSql = createNeonSql(),
): Promise<SagaAvatarOwnedReference[] | null> {
  assertCanWrite(actor);
  const profileId = sagaAvatarProfileIdSchema.parse(profileIdInput);
  const profile = await getAvatarProfileRow(actor, profileId, sql);
  if (!profile) return null;
  const references = await listAvatarReferenceRows(actor, profileId, sql);
  return references.map(mapOwnedReference);
}

/** Deletes the profile only after every child reference was removed safely. */
export async function deleteSagaAvatarProfileIfEmpty(
  actor: AppActor,
  profileIdInput: string,
  sql: NeonSql = createNeonSql(),
): Promise<boolean> {
  assertCanWrite(actor);
  const profileId = sagaAvatarProfileIdSchema.parse(profileIdInput);
  const rows = await sql.query(
    `delete from saga_avatar_profiles as profile
      where profile.workspace_id = $1::uuid
         and profile.id = $2::uuid
         and profile.created_by_user_id = $3::uuid
        and not exists (
          select 1
          from saga_avatar_reference_images as reference
          where reference.workspace_id = profile.workspace_id
            and reference.profile_id = profile.id
        )
      returning id::text`,
    [actor.workspaceId, profileId, actor.userId],
  ) as unknown as Array<{ id: string }>;
  return Boolean(rows[0]);
}

async function getAvatarProfileRow(
  actor: AppActor,
  profileId: string,
  sql: NeonSql,
): Promise<AvatarProfileRow | null> {
  const rows = await sql.query(
    `select
       id::text,
       label,
       output_visibility_policy,
       full_face_allowed,
       provider_processing_enabled,
       provider_processing_provider,
       provider_processing_consent_version,
       provider_processing_consented_at::text,
       created_at::text,
       updated_at::text
     from saga_avatar_profiles
      where workspace_id = $1::uuid
        and id = $2::uuid
        and created_by_user_id = $3::uuid
      limit 1`,
    [actor.workspaceId, profileId, actor.userId],
  ) as unknown as AvatarProfileRow[];
  return rows[0] ?? null;
}

async function listAvatarReferenceRows(
  actor: AppActor,
  profileId: string,
  sql: NeonSql,
): Promise<AvatarReferenceRow[]> {
  return await sql.query(
    `select
       reference.id::text,
       reference.profile_id::text,
       reference.angle,
       reference.position,
       reference.blob_url,
       reference.blob_pathname,
       reference.content_type,
       reference.byte_size,
       reference.created_at::text
      from saga_avatar_reference_images as reference
      join saga_avatar_profiles as profile
        on profile.workspace_id = reference.workspace_id
       and profile.id = reference.profile_id
      where reference.workspace_id = $1::uuid
        and reference.profile_id = $2::uuid
        and profile.created_by_user_id = $3::uuid
      order by reference.position asc`,
    [actor.workspaceId, profileId, actor.userId],
  ) as unknown as AvatarReferenceRow[];
}

function mapProfile(row: AvatarProfileRow, referenceRows: AvatarReferenceRow[]): SagaAvatarProfileView {
  if (row.output_visibility_policy !== SAGA_AVATAR_OUTPUT_VISIBILITY_POLICY || row.full_face_allowed !== false) {
    throw new Error("Avatarprofilen bryter mot SAGA:s integritetspolicy.");
  }
  const references = [...referenceRows]
    .sort((first, second) => Number(first.position) - Number(second.position))
    .map(mapReferenceView);
  const providerConsented = (
    row.provider_processing_enabled === true
    && row.provider_processing_provider === SAGA_AVATAR_PROVIDER
    && Boolean(row.provider_processing_consent_version)
    && Boolean(row.provider_processing_consented_at)
  );
  return {
    id: row.id,
    label: row.label,
    referenceCount: references.length,
    references,
    outputVisibilityPolicy: SAGA_AVATAR_OUTPUT_VISIBILITY_POLICY,
    fullFaceAllowed: false,
    providerProcessing: {
      provider: SAGA_AVATAR_PROVIDER,
      enabled: providerConsented,
      consented: providerConsented,
      readyForPrivateModelUse: providerConsented && references.length >= 3 && references.length <= 6,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapReferenceView(row: AvatarReferenceRow): SagaAvatarReferenceView {
  const angle = sagaAvatarReferenceAngleSchema.safeParse(row.angle);
  if (!angle.success || !Number.isInteger(Number(row.position)) || Number(row.position) < 1 || Number(row.position) > 6) {
    throw new Error("Avatarreferensens metadata är ogiltig.");
  }
  return {
    id: row.id,
    angle: angle.data,
    position: Number(row.position),
    createdAt: row.created_at,
  };
}

function mapOwnedReference(row: AvatarReferenceRow): SagaAvatarOwnedReference {
  const view = mapReferenceView(row);
  const byteSize = Number(row.byte_size);
  if (!isAvatarReferenceContentType(row.content_type) || !Number.isInteger(byteSize) || byteSize <= 0 || byteSize > 20 * 1024 * 1024) {
    throw new Error("Avatarreferensens lagringsmetadata är ogiltig.");
  }
  const contentType: AvatarReferenceBlobContentType = row.content_type;
  if (typeof row.blob_url !== "string" || !row.blob_url.startsWith("https://") || typeof row.blob_pathname !== "string") {
    throw new Error("Avatarreferensens privata lagringsmetadata är ogiltig.");
  }
  return {
    id: view.id,
    profileId: row.profile_id,
    angle: view.angle,
    position: view.position,
    blobUrl: row.blob_url,
    blobPathname: row.blob_pathname as TrustedAvatarReferenceBlobPath,
    contentType,
    byteSize,
    createdAt: view.createdAt,
  };
}

function normalizeMetadataInput(input: CreateSagaAvatarReferenceMetadataInput["references"]) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 6) {
    throw new SagaAvatarValidationError("Välj mellan en och sex referensbilder per uppladdning.");
  }
  return input.map((reference) => {
    const angle = sagaAvatarReferenceAngleSchema.parse(reference.angle);
    if (typeof reference.blobUrl !== "string" || !reference.blobUrl.startsWith("https://")) {
      throw new SagaAvatarValidationError("Referensbildens privata lagring är ogiltig.");
    }
    if (typeof reference.blobPathname !== "string" || !reference.blobPathname) {
      throw new SagaAvatarValidationError("Referensbildens privata filsökväg är ogiltig.");
    }
    if (reference.contentType !== "image/jpeg" && reference.contentType !== "image/png" && reference.contentType !== "image/webp") {
      throw new SagaAvatarValidationError("Referensbildens format är ogiltigt.");
    }
    if (!Number.isInteger(reference.byteSize) || reference.byteSize <= 0 || reference.byteSize > 20 * 1024 * 1024) {
      throw new SagaAvatarValidationError("Referensbildens storlek är ogiltig.");
    }
    return { ...reference, angle };
  });
}

function assertUploadCapacity(existingCount: number, uploadCount: number): void {
  if (existingCount < 0 || existingCount > 6 || uploadCount < 1 || uploadCount > 6 || existingCount + uploadCount > 6) {
    throw new SagaAvatarValidationError("En privat avatarprofil kan innehålla högst sex referensbilder.");
  }
  if (existingCount === 0 && uploadCount < 3) {
    throw new SagaAvatarValidationError("Lägg in tre till sex referensbilder första gången.");
  }
  if (existingCount > 0 && existingCount < 3 && existingCount + uploadCount < 3) {
    throw new SagaAvatarValidationError("Lägg in tillräckligt många referensbilder för att nå minst tre bilder.");
  }
}

function availableReferencePositions(existing: AvatarReferenceRow[]): number[] {
  return [1, 2, 3, 4, 5, 6].filter(
    (position) => !existing.some((reference) => Number(reference.position) === position),
  );
}

function normalizeLabel(value: string): string {
  const label = typeof value === "string" ? value.trim() : "";
  if (!label || label.length > 120) throw new SagaAvatarValidationError("Profilnamnet måste vara mellan 1 och 120 tecken.");
  return label;
}

function assertCanWrite(actor: AppActor): void {
  if (actor.role === "viewer") throw new SagaAvatarAccessError();
}

function isAvatarReferenceContentType(value: string): value is AvatarReferenceBlobContentType {
  return value === "image/jpeg" || value === "image/png" || value === "image/webp";
}
