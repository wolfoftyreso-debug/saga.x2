import { describe, expect, it, vi } from "vitest";
import type { AppActor } from "@/lib/neon/auth-repository";
import type { SagaQuarterlyGenerationClaim } from "@/lib/domain/saga-quarterly-planning";
import {
  generationInputForSagaQuarterlyClaim,
  processSagaQuarterlyPlanningClaim,
  type SagaQuarterlyPlanningWorkerDependencies,
} from "@/lib/neon/saga-quarterly-planning-worker";
import { ContentGenerationError, type GeneratedContentResult } from "@/lib/services/content-generation";
import type { SagaProductionQualityAssessment } from "@/lib/services/saga-production-quality";

const actor: AppActor = {
  userId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  role: "editor",
  email: null,
  displayName: null,
};

const claim: SagaQuarterlyGenerationClaim = {
  jobId: "33333333-3333-4333-8333-333333333333",
  claimToken: "44444444-4444-4444-8444-444444444444",
  batchId: "55555555-5555-4555-8555-555555555555",
  batchItemId: "66666666-6666-4666-8666-666666666666",
  materializationReceiptId: "77777777-7777-4777-8777-777777777777",
  planId: "88888888-8888-4888-8888-888888888888",
  planRevision: 3,
  authorUserId: actor.userId,
  timezone: "Europe/Stockholm",
  brand: {
    name: "SAGA Systems",
    summary: "Vi bygger pålitliga system som frigör människors tid för viktigt arbete.",
    voice: { tone: "Ödmjuk, konkret och insiktsdriven." },
  },
  slot: {
    id: "99999999-9999-4999-8999-999999999999",
    revision: 2,
    slotKey: "linkedin-plan:1:2026-08-24:09:30",
    channelPlanId: "linkedin-plan",
    weekIndex: 1,
    plannedAt: "2026-08-24T07:30:00.000Z",
    plannedLocalDate: "2026-08-24",
    plannedLocalTime: "09:30",
    timezone: "Europe/Stockholm",
    channel: "linkedin",
    contentType: "social_post",
    theme: {
      id: "systeminsikt",
      title: "System som frigör tid",
      intent: "Visa hur genomtänkta system frigör tid för mänskligt omdöme.",
      contentDirection: "Börja med en konkret vardagssituation och gör nyttan tydlig.",
      approved: true,
    },
    objective: "Hjälpa relevanta beslutsfattare att förstå värdet av välbyggda system.",
    contentDirection: "Börja med en konkret vardagssituation och gör nyttan tydlig.",
    desiredCallToAction: "Berätta vilken återkommande uppgift du vill frigöra först.",
    imageDirection: "Naturbild i dokumentär stil med en diskret detalj som knyter an till systemtänkande.",
    targetLength: "medium",
    planningLabel: "System som frigör tid",
  },
};

function generated(): GeneratedContentResult {
  return {
    draft: {
      title: "När systemet gör sitt jobb kan människan göra sitt",
      headline: "Automatisera det repetitiva. Behåll det mänskliga.",
      subject: "System som frigör tid",
      previewText: "Ett privat utkast för mänsklig granskning.",
      body: "När samma uppgift återkommer varje dag är frågan sällan om någon ska arbeta hårdare. Frågan är hur flödet kan bli tydligare, tryggare och mindre beroende av att en människa minns varje steg. Ett bra system frigör utrymme för omdöme, relationer och arbete som faktiskt behöver en människa.",
      excerpt: "Ett bra system frigör utrymme för mänskligt omdöme.",
      callToAction: "Berätta vilken återkommande uppgift du vill frigöra först.",
      hashtags: ["#system", "#automation"],
      imagePrompt: "Dokumentär naturbild med naturligt ljus, ett litet systemdiagram ritat i sanden, ingen text, logotyp eller watermark.",
      altText: "Ett enkelt mönster ritat i sand nära skogskanten.",
    },
    model: "test-model",
    responseId: "response-test",
    inputTokens: 1,
    outputTokens: 1,
  };
}

