import "server-only";

import {
  calculateSagaBrandOnboardingDecisionSupport,
  sagaBrandOnboardingAnnualPlanSchema,
  sagaBrandOnboardingCreateSchema,
  sagaBrandOnboardingDecisionSupportSchema,
  sagaBrandOnboardingOverviewSchema,
  sagaBrandOnboardingSchema,
  sagaBrandOnboardingUpdateSchema,
  type SagaBrandOnboarding,
  type SagaBrandOnboardingCreateInput,
  type SagaBrandOnboardingOverview,
  type SagaBrandOnboardingUpdateInput,
} from "@/lib/domain/saga-brand-onboarding";
import { contentEngineBrandProfileSchema } from "@/lib/domain/content-engine";
import type { AppActor } from "@/lib/neon/auth-repository";
import { createNeonSql, type NeonSql } from "@/lib/neon/database";

type OnboardingRow = {
  onboarding_id: string;
  brand_profile_id: string;
  completion_state: string;
  make_default_on_completion: boolean;
  annual_plan_input: unknown;
  decision_support: unknown;
  revision: number | string;
  onboarding_created_at: string | Date;
  onboarding_updated_at: string | Date;
  completed_at: string | Date | null;
  brand_id: string;
  brand_created_by_user_id: string;
  brand_slug: string;
  brand_name: string;
  brand_organization_name: string;
  brand_summary: string;
  brand_default_language: string;
  brand_voice: unknown;
  brand_profile_config: unknown;
  brand_active: boolean;
  brand_is_default: boolean;
  brand_created_at: string | Date;
  brand_updated_at: string | Date;
};

type OverviewRow = {
  brand_profile_id: string;
  brand_name: string;
  brand_slug: string;
  brand_active: boolean;
  completion_state: string;
  plan_year: number | string;
  annual_plan_input: unknown;
  decision_support: unknown;
  revision: number | string;
  updated_at: string | Date;
};

type CreateFunctionRow = {
  onboarding_id: string;
  brand_profile_id: string;
  reused: boolean;
};

export class SagaBrandOnboardingAccessError extends Error {
  constructor(message = "Du har bara läsrättighet i den här arbetsytan.") {
    super(message);
    this.name = "SagaBrandOnboardingAccessError";
  }
}

export class SagaBrandOnboardingNotFoundError extends Error {
  constructor(message = "Varumärkes-onboardingen hittades inte i den här arbetsytan.") {
    super(message);
    this.name = "SagaBrandOnboardingNotFoundError";
  }
}

export class SagaBrandOnboardingConflictError extends Error {
  constructor(message = "Onboardingen har ändrats i en annan flik. Läs in den igen innan du sparar.") {
    super(message);
    this.name = "SagaBrandOnboardingConflictError";
  }
}

export class SagaBrandOnboardingValidationError extends Error {
  constructor(message = "Onboardingens varumärke eller årsplan kunde inte läsas säkert.") {
    super(message);
    this.name = "SagaBrandOnboardingValidationError";
  }
}

function assertCanWrite(actor: AppActor): void {
  if (actor.role === "viewer") throw new SagaBrandOnboardingAccessError();
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function timestamp(value: unknown, nullable = false): string | null {
  if (value === null && nullable) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value === "string" && !Number.isNaN(new Date(value).getTime())) return new Date(value).toISOString();
  throw new SagaBrandOnboardingValidationError("Onboardingens datum kunde inte läsas säkert.");
}

