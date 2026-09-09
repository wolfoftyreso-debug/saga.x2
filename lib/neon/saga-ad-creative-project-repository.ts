import "server-only";

import {
  materializeSagaAdCreativeVariant,
  parseSagaAdCreativeStoredVariants,
  sagaAdCreativeMasterBriefSchema,
  sagaAdCreativeProjectCreateSchema,
  sagaAdCreativeProjectDeleteSchema,
  sagaAdCreativeProjectUpdateSchema,
  type SagaAdCreativeProject,
  type SagaAdCreativeProjectCreateInput,
  type SagaAdCreativeProjectUpdateInput,
} from "@/lib/domain/saga-ad-creative";
import type { AppActor } from "@/lib/neon/auth-repository";
import { createNeonSql, type NeonSql } from "@/lib/neon/database";

type ProjectRow = {
  id: string;
  name: string;
  master_brief: unknown;
  variants: unknown;
  revision: number | string;
  created_at: string | Date;
  updated_at: string | Date;
};

export class SagaAdCreativeProjectAccessError extends Error {
  constructor(message = "Du har bara läsrättighet i den här arbetsytan.") {
    super(message);
    this.name = "SagaAdCreativeProjectAccessError";
  }
}

export class SagaAdCreativeProjectNotFoundError extends Error {
  constructor(message = "Annonsprojektet hittades inte i den här arbetsytan.") {
    super(message);
    this.name = "SagaAdCreativeProjectNotFoundError";
  }
}

export class SagaAdCreativeProjectConflictError extends Error {
  constructor(message = "Annonsprojektet har ändrats i en annan flik. Läs in det igen innan du sparar.") {
    super(message);
    this.name = "SagaAdCreativeProjectConflictError";
  }
}

export class SagaAdCreativeProjectValidationError extends Error {
  constructor(message = "Annonsprojektet eller ett av dess format är ogiltigt.") {
    super(message);
    this.name = "SagaAdCreativeProjectValidationError";
  }
}

function assertCanWrite(actor: AppActor): void {
  if (actor.role === "viewer") throw new SagaAdCreativeProjectAccessError();
}

function timestamp(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value === "string" && !Number.isNaN(new Date(value).getTime())) return new Date(value).toISOString();
  throw new SagaAdCreativeProjectValidationError("Annonsprojektets datum kunde inte läsas säkert.");
}

function revision(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new SagaAdCreativeProjectValidationError("Annonsprojektets revision kunde inte läsas säkert.");
  return parsed;
}

