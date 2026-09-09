import OpenAI from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AI_GATEWAY_LAB_DEFAULT_PROVIDERS,
  aiGatewayLabRequestSchema,
} from "@/lib/domain/ai-gateway-content-lab";
import {
  AiGatewayContentLabError,
  generateAiGatewayContentLab,
} from "@/lib/services/ai-gateway-content-lab";
import { resolveSagaSeriesReferenceContext } from "@/lib/services/saga-series-reference";
import { resolveAiGatewayLabModel } from "@/lib/vercel/ai-gateway";
import { contentEngineModelPresetInputSchema } from "@/lib/domain/content-engine";

const originalGatewayKey = process.env.AI_GATEWAY_API_KEY;
const originalOidcToken = process.env.VERCEL_OIDC_TOKEN;
const originalOpenAiKey = process.env.OPENAI_API_KEY;
const originalOpenAiModel = process.env.AI_GATEWAY_LAB_OPENAI_MODEL;
const originalXaiModel = process.env.AI_GATEWAY_LAB_XAI_MODEL;

const draft = {
  title: "En bättre bokning",
  headline: "Gör det enklare att boka nästa service",
  subject: "Gör det enklare att boka nästa service",
  previewText: "Ett kort, tydligt testutkast.",
  body: "Det här är ett konkret testutkast. Kunden ser nästa steg direkt och slipper fundera på hur bokningen fungerar.",
  excerpt: "Ett konkret testutkast för bokning.",
  callToAction: "Boka en tid när det passar dig.",
  hashtags: ["#bilservice"],
  imagePrompt: "En väl upplyst bilverkstad med en mekaniker och en kund, utan text i bilden.",
  altText: "En kund pratar med en mekaniker i en bilverkstad.",
};

function input() {
  return aiGatewayLabRequestSchema.parse({
    topic: "Gör det enklare för kunder att boka bilservice",
    recipe: { templateId: null, label: "Bilverkstad – service" },
    persona: { label: "Rak verkstadston", instructions: "Skriv som en erfaren lokal verkstad: tryggt, sakligt och vänligt." },
    models: ["openai", "anthropic"],
  });
}

function fakeClient() {
  return {
    responses: {
      parse: vi.fn(async ({ model }: { model: string }) => ({
        id: `resp-${model.replace(/[^a-z]+/g, "-")}`,
        model,
        status: "completed",
        output_parsed: { variationLabel: "Bokning utan krångel", draft },
        usage: { input_tokens: 123, output_tokens: 456 },
      })),
    },
  } as unknown as OpenAI;
}

