import { describe, expect, it, vi } from "vitest";
import type { ClaimedContentAutomationJob, ContentDraftView, ContentTemplateView } from "@/lib/domain/content-studio";
import { sagaEditorialLensPromptContextSchema } from "@/lib/domain/saga-editorial-lens";
import {
  ContentGenerationError,
  type GeneratedContentResult,
} from "@/lib/services/content-generation";
import {
  generationInputForClaim,
  runNeonStudioAutomationWorker,
  type StudioAutomationWorkerDependencies,
} from "@/lib/neon/studio-automation-worker";
import { resolveSagaSeriesReferenceContext } from "@/lib/services/saga-series-reference";

const now = new Date("2026-08-24T08:00:00.000Z");
const jobId = "11111111-1111-4111-8111-111111111111";
const claimToken = "22222222-2222-4222-8222-222222222222";
const workspaceId = "99999999-9999-4999-8999-999999999999";
const seriesId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const brandProfileId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function claim(overrides: Partial<ClaimedContentAutomationJob> = {}): ClaimedContentAutomationJob {
  return {
    id: jobId,
    userId: "33333333-3333-4333-8333-333333333333",
    automationRuleId: "44444444-4444-4444-8444-444444444444",
    contentDraftId: null,
    triggerKind: "scheduled",
    manualRunKey: null,
    state: "processing",
    scheduledFor: now.toISOString(),
    timezone: "Europe/Stockholm",
    scheduledLocalDate: "2026-08-24",
    scheduledLocalTime: "10:00",
    attemptCount: 1,
    lockedUntil: "2026-08-24T08:10:00.000Z",
    claimedAt: now.toISOString(),
    completedAt: null,
    lastError: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    claimToken,
    workspaceId,
    rule: {
      id: "44444444-4444-4444-8444-444444444444",
      brandProfileId,
      userId: "33333333-3333-4333-8333-333333333333",
      name: "Veckans AI-svep",
      active: true,
      contentType: "social_post",
      channels: ["linkedin"],
      templateId: null,
      newsletterAudienceId: null,
      generationPrompt: "Sammanfatta veckans viktigaste AI-nyheter för svenska företag.",
      imagePrompt: "Lugn redaktionell AI-illustration",
      desiredLength: 220,
      tone: "Rak och konkret",
      language: "sv",
      approvalRequired: true,
      timezone: "Europe/Stockholm",
      scheduleMode: "weekly_count",
      weeklyCount: 1,
      weekdays: [1],
      localTimes: ["10:00"],
      cronExpression: null,
      startsOn: null,
      endsOn: null,
      nextRunAt: now.toISOString(),
      lastRunAt: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    },
    template: null,
    ...overrides,
  };
}

function generated(): GeneratedContentResult {
  return {
    model: "openai/gpt-test",
    responseId: "response-test",
    inputTokens: 10,
    outputTokens: 20,
    draft: {
      title: "AI: det som spelar roll",
      headline: "Det här ändrar läget",
      subject: "Veckans AI-svep",
      previewText: "Det viktigaste på två minuter.",
      body: "Här är det viktigaste som hände och vad du kan göra nu.",
      excerpt: "Det viktigaste från veckan.",
      callToAction: "Välj en sak att testa den här veckan.",
      hashtags: ["#AI"],
      imagePrompt: "Ljus redaktionell illustration utan text.",
      altText: "Abstrakt illustration om AI.",
    },
  };
}

