import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { AppActor } from "@/lib/neon/auth-repository";
import type { NeonSql } from "@/lib/neon/database";
import {
  calculateSagaBrandOnboardingDecisionSupport,
  sagaBrandOnboardingCreateSchema,
  sagaBrandOnboardingDraftSchema,
  sagaBrandOnboardingUpdateSchema,
  type SagaBrandOnboardingCreateInput,
} from "@/lib/domain/saga-brand-onboarding";
import {
  createSagaBrandOnboarding,
  SagaBrandOnboardingAccessError,
  updateSagaBrandOnboarding,
} from "@/lib/neon/saga-brand-onboarding-repository";

const actor: AppActor = {
  userId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  role: "owner",
  email: "owner@example.test",
  displayName: "Owner",
};
const onboardingId = "33333333-3333-4333-8333-333333333333";
const brandProfileId = "44444444-4444-4444-8444-444444444444";
const createIdempotencyKey = "55555555-5555-4555-8555-555555555555";

function draft(overrides: Record<string, unknown> = {}) {
  const base = {
    completionState: "completed" as const,
    makeDefaultOnCompletion: true,
    brand: {
      slug: "system-byggarna",
      name: "Systembyggarna",
      organizationName: "Systembyggarna AB",
      summary: "Vi bygger system som frigör tid för mänskligt omdöme och livet utanför skärmen.",
      defaultLanguage: "sv",
      voice: {
        positioning: "System ska frigöra människan från maskinellt arbete.",
        audience: "Människor som bygger verksamheter och vill skapa mer plats för livet.",
        toneTraits: ["rak", "ödmjuk", "insiktsdriven"],
        vocabulary: ["system", "mänskligt omdöme"],
        avoidPhrases: ["garanterad tillväxt"],
        writingSamples: [],
      },
      profileConfig: {},
    },
    annualPlan: {
      planYear: 2026,
      primaryObjective: "demand_creation" as const,
      objectiveStatement: "Göra värdet av välbyggda system begripligt för fler rätta människor.",
      objectives: [{
        id: "efterfragaan",
        kind: "demand_creation" as const,
        statement: "Bygga återkommande kvalificerat intresse för system som frigör mänsklig tid.",
        measurement: { metric: "kvalificerade förfrågningar", unit: "count" as const, baseline: null, target: null, provenance: "unknown" as const },
      }],
      audience: {
        description: "Ägare och team som tröttnat på repetitivt arbete och vill bygga hållbara system.",
        geography: "Sverige",
        sizeEvidence: "estimated" as const,
      },
      marketContext: {
        productReadiness: "ready" as const,
        demandEvidence: "customer_signal" as const,
        historicalPerformance: "partial" as const,
        conversionMeasurement: "basic" as const,
        competitiveContext: "working_assumption" as const,
        timingConfidence: "working_assumption" as const,
      },
      channels: ["organic_social", "email", "website"],
      activity: {
        alwaysOn: true,
        campaignBurstsPerYear: 3,
        contentPiecesPerMonth: 4,
        reviewCadence: "monthly" as const,
        seasonalWindows: [{
          label: "Höstbygget",
          startMonth: 9,
          endMonth: 10,
          importance: "primary" as const,
          rationale: "Många planerar hur nästa arbetsår ska bli mindre manuellt.",
        }],
      },
      budget: {
        currency: "SEK",
        status: "provisional" as const,
        annualBudgetMinor: 12_000_000,
        fixedCommitmentsMinor: 2_000_000,
        allocationIntent: "learning_first" as const,
      },
    },
  };
  return sagaBrandOnboardingDraftSchema.parse({ ...base, ...overrides });
}

function row(revision = 1) {
  const value = draft();
  return {
    onboarding_id: onboardingId,
    brand_profile_id: brandProfileId,
    completion_state: value.completionState,
    make_default_on_completion: value.makeDefaultOnCompletion,
    annual_plan_input: value.annualPlan,
    decision_support: calculateSagaBrandOnboardingDecisionSupport(value),
    revision,
    onboarding_created_at: "2026-08-26T09:00:00.000Z",
    onboarding_updated_at: "2026-08-26T09:00:00.000Z",
    completed_at: "2026-08-26T09:00:00.000Z",
    brand_id: brandProfileId,
    brand_created_by_user_id: actor.userId,
    brand_slug: value.brand.slug,
    brand_name: value.brand.name,
    brand_organization_name: value.brand.organizationName,
    brand_summary: value.brand.summary,
    brand_default_language: value.brand.defaultLanguage,
    brand_voice: value.brand.voice,
    brand_profile_config: value.brand.profileConfig,
    brand_active: true,
    brand_is_default: true,
    brand_created_at: "2026-08-26T09:00:00.000Z",
    brand_updated_at: "2026-08-26T09:00:00.000Z",
  };
}

