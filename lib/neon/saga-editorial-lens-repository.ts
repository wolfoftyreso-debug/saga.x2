import "server-only";

import {
  sagaEditorialLensInputSchema,
  sagaEditorialLensSchema,
  type SagaEditorialLens,
  type SagaEditorialLensInput,
  type SagaEditorialLensPromptContext,
  sagaEditorialLensPromptContext,
} from "@/lib/domain/saga-editorial-lens";
import type { AppActor } from "@/lib/neon/auth-repository";
import { createNeonSql, type NeonSql } from "@/lib/neon/database";
import { resolveSagaBrandActor } from "@/lib/neon/saga-brand-api-eligibility";

type JsonObject = Record<string, unknown>;

type LensRow = {
  id: string;
  created_by_user_id: string;
  updated_by_user_id: string;
  brand_profile_id: string | null;
  name: string;
  mission: string;
  strategic_perspective: string;
  industry: string;
  audience: string;
  themes: unknown;
  forbidden_themes: unknown;
  tone_config: unknown;
  construction_config: unknown;
  evidence_threshold: string;
  source_rules: unknown;
  source_selections: unknown;
  control_mode: string;
  active: boolean;
  created_at: string | Date;
  updated_at: string | Date;
};

export class SagaEditorialLensAccessError extends Error {
  constructor() {
    super("Endast arbetsytans ägare kan ändra SAGA Editorial Lens.");
    this.name = "SagaEditorialLensAccessError";
  }
}

export class SagaEditorialLensReferenceError extends Error {
  constructor(message = "Den valda varumärkesprofilen eller källan hör inte till den här arbetsytan.") {
    super(message);
    this.name = "SagaEditorialLensReferenceError";
  }
}

export class SagaEditorialLensConflictError extends Error {
  constructor(message = "Editorial Lens kunde inte sparas eftersom ett beroende ändrades samtidigt.") {
    super(message);
    this.name = "SagaEditorialLensConflictError";
  }
}

function assertOwner(actor: AppActor): void {
  if (actor.role !== "owner") throw new SagaEditorialLensAccessError();
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function timestamp(value: unknown): string {
  return value instanceof Date ? value.toISOString() : typeof value === "string" ? value : "";
}

function objectValue(value: unknown): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as JsonObject;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonObject : {};
  } catch {
    return {};
  }
}

