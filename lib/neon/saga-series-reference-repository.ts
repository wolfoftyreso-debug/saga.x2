import "server-only";

import {
  sagaSeriesReferenceContextSchema,
  sagaSeriesReferenceCreateSchema,
  sagaSeriesReferenceDeleteSchema,
  sagaSeriesReferencePatchSchema,
  sagaSeriesReferenceSchema,
  type SagaSeriesReference,
  type SagaSeriesReferenceContext,
  type SagaSeriesReferenceCreateInput,
  type SagaSeriesReferenceDeleteInput,
  type SagaSeriesReferencePatchInput,
} from "@/lib/domain/saga-series-reference";
import type { AppActor } from "@/lib/neon/auth-repository";
import { createNeonSql, type NeonSql } from "@/lib/neon/database";
import {
  resolveSagaSeriesReferenceContext,
  type SagaSeriesReferenceContext as SagaSeriesReferenceGuidanceContext,
} from "@/lib/services/saga-series-reference";

type JsonObject = Record<string, unknown>;

type SeriesReferenceRow = {
  id: string;
  created_by_user_id: string;
  updated_by_user_id: string;
  slug: string;
  name: string;
  active: boolean;
  revision: number | string;
  source_draft_id: string;
  source_draft_revision: number | string;
  content_type: string;
  reference_title: string;
  reference_body: string;
  reference_channels: unknown;
  media_safe_metadata: unknown;
  controls_snapshot: unknown;
  captured_at: string | Date;
  created_at: string | Date;
  updated_at: string | Date;
};

type IdRow = { id: string | null };

export class SagaSeriesReferenceAccessError extends Error {
  constructor(message = "Du har bara läsrättighet i den här arbetsytan.") {
    super(message);
    this.name = "SagaSeriesReferenceAccessError";
  }
}

export class SagaSeriesReferenceNotFoundError extends Error {
  constructor(message = "SAGA-serien hittades inte i den här arbetsytan.") {
    super(message);
    this.name = "SagaSeriesReferenceNotFoundError";
  }
}

export class SagaSeriesReferenceConflictError extends Error {
  constructor(message = "SAGA-serien har ändrats av någon annan. Läs in den igen innan du sparar.") {
    super(message);
    this.name = "SagaSeriesReferenceConflictError";
  }
}

export class SagaSeriesReferenceValidationError extends Error {
  constructor(message = "SAGA-seriens referens eller kontroller är ogiltiga.") {
    super(message);
    this.name = "SagaSeriesReferenceValidationError";
  }
}

function assertCanWrite(actor: AppActor): void {
  if (actor.role === "viewer") throw new SagaSeriesReferenceAccessError();
}

function integer(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function timestamp(value: unknown): string {
  return value instanceof Date ? value.toISOString() : typeof value === "string" ? value : "";
}

function jsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function jsonObject(value: unknown): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as JsonObject;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonObject : {};
  } catch {
    return {};
  }
}

function mapSeriesReference(row: SeriesReferenceRow): SagaSeriesReference {
  return sagaSeriesReferenceSchema.parse({
    id: row.id,
    createdByUserId: row.created_by_user_id,
    updatedByUserId: row.updated_by_user_id,
    slug: row.slug,
    name: row.name,
    active: row.active === true,
    revision: integer(row.revision),
    reference: {
      revision: integer(row.revision),
      sourceDraftId: row.source_draft_id,
      sourceDraftRevision: integer(row.source_draft_revision),
      contentType: row.content_type,
      title: row.reference_title,
      body: row.reference_body,
      channels: jsonArray(row.reference_channels),
      media: jsonArray(row.media_safe_metadata),
      capturedAt: timestamp(row.captured_at),
    },
    controls: jsonObject(row.controls_snapshot),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  });
}

const currentSeriesSelect = `select
  series.id::text,
  series.created_by_user_id::text,
  series.updated_by_user_id::text,
  series.slug,
  series.name,
  series.active,
  series.revision,
  reference.source_draft_id::text,
  reference.source_draft_revision,
  reference.content_type,
  reference.reference_title,
  reference.reference_body,
  reference.reference_channels,
  reference.media_safe_metadata,
  reference.controls_snapshot,
  reference.captured_at::text,
  series.created_at::text,
  series.updated_at::text
from saga_series_references series
join saga_series_reference_revisions reference
  on reference.workspace_id = series.workspace_id
  and reference.series_id = series.id
  and reference.revision = series.current_reference_revision`;