function assessment(overrides: Partial<SagaProductionQualityAssessment> = {}): SagaProductionQualityAssessment {
  return {
    version: "saga-production-quality/v1",
    decision: "review_required",
    score: 92,
    findings: [{ code: "readability_needs_review", severity: "warning", field: "body", message: "Granska formuleringen innan den används." }],
    canCreatePrivateDraft: true,
    canEnterCalendar: false,
    canDeliver: false,
    ...overrides,
  };
}

function dependencies(overrides: Partial<SagaQuarterlyPlanningWorkerDependencies> = {}): SagaQuarterlyPlanningWorkerDependencies {
  return {
    claim: vi.fn(),
    lens: vi.fn().mockResolvedValue(null),
    generate: vi.fn().mockResolvedValue(generated()),
    assess: vi.fn().mockReturnValue(assessment()),
    complete: vi.fn().mockResolvedValue({ draftId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", stale: false }),
    fail: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

describe("quarterly private-draft worker", () => {
  it("builds channel-pinned Swedish generation input without invented performance data", () => {
    const input = generationInputForSagaQuarterlyClaim(claim);
    expect(input).toMatchObject({
      contentType: "social_post",
      channels: ["linkedin"],
      targetLength: "medium",
      language: "sv",
    });
    expect(input.brief).toContain("Skriv inga publik-, räckvidds-, resultat- eller prestationspåståenden");
    expect(input.templateInstructions).toContain("Skapa inte schema, publicering, leverans eller bildfil");
  });

  it("creates exactly one quality-gated private draft, never a scheduled or delivered post", async () => {
    const deps = dependencies();
    const result = await processSagaQuarterlyPlanningClaim(claim, actor, deps);

    expect(result).toMatchObject({ status: "private_draft_created", draftId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    expect(deps.complete).toHaveBeenCalledWith(actor, expect.objectContaining({
      jobId: claim.jobId,
      claimToken: claim.claimToken,
      draft: expect.objectContaining({
        contentType: "social_post",
        channels: ["linkedin"],
        timezone: "Europe/Stockholm",
        quality: expect.objectContaining({ canCreatePrivateDraft: true, canDeliver: false }),
      }),
    }));
    const completedDraft = vi.mocked(deps.complete).mock.calls[0]?.[1].draft;
    expect(completedDraft).not.toHaveProperty("scheduledAt");
    expect(completedDraft).not.toHaveProperty("publishAt");
    expect(deps.fail).not.toHaveBeenCalled();
  });

  it("records a durable failure instead of inserting a quality-blocked AI response", async () => {
    const blocked = assessment({
      decision: "blocked",
      canCreatePrivateDraft: false,
      score: 20,
      findings: [{ code: "missing_image_direction", severity: "blocker", field: "imagePrompt", message: "Bildriktning saknas." }],
    });
    const deps = dependencies({ assess: vi.fn().mockReturnValue(blocked) });
    const result = await processSagaQuarterlyPlanningClaim(claim, actor, deps);

    expect(result).toMatchObject({ status: "quality_blocked", code: "production_quality_rejected" });
    expect(deps.complete).not.toHaveBeenCalled();
    expect(deps.fail).toHaveBeenCalledWith(actor, expect.objectContaining({ errorCode: "production_quality_rejected" }));
  });

  it("returns a truthful recoverable receipt failure when AI Gateway is unavailable", async () => {
    const deps = dependencies({ generate: vi.fn().mockRejectedValue(new ContentGenerationError("gateway missing", 503)) });
    const result = await processSagaQuarterlyPlanningClaim(claim, actor, deps);

    expect(result).toMatchObject({ status: "failed", code: "ai_gateway_unavailable" });
    expect(deps.complete).not.toHaveBeenCalled();
    expect(deps.fail).toHaveBeenCalledWith(actor, expect.objectContaining({
      errorCode: "ai_gateway_unavailable",
      errorMessage: expect.stringContaining("Inget utkast sparades"),
    }));
  });
});