function arrayValue(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function strings(value: unknown): string[] {
  return arrayValue(value).flatMap((entry) => typeof entry === "string" ? [entry] : []);
}

function mapLens(row: LensRow): SagaEditorialLens {
  return sagaEditorialLensSchema.parse({
    id: row.id,
    createdByUserId: row.created_by_user_id,
    updatedByUserId: row.updated_by_user_id,
    brandProfileId: stringOrNull(row.brand_profile_id),
    name: row.name,
    mission: row.mission,
    strategicPerspective: row.strategic_perspective,
    industry: row.industry,
    audience: row.audience,
    themes: strings(row.themes),
    forbiddenThemes: strings(row.forbidden_themes),
    tone: objectValue(row.tone_config),
    construction: objectValue(row.construction_config),
    evidenceThreshold: row.evidence_threshold,
    sourceRules: objectValue(row.source_rules),
    sourceSelections: arrayValue(row.source_selections),
    controlMode: row.control_mode,
    active: row.active !== false,
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  });
}

const lensSelect = `select
  lens.id::text,
  lens.created_by_user_id::text,
  lens.updated_by_user_id::text,
  lens.brand_profile_id::text,
  lens.name,
  lens.mission,
  lens.strategic_perspective,
  lens.industry,
  lens.audience,
  lens.themes,
  lens.forbidden_themes,
  lens.tone_config,
  lens.construction_config,
  lens.evidence_threshold,
  lens.source_rules,
  coalesce(
    jsonb_agg(jsonb_build_object(
      'sourceId', source_selection.source_id::text,
      'role', source_selection.role,
      'priority', source_selection.priority
    ) order by source_selection.priority) filter (where source_selection.source_id is not null),
    '[]'::jsonb
  ) as source_selections,
  lens.control_mode,
  lens.active,
  lens.created_at::text,
  lens.updated_at::text
from saga_editorial_lenses lens
left join saga_editorial_lens_sources source_selection
  on source_selection.workspace_id = lens.workspace_id
 and source_selection.lens_id = lens.id`;

function lensGroupBy(alias = "lens"): string {
  return `group by ${alias}.id, ${alias}.created_by_user_id, ${alias}.updated_by_user_id,
    ${alias}.brand_profile_id, ${alias}.name, ${alias}.mission,
    ${alias}.strategic_perspective, ${alias}.industry, ${alias}.audience,
    ${alias}.themes, ${alias}.forbidden_themes, ${alias}.tone_config,
    ${alias}.construction_config, ${alias}.evidence_threshold,
    ${alias}.source_rules, ${alias}.control_mode, ${alias}.active,
    ${alias}.created_at, ${alias}.updated_at`;
}

/** Viewer-safe read. It cannot select another workspace because actor scope is always a SQL parameter. */
export async function getSagaEditorialLens(
  actor: AppActor,
  sql: NeonSql = createNeonSql(),
): Promise<SagaEditorialLens | null> {
  const scoped = actor.brandProfileId ? actor : await resolveSagaBrandActor(actor, null, sql);
  const rows = await sql.query(
    `${lensSelect}
     where lens.workspace_id = $1::uuid
       and lens.brand_profile_id = $2::uuid
       and exists (select 1 from content_engine_brand_profiles profile
         join saga_brand_onboardings onboarding on onboarding.workspace_id = profile.workspace_id and onboarding.brand_profile_id = profile.id
         where profile.workspace_id = lens.workspace_id and profile.id = lens.brand_profile_id
           and profile.active = true and onboarding.completion_state = 'completed')
     ${lensGroupBy()}`,
    [actor.workspaceId, scoped.brandProfileId],
  ) as unknown as LensRow[];
  return rows[0] ? mapLens(rows[0]) : null;
}

/**
 * Server-only material for an AI Lab run. Source IDs deliberately stay out of
 * the prompt object: the route uses them only to narrow an already
 * recipe-scoped source query before any content reaches a model.
 */
export type SagaEditorialLensLabContext = {
  prompt: SagaEditorialLensPromptContext;
  sourceSelectionIds: string[];
};

export async function getSagaEditorialLensLabContext(
  actor: AppActor,
  sql: NeonSql = createNeonSql(),
): Promise<SagaEditorialLensLabContext | null> {
  const lens = await getSagaEditorialLens(actor, sql);
  if (!lens?.active) return null;
  return {
    prompt: sagaEditorialLensPromptContext(lens),
    sourceSelectionIds: lens.sourceSelections
      .slice()
      .sort((left, right) => left.priority - right.priority)
      .map((selection) => selection.sourceId),
  };
}

/** A narrow future-generation seam: it exposes doctrine only, never source IDs, credentials or a database row. */
export async function getSagaEditorialLensPromptContext(
  actor: AppActor,
  sql: NeonSql = createNeonSql(),
): Promise<SagaEditorialLensPromptContext | null> {
  return (await getSagaEditorialLensLabContext(actor, sql))?.prompt ?? null;
}

async function assertBrandProfileInWorkspace(actor: AppActor, brandProfileId: string | null, sql: NeonSql): Promise<void> {
  if (!brandProfileId) throw new SagaEditorialLensReferenceError("Välj ett färdigställt varumärke för din redaktionella riktning.");
  const rows = await sql.query(
    `select id::text
       from content_engine_brand_profiles profile
      where workspace_id = $1::uuid and id = $2::uuid and active = true
        and exists (select 1 from saga_brand_onboardings onboarding
          where onboarding.workspace_id = profile.workspace_id
            and onboarding.brand_profile_id = profile.id and onboarding.completion_state = 'completed')
      limit 1`,
    [actor.workspaceId, brandProfileId],
  ) as unknown as Array<{ id: string }>;
  if (!rows[0]) throw new SagaEditorialLensReferenceError("Varumärkesprofilen hittades inte i den här arbetsytan.");
}

/**
 * Replaces the single workspace doctrine. The CTE and database function keep
 * source selections atomic with the upsert; `workspace_id` comes only from
 * the signed actor and is never an input field.
 */
export async function upsertSagaEditorialLens(
  actor: AppActor,
  input: SagaEditorialLensInput,
  sql: NeonSql = createNeonSql(),
): Promise<SagaEditorialLens> {
  assertOwner(actor);
  const scoped = actor.brandProfileId ? actor : await resolveSagaBrandActor(actor, input.brandProfileId, sql);
  if (input.brandProfileId && input.brandProfileId !== scoped.brandProfileId) throw new SagaEditorialLensReferenceError();
  const value = sagaEditorialLensInputSchema.parse({ ...input, brandProfileId: scoped.brandProfileId });
  await assertBrandProfileInWorkspace(actor, value.brandProfileId, sql);
  try {
    const rows = await sql.query(
      `select saga_upsert_brand_editorial_lens($1::uuid, $2::uuid, $3::uuid, $4::jsonb)::text as id`,
      [actor.workspaceId, actor.userId, value.brandProfileId, JSON.stringify(value)],
    ) as unknown as Array<{ id: string }>;
    if (!rows[0]?.id) throw new SagaEditorialLensConflictError();
    const saved = await getSagaEditorialLens(scoped, sql);
    if (!saved || saved.id !== rows[0].id) throw new SagaEditorialLensConflictError();
    return saved;
  } catch (error) {
    normalizeDatabaseError(error);
  }
}

/** Owner-only reset. No source selection or doctrine record survives the delete. */
export async function deleteSagaEditorialLens(
  actor: AppActor,
  sql: NeonSql = createNeonSql(),
): Promise<boolean> {
  assertOwner(actor);
  const scoped = actor.brandProfileId ? actor : await resolveSagaBrandActor(actor, null, sql);
  try {
    const rows = await sql.query(
      `delete from saga_editorial_lenses
        where workspace_id = $1::uuid and brand_profile_id = $2::uuid
        returning id::text`,
      [actor.workspaceId, scoped.brandProfileId],
    ) as unknown as Array<{ id: string }>;
    return Boolean(rows[0]);
  } catch (error) {
    normalizeDatabaseError(error);
  }
}

function normalizeDatabaseError(error: unknown): never {
  if (error instanceof SagaEditorialLensReferenceError || error instanceof SagaEditorialLensConflictError) throw error;
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (code === "23503") throw new SagaEditorialLensReferenceError();
    if (code === "23505") throw new SagaEditorialLensConflictError();
    // The atomic source replacement function uses explicit PostgreSQL errors
    // for a stale, inactive, or cross-workspace source selection.
    if (code === "P0001") throw new SagaEditorialLensReferenceError("En vald Lens-källa är inte längre tillåten i arbetsytan.");
  }
  throw error;
}