function uuid(value: string): string {
  const normalized = value.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) {
    throw new SagaSeriesReferenceNotFoundError();
  }
  return normalized;
}

function databaseFailure(error: unknown): never {
  if (error instanceof SagaSeriesReferenceAccessError
    || error instanceof SagaSeriesReferenceNotFoundError
    || error instanceof SagaSeriesReferenceConflictError
    || error instanceof SagaSeriesReferenceValidationError) {
    throw error;
  }
  const code = error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  const message = error instanceof Error ? error.message : "";
  if (code === "23505") throw new SagaSeriesReferenceConflictError("En SAGA-serie med samma slug finns redan i arbetsytan.");
  if (code === "P0001" || code === "23514" || code === "23503" || /SAGA series reference|SAGA series controls/i.test(message)) {
    throw new SagaSeriesReferenceValidationError(
      /missing or unsuitable/i.test(message)
        ? "Referensutkastet saknas, är tomt eller tillhör inte den här arbetsytan."
        : "SAGA-seriens referens eller kontroller är ogiltiga.",
    );
  }
  throw error;
}

/** Lists the current immutable snapshot for every series in the signed actor's workspace. */
export async function listSagaSeriesReferences(
  actor: AppActor,
  sql: NeonSql = createNeonSql(),
): Promise<SagaSeriesReference[]> {
  try {
    const rows = await sql.query(
      `${currentSeriesSelect}
       where series.workspace_id = $1::uuid
       order by series.active desc, lower(series.name), series.created_at`,
      [actor.workspaceId],
    ) as unknown as SeriesReferenceRow[];
    return rows.map(mapSeriesReference);
  } catch (error) {
    return databaseFailure(error);
  }
}

/** Reads one current snapshot, always constrained by the signed actor's workspace. */
export async function getSagaSeriesReference(
  actor: AppActor,
  seriesIdInput: string,
  sql: NeonSql = createNeonSql(),
): Promise<SagaSeriesReference | null> {
  const seriesId = uuid(seriesIdInput);
  try {
    const rows = await sql.query(
      `${currentSeriesSelect}
       where series.workspace_id = $1::uuid
         and series.id = $2::uuid
         and ($3::uuid is null or exists (
           select 1 from studio_drafts source_draft
           where source_draft.workspace_id = reference.workspace_id
             and source_draft.id = reference.source_draft_id
             and source_draft.brand_profile_id = $3::uuid
         ))
       limit 1`,
      [actor.workspaceId, seriesId, actor.brandProfileId ?? null],
    ) as unknown as SeriesReferenceRow[];
    return rows[0] ? mapSeriesReference(rows[0]) : null;
  } catch (error) {
    return databaseFailure(error);
  }
}

/** Captures a server-read Studio draft into revision 1; browser data never supplies snapshot copy or a workspace id. */
export async function createSagaSeriesReference(
  actor: AppActor,
  input: SagaSeriesReferenceCreateInput,
  sql: NeonSql = createNeonSql(),
): Promise<SagaSeriesReference> {
  assertCanWrite(actor);
  const value = sagaSeriesReferenceCreateSchema.parse(input);
  try {
    const rows = await sql.query(
      `select saga_series_reference_create(
        $1::uuid, $2::uuid, $3, $4, $5::boolean, $6::uuid, $7::jsonb
      )::text as id`,
      [
        actor.workspaceId,
        actor.userId,
        value.slug,
        value.name,
        value.active,
        value.referenceDraftId,
        JSON.stringify(value.controls),
      ],
    ) as unknown as IdRow[];
    const id = rows[0]?.id;
    if (!id) throw new SagaSeriesReferenceValidationError("SAGA-serien kunde inte fånga sitt referensutkast.");
    const series = await getSagaSeriesReference(actor, id, sql);
    if (!series) throw new SagaSeriesReferenceNotFoundError();
    return series;
  } catch (error) {
    return databaseFailure(error);
  }
}

/**
 * Any mutation appends a new immutable snapshot and advances its revision.
 * This makes the expected revision a single concurrency contract for title,
 * controls, activation and replacement source changes.
 */