function template(): ContentTemplateView {
  return {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    userId: "33333333-3333-4333-8333-333333333333",
    isSystemTemplate: false,
    slug: "veckans-ai-svep",
    name: "Veckans AI-svep",
    description: "En kort redaktionell sammanfattning för veckan.",
    contentType: "social_post",
    channels: ["linkedin"],
    defaultTitle: "",
    defaultHeadline: null,
    defaultSubject: null,
    defaultBody: "",
    defaultCta: "Läs vidare och välj ett nästa steg.",
    defaultExcerpt: null,
    defaultHashtags: [],
    generationPrompt: "Skriv som en reflekterande redaktör.",
    imagePrompt: "Naturlig arbetsmiljö utan text.",
    defaultLanguage: "sv",
    active: true,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

function workerDependencies(): {
  dependencies: StudioAutomationWorkerDependencies;
  mocks: {
    materializeJobs: ReturnType<typeof vi.fn>;
    claimDueJobs: ReturnType<typeof vi.fn>;
    materializeDraft: ReturnType<typeof vi.fn>;
    failJob: ReturnType<typeof vi.fn>;
    generateContent: ReturnType<typeof vi.fn>;
    getEditorialLens: ReturnType<typeof vi.fn>;
    getSeriesReference: ReturnType<typeof vi.fn>;
  };
} {
  const materializeJobs = vi.fn(async () => ({ rulesScanned: 1, jobsCreated: 1, nextRunsUpdated: 1 }));
  const claimDueJobs = vi.fn(async () => [] as ClaimedContentAutomationJob[]);
  const materializeDraft = vi.fn(async () => ({ id: "55555555-5555-4555-8555-555555555555" }) as ContentDraftView);
  const failJob = vi.fn(async () => true);
  const generateContent = vi.fn(async () => generated());
  const getEditorialLens = vi.fn(async () => null);
  const getSeriesReference = vi.fn(async () => null);
  return {
    dependencies: { materializeJobs, claimDueJobs, materializeDraft, failJob, generateContent, getEditorialLens, getSeriesReference },
    mocks: { materializeJobs, claimDueJobs, materializeDraft, failJob, generateContent, getEditorialLens, getSeriesReference },
  };
}

describe("Neon Studio automation worker", () => {
  it("refuses an unassigned legacy rule before reading a Lens or invoking AI", async () => {
    const { dependencies, mocks } = workerDependencies();
    mocks.claimDueJobs.mockResolvedValueOnce([claim({ rule: { ...claim().rule, brandProfileId: null } })]);
    const result = await runNeonStudioAutomationWorker({ now, maxJobs: 1 }, dependencies);
    expect(result.failuresRecorded).toBe(1);
    expect(mocks.getEditorialLens).not.toHaveBeenCalled();
    expect(mocks.generateContent).not.toHaveBeenCalled();
    expect(mocks.materializeDraft).not.toHaveBeenCalled();
    expect(mocks.failJob).toHaveBeenCalledWith(expect.objectContaining({ retry: false, errorCode: "automation_configuration_invalid" }));
  });

  it("keeps exact brand context when two brands run in the same workspace", async () => {
    const { dependencies, mocks } = workerDependencies();
    const secondBrand = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    mocks.claimDueJobs.mockResolvedValueOnce([claim()])
      .mockResolvedValueOnce([claim({ id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", rule: { ...claim().rule, brandProfileId: secondBrand } })]);
    const result = await runNeonStudioAutomationWorker({ now, maxJobs: 2 }, dependencies);
    expect(result.draftsCreated).toBe(2);
    expect(mocks.getEditorialLens.mock.calls.map(([actor]) => actor)).toEqual([
      expect.objectContaining({ workspaceId, brandProfileId }),
      expect.objectContaining({ workspaceId, brandProfileId: secondBrand }),
    ]);
  });

  it("maps a trusted rule to shared generation input and creates only a private draft", async () => {
    const { dependencies, mocks } = workerDependencies();
    mocks.claimDueJobs.mockResolvedValueOnce([claim()]).mockResolvedValueOnce([]);

    const result = await runNeonStudioAutomationWorker({ now, maxJobs: 5, workerId: "cron-test" }, dependencies);

    expect(result).toMatchObject({
      materialization: { rulesScanned: 1, jobsCreated: 1 },
      jobsClaimed: 1,
      draftsCreated: 1,
      retriesScheduled: 0,
      failuresRecorded: 0,
      jobs: [{ jobId, status: "draft_created" }],
    });
    expect(mocks.generateContent).toHaveBeenCalledWith(
      expect.objectContaining({
        contentType: "social_post",
        channels: ["linkedin"],
        language: "sv",
        targetLength: "medium",
      }),
      expect.objectContaining({
        editorialLens: null,
        seriesReference: null,
        automation: expect.objectContaining({ name: "Veckans AI-svep" }),
      }),
    );
    expect(mocks.materializeDraft).toHaveBeenCalledWith(expect.objectContaining({
      jobId,
      claimToken,
      content: expect.objectContaining({
        title: "AI: det som spelar roll",
        language: "sv",
        quality: expect.objectContaining({
          version: "saga-production-quality/v1",
          decision: "review_required",
          canCreatePrivateDraft: true,
          canEnterCalendar: false,
          canDeliver: false,
        }),
        qualityContext: { targetLength: "medium", editorialLens: null, seriesReference: null },
      }),
    }));
    expect(mocks.failJob).not.toHaveBeenCalled();
  });

  it("resolves the active workspace Lens and frozen Series only after the lease, then applies both to generation and quality", async () => {
    const { dependencies, mocks } = workerDependencies();
    const editorialLens = sagaEditorialLensPromptContextSchema.parse({
      mission: "Gör teknik begriplig för fler människor.",
      strategicPerspective: "Bygg system som frigör tid för det mänskliga.",
      industry: "Teknik",
      audience: "Nyfikna byggare",
      themes: ["Systemtänkande"],
      forbiddenThemes: ["Partipolitik"],
      tone: { directness: 4, warmth: 4, formality: 2, technicalDepth: 3, pointOfView: "we", avoidJargon: true, preferredWords: [], avoidedWords: [] },
      construction: { openingStyle: "direct", paragraphStyle: "short", callToAction: "soft", useHeadings: true, maxParagraphs: 5, maxSentencesPerParagraph: 3, includeSourceNotes: true },
      evidenceThreshold: "one_primary_or_two_independent",
      sourceRules: { requireAllowedSources: true, requireCitations: true, minimumUniqueSources: 1, allowedSourceKinds: ["manual"], blockedDomains: [], allowUnsupportedInference: false },
      controlMode: "review_required",
    });
    const seriesReference = resolveSagaSeriesReferenceContext({
      reference: {
        sourceDraftId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        sourceDraftRevision: 2,
        title: "Bygg system som ger tillbaka tid",
        body: "Vi ska bygga system som tar hand om det upprepade arbetet. Då kan människor använda sin tid till det som kräver omdöme, omsorg och fantasi.",
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
    mocks.getEditorialLens.mockResolvedValueOnce(editorialLens);
    mocks.getSeriesReference.mockResolvedValueOnce(seriesReference);
    mocks.claimDueJobs.mockResolvedValueOnce([claim({
      rule: { ...claim().rule, seriesId },
      template: template(),
    })]).mockResolvedValueOnce([]);

    const result = await runNeonStudioAutomationWorker({ now, maxJobs: 1 }, dependencies);

    expect(mocks.getEditorialLens).toHaveBeenCalledWith(expect.objectContaining({
      userId: "33333333-3333-4333-8333-333333333333",
      workspaceId,
      brandProfileId,
      role: "editor",
    }));
    expect(mocks.getSeriesReference).toHaveBeenCalledWith(expect.objectContaining({ workspaceId }), seriesId);
    expect(mocks.generateContent).toHaveBeenCalledWith(
      expect.objectContaining({
        templateInstructions: "Skriv som en reflekterande redaktör.",
        desiredCallToAction: "Läs vidare och välj ett nästa steg.",
      }),
      expect.objectContaining({
        editorialLens: expect.objectContaining({ mission: "Gör teknik begriplig för fler människor." }),
        seriesReference,
        automation: expect.objectContaining({
          name: "Veckans AI-svep",
          template: expect.objectContaining({ name: "Veckans AI-svep" }),
        }),
      }),
    );
    expect(result.jobs[0]).toMatchObject({
      status: "draft_created",
      quality: {
        decision: "review_required",
        seriesReferenceAlignment: { requiresReview: true },
      },
    });
    expect(mocks.materializeDraft).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.objectContaining({
        qualityContext: expect.objectContaining({ editorialLens, seriesReference }),
      }),
    }));
  });

  it("does not fall back to generic writing when a configured Series is absent or inactive", async () => {
    const { dependencies, mocks } = workerDependencies();
    mocks.claimDueJobs.mockResolvedValueOnce([claim({ rule: { ...claim().rule, seriesId } })]).mockResolvedValueOnce([]);
    mocks.getSeriesReference.mockResolvedValueOnce(null);

    const result = await runNeonStudioAutomationWorker({ now, maxJobs: 1 }, dependencies);

    expect(mocks.generateContent).not.toHaveBeenCalled();
    expect(mocks.materializeDraft).not.toHaveBeenCalled();
    expect(mocks.failJob).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: "automation_configuration_invalid",
      retry: false,
    }));
    expect(result).toMatchObject({ failuresRecorded: 1, jobs: [{ status: "failed", code: "automation_configuration_invalid" }] });
  });

  it("records a retryable AI/configuration outage with the live claim token", async () => {
    const { dependencies, mocks } = workerDependencies();
    mocks.claimDueJobs.mockResolvedValueOnce([claim()]).mockResolvedValueOnce([]);
    mocks.generateContent.mockRejectedValueOnce(new ContentGenerationError("AI-skrivningen är inte konfigurerad ännu.", 503));

    const result = await runNeonStudioAutomationWorker({ now }, dependencies);

    expect(result).toMatchObject({ jobsClaimed: 1, retriesScheduled: 1, failuresRecorded: 0, jobs: [{ status: "retry_scheduled", code: "ai_configuration_unavailable" }] });
    expect(mocks.failJob).toHaveBeenCalledWith(expect.objectContaining({
      jobId,
      claimToken,
      errorCode: "ai_configuration_unavailable",
      retry: true,
    }));
    expect(mocks.materializeDraft).not.toHaveBeenCalled();
  });

  it("records invalid automation input without retrying or calling the model", async () => {
    const { dependencies, mocks } = workerDependencies();
    mocks.claimDueJobs.mockResolvedValueOnce([claim({ rule: { ...claim().rule, language: "en" } })]).mockResolvedValueOnce([]);

    const result = await runNeonStudioAutomationWorker({ now }, dependencies);

    expect(result).toMatchObject({ failuresRecorded: 1, retriesScheduled: 0, jobs: [{ status: "failed", code: "automation_configuration_invalid" }] });
    expect(mocks.generateContent).not.toHaveBeenCalled();
    expect(mocks.failJob).toHaveBeenCalledWith(expect.objectContaining({ retry: false, errorCode: "automation_configuration_invalid" }));
  });

  it("records a terminal quality failure before a weak or unsupported AI result can become a private draft", async () => {
    const { dependencies, mocks } = workerDependencies();
    mocks.claimDueJobs.mockResolvedValueOnce([claim()]).mockResolvedValueOnce([]);
    mocks.generateContent.mockResolvedValueOnce({
      ...generated(),
      draft: {
        ...generated().draft,
        body: "Boka nu och få 2 000 kr rabatt på en provkörning som passar din vardag.",
      },
    });

    const result = await runNeonStudioAutomationWorker({ now }, dependencies);

    expect(result).toMatchObject({
      failuresRecorded: 1,
      retriesScheduled: 0,
      jobs: [{ status: "failed", code: "production_quality_rejected" }],
    });
    expect(mocks.materializeDraft).not.toHaveBeenCalled();
    expect(mocks.failJob).toHaveBeenCalledWith(expect.objectContaining({
      jobId,
      claimToken,
      errorCode: "production_quality_rejected",
      retry: false,
    }));
  });

  it("never claims more than five jobs and can skip schedule discovery for a manual caller", async () => {
    const { dependencies, mocks } = workerDependencies();
    mocks.claimDueJobs.mockResolvedValue([claim()]);

    const result = await runNeonStudioAutomationWorker({ now, maxJobs: 99, materializeScheduledJobs: false }, dependencies);

    expect(result.materialization).toEqual({ rulesScanned: 0, jobsCreated: 0, nextRunsUpdated: 0 });
    expect(result.jobsClaimed).toBe(5);
    expect(mocks.claimDueJobs).toHaveBeenCalledTimes(5);
    expect(mocks.claimDueJobs).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 1 }));
    expect(mocks.materializeJobs).not.toHaveBeenCalled();
  });

  it("rejects unsupported languages before a model request", () => {
    expect(() => generationInputForClaim(claim({ rule: { ...claim().rule, language: "en" } }))).toThrow("bara svenska");
  });
});
