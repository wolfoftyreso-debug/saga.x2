import { describe, expect, it } from "vitest";
import { validAdCreativeBrief } from "@/tests/fixtures/ad-automation";
import { sagaEditorialLensPromptContextSchema } from "@/lib/domain/saga-editorial-lens";
import {
  assertSagaProductionQuality,
  assessAdAutomationPrivateDraftQuality,
  assessSagaProductionQuality,
  resolveSagaAutomationQualityContext,
  SagaProductionQualityError,
} from "@/lib/services/saga-production-quality";
import { resolveSagaSeriesReferenceContext } from "@/lib/services/saga-series-reference";

function editorialBody(sentences = 8): string {
  return Array.from({ length: sentences }, () =>
    "System tar hand om återkommande arbete så människor får mer tid att tänka bygga och leva bättre tillsammans.",
  ).join(" ");
}

function qualityInput(overrides: Record<string, unknown> = {}) {
  return {
    kind: "content_draft" as const,
    contentType: "social_post" as const,
    channels: ["linkedin"] as const,
    targetLength: "medium" as const,
    title: "System som frigör mänsklig tid",
    headline: "När maskinen gör maskinarbetet får människor bygga vidare",
    subject: null,
    previewText: "En insikt om system och mänsklig tid.",
    body: editorialBody(),
    callToAction: "Välj en återkommande uppgift att göra enklare denna vecka.",
    imagePrompt: "Ljus redaktionell arbetsmiljö med människor som planerar tillsammans, utan text eller logotyp.",
    deliveryIntent: "private_draft" as const,
    ...overrides,
  };
}

describe("SAGA production quality gate", () => {
  it("approves structured, readable channel-fit content for calendar review", () => {
    const assessment = assessSagaProductionQuality({ ...qualityInput(), deliveryIntent: "calendar" });

    expect(assessment).toMatchObject({
      version: "saga-production-quality/v1",
      decision: "approved",
      canCreatePrivateDraft: true,
      canEnterCalendar: true,
      canDeliver: false,
      findings: [],
    });
  });

  it("keeps weak but safe copy as a private draft and out of the calendar", () => {
    const input = qualityInput({
      body: "Vi bygger vidare tillsammans och väljer en återkommande uppgift som kan bli enklare redan denna vecka.",
      deliveryIntent: "private_draft",
    });
    const assessment = assessSagaProductionQuality(input);

    expect(assessment).toMatchObject({ decision: "review_required", canCreatePrivateDraft: true, canEnterCalendar: false });
    expect(assessment.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "body_off_target_length", severity: "warning" }),
    ]));
    expect(() => assertSagaProductionQuality({ ...input, deliveryIntent: "calendar" }, "calendar"))
      .toThrow(SagaProductionQualityError);
  });

  it("blocks unsupported commercial claims and unsafe image directions before a private draft is saved", () => {
    const assessment = assessSagaProductionQuality(qualityInput({
      body: `${editorialBody()} Boka nu för 2 000 kr rabatt.`,
      imagePrompt: "En fallande skylt över en folksamling med inlagd text.",
    }));

    expect(assessment).toMatchObject({ decision: "blocked", canCreatePrivateDraft: false, canEnterCalendar: false });
    expect(assessment.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining([
      "unsupported_claim_without_evidence",
      "unsafe_or_non_compliant_image_direction",
    ]));
  });

  it("treats an unverified ad offer as review-only and keeps the brief private", () => {
    const assessment = assessAdAutomationPrivateDraftQuality("Sätra – provkörning", validAdCreativeBrief());

    expect(assessment).toMatchObject({
      decision: "review_required",
      canCreatePrivateDraft: true,
      canEnterCalendar: false,
      canDeliver: false,
    });
    expect(assessment.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "offer_evidence_pending", severity: "warning" }),
    ]));
  });

  it("adds a frozen Series Reference assessment without permitting a matching draft into the calendar", () => {
    const seriesReference = resolveSagaSeriesReferenceContext({
      reference: {
        sourceDraftId: "11111111-1111-4111-8111-111111111111",
        sourceDraftRevision: 3,
        title: "Boka trygg service",
        body: "En rak referenstext om nästa steg.",
        channels: ["linkedin"],
        media: [],
        capturedAt: "2026-08-25T09:00:00.000Z",
      },
      controls: {
        objective: "convert",
        audience: "Bilägare",
        tone: "direct",
        requiredElements: [],
        forbiddenElements: [],
        defaultChannels: ["linkedin"],
        reviewRequired: true,
      },
    });
    const assessment = assessSagaProductionQuality(qualityInput({
      callToAction: "Boka en tid när det passar dig.",
      deliveryIntent: "calendar",
      seriesReference,
    }));

    expect(assessment).toMatchObject({
      decision: "review_required",
      canCreatePrivateDraft: true,
      canEnterCalendar: false,
      seriesReferenceAlignment: {
        version: "saga-series-reference-alignment/v1",
        requiresReview: true,
      },
    });
    expect(assessment.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "series_reference_review_required", field: "seriesReference", severity: "warning" }),
    ]));
  });

  it("carries an active Editorial Lens into the deterministic gate and retains the safe context for a later calendar check", () => {
    const editorialLens = sagaEditorialLensPromptContextSchema.parse({
      mission: "Ge människor mer tid för det som kräver omdöme.",
      strategicPerspective: "System före manuellt dubbelarbete.",
      industry: "Teknik",
      audience: "Byggare",
      themes: ["System"],
      forbiddenThemes: ["Partipolitik"],
      tone: {},
      construction: {},
      evidenceThreshold: "one_primary_or_two_independent",
      sourceRules: {},
      controlMode: "review_required",
    });
    const review = assessSagaProductionQuality(qualityInput({
      editorialLens,
      deliveryIntent: "calendar",
    }));
    expect(review).toMatchObject({ decision: "review_required", canCreatePrivateDraft: true, canEnterCalendar: false });
    expect(review.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "editorial_lens_review_required", field: "editorialLens", severity: "warning" }),
    ]));

    const blocked = assessSagaProductionQuality(qualityInput({
      editorialLens,
      body: `${editorialBody()} Partipolitik är dagens tema.`,
    }));
    expect(blocked).toMatchObject({ decision: "blocked", canCreatePrivateDraft: false });
    expect(blocked.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "editorial_lens_forbidden_theme_present", severity: "blocker" }),
    ]));

    expect(resolveSagaAutomationQualityContext({ targetLength: "medium", editorialLens, seriesReference: null }))
      .toEqual(expect.objectContaining({ targetLength: "medium", editorialLens, seriesReference: null }));
  });
});
