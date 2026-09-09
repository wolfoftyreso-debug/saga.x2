import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  EMPTY_BRAND_ONBOARDING_DRAFT,
  isOnboardingStepComplete,
  MarketStep,
  SagaBrandOnboarding,
  annualPlanScenario,
} from "@/components/saga-brand-onboarding";
import {
  brandOnboardingDecisionSupportFromForm,
  brandOnboardingInputFromForm,
  type BrandOnboardingDraft,
} from "@/lib/client/saga-brand-onboarding";

const completeDraft: BrandOnboardingDraft = {
  ...EMPTY_BRAND_ONBOARDING_DRAFT,
  brandName: "Nordkust Verkstad",
  organizationName: "Nordkust Verkstad AB",
  offer: "Trygg service för bilägare som vill fatta ett genomtänkt beslut.",
  customerProblem: "Bilägare behöver förstå vad som är relevant före de bokar en verkstadstid.",
  difference: "Vi översätter tekniska val till vardagliga beslut utan press.",
  productReadiness: "ready" as const,
  audience: "Bilägare i närområdet som vill ha tydlig service och långsiktig trygghet.",
  operatingModel: "commercial_b2c" as const,
  marketScope: "local" as const,
  audienceSizeEvidence: "estimated" as const,
  demandEvidence: "early" as const,
  historicalPerformance: "partial" as const,
  competition: "medium" as const,
  competitiveContext: "working_assumption" as const,
  timing: "always_on" as const,
  timingConfidence: "working_assumption" as const,
  annualGoal: "demand" as const,
  goalDetail: "Göra det lättare för rätt bilägare att ta nästa trygga steg.",
  measurementMetric: "Kvalificerade förfrågningar",
  measurementUnit: "count" as const,
  measurementProvenance: "unknown" as const,
  salesCycle: "considered" as const,
  conversionMeasurement: "basic" as const,
  teamCapacity: "steady" as const,
  channels: ["website", "organic_social"],
  planYear: "2026",
  alwaysOn: true,
  campaignBurstsPerYear: "4",
  contentPiecesPerMonth: "4",
  reviewCadence: "monthly" as const,
  annualBudgetSek: "240000",
  fixedCommitmentsSek: "60000",
  budgetStatus: "provisional" as const,
  allocationIntent: "learning_first" as const,
};

describe("SAGA brand onboarding UI", () => {
  it("uses the canonical document and deterministic server calculation for the browser preview", () => {
    const input = brandOnboardingInputFromForm(completeDraft, "completed", false);
    const support = brandOnboardingDecisionSupportFromForm(completeDraft);
    const scenario = annualPlanScenario(completeDraft);

    expect(input).toMatchObject({
      completionState: "completed",
      brand: {
        slug: "nordkust-verkstad",
        name: "Nordkust Verkstad",
        profileConfig: { onboardingContext: { operatingModel: "commercial_b2c" } },
      },
      annualPlan: {
        primaryObjective: "demand_creation",
        channels: ["website", "organic_social"],
        budget: { annualBudgetMinor: 24_000_000, fixedCommitmentsMinor: 6_000_000 },
      },
    });
    expect(input).not.toHaveProperty("workspaceId");
    expect(input).not.toHaveProperty("active");
    expect(support?.outcomeForecast).toEqual({ available: false, reason: "no_historical_outcome_data_or_external_market_model" });
    expect(support?.suppliedFacts).toContainEqual({
      field: "brand.profileConfig.onboardingContext.operatingModel",
      value: "Kommersiell B2C-verksamhet",
      provenance: "user_declared",
    });
    expect(scenario.available).toBe(true);
    expect(scenario.allocatableSek).toBe(180_000);
    expect(scenario.allocations.reduce((sum, allocation) => sum + allocation.amountSek, 0)).toBe(180_000);
  });

  it("requires an explicit operating model before the market step advances and makes its boundary visible", () => {
    const update = <K extends keyof BrandOnboardingDraft>(_key: K, _value: BrandOnboardingDraft[K]) => undefined;
    const html = renderToStaticMarkup(createElement(MarketStep, { draft: completeDraft, update }));

    expect(isOnboardingStepComplete("market", { ...completeDraft, operatingModel: "unknown" })).toBe(false);
    expect(isOnboardingStepComplete("market", completeDraft)).toBe(true);
    expect(html).toContain("Arbetsmodell");
    expect(html).toContain("Kommersiell B2C-verksamhet");
    expect(html).toContain("Den ändrar inte automatiskt budget, innehåll, kalender eller andra åtgärder.");
  });

  it("makes source categories and the explicit AI Gateway handoff visible without pretending that anything is saved", () => {
    const html = renderToStaticMarkup(createElement(SagaBrandOnboarding));

    expect(html).toContain("Ditt underlag");
    expect(html).toContain("Planeringsantaganden");
    expect(html).toContain("Behöver mätas");
    expect(html).toContain("Vercel AI Gateway");
    expect(html).toContain("Ingen kalenderpost, automation eller extern publicering skapas här.");
    expect(html).toContain("Spara som pågående");
    expect(html).not.toContain("Publicera varumärke");
  });
});
