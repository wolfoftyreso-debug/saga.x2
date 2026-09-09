import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  requireNeonActor: vi.fn(),
  getContentEngineRecipe: vi.fn(),
  getContentEngineRecipeLabModelPlan: vi.fn(),
  getContentEngineRecipeLabSources: vi.fn(),
  getSagaEditorialLensLabContext: vi.fn(),
  getSagaSeriesReferenceGuidanceContext: vi.fn(),
  getStudioTemplate: vi.fn(),
  generateAiGatewayContentLab: vi.fn(),
  brandEligibility: vi.fn(),
}));

vi.mock("@/lib/neon/http", () => ({ requireNeonActor: mocks.requireNeonActor }));
vi.mock("@/lib/neon/saga-brand-onboarding-repository", () => ({
  listSagaBrandOnboardingOverviews: async () => (await mocks.brandEligibility()).brands.map((brand: { brandProfileId: string; brandName: string }) => ({ ...brand, completionState: "completed", brandActive: true })),
}));
vi.mock("@/lib/neon/content-engine-repository", () => ({
  getContentEngineRecipe: mocks.getContentEngineRecipe,
  getContentEngineRecipeLabModelPlan: mocks.getContentEngineRecipeLabModelPlan,
  getContentEngineRecipeLabSources: mocks.getContentEngineRecipeLabSources,
}));
vi.mock("@/lib/neon/saga-editorial-lens-repository", () => ({
  getSagaEditorialLensLabContext: mocks.getSagaEditorialLensLabContext,
}));
vi.mock("@/lib/neon/saga-series-reference-repository", () => ({
  getSagaSeriesReferenceGuidanceContext: mocks.getSagaSeriesReferenceGuidanceContext,
}));
vi.mock("@/lib/neon/studio-content-repository", () => ({ getStudioTemplate: mocks.getStudioTemplate }));
vi.mock("@/lib/services/ai-gateway-content-lab", async () => {
  const actual = await vi.importActual<typeof import("@/lib/services/ai-gateway-content-lab")>("@/lib/services/ai-gateway-content-lab");
  return { ...actual, generateAiGatewayContentLab: mocks.generateAiGatewayContentLab };
});

import { POST } from "@/app/api/content/ai-lab/generate/route";
import { AiGatewayContentLabError } from "@/lib/services/ai-gateway-content-lab";

const actor = {
  userId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  role: "owner" as const,
  email: "owner@example.test",
  displayName: "Owner",
};
const templateId = "33333333-3333-4333-8333-333333333333";
const seriesId = "44444444-4444-4444-8444-444444444444";