export async function patchSagaSeriesReference(
  actor: AppActor,
  input: SagaSeriesReferencePatchInput,
  sql: NeonSql = createNeonSql(),
): Promise<SagaSeriesReference> {
  assertCanWrite(actor);
  const patch = sagaSeriesReferencePatchSchema.parse(input);
  const current = await getSagaSeriesReference(actor, patch.id, sql);
  if (!current) throw new SagaSeriesReferenceNotFoundError();
  if (current.revision !== patch.expectedRevision) throw new SagaSeriesReferenceConflictError();
  try {
    const rows = await sql.query(
      `select saga_series_reference_update(
        $1::uuid, $2::uuid, $3::uuid, $4::integer, $5, $6, $7::boolean,
        $8::uuid, $9::jsonb
      )::text as id`,
      [
        actor.workspaceId,
        patch.id,
        actor.userId,
        patch.expectedRevision,
        patch.slug ?? current.slug,
        patch.name ?? current.name,
        patch.active ?? current.active,
        patch.referenceDraftId ?? null,
        JSON.stringify(patch.controls ?? current.controls),
      ],
    ) as unknown as IdRow[];
    const id = rows[0]?.id;
    if (!id) {
      const latest = await getSagaSeriesReference(actor, patch.id, sql);
      if (!latest) throw new SagaSeriesReferenceNotFoundError();
      throw new SagaSeriesReferenceConflictError();
    }
    const series = await getSagaSeriesReference(actor, id, sql);
    if (!series) throw new SagaSeriesReferenceNotFoundError();
    return series;
  } catch (error) {
    return databaseFailure(error);
  }
}

/** Deletes only the exact actor-owned revision. A stale revision can never delete a newer series. */
export async function deleteSagaSeriesReference(
  actor: AppActor,
  input: SagaSeriesReferenceDeleteInput,
  sql: NeonSql = createNeonSql(),
): Promise<void> {
  assertCanWrite(actor);
  const value = sagaSeriesReferenceDeleteSchema.parse(input);
  try {
    const rows = await sql.query(
      `delete from saga_series_references
        where workspace_id = $1::uuid
          and id = $2::uuid
          and revision = $3::integer
        returning id::text`,
      [actor.workspaceId, value.id, value.expectedRevision],
    ) as unknown as Array<{ id: string }>;
    if (rows[0]) return;
    const current = await getSagaSeriesReference(actor, value.id, sql);
    if (!current) throw new SagaSeriesReferenceNotFoundError();
    throw new SagaSeriesReferenceConflictError();
  } catch (error) {
    return databaseFailure(error);
  }
}

/**
 * Rich server-only context for AI and quality callers. Inactive series never
 * influence a model or quality decision, and the response contains only the
 * immutable snapshot's safe metadata—not a live Blob location or provider secret.
 */
export async function getSagaSeriesReferenceContext(
  actor: AppActor,
  seriesIdInput: string,
  sql: NeonSql = createNeonSql(),
): Promise<SagaSeriesReferenceContext | null> {
  const series = await getSagaSeriesReference(actor, seriesIdInput, sql);
  if (!series || !series.active) return null;
  return sagaSeriesReferenceContextSchema.parse({
    seriesId: series.id,
    seriesRevision: series.revision,
    seriesName: series.name,
    reference: series.reference,
    controls: series.controls,
  });
}

/**
 * Compatibility projection for the deterministic Series Reference guidance
 * service. This deliberately strips the storage-independent series identity,
 * revision and content type from model/quality context while preserving only
 * its frozen reference copy and fixed editorial controls.
 */
export async function getSagaSeriesReferenceGuidanceContext(
  actor: AppActor,
  seriesIdInput: string,
  sql: NeonSql = createNeonSql(),
): Promise<SagaSeriesReferenceGuidanceContext | null> {
  const context = await getSagaSeriesReferenceContext(actor, seriesIdInput, sql);
  if (!context) return null;
  return resolveSagaSeriesReferenceContext({
    reference: {
      sourceDraftId: context.reference.sourceDraftId,
      sourceDraftRevision: context.reference.sourceDraftRevision,
      title: context.reference.title,
      body: context.reference.body,
      channels: context.reference.channels,
      media: context.reference.media,
      capturedAt: context.reference.capturedAt,
    },
    controls: context.controls,
  });
}
