import OpenAI from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sagaBrandOnboardingDraftSchema } from "@/lib/domain/saga-brand-onboarding";
import {
  generateSagaBrandOnboardingAdvice,
  SagaBrandOnboardingAdviceError,
} from "@/lib/services/saga-brand-onboarding-advice";
import { resolveSagaBrandAdvisorGatewayModel } from "@/lib/vercel/ai-gateway";

const previous = {
  gateway: process.env.AI_GATEWAY_API_KEY,
  oidc: process.env.VERCEL_OIDC_TOKEN,
  direct: process.env.OPENAI_API_KEY,
  model: process.env.SAGA_BRAND_ADVISOR_GATEWAY_MODEL,
};

function draft() {
  return sagaBrandOnboardingDraftSchema.parse({
    completionState: "in_progress",
    makeDefaultOnCompletion: true,
    brand: {
      slug: "systembyggarna",
      name: "Systembyggarna",
      organizationName: "Systembyggarna AB",
      summary: "Vi bygger system som frigör tid för mänskligt omdöme.",
      defaultLanguage: "sv",
      voice: { positioning: "Frigör tid", audience: "Byggare", toneTraits: ["rak"], vocabulary: [], avoidPhrases: [], writingSamples: [] },
      profileConfig: {},
    },
    annualPlan: {
      planYear: 2026,
      primaryObjective: "awareness",
      objectiveStatement: "Göra systembyggande tydligt för fler människor som skapar verksamheter.",
      objectives: [{ id: "kannedom", kind: "awareness", statement: "Göra fler relevanta människor medvetna om systembyggande.", measurement: { metric: "relevant räckvidd", unit: "count", baseline: null, target: null, provenance: "unknown" } }],
      audience: { description: "Människor som bygger verksamheter och vill frigöra tid från repetitiva uppgifter.", geography: "Sverige", sizeEvidence: "unknown" },
      marketContext: { productReadiness: "early", demandEvidence: "hypothesis", historicalPerformance: "none", conversionMeasurement: "none", competitiveContext: "unknown", timingConfidence: "unknown" },
      channels: ["organic_social", "website"],
      activity: { alwaysOn: true, campaignBurstsPerYear: 2, contentPiecesPerMonth: 4, reviewCadence: "monthly", seasonalWindows: [] },
      budget: { currency: "SEK", status: "provisional", annualBudgetMinor: 1_000_000, fixedCommitmentsMinor: 0, allocationIntent: "learning_first" },
    },
  });
}

function client() {
  return {
    responses: {
      parse: vi.fn(async () => ({
        id: "response-1",
        model: "openai/gpt-5.4-mini",
        status: "completed",
        output_parsed: {
          summary: "Börja med en avgränsad testcykel och följ en tydlig kundhandling.",
          recommendations: [{ area: "measurement", recommendation: "Definiera en spårbar nästa handling.", rationale: "Mätningen är begränsad i underlaget." }],
          questions: ["Vilken handling visar att budskapet är relevant?"],
        },
        usage: { input_tokens: 120, output_tokens: 90 },
      })),
    },
  } as unknown as OpenAI;
}

afterEach(() => {
  for (const [key, value] of Object.entries(previous)) {
    const environmentKey = key === "gateway" ? "AI_GATEWAY_API_KEY"
      : key === "oidc" ? "VERCEL_OIDC_TOKEN"
        : key === "direct" ? "OPENAI_API_KEY"
          : "SAGA_BRAND_ADVISOR_GATEWAY_MODEL";
    if (value === undefined) delete process.env[environmentKey];
    else process.env[environmentKey] = value;
  }
});

describe("SAGA Brand Onboarding advisor", () => {
  it("uses a bounded Gateway response without saving, web facts or outcome forecasts", async () => {
    const fake = client();
    const result = await generateSagaBrandOnboardingAdvice({
      draft: draft(),
      client: fake,
      resolveModel: () => "openai/gpt-5.4-mini",
    });

    expect(result).toMatchObject({
      saved: false,
      scope: "advisory_only_no_market_facts_or_outcome_forecast",
      metadata: { gateway: "vercel-ai-gateway", api: "responses", stored: false, model: "openai/gpt-5.4-mini" },
    });
    expect(result.suppliedFacts.every((fact) => fact.provenance === "user_declared")).toBe(true);
    expect(result.unknowns.join(" ")).toContain("Efterfrågan");
    const parse = fake.responses.parse as unknown as ReturnType<typeof vi.fn>;
    expect(parse).toHaveBeenCalledWith(expect.objectContaining({
      store: false,
      model: "openai/gpt-5.4-mini",
      max_output_tokens: 1_500,
    }));
    const call = parse.mock.calls[0]?.[0] as { instructions: string };
    expect(call.instructions).toContain("Hitta aldrig på marknadsdata");
    expect(call.instructions).toContain("CAC");
  });

  it("requires AI Gateway even when a legacy direct provider key exists", async () => {
    delete process.env.AI_GATEWAY_API_KEY;
    delete process.env.VERCEL_OIDC_TOKEN;
    process.env.OPENAI_API_KEY = "legacy-direct-key";

    await expect(generateSagaBrandOnboardingAdvice({ draft: draft() })).rejects.toMatchObject({
      name: "SagaBrandOnboardingAdviceError",
      status: 503,
      code: "ai_gateway_not_configured",
    } satisfies Partial<SagaBrandOnboardingAdviceError>);
  });

  it("allows only deployment-configured OpenAI Gateway models", () => {
    process.env.SAGA_BRAND_ADVISOR_GATEWAY_MODEL = "openai/gpt-5.6-business";
    expect(resolveSagaBrandAdvisorGatewayModel()).toBe("openai/gpt-5.6-business");
    process.env.SAGA_BRAND_ADVISOR_GATEWAY_MODEL = "anthropic/not-allowed-here";
    expect(() => resolveSagaBrandAdvisorGatewayModel()).toThrow("SAGA_BRAND_ADVISOR_GATEWAY_MODEL");
  });
});