function integer(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new SagaBrandOnboardingValidationError("Onboardingens revision kunde inte läsas säkert.");
  return parsed;
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function bool(value: unknown): boolean {
  return value === true;
}

function mapOnboarding(row: OnboardingRow): SagaBrandOnboarding {
  try {
    const brandProfile = contentEngineBrandProfileSchema.parse({
      id: row.brand_id,
      createdByUserId: row.brand_created_by_user_id,
      slug: row.brand_slug,
      name: row.brand_name,
      organizationName: row.brand_organization_name,
      summary: row.brand_summary,
      defaultLanguage: row.brand_default_language,
      voice: jsonObject(row.brand_voice),
      profileConfig: jsonObject(row.brand_profile_config),
      active: bool(row.brand_active),
      isDefault: bool(row.brand_is_default),
      createdAt: timestamp(row.brand_created_at),
      updatedAt: timestamp(row.brand_updated_at),
    });
    const annualPlan = sagaBrandOnboardingAnnualPlanSchema.parse(jsonObject(row.annual_plan_input));
    const decisionSupport = sagaBrandOnboardingDecisionSupportSchema.parse(jsonObject(row.decision_support));
    return sagaBrandOnboardingSchema.parse({
      id: row.onboarding_id,
      brandProfileId: row.brand_profile_id,
      brandProfile,
      completionState: row.completion_state,
      makeDefaultOnCompletion: bool(row.make_default_on_completion),
      annualPlan,
      decisionSupport,
      revision: integer(row.revision),
      createdAt: timestamp(row.onboarding_created_at),
      updatedAt: timestamp(row.onboarding_updated_at),
      completedAt: timestamp(row.completed_at, true),
    });
  } catch (error) {
    if (error instanceof SagaBrandOnboardingValidationError) throw error;
    throw new SagaBrandOnboardingValidationError();
  }
}

function mapOverview(row: OverviewRow): SagaBrandOnboardingOverview {
  try {
    const annualPlan = sagaBrandOnboardingAnnualPlanSchema.parse(jsonObject(row.annual_plan_input));
    const support = sagaBrandOnboardingDecisionSupportSchema.parse(jsonObject(row.decision_support));
    return sagaBrandOnboardingOverviewSchema.parse({
      brandProfileId: row.brand_profile_id,
      brandName: row.brand_name,
      brandSlug: row.brand_slug,
      brandActive: bool(row.brand_active),
      completionState: row.completion_state,
      planYear: Number(row.plan_year),
      budget: {
        currency: annualPlan.budget.currency,
        status: annualPlan.budget.status,
        annualBudgetMinor: annualPlan.budget.annualBudgetMinor,
      },
      decisionReadiness: support.decisionReadiness,
      revision: integer(row.revision),
      updatedAt: timestamp(row.updated_at),
    });
  } catch (error) {
    if (error instanceof SagaBrandOnboardingValidationError) throw error;
    throw new SagaBrandOnboardingValidationError();
  }
}

function databaseFailure(error: unknown): never {
  if (
    error instanceof SagaBrandOnboardingAccessError
    || error instanceof SagaBrandOnboardingNotFoundError
    || error instanceof SagaBrandOnboardingConflictError
    || error instanceof SagaBrandOnboardingValidationError
  ) throw error;
  const details = error && typeof error === "object" ? error as { code?: unknown; message?: unknown } : null;
  const code = details?.code;
  const message = typeof details?.message === "string" ? details.message : "";
  if (message.includes("saga_brand_onboarding_not_found")) throw new SagaBrandOnboardingNotFoundError();
  if (message.includes("saga_brand_onboarding_revision_conflict")) throw new SagaBrandOnboardingConflictError();
  if (code === "23505") throw new SagaBrandOnboardingConflictError("En annan onboarding använder redan samma varumärkesslug eller sparretry.");
  if (code === "23514" || code === "23503" || code === "22P02") throw new SagaBrandOnboardingValidationError();
  throw error;
}

const currentSelect = `select
  onboarding.id::text as onboarding_id,
  onboarding.brand_profile_id::text as brand_profile_id,
  onboarding.completion_state,
  onboarding.make_default_on_completion,
  onboarding.annual_plan_input,
  onboarding.decision_support,
  onboarding.revision,
  onboarding.created_at::text as onboarding_created_at,
  onboarding.updated_at::text as onboarding_updated_at,
  onboarding.completed_at::text,
  profile.id::text as brand_id,
  profile.created_by_user_id::text as brand_created_by_user_id,
  profile.slug as brand_slug,
  profile.name as brand_name,
  profile.organization_name as brand_organization_name,
  profile.summary as brand_summary,
  profile.default_language as brand_default_language,
  profile.voice as brand_voice,
  profile.profile_config as brand_profile_config,
  profile.active as brand_active,
  profile.is_default as brand_is_default,
  profile.created_at::text as brand_created_at,
  profile.updated_at::text as brand_updated_at
from saga_brand_onboardings onboarding
join content_engine_brand_profiles profile
  on profile.workspace_id = onboarding.workspace_id
 and profile.id = onboarding.brand_profile_id`;

async function getOnboardingRow(
  actor: AppActor,
  brandProfileId: string,
  sql: NeonSql,
): Promise<OnboardingRow | null> {
  const rows = await sql.query(
    `${currentSelect}
      where onboarding.workspace_id = $1::uuid
        and onboarding.brand_profile_id = $2::uuid
      limit 1`,
    [actor.workspaceId, brandProfileId],
  ) as unknown as OnboardingRow[];
  return rows[0] ?? null;
}

/** Overview deliberately returns just enough state for a selector/control room. */
export async function listSagaBrandOnboardingOverviews(
  actor: AppActor,
  sql: NeonSql = createNeonSql(),
): Promise<SagaBrandOnboardingOverview[]> {
  try {
    const rows = await sql.query(
      `select
        onboarding.brand_profile_id::text,
        profile.name as brand_name,
        profile.slug as brand_slug,
        profile.active as brand_active,
        onboarding.completion_state,
        (onboarding.annual_plan_input ->> 'planYear')::integer as plan_year,
        onboarding.annual_plan_input,
        onboarding.decision_support,
        onboarding.revision,
        onboarding.updated_at::text
      from saga_brand_onboardings onboarding
      join content_engine_brand_profiles profile
        on profile.workspace_id = onboarding.workspace_id
       and profile.id = onboarding.brand_profile_id
      where onboarding.workspace_id = $1::uuid
      order by onboarding.updated_at desc, onboarding.id desc`,
      [actor.workspaceId],
    ) as unknown as OverviewRow[];
    return rows.map(mapOverview);
  } catch (error) {
    return databaseFailure(error);
  }
}

export async function getSagaBrandOnboarding(
  actor: AppActor,
  brandProfileId: string,
  sql: NeonSql = createNeonSql(),
): Promise<SagaBrandOnboarding | null> {
  if (!isUuid(brandProfileId)) throw new SagaBrandOnboardingNotFoundError();
  try {
    const row = await getOnboardingRow(actor, brandProfileId, sql);
    return row ? mapOnboarding(row) : null;
  } catch (error) {
    return databaseFailure(error);
  }
}

/**
 * Calls one DB function for the write boundary. A retry gets the original
 * onboarding back unchanged; the client cannot create two brands from one
 * click even if its network response is interrupted.
 */
export async function createSagaBrandOnboarding(
  actor: AppActor,
  input: SagaBrandOnboardingCreateInput,
  sql: NeonSql = createNeonSql(),
): Promise<{ onboarding: SagaBrandOnboarding; reused: boolean }> {
  assertCanWrite(actor);
  const payload = sagaBrandOnboardingCreateSchema.parse(input);
  const draft = {
    completionState: payload.completionState,
    makeDefaultOnCompletion: payload.makeDefaultOnCompletion,
    brand: payload.brand,
    annualPlan: payload.annualPlan,
  };
  const support = calculateSagaBrandOnboardingDecisionSupport(draft);
  try {
    const rows = await sql.query(
      `select onboarding_id::text, brand_profile_id::text, reused
         from saga_create_brand_onboarding(
           $1::uuid, $2::uuid, $3::uuid, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb
         )`,
      [
        actor.workspaceId,
        actor.userId,
        payload.createIdempotencyKey,
        payload.completionState,
        payload.makeDefaultOnCompletion,
        JSON.stringify(payload.brand),
        JSON.stringify(payload.annualPlan),
        JSON.stringify(support),
      ],
    ) as unknown as CreateFunctionRow[];
    const result = rows[0];
    if (!result || !isUuid(result.brand_profile_id)) throw new SagaBrandOnboardingValidationError("Onboardingen kunde inte återläsas efter sparandet.");
    const onboarding = await getSagaBrandOnboarding(actor, result.brand_profile_id, sql);
    if (!onboarding) throw new SagaBrandOnboardingConflictError("Onboardingen kunde inte återläsas efter sparandet.");
    return { onboarding, reused: bool(result.reused) };
  } catch (error) {
    return databaseFailure(error);
  }
}

/** Full replacement prevents a stale tab from mixing two annual plans. */
export async function updateSagaBrandOnboarding(
  actor: AppActor,
  brandProfileId: string,
  input: SagaBrandOnboardingUpdateInput,
  sql: NeonSql = createNeonSql(),
): Promise<SagaBrandOnboarding> {
  assertCanWrite(actor);
  if (!isUuid(brandProfileId)) throw new SagaBrandOnboardingNotFoundError();
  const payload = sagaBrandOnboardingUpdateSchema.parse(input);
  const draft = {
    completionState: payload.completionState,
    makeDefaultOnCompletion: payload.makeDefaultOnCompletion,
    brand: payload.brand,
    annualPlan: payload.annualPlan,
  };
  const support = calculateSagaBrandOnboardingDecisionSupport(draft);
  try {
    await sql.query(
      `select onboarding_id::text, revision
         from saga_update_brand_onboarding(
           $1::uuid, $2::uuid, $3::uuid, $4::integer, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb
         )`,
      [
        actor.workspaceId,
        actor.userId,
        brandProfileId,
        payload.expectedRevision,
        payload.completionState,
        payload.makeDefaultOnCompletion,
        JSON.stringify(payload.brand),
        JSON.stringify(payload.annualPlan),
        JSON.stringify(support),
      ],
    );
    const onboarding = await getSagaBrandOnboarding(actor, brandProfileId, sql);
    if (!onboarding) throw new SagaBrandOnboardingNotFoundError();
    return onboarding;
  } catch (error) {
    return databaseFailure(error);
  }
}