describe("SAGA Brand Onboarding domain", () => {
  it("makes a deterministic annual allocation with explicit scope, unknowns and no outcome forecast", () => {
    const value = draft();
    const first = calculateSagaBrandOnboardingDecisionSupport(value);
    const second = calculateSagaBrandOnboardingDecisionSupport(value);

    expect(second).toEqual(first);
    expect(first.scope).toBe("scenario_allocation_not_outcome_forecast");
    expect(first.inputProvenance).toMatchObject({ externalMarketDataUsed: false, historicalPerformance: "partial" });
    expect(first.outcomeForecast).toEqual({ available: false, reason: "no_historical_outcome_data_or_external_market_model" });
    expect(first.allocation.reduce((sum, bucket) => sum + bucket.amountMinor, 0)).toBe(10_000_000);
    expect(first.quarterlyCadence.reduce((sum, quarter) => sum + quarter.allocationMinor, 0)).toBe(10_000_000);
    expect(first.monthlyCadence.reduce((sum, month) => sum + month.allocationMinor, 0)).toBe(10_000_000);
    expect(first.unknowns.join(" ")).toContain("baslinje");
    expect(first.decisionFlags.some((flag) => flag.id === "measurement_readiness")).toBe(true);
  });

  it("keeps every minor unit accounted for at the supported budget ceiling", () => {
    const value = structuredClone(draft());
    value.annualPlan.budget.annualBudgetMinor = 9_000_000_000_000_000;
    value.annualPlan.budget.fixedCommitmentsMinor = 1;
    const support = calculateSagaBrandOnboardingDecisionSupport(value);
    expect(support.allocation.reduce((sum, bucket) => sum + bucket.amountMinor, 0)).toBe(8_999_999_999_999_999);
    expect(support.monthlyCadence.reduce((sum, month) => sum + month.allocationMinor, 0)).toBe(8_999_999_999_999_999);
  });

  it("requires the stated primary goal, non-overlapping timing and a real budget state before completion", () => {
    const primaryMismatch = structuredClone(draft());
    primaryMismatch.annualPlan.primaryObjective = "retention";
    expect(sagaBrandOnboardingDraftSchema.safeParse(primaryMismatch).success).toBe(false);

    const overlapping = structuredClone(draft());
    overlapping.annualPlan.activity.seasonalWindows.push({
      label: "Överlapp", startMonth: 10, endMonth: 11, importance: "supporting", rationale: "Skulle ge dubbel vikt utan ett tydligt beslut.",
    });
    expect(sagaBrandOnboardingDraftSchema.safeParse(overlapping).success).toBe(false);

    const missingBudget = structuredClone(draft());
    missingBudget.annualPlan.budget.status = "unknown";
    missingBudget.annualPlan.budget.annualBudgetMinor = 0;
    missingBudget.annualPlan.budget.fixedCommitmentsMinor = 0;
    expect(sagaBrandOnboardingDraftSchema.safeParse(missingBudget).success).toBe(false);
  });
});

describe("SAGA Brand Onboarding persistence boundary", () => {
  it("denies a viewer before any atomically scoped database call", async () => {
    const query = vi.fn();
    const input = sagaBrandOnboardingCreateSchema.parse({ ...draft(), createIdempotencyKey });
    await expect(createSagaBrandOnboarding({ ...actor, role: "viewer" }, input, { query } as unknown as NeonSql)).rejects.toBeInstanceOf(SagaBrandOnboardingAccessError);
    expect(query).not.toHaveBeenCalled();
  });

  it("calls the atomic DB function and derives the calculation server-side", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([{ onboarding_id: onboardingId, brand_profile_id: brandProfileId, reused: false }])
      .mockResolvedValueOnce([row()]);
    const input: SagaBrandOnboardingCreateInput = sagaBrandOnboardingCreateSchema.parse({ ...draft(), createIdempotencyKey });

    const created = await createSagaBrandOnboarding(actor, input, { query } as unknown as NeonSql);

    expect(created).toMatchObject({ reused: false, onboarding: { id: onboardingId, brandProfileId, revision: 1, completionState: "completed" } });
    const [statement, params] = query.mock.calls[0] ?? [];
    expect(statement).toContain("saga_create_brand_onboarding");
    expect(params?.slice(0, 4)).toEqual([actor.workspaceId, actor.userId, createIdempotencyKey, "completed"]);
    expect(JSON.parse(params?.[7] as string)).toMatchObject({ calculationVersion: "saga-brand-plan-v1", scope: "scenario_allocation_not_outcome_forecast" });
    expect(JSON.stringify(params)).not.toMatch(/workspaceId|accessToken|publishAt/i);
  });

  it("updates a whole annual plan at one revision function boundary", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([{ onboarding_id: onboardingId, revision: 2 }])
      .mockResolvedValueOnce([row(2)]);
    const update = sagaBrandOnboardingUpdateSchema.parse({ ...draft(), expectedRevision: 1 });

    const updated = await updateSagaBrandOnboarding(actor, brandProfileId, update, { query } as unknown as NeonSql);

    expect(updated.revision).toBe(2);
    expect(query.mock.calls[0]?.[0]).toContain("saga_update_brand_onboarding");
    expect(query.mock.calls[0]?.[1]?.slice(0, 4)).toEqual([actor.workspaceId, actor.userId, brandProfileId, 1]);
  });
});

describe("SAGA Brand Onboarding migration", () => {
  it("makes profile activation contingent on a completed onboarding and keeps immutable plan revisions", () => {
    const migration = readFileSync("db/migrations/202608260022_neon_saga_brand_onboarding.sql", "utf8");
    expect(migration).toContain("create table if not exists saga_brand_onboardings");
    expect(migration).toContain("create table if not exists saga_brand_onboarding_revisions");
    expect(migration).toContain("saga_create_brand_onboarding");
    expect(migration).toContain("saga_update_brand_onboarding");
    expect(migration).toContain("saga_brand_onboarding_guard_profile_activation");
    expect(migration).toContain("unique (workspace_id, create_idempotency_key)");
    expect(migration).toContain("scenario_allocation_not_outcome_forecast");
    expect(migration).toContain("target_completion_state = 'completed'");
    expect(migration).toContain("target_completion_state = 'in_progress'");
    expect(migration).toContain("active = false,");
    expect(migration).toContain("is_default = false");
    expect(migration.toLowerCase()).not.toContain("provider_token");
    expect(migration.toLowerCase()).not.toContain("access_token");
  });
});
