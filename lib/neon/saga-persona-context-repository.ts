import "server-only";

import {
  normalizeSagaPersonaContext,
  sagaPersonaContextInputSchema,
  sagaPersonaContextValueSchema,
  sagaPersonaPrivateVisualContextSchema,
  type SagaPersonaContextInput,
  type SagaPersonaContextView,
  type SagaPersonaPrivateVisualContext,
} from "@/lib/domain/saga-persona-context";
import type { AppActor } from "@/lib/neon/auth-repository";
import { createNeonSql, type NeonSql } from "@/lib/neon/database";

type PersonaContextRow = {
  revision: number | string;
  payload: unknown;
  created_at: string | Date;
  updated_at: string | Date;
};

type RevisionRow = { revision: number | string | null };

export class SagaPersonaContextAccessError extends Error {
  constructor(message = "Bara arbetsytans ägare kan öppna eller ändra sin privata personakontext.") {
    super(message);
    this.name = "SagaPersonaContextAccessError";
  }
}

export class SagaPersonaContextConflictError extends Error {
  constructor(message = "Din privata personakontext ändrades i en annan flik. Läs in den igen innan du sparar.") {
    super(message);
    this.name = "SagaPersonaContextConflictError";
  }
}

export class SagaPersonaContextValidationError extends Error {
  constructor(message = "Din privata personakontext innehåller ett ogiltigt värde.") {
    super(message);
    this.name = "SagaPersonaContextValidationError";
  }
}

function assertOwner(actor: AppActor): void {
  if (actor.role !== "owner") throw new SagaPersonaContextAccessError();
}

function asInteger(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new SagaPersonaContextValidationError("Den privata personakontexten kunde inte läsas säkert.");
  return parsed;
}

function asTimestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value) return value;
  throw new SagaPersonaContextValidationError("Den privata personakontexten kunde inte läsas säkert.");
}

function asJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") throw new SagaPersonaContextValidationError("Den privata personakontexten kunde inte läsas säkert.");
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // Turn bad persisted JSON into a safe, non-descriptive error.
  }
  throw new SagaPersonaContextValidationError("Den privata personakontexten kunde inte läsas säkert.");
}

function mapContext(row: PersonaContextRow): SagaPersonaContextView {
  const value = sagaPersonaContextValueSchema.parse(asJsonObject(row.payload));
  return {
    ...value,
    revision: asInteger(row.revision),
    createdAt: asTimestamp(row.created_at),
    updatedAt: asTimestamp(row.updated_at),
    modelUse: {
      visualContextConsent: value.visualContextConsent,
      activeIntegration: false,
    },
  };
}

function databaseFailure(error: unknown): never {
  if (
    error instanceof SagaPersonaContextAccessError
    || error instanceof SagaPersonaContextConflictError
    || error instanceof SagaPersonaContextValidationError
  ) throw error;
  const code = error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  const message = error instanceof Error ? error.message : "";
  if (code === "P0001" && /requires workspace owner/i.test(message)) {
    throw new SagaPersonaContextAccessError();
  }
  if (code === "P0001" || code === "23514" || /SAGA persona context/i.test(message)) {
    throw new SagaPersonaContextValidationError();
  }
  throw error;
}

/**
 * Reads only the signed owner's own record. A workspace editor, viewer, or a
 * second owner never receives another owner's persona data.
 */
export async function getSagaPersonaContext(
  actor: AppActor,
  sql: NeonSql = createNeonSql(),
): Promise<SagaPersonaContextView | null> {
  assertOwner(actor);
  try {
    const rows = await sql.query(
      `select revision, payload, created_at::text, updated_at::text
         from saga_persona_contexts
        where workspace_id = $1::uuid
          and owner_user_id = $2::uuid
        limit 1`,
      [actor.workspaceId, actor.userId],
    ) as unknown as PersonaContextRow[];
    return rows[0] ? mapContext(rows[0]) : null;
  } catch (error) {
    return databaseFailure(error);
  }
}

/**
 * Full replacement of the current owner's record. Payload is parameterized,
 * revisioned in PostgreSQL and has no route-supplied workspace or user id.
 */
export async function replaceSagaPersonaContext(
  actor: AppActor,
  input: SagaPersonaContextInput,
  sql: NeonSql = createNeonSql(),
): Promise<SagaPersonaContextView> {
  assertOwner(actor);
  const parsed = sagaPersonaContextInputSchema.parse(input);
  const value = normalizeSagaPersonaContext(parsed);
  try {
    const rows = await sql.query(
      `select saga_persona_context_write(
         $1::uuid, $2::uuid, $3::jsonb, $4::integer, $5
       ) as revision`,
      [
        actor.workspaceId,
        actor.userId,
        JSON.stringify(value),
        parsed.expectedRevision ?? null,
        parsed.sensitiveDataStorageConsent?.version ?? null,
      ],
    ) as unknown as RevisionRow[];
    if (rows[0]?.revision === null || rows[0]?.revision === undefined) {
      throw new SagaPersonaContextConflictError();
    }
    const context = await getSagaPersonaContext(actor, sql);
    if (!context) throw new SagaPersonaContextValidationError("Den privata personakontexten kunde inte sparas.");
    return context;
  } catch (error) {
    return databaseFailure(error);
  }
}

/** Explicit owner-only erase. Cascading deletes clear every immutable revision too. */
export async function deleteSagaPersonaContext(
  actor: AppActor,
  sql: NeonSql = createNeonSql(),
): Promise<boolean> {
  assertOwner(actor);
  try {
    const rows = await sql.query(
      `delete from saga_persona_contexts
        where workspace_id = $1::uuid
          and owner_user_id = $2::uuid
        returning revision`,
      [actor.workspaceId, actor.userId],
    ) as unknown as RevisionRow[];
    return Boolean(rows[0]);
  } catch (error) {
    return databaseFailure(error);
  }
}

/**
 * Server-only future seam. It selects only the expressly permitted visual
 * values from a consented record, avoiding even an in-memory read of politics,
 * religion, origin, birth country, height, biography, work or website links.
 *
 * No model or publisher calls this today.
 */
export async function getSagaPersonaPrivateVisualContext(
  actor: AppActor,
  sql: NeonSql = createNeonSql(),
): Promise<SagaPersonaPrivateVisualContext | null> {
  assertOwner(actor);
  try {
    const rows = await sql.query(
      `select
         payload -> 'clothing' as clothing,
         payload -> 'environments' as environments,
         payload -> 'visualCountries' as visual_countries
       from saga_persona_contexts
      where workspace_id = $1::uuid
        and owner_user_id = $2::uuid
        and visual_context_consent = true
      limit 1`,
      [actor.workspaceId, actor.userId],
    ) as unknown as Array<{
      clothing: unknown;
      environments: unknown;
      visual_countries: unknown;
    }>;
    const row = rows[0];
    if (!row) return null;
    return sagaPersonaPrivateVisualContextSchema.parse({
      source: "self_described",
      clothing: jsonArray(row.clothing),
      environments: jsonArray(row.environments),
      visualCountries: jsonArray(row.visual_countries),
    });
  } catch (error) {
    return databaseFailure(error);
  }
}

function jsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