afterEach(() => {
  if (originalGatewayKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
  else process.env.AI_GATEWAY_API_KEY = originalGatewayKey;
  if (originalOidcToken === undefined) delete process.env.VERCEL_OIDC_TOKEN;
  else process.env.VERCEL_OIDC_TOKEN = originalOidcToken;
  if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalOpenAiKey;
  if (originalOpenAiModel === undefined) delete process.env.AI_GATEWAY_LAB_OPENAI_MODEL;
  else process.env.AI_GATEWAY_LAB_OPENAI_MODEL = originalOpenAiModel;
  if (originalXaiModel === undefined) delete process.env.AI_GATEWAY_LAB_XAI_MODEL;
  else process.env.AI_GATEWAY_LAB_XAI_MODEL = originalXaiModel;
});

describe("Vercel AI Gateway content lab", () => {
  it("defaults to three logical model presets and requires a genuine comparison", () => {
    const defaulted = aiGatewayLabRequestSchema.parse({ topic: "Nyhetsbrev om vårservice" });
    expect(defaulted.models).toEqual(AI_GATEWAY_LAB_DEFAULT_PROVIDERS);
    expect(defaulted.seriesId).toBeNull();
    expect(aiGatewayLabRequestSchema.safeParse({ topic: "Nyhetsbrev om vårservice", models: ["openai"] }).success).toBe(false);
    expect(aiGatewayLabRequestSchema.safeParse({ topic: "Nyhetsbrev om vårservice", models: ["openai", "openai"] }).success).toBe(false);
    expect(aiGatewayLabRequestSchema.safeParse({ topic: "Nyhetsbrev om vårservice", seriesId: "inte-en-uuid" }).success).toBe(false);
    expect(aiGatewayLabRequestSchema.safeParse({
      topic: "Nyhetsbrev om vårservice",
      seriesId: "11111111-1111-4111-8111-111111111111",
      // A browser can select an opaque ID, but cannot smuggle a reference
      // snapshot or controls into the protected generation boundary.
      seriesReference: { reference: { body: "otillåten klientdata" } },
    }).success).toBe(false);
  });

  it("returns labeled transient comparisons with model metadata but no publication capability", async () => {
    const client = fakeClient();
    const result = await generateAiGatewayContentLab({
      input: input(),
      template: null,
      client,
      resolveModel: (provider) => `${provider}/current-safe-model`,
    });

    expect(result).toMatchObject({ saved: false, publishable: false });
    expect(result.variations).toHaveLength(2);
    expect(result.variations[0]).toMatchObject({
      label: "OpenAI · Bokning utan krångel",
      provider: "openai",
      model: "openai/current-safe-model",
      metadata: {
        requestedModel: "openai/current-safe-model",
        inputTokens: 123,
        outputTokens: 456,
        configuration: {
          gateway: "vercel-ai-gateway",
          api: "responses",
          stored: false,
          outputSchema: "content_engine_lab_draft/v1",
        },
      },
    });

    const parse = client.responses.parse as unknown as ReturnType<typeof vi.fn>;
    expect(parse).toHaveBeenCalledTimes(2);
    expect(parse).toHaveBeenCalledWith(expect.objectContaining({
      store: false,
      max_output_tokens: 2_600,
      model: "openai/current-safe-model",
    }));
    const firstCall = parse.mock.calls[0]?.[0] as { instructions: string; input: string };
    expect(firstCall.instructions).toContain("publicera/skicka något");
    expect(firstCall.instructions).toContain("konstruktiv, kunnig och framåtblickande");
    expect(firstCall.instructions).toContain("verifierbara fakta, er tolkning och förslag");
    expect(firstCall.instructions).toContain("Prioritera natur, väder, material och platskänsla");
    expect(firstCall.instructions).toContain("lätt analogt korn");
    expect(firstCall.input).toContain("utan resonemang eller processbeskrivning");
  });

  it("requires Vercel AI Gateway even if a legacy direct OpenAI key exists", async () => {
    delete process.env.AI_GATEWAY_API_KEY;
    delete process.env.VERCEL_OIDC_TOKEN;
    process.env.OPENAI_API_KEY = "legacy-direct-provider-key";

    await expect(generateAiGatewayContentLab({ input: input(), template: null })).rejects.toMatchObject({
      name: "AiGatewayContentLabError",
      status: 503,
      code: "ai_gateway_not_configured",
    } satisfies Partial<AiGatewayContentLabError>);
  });

  it("allows deployment configuration to replace an exact model without accepting it from a caller", () => {
    process.env.AI_GATEWAY_LAB_OPENAI_MODEL = "openai/gpt-5.6-business";
    expect(resolveAiGatewayLabModel("openai")).toBe("openai/gpt-5.6-business");

    process.env.AI_GATEWAY_LAB_OPENAI_MODEL = "anthropic/not-the-openai-preset";
    expect(() => resolveAiGatewayLabModel("openai")).toThrow("AI_GATEWAY_LAB_OPENAI_MODEL");
  });

  it("resolves logical xai to the current Grok Gateway namespace, including a legacy deployment setting", () => {
    delete process.env.AI_GATEWAY_LAB_XAI_MODEL;
    expect(resolveAiGatewayLabModel("xai")).toBe("spacexai/grok-4.1-fast-non-reasoning");
    process.env.AI_GATEWAY_LAB_XAI_MODEL = "spacexai/grok-4.1-fast-non-reasoning";
    expect(resolveAiGatewayLabModel("xai")).toBe("spacexai/grok-4.1-fast-non-reasoning");
    process.env.AI_GATEWAY_LAB_XAI_MODEL = "xai/grok-4.1-fast-non-reasoning";
    expect(resolveAiGatewayLabModel("xai")).toBe("spacexai/grok-4.1-fast-non-reasoning");
    process.env.AI_GATEWAY_LAB_XAI_MODEL = "openai/gpt-5.4";
    expect(() => resolveAiGatewayLabModel("xai")).toThrow("spacexai/");
    process.env.AI_GATEWAY_LAB_OPENAI_MODEL = "spacexai/grok-4.1-fast-non-reasoning";
    expect(() => resolveAiGatewayLabModel("openai")).toThrow("AI_GATEWAY_LAB_OPENAI_MODEL");
  });

  it.each(["spacexai/grok-4.1-fast-non-reasoning", "xai/grok-4.1-fast-non-reasoning"])("accepts a saved Grok model profile and routes its policy correctly: %s", async (modelId) => {
    const preset = contentEngineModelPresetInputSchema.parse({
      slug: "grok-writing", name: "Grok skrivande", provider: "xai", modelId, taskKinds: ["writing"],
    });
    expect(preset.provider).toBe("xai");
    expect(preset.modelId).toBe(modelId);
    const modelPolicy = {
      id: "55555555-5555-4555-8555-555555555555", name: "Grok och Claude", taskKind: "writing", selectionMode: "quality_first", active: true,
      models: [
        { provider: preset.provider, modelId: preset.modelId, presetName: preset.name, priority: 1 },
        { provider: "anthropic", modelId: "anthropic/claude-sonnet-4.6", presetName: "Claude", priority: 2 },
      ],
    };
    const client = fakeClient();
    const result = await generateAiGatewayContentLab({ input: input(), template: null, client, modelPolicy });
    expect(client.responses.parse).toHaveBeenCalledWith(expect.objectContaining({ model: "spacexai/grok-4.1-fast-non-reasoning", store: false }));
    expect(result.variations[0]).toMatchObject({ provider: "xai", model: "spacexai/grok-4.1-fast-non-reasoning", metadata: { provider: "xai", requestedModel: "spacexai/grok-4.1-fast-non-reasoning" } });
    expect(result.modelPolicy?.models[0]).toEqual({ provider: "xai", preset: "Grok skrivande", model: "spacexai/grok-4.1-fast-non-reasoning" });
    // Runtime normalization must not mutate the stored model or provider.
    expect(modelPolicy.models[0]).toMatchObject({ provider: "xai", modelId });
  });

  it.each([
    ["xai", "openai/gpt-5.4"],
    ["openai", "spacexai/grok-4.1-fast-non-reasoning"],
    ["other", "spacexai/grok-4.1-fast-non-reasoning"],
    ["spacexai", "spacexai/grok-4.1-fast-non-reasoning"],
  ])("rejects cross-provider or unknown logical-provider profiles and policies: %s / %s", async (provider, modelId) => {
    expect(contentEngineModelPresetInputSchema.safeParse({ slug: "invalid-profile", name: "Fel profil", provider, modelId, taskKinds: ["writing"] }).success).toBe(false);
    const client = fakeClient();
    await expect(generateAiGatewayContentLab({
      input: input(), template: null, client,
      modelPolicy: {
        id: "55555555-5555-4555-8555-555555555555", name: "Fel policy", taskKind: "writing", selectionMode: "quality_first", active: true,
        models: [
          { provider, modelId, presetName: "Fel", priority: 1 },
          { provider: "anthropic", modelId: "anthropic/claude-sonnet-4.6", presetName: "Claude", priority: 2 },
        ],
      },
    })).rejects.toMatchObject({ code: "ai_gateway_model_policy_invalid", status: 422 });
    expect(client.responses.parse).not.toHaveBeenCalled();
  });

  it("uses an actor-owned saved model policy instead of browser-selected model ids", async () => {
    const client = fakeClient();
    const result = await generateAiGatewayContentLab({
      input: input(),
      template: null,
      client,
      // The caller's `models` above deliberately says OpenAI + Claude. The
      // saved policy is the only source of the exact Gateway model IDs.
      modelPolicy: {
        id: "55555555-5555-4555-8555-555555555555",
        name: "Redaktionell kvalitet",
        taskKind: "writing",
        selectionMode: "quality_first",
        active: true,
        models: [
          { provider: "google", modelId: "google/gemini-editorial", presetName: "Gemini redaktion", priority: 2 },
          { provider: "anthropic", modelId: "anthropic/claude-editorial", presetName: "Claude redaktion", priority: 1 },
        ],
      },
    });

    const parse = client.responses.parse as unknown as ReturnType<typeof vi.fn>;
    expect(parse.mock.calls.map(([call]) => (call as { model: string }).model)).toEqual([
      "anthropic/claude-editorial",
      "google/gemini-editorial",
    ]);
    expect(result.modelPolicy).toEqual({
      id: "55555555-5555-4555-8555-555555555555",
      name: "Redaktionell kvalitet",
      selectionMode: "quality_first",
      models: [
        { provider: "anthropic", preset: "Claude redaktion", model: "anthropic/claude-editorial" },
        { provider: "google", preset: "Gemini redaktion", model: "google/gemini-editorial" },
      ],
    });
  });

  it("refuses a saved policy that cannot produce a genuine comparison", async () => {
    await expect(generateAiGatewayContentLab({
      input: input(),
      template: null,
      client: fakeClient(),
      modelPolicy: {
        id: "55555555-5555-4555-8555-555555555555",
        name: "Ensam modell",
        taskKind: "writing",
        selectionMode: "manual",
        active: true,
        models: [{ provider: "openai", modelId: "openai/gpt-editorial", presetName: "GPT", priority: 1 }],
      },
    })).rejects.toMatchObject({
      status: 422,
      code: "ai_gateway_model_policy_invalid",
    } satisfies Partial<AiGatewayContentLabError>);
  });

  it("uses the actual workspace Content Engine recipe instructions and content type without making it durable", async () => {
    const client = fakeClient();
    const recipe = {
      id: "33333333-3333-4333-8333-333333333333",
      createdByUserId: "11111111-1111-4111-8111-111111111111",
      slug: "veckans-verkstadstips",
      name: "Veckans verkstadstips",
      description: "Ett konkret veckobrev.",
      contentType: "newsletter" as const,
      brandProfileId: null,
      modelPolicyId: null,
      instructions: "Skriv rakt, utan branschfloskler, och avsluta med ett tydligt nästa steg.",
      renderingConfig: { imageStyle: "ljust" },
      sourceIds: [],
      active: true,
      createdAt: "2026-08-24T08:00:00.000Z",
      updatedAt: "2026-08-24T08:00:00.000Z",
    };
    const serverResolvedSources = [{
      sourceId: "55555555-5555-4555-8555-555555555555",
      name: "Verkstadens FAQ",
      sourceKind: "website",
      sourceUrl: "https://example.test/faq",
      description: "Bokningsregler.",
      referenceText: "Boka i god tid.",
      trustLevel: 4,
    }];

    const result = await generateAiGatewayContentLab({
      input: input(),
      template: recipe,
      sources: serverResolvedSources,
      client,
      resolveModel: (provider) => `${provider}/current-safe-model`,
      editorialLens: {
        mission: "Gör bilservice begriplig.",
        strategicPerspective: "Bygg förtroende före räckvidd.",
        industry: "Bilservice",
        audience: "Bilägare i Borås.",
        themes: ["trygg service"],
        forbiddenThemes: ["skrämsel"],
        tone: { directness: 4, warmth: 3, formality: 2, technicalDepth: 3, pointOfView: "you", avoidJargon: true, preferredWords: ["trygg"], avoidedWords: ["billigast"] },
        construction: { openingStyle: "direct", paragraphStyle: "short", callToAction: "soft", useHeadings: true, maxParagraphs: 5, maxSentencesPerParagraph: 3, includeSourceNotes: true },
        evidenceThreshold: "one_primary_or_two_independent",
        sourceRules: { requireAllowedSources: true, requireCitations: true, minimumUniqueSources: 2, allowedSourceKinds: ["website", "rss"], blockedDomains: [], allowUnsupportedInference: false },
        controlMode: "review_required",
      },
    });

    expect(result).toMatchObject({ saved: false, publishable: false });
    const parse = client.responses.parse as unknown as ReturnType<typeof vi.fn>;
    const modelInput = JSON.parse((parse.mock.calls[0]?.[0] as { input: string }).input) as { recipe: Record<string, unknown>; sources: Array<Record<string, unknown>>; editorialLens: Record<string, unknown> };
    expect(modelInput.recipe).toMatchObject({
      origin: "content_engine_recipe",
      contentType: "newsletter",
      instructions: recipe.instructions,
      renderingConfig: recipe.renderingConfig,
    });
    expect(modelInput.recipe).not.toHaveProperty("generationPrompt");
    expect(modelInput.sources).toEqual([expect.objectContaining({ name: "Verkstadens FAQ", referenceText: "Boka i god tid.", trustLevel: 4 })]);
    expect(modelInput.sources[0]).not.toHaveProperty("sourceId");
    expect(modelInput.editorialLens).toMatchObject({
      mission: "Gör bilservice begriplig.",
      themes: ["trygg service"],
      evidenceThreshold: "one_primary_or_two_independent",
      controlMode: "review_required",
    });
  });

  it("accepts only a pre-resolved Series Reference context and returns a deterministic continuity assessment", async () => {
    const client = fakeClient();
    const sourceDraftId = "77777777-7777-4777-8777-777777777777";
    const seriesReference = resolveSagaSeriesReferenceContext({
      reference: {
        sourceDraftId,
        sourceDraftRevision: 4,
        title: "Boka trygg service",
        body: "En kund och en mekaniker går igenom nästa steg i en lugn verkstad.",
        channels: ["linkedin"],
        media: [{
          kind: "generated",
          contentType: "image/jpeg",
          width: 1600,
          height: 1000,
          altText: "En kund och en mekaniker i en ljus bilverkstad.",
          status: "ready",
        }],
        capturedAt: "2026-08-25T09:00:00.000Z",
      },
      controls: {
        objective: "convert",
        audience: "Bilägare i Sätra",
        tone: "warm",
        requiredElements: [],
        forbiddenElements: ["billigast"],
        defaultChannels: ["linkedin"],
        reviewRequired: true,
      },
    });

    const result = await generateAiGatewayContentLab({
      input: input(),
      template: null,
      client,
      resolveModel: (provider) => `${provider}/current-safe-model`,
      seriesReference,
      intendedChannels: ["linkedin"],
    });

    expect(result.variations[0]?.seriesReferenceAlignment).toMatchObject({
      version: "saga-series-reference-alignment/v1",
      decision: "aligned",
      requiresReview: true,
    });
    const parse = client.responses.parse as unknown as ReturnType<typeof vi.fn>;
    const modelInput = JSON.parse((parse.mock.calls[0]?.[0] as { input: string }).input) as { seriesReference: Record<string, unknown>; intendedChannels: string[] };
    expect(modelInput.intendedChannels).toEqual(["linkedin"]);
    expect(modelInput.seriesReference).toMatchObject({
      objective: "convert",
      tone: "warm",
      source: { title: "Boka trygg service", media: [expect.objectContaining({ kind: "generated", altText: expect.any(String) })] },
    });
    const modelMaterial = JSON.stringify(modelInput.seriesReference);
    expect(modelMaterial).not.toContain(sourceDraftId);
    expect(modelMaterial).not.toContain("sourceDraftRevision");
    expect(modelMaterial).not.toContain("capturedAt");
    expect(modelMaterial).not.toContain("blobUrl");
    expect((parse.mock.calls[0]?.[0] as { instructions: string }).instructions).toContain("Series Reference");
  });
});