function request(body: unknown) {
  return new NextRequest("http://localhost/api/content/ai-lab/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function payload() {
  return {
    topic: "Nyhetsbrev om vårservice",
    recipe: { templateId, label: "Vårservice" },
    persona: { label: "Rak ton", instructions: "Kort, varmt och konkret." },
    models: ["openai", "google"],
  };
}

afterEach(() => {
  mocks.requireNeonActor.mockReset();
  mocks.getContentEngineRecipe.mockReset();
  mocks.getContentEngineRecipeLabModelPlan.mockReset();
  mocks.getContentEngineRecipeLabSources.mockReset();
  mocks.getSagaEditorialLensLabContext.mockReset();
  mocks.getSagaSeriesReferenceGuidanceContext.mockReset();
  mocks.getStudioTemplate.mockReset();
  mocks.generateAiGatewayContentLab.mockReset();
  mocks.brandEligibility.mockReset();
  mocks.brandEligibility.mockResolvedValue({ status: "single", brands: [{ brandProfileId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", brandName: "SAGA" }] });
});

describe("AI Gateway testlabbets route", () => {
  it("does not accept a caller without the signed Vercel actor", async () => {
    mocks.requireNeonActor.mockResolvedValue({
      response: NextResponse.json({ error: "Logga in för att testa AI-motorn." }, { status: 401 }),
    });

    const response = await POST(request(payload()));

    expect(response.status).toBe(401);
    expect(mocks.getContentEngineRecipe).not.toHaveBeenCalled();
    expect(mocks.getContentEngineRecipeLabSources).not.toHaveBeenCalled();
    expect(mocks.getStudioTemplate).not.toHaveBeenCalled();
    expect(mocks.generateAiGatewayContentLab).not.toHaveBeenCalled();
  });

  it("requires a brand selection before loading any workspace-shared AI context", async () => {
    mocks.requireNeonActor.mockResolvedValue({ actor });
    mocks.brandEligibility.mockResolvedValue({
      status: "multiple",
      brands: [
        { brandProfileId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", brandName: "Första" },
        { brandProfileId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", brandName: "Andra" },
      ],
    });

    const response = await POST(request(payload()));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Välj vilket varumärke innehållet tillhör.",
      code: "brand_selection_required",
    });
    expect(mocks.getStudioTemplate).not.toHaveBeenCalled();
    expect(mocks.getContentEngineRecipe).not.toHaveBeenCalled();
    expect(mocks.getSagaEditorialLensLabContext).not.toHaveBeenCalled();
    expect(mocks.generateAiGatewayContentLab).not.toHaveBeenCalled();
  });

  it("resolves a saved recipe only in the signed actor workspace and returns transient results", async () => {
    const template = { id: templateId, name: "Vårservice", contentType: "newsletter", channels: ["newsletter"] };
    const prompt = {
      mission: "Gör bilservice begriplig.", strategicPerspective: "Förtroende före räckvidd.", industry: "Bilservice", audience: "Bilägare",
      themes: ["trygg service"], forbiddenThemes: [], tone: {}, construction: {}, evidenceThreshold: "one_primary_or_two_independent",
      sourceRules: {}, controlMode: "review_required",
    };
    mocks.requireNeonActor.mockResolvedValue({ actor });
    mocks.getStudioTemplate.mockResolvedValue(template);
    mocks.getSagaEditorialLensLabContext.mockResolvedValue({ prompt, sourceSelectionIds: [] });
    mocks.generateAiGatewayContentLab.mockResolvedValue({
      variations: [{ id: "openai-r1", label: "OpenAI · Rak", provider: "openai" }],
      saved: false,
      publishable: false,
    });

    const response = await POST(request(payload()));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ saved: false, publishable: false });
    expect(mocks.getStudioTemplate).toHaveBeenCalledWith(expect.objectContaining(actor), templateId);
    expect(mocks.getSagaSeriesReferenceGuidanceContext).not.toHaveBeenCalled();
    expect(mocks.generateAiGatewayContentLab).toHaveBeenCalledWith(expect.objectContaining({
      template,
      input: expect.objectContaining({ topic: "Nyhetsbrev om vårservice", models: ["openai", "google"] }),
      editorialLens: prompt,
    }));
  });

  it("resolves a selected Series Reference only through the signed actor and passes its safe context to the lab", async () => {
    const template = { id: templateId, name: "Vårservice", contentType: "newsletter", channels: ["newsletter"] };
    const seriesReference = {
      reference: {
        sourceDraftId: "55555555-5555-4555-8555-555555555555",
        sourceDraftRevision: 4,
        title: "Trygg vårservice",
        body: "Vi förklarar service steg för steg.",
        channels: ["linkedin"],
        media: [],
        capturedAt: "2026-08-25T09:00:00.000Z",
      },
      controls: {
        objective: "educate",
        audience: "Bilägare i Sätra",
        tone: "insightful",
        requiredElements: ["trygg service"],
        forbiddenElements: ["billigast"],
        defaultChannels: ["linkedin"],
        reviewRequired: true,
      },
    };
    mocks.requireNeonActor.mockResolvedValue({ actor });
    mocks.getSagaSeriesReferenceGuidanceContext.mockResolvedValue(seriesReference);
    mocks.getStudioTemplate.mockResolvedValue(template);
    mocks.generateAiGatewayContentLab.mockResolvedValue({ variations: [], saved: false, publishable: false });

    const response = await POST(request({ ...payload(), seriesId }));

    expect(response.status).toBe(200);
    expect(mocks.getSagaSeriesReferenceGuidanceContext).toHaveBeenCalledWith(expect.objectContaining(actor), seriesId);
    expect(mocks.generateAiGatewayContentLab).toHaveBeenCalledWith(expect.objectContaining({
      seriesReference,
      // This comes from the actor-scoped Studio template, not from the browser.
      intendedChannels: ["newsletter"],
    }));
  });

  it("returns 404 without reaching the model when the selected Series Reference is inactive, missing, or outside the actor workspace", async () => {
    mocks.requireNeonActor.mockResolvedValue({ actor });
    mocks.getSagaSeriesReferenceGuidanceContext.mockResolvedValue(null);

    const response = await POST(request({ ...payload(), seriesId }));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "series_reference_not_found" });
    expect(mocks.getSagaSeriesReferenceGuidanceContext).toHaveBeenCalledWith(expect.objectContaining(actor), seriesId);
    expect(mocks.getStudioTemplate).not.toHaveBeenCalled();
    expect(mocks.generateAiGatewayContentLab).not.toHaveBeenCalled();
  });

  it("makes a missing Vercel AI Gateway explicit and never falls back to another provider key", async () => {
    mocks.requireNeonActor.mockResolvedValue({ actor });
    mocks.getStudioTemplate.mockResolvedValue(null);
    mocks.generateAiGatewayContentLab.mockRejectedValue(new AiGatewayContentLabError(
      "AI-testet är inte konfigurerat.",
      503,
      "ai_gateway_not_configured",
    ));

    const response = await POST(request({ ...payload(), recipe: { templateId: null, label: "" } }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "ai_gateway_not_configured",
      missing: ["AI_GATEWAY_API_KEY eller VERCEL_OIDC_TOKEN"],
    });
  });

  it("resolves an active Content Engine recipe in the actor workspace when the new UI sends its recipe id through the legacy template field", async () => {
    const recipe = {
      id: templateId,
      name: "Veckans verkstadstips",
      description: "Ett tydligt veckobrev.",
      contentType: "newsletter",
      instructions: "Skriv rakt och konkret.",
      renderingConfig: { imageStyle: "ljust" },
      sourceIds: [],
      active: true,
    };
    mocks.requireNeonActor.mockResolvedValue({ actor });
    mocks.getStudioTemplate.mockResolvedValue(null);
    mocks.getContentEngineRecipe.mockResolvedValue(recipe);
    const sources = [{ sourceId: "55555555-5555-4555-8555-555555555555", name: "Verkstadens FAQ", sourceKind: "website", sourceUrl: "https://example.test/faq", description: "Bokningsregler", referenceText: "Boka i god tid.", trustLevel: 4 }];
    mocks.getContentEngineRecipeLabSources.mockResolvedValue(sources);
    mocks.generateAiGatewayContentLab.mockResolvedValue({ variations: [], saved: false, publishable: false });

    const response = await POST(request({ ...payload(), recipe: { templateId, label: "Veckans verkstadstips" } }));

    expect(response.status).toBe(200);
    expect(mocks.getStudioTemplate).toHaveBeenCalledWith(expect.objectContaining(actor), templateId);
    expect(mocks.getContentEngineRecipe).toHaveBeenCalledWith(expect.objectContaining(actor), templateId);
    expect(mocks.getContentEngineRecipeLabSources).toHaveBeenCalledWith(expect.objectContaining(actor), templateId, []);
    expect(mocks.generateAiGatewayContentLab).toHaveBeenCalledWith(expect.objectContaining({ template: recipe, sources }));
  });

  it("resolves a recipe-bound model policy on the server and never trusts a browser model id", async () => {
    const recipe = {
      id: templateId,
      name: "Veckans verkstadstips",
      description: "Ett tydligt veckobrev.",
      contentType: "newsletter",
      instructions: "Skriv rakt och konkret.",
      renderingConfig: {},
      sourceIds: [],
      active: true,
      modelPolicyId: "44444444-4444-4444-8444-444444444444",
    };
    const plan = {
      policyId: "44444444-4444-4444-8444-444444444444",
      policyName: "Redaktionell kvalitet",
      taskKind: "writing",
      selectionMode: "quality_first",
      active: true,
      models: [
        { presetId: "55555555-5555-4555-8555-555555555555", presetName: "Claude", provider: "anthropic", modelId: "anthropic/claude-editorial", priority: 1 },
        { presetId: "66666666-6666-4666-8666-666666666666", presetName: "Gemini", provider: "google", modelId: "google/gemini-editorial", priority: 2 },
      ],
    };
    mocks.requireNeonActor.mockResolvedValue({ actor });
    mocks.getContentEngineRecipe.mockResolvedValue(recipe);
    mocks.getContentEngineRecipeLabSources.mockResolvedValue([]);
    mocks.getContentEngineRecipeLabModelPlan.mockResolvedValue(plan);
    mocks.generateAiGatewayContentLab.mockResolvedValue({ variations: [], saved: false, publishable: false });

    const response = await POST(request({ ...payload(), recipe: { engineRecipeId: templateId, templateId: null, label: recipe.name } }));

    expect(response.status).toBe(200);
    expect(mocks.getContentEngineRecipeLabModelPlan).toHaveBeenCalledWith(expect.objectContaining(actor), templateId);
    expect(mocks.generateAiGatewayContentLab).toHaveBeenCalledWith(expect.objectContaining({
      modelPolicy: expect.objectContaining({
        id: plan.policyId,
        models: [
          expect.objectContaining({ modelId: "anthropic/claude-editorial" }),
          expect.objectContaining({ modelId: "google/gemini-editorial" }),
        ],
      }),
    }));
  });

  it("passes only the active Lens-selected source IDs into an already recipe-scoped source lookup", async () => {
    const sourceId = "55555555-5555-4555-8555-555555555555";
    const recipe = {
      id: templateId,
      name: "Veckans verkstadstips",
      description: "Ett tydligt veckobrev.",
      contentType: "newsletter",
      instructions: "Skriv rakt och konkret.",
      renderingConfig: {},
      sourceIds: [sourceId],
      active: true,
    };
    const prompt = {
      mission: "Gör bilservice begriplig.", strategicPerspective: "Förtroende före räckvidd.", industry: "Bilservice", audience: "Bilägare",
      themes: [], forbiddenThemes: [], tone: {}, construction: {}, evidenceThreshold: "two_independent_sources",
      sourceRules: { allowedSourceKinds: ["website"], blockedDomains: ["blocked.example"] }, controlMode: "review_required",
    };
    const sources = [
      { sourceId, name: "Verkstadens FAQ", sourceKind: "website", sourceUrl: "https://example.test/faq", description: "Bokningsregler", referenceText: "Boka i god tid.", trustLevel: 4 },
      { sourceId: "66666666-6666-4666-8666-666666666666", name: "Blockerad domän", sourceKind: "website", sourceUrl: "https://blocked.example/nyhet", description: "Får inte nå modellen", referenceText: "Blockerat", trustLevel: 4 },
      { sourceId: "77777777-7777-4777-8777-777777777777", name: "Fel källtyp", sourceKind: "rss", sourceUrl: "https://example.test/feed", description: "Får inte nå modellen", referenceText: "Fel typ", trustLevel: 4 },
    ];
    mocks.requireNeonActor.mockResolvedValue({ actor });
    mocks.getContentEngineRecipe.mockResolvedValue(recipe);
    mocks.getSagaEditorialLensLabContext.mockResolvedValue({ prompt, sourceSelectionIds: [sourceId, "66666666-6666-4666-8666-666666666666", "77777777-7777-4777-8777-777777777777"] });
    mocks.getContentEngineRecipeLabSources.mockResolvedValue(sources);
    mocks.generateAiGatewayContentLab.mockResolvedValue({ variations: [], saved: false, publishable: false });

    const response = await POST(request({ ...payload(), recipe: { engineRecipeId: templateId, templateId: null, label: recipe.name } }));

    expect(response.status).toBe(200);
    expect(mocks.getContentEngineRecipeLabSources).toHaveBeenCalledWith(expect.objectContaining(actor), templateId, [sourceId, "66666666-6666-4666-8666-666666666666", "77777777-7777-4777-8777-777777777777"]);
    expect(mocks.generateAiGatewayContentLab).toHaveBeenCalledWith(expect.objectContaining({ sources: [sources[0]], editorialLens: prompt }));
  });

  it("refuses to widen an active Lens selection when none of its sources belong to the recipe", async () => {
    const recipe = {
      id: templateId,
      name: "Veckans verkstadstips",
      description: "Ett tydligt veckobrev.",
      contentType: "newsletter",
      instructions: "Skriv rakt och konkret.",
      renderingConfig: {},
      sourceIds: [],
      active: true,
    };
    mocks.requireNeonActor.mockResolvedValue({ actor });
    mocks.getContentEngineRecipe.mockResolvedValue(recipe);
    mocks.getSagaEditorialLensLabContext.mockResolvedValue({ prompt: { mission: "M", strategicPerspective: "P", industry: "", audience: "", themes: [], forbiddenThemes: [], tone: {}, construction: {}, evidenceThreshold: "two_independent_sources", sourceRules: {}, controlMode: "review_required" }, sourceSelectionIds: ["55555555-5555-4555-8555-555555555555"] });
    mocks.getContentEngineRecipeLabSources.mockResolvedValue([]);

    const response = await POST(request({ ...payload(), recipe: { engineRecipeId: templateId, templateId: null, label: recipe.name } }));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ code: "lens_source_scope_empty" });
    expect(mocks.generateAiGatewayContentLab).not.toHaveBeenCalled();
  });

  it("rejects caller-supplied workspace scope before any lookup or model invocation", async () => {
    mocks.requireNeonActor.mockResolvedValue({ actor });

    const response = await POST(request({ ...payload(), workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }));

    expect(response.status).toBe(400);
    expect(mocks.getStudioTemplate).not.toHaveBeenCalled();
    expect(mocks.getContentEngineRecipe).not.toHaveBeenCalled();
    expect(mocks.getContentEngineRecipeLabSources).not.toHaveBeenCalled();
    expect(mocks.generateAiGatewayContentLab).not.toHaveBeenCalled();
  });
});
