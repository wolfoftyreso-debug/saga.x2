import { beforeEach, describe, expect, it, vi } from "vitest";
import { sagaEditorialLensPromptContextSchema } from "@/lib/domain/saga-editorial-lens";
import { resolveSagaSeriesReferenceContext } from "@/lib/services/saga-series-reference";

const mocks = vi.hoisted(() => ({
  getClient: vi.fn(),
  getModel: vi.fn(),
  parse: vi.fn(),
}));

vi.mock("@/lib/openai/client", () => {
  class MissingOpenAIConfigurationError extends Error {}
  return {
    getOpenAIClient: mocks.getClient,
    getOpenAIModel: mocks.getModel,
    MissingOpenAIConfigurationError,
  };
});

import {
  generateContentDraft,
  SAGA_CONTENT_GENERATION_TIMEOUT_MS,
} from "@/lib/services/content-generation";

const generatedDraft = {
  title: "Ett system som frigör tid",
  headline: "Låt systemen bära det repetitiva",
  subject: "Ett system som frigör tid",
  previewText: "Ett privat utkast för granskning.",
  body: "När vi låter systemen hantera det upprepade får människor mer utrymme att tänka, bygga och vara närvarande.",
  excerpt: "Ett system kan ge mer tid till det mänskliga.",
  callToAction: "Välj en återkommande uppgift att förenkla den här veckan.",
  hashtags: ["#system"],
  imagePrompt: "Dokumentär arbetsmiljö med mänsklig närvaro, utan text eller logotyp.",
  altText: "En person som skissar ett enkelt system vid ett bord.",
};

describe("Studio generation deadline", () => {
  beforeEach(() => {
    mocks.getClient.mockReset();
    mocks.getModel.mockReset();
    mocks.parse.mockReset();
    mocks.getClient.mockReturnValue({ responses: { parse: mocks.parse } });
    mocks.getModel.mockReturnValue("openai/gpt-5.4-mini");
    mocks.parse.mockResolvedValue({
      id: "response-test",
      model: "openai/gpt-5.4-mini",
      status: "completed",
      output_parsed: { draft: generatedDraft },
      usage: { input_tokens: 10, output_tokens: 20 },
    });
  });

  it("bounds one model request and leaves retry ownership with the durable Cron receipt", async () => {
    await expect(generateContentDraft({
      contentType: "social_post",
      channels: ["linkedin"],
      topic: "Hur system kan frigöra tid för människor",
    })).resolves.toMatchObject({ responseId: "response-test", draft: { title: generatedDraft.title } });

    expect(mocks.parse).toHaveBeenCalledWith(
      expect.objectContaining({ model: "openai/gpt-5.4-mini", store: false }),
      { timeout: SAGA_CONTENT_GENERATION_TIMEOUT_MS, maxRetries: 0 },
    );
    expect(SAGA_CONTENT_GENERATION_TIMEOUT_MS).toBeLessThan(45_000);
  });

  it("passes only the safe active Lens and frozen Series context into the model request", async () => {
    const sourceDraftId = "11111111-1111-4111-8111-111111111111";
    const editorialLens = sagaEditorialLensPromptContextSchema.parse({
      mission: "Gör teknik begriplig för fler människor.",
      strategicPerspective: "Bygg system som frigör tid.",
      industry: "Teknik",
      audience: "Nyfikna byggare",
      themes: ["System"],
      forbiddenThemes: ["Partipolitik"],
      tone: {},
      construction: {},
      evidenceThreshold: "one_primary_or_two_independent",
      sourceRules: {},
      controlMode: "review_required",
    });
    const seriesReference = resolveSagaSeriesReferenceContext({
      reference: {
        sourceDraftId,
        sourceDraftRevision: 2,
        title: "System som ger tillbaka tid",
        body: "En fryst referenstext som endast ska ge kontinuitet.",
        channels: ["linkedin"],
        media: [],
        capturedAt: "2026-08-24T08:00:00.000Z",
      },
      controls: {
        objective: "educate",
        audience: "Nyfikna byggare",
        tone: "insightful",
        requiredElements: [],
        forbiddenElements: [],
        defaultChannels: ["linkedin"],
        reviewRequired: true,
      },
    });

    await generateContentDraft({
      contentType: "social_post",
      channels: ["linkedin"],
      topic: "Hur system frigör tid för människor",
    }, {
      editorialLens,
      seriesReference,
      automation: {
        name: "Veckans systeminsikt",
        template: {
          name: "Reflekterande LinkedIn",
          description: "En lugn och tydlig branschreflektion.",
          contentType: "social_post",
          channels: ["linkedin"],
        },
      },
    });

    const [request] = mocks.parse.mock.calls[0] ?? [];
    const prompt = JSON.parse(request.input as string) as Record<string, unknown>;
    expect(prompt).toMatchObject({
      automation: { name: "Veckans systeminsikt" },
      editorialLens: { mission: "Gör teknik begriplig för fler människor." },
      seriesReference: {
        audience: "Nyfikna byggare",
        source: { title: "System som ger tillbaka tid" },
      },
    });
    expect(JSON.stringify(prompt)).not.toContain(sourceDraftId);
    expect(request.instructions).toContain("aktiv SAGA Editorial Lens");
    expect(request.instructions).toContain("Series Reference är aktiv");
  });
});