function jsonObject(value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function mapProject(row: ProjectRow): SagaAdCreativeProject {
  const name = typeof row.name === "string" ? row.name.trim() : "";
  if (name.length < 2 || name.length > 160) {
    throw new SagaAdCreativeProjectValidationError("Annonsprojektets namn kunde inte läsas säkert.");
  }
  const masterBrief = sagaAdCreativeMasterBriefSchema.safeParse(jsonObject(row.master_brief));
  if (!masterBrief.success) throw new SagaAdCreativeProjectValidationError("Annonsprojektets masterbrief kunde inte läsas säkert.");
  try {
    return {
      id: row.id,
      name,
      masterBrief: masterBrief.data,
      variants: parseSagaAdCreativeStoredVariants(row.variants),
      revision: revision(row.revision),
      createdAt: timestamp(row.created_at),
      updatedAt: timestamp(row.updated_at),
    };
  } catch (error) {
    if (error instanceof SagaAdCreativeProjectValidationError) throw error;
    throw new SagaAdCreativeProjectValidationError();
  }
}

function databaseFailure(error: unknown): never {
  if (
    error instanceof SagaAdCreativeProjectAccessError
    || error instanceof SagaAdCreativeProjectNotFoundError
    || error instanceof SagaAdCreativeProjectConflictError
    || error instanceof SagaAdCreativeProjectValidationError
  ) throw error;
  const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
  if (code === "23505") throw new SagaAdCreativeProjectConflictError("En sparretry krockade med ett annat annonsprojekt.");
  if (code === "23514" || code === "23503") throw new SagaAdCreativeProjectValidationError();
  throw error;
}

const selectFields = `id::text, name, master_brief, variants, revision, created_at::text, updated_at::text`;

async function getRow(
  actor: AppActor,
  id: string,
  sql: NeonSql,
): Promise<ProjectRow | null> {
  const rows = await sql.query(
    `select ${selectFields}
       from saga_ad_creative_projects
      where workspace_id = $1::uuid and id = $2::uuid
      limit 1`,
    [actor.workspaceId, id],
  ) as unknown as ProjectRow[];
  return rows[0] ?? null;
}

/** Lists only private projects in the signed actor's current workspace. */
export async function listSagaAdCreativeProjects(
  actor: AppActor,
  sql: NeonSql = createNeonSql(),
): Promise<SagaAdCreativeProject[]> {
  try {
    const rows = await sql.query(
      `select ${selectFields}
         from saga_ad_creative_projects
        where workspace_id = $1::uuid
        order by updated_at desc, id desc`,
      [actor.workspaceId],
    ) as unknown as ProjectRow[];
    return rows.map(mapProject);
  } catch (error) {
    return databaseFailure(error);
  }
}

export async function getSagaAdCreativeProject(
  actor: AppActor,
  id: string,
  sql: NeonSql = createNeonSql(),
): Promise<SagaAdCreativeProject | null> {
  if (!isUuid(id)) throw new SagaAdCreativeProjectNotFoundError();
  try {
    const row = await getRow(actor, id, sql);
    return row ? mapProject(row) : null;
  } catch (error) {
    return databaseFailure(error);
  }
}

/** An interrupted project creation retries safely using a workspace-scoped UUID. */
export async function createSagaAdCreativeProject(
  actor: AppActor,
  input: SagaAdCreativeProjectCreateInput,
  sql: NeonSql = createNeonSql(),
): Promise<{ project: SagaAdCreativeProject; reused: boolean }> {
  assertCanWrite(actor);
  const payload = sagaAdCreativeProjectCreateSchema.parse(input);
  const variants = payload.variants.map(materializeSagaAdCreativeVariant);
  try {
    const rows = await sql.query(
      `insert into saga_ad_creative_projects (
         workspace_id, created_by_user_id, updated_by_user_id, create_idempotency_key,
         name, master_brief, variants
       ) values ($1::uuid, $2::uuid, $2::uuid, $3::uuid, $4, $5::jsonb, $6::jsonb)
       on conflict (workspace_id, create_idempotency_key) do nothing
       returning ${selectFields}`,
      [actor.workspaceId, actor.userId, payload.createIdempotencyKey, payload.name, JSON.stringify(payload.masterBrief), JSON.stringify(variants)],
    ) as unknown as ProjectRow[];
    if (rows[0]) return { project: mapProject(rows[0]), reused: false };
    const retried = await sql.query(
      `select ${selectFields}
         from saga_ad_creative_projects
        where workspace_id = $1::uuid and create_idempotency_key = $2::uuid
        limit 1`,
      [actor.workspaceId, payload.createIdempotencyKey],
    ) as unknown as ProjectRow[];
    if (!retried[0]) throw new SagaAdCreativeProjectConflictError("Annonsprojektet kunde inte återläsas efter en sparretry.");
    return { project: mapProject(retried[0]), reused: true };
  } catch (error) {
    return databaseFailure(error);
  }
}

/** Full canvas data stays atomic under one revision boundary. */
export async function updateSagaAdCreativeProject(
  actor: AppActor,
  id: string,
  input: SagaAdCreativeProjectUpdateInput,
  sql: NeonSql = createNeonSql(),
): Promise<SagaAdCreativeProject> {
  assertCanWrite(actor);
  if (!isUuid(id)) throw new SagaAdCreativeProjectNotFoundError();
  const patch = sagaAdCreativeProjectUpdateSchema.parse(input);
  try {
    const currentRow = await getRow(actor, id, sql);
    if (!currentRow) throw new SagaAdCreativeProjectNotFoundError();
    const current = mapProject(currentRow);
    if (current.revision !== patch.expectedRevision) throw new SagaAdCreativeProjectConflictError();
    const nextVariants = patch.variants === undefined
      ? current.variants
      : patch.variants.map(materializeSagaAdCreativeVariant);
    const rows = await sql.query(
      `update saga_ad_creative_projects
          set name = $4,
              master_brief = $5::jsonb,
              variants = $6::jsonb,
              updated_by_user_id = $7::uuid,
              revision = revision + 1
        where workspace_id = $1::uuid
          and id = $2::uuid
          and revision = $3::integer
        returning ${selectFields}`,
      [
        actor.workspaceId,
        id,
        patch.expectedRevision,
        patch.name ?? current.name,
        JSON.stringify(patch.masterBrief ?? current.masterBrief),
        JSON.stringify(nextVariants),
        actor.userId,
      ],
    ) as unknown as ProjectRow[];
    if (!rows[0]) throw new SagaAdCreativeProjectConflictError();
    return mapProject(rows[0]);
  } catch (error) {
    return databaseFailure(error);
  }
}

export async function deleteSagaAdCreativeProject(
  actor: AppActor,
  id: string,
  input: { expectedRevision: number },
  sql: NeonSql = createNeonSql(),
): Promise<void> {
  assertCanWrite(actor);
  if (!isUuid(id)) throw new SagaAdCreativeProjectNotFoundError();
  const value = sagaAdCreativeProjectDeleteSchema.parse(input);
  try {
    const rows = await sql.query(
      `delete from saga_ad_creative_projects
        where workspace_id = $1::uuid
          and id = $2::uuid
          and revision = $3::integer
        returning id::text`,
      [actor.workspaceId, id, value.expectedRevision],
    ) as unknown as Array<{ id: string }>;
    if (rows[0]) return;
    const stillExists = await getRow(actor, id, sql);
    if (!stillExists) throw new SagaAdCreativeProjectNotFoundError();
    throw new SagaAdCreativeProjectConflictError();
  } catch (error) {
    return databaseFailure(error);
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
