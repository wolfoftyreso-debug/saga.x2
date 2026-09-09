import { describe, expect, it } from "vitest";
import {
  assessSagaSeriesReferenceAlignment,
  buildSagaSeriesReferenceGuidance,
  resolveSagaSeriesReferenceContext,
} from "@/lib/services/saga-series-reference";

const sourceDraftId = "11111111-1111-4111-8111-111111111111";

function context() {
  return resolveSagaSeriesReferenceContext({
    reference: {
      sourceDraftId,
      sourceDraftRevision: 7,
      title: "Trygg provkörning i Sätra",
      body: [
        "När valet av elbil känns stort hjälper en lugn provkörning dig att jämföra det som spelar roll i vardagen.",
        "Vi går igenom räckvidd, laddning och nästa steg tillsammans innan du bestämmer dig.",
        "Boka en tid när du vill känna efter i lugn och ro.",
      ].join("\n\n"),
      channels: ["linkedin"],
      media: [{
        kind: "generated",
        contentType: "image/jpeg",
        width: 1600,
        height: 1000,
        altText: "En kund och en mekaniker i en ljus verkstad bredvid en elbil.",
        status: "ready",
      }],
      capturedAt: "2026-08-25T09:00:00.000Z",
    },
    controls: {
      objective: "convert",
      audience: "Bilägare i Sätra",
      tone: "warm",
      requiredElements: ["trygg", "provkörning"],
      forbiddenElements: ["billigast"],
      defaultChannels: ["linkedin"],
      reviewRequired: true,
    },
  });
}

describe("SAGA Series Reference guidance", () => {
  it("creates a frozen, prompt-safe snapshot without a source ID or storage locator in model material", () => {
    const series = context();
    const guidance = buildSagaSeriesReferenceGuidance(series, {
      title: "Provkör i lugn och ro",
      headline: "Trygg hjälp när du vill jämföra elbil",
      body: "Du får trygg hjälp att jämföra laddning och räckvidd.\n\nBoka en provkörning när det passar dig.",
      callToAction: "Boka en provkörning i Sätra.",
      channels: ["linkedin"],
      imagePrompt: "Ljus bilverkstad med kund, mekaniker och elbil, utan text eller logotyp.",
      altText: "En kund pratar med en mekaniker bredvid en elbil i verkstaden.",
    });

    expect(Object.isFrozen(series.reference)).toBe(true);
    expect(Object.isFrozen(series.controls)).toBe(true);
    expect(guidance.instructions).toContain("Series Reference");
    expect(guidance.assessment).toMatchObject({
      version: "saga-series-reference-alignment/v1",
      decision: "aligned",
      requiresReview: true,
    });
    expect(guidance.assessment.score).toBeGreaterThanOrEqual(90);
    expect(guidance.assessment.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "series_reference_review_required", severity: "notice" }),
    ]));
    const modelMaterial = JSON.stringify(guidance.prompt);
    expect(modelMaterial).not.toContain(sourceDraftId);
    expect(modelMaterial).not.toContain("sourceDraftRevision");
    expect(modelMaterial).not.toContain("capturedAt");
    expect(modelMaterial).not.toContain("blobUrl");
  });

  it("reports concrete tone, structure, CTA, channel and media mismatches without pretending semantic certainty", () => {
    const assessment = assessSagaSeriesReferenceAlignment(context(), {
      title: "Ett val",
      headline: "Nya möjligheter",
      body: "Billigast är alltid bäst enligt oss.",
      callToAction: "Tänk vidare.",
      channels: ["instagram"],
      imagePrompt: "Abstrakt neonmönster i ett tomt rum, utan text.",
      altText: "Ett abstrakt neonmönster.",
    });

    expect(assessment).toMatchObject({ decision: "review_required", requiresReview: true });
    expect(assessment.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining([
      "series_reference_required_element_missing",
      "series_reference_forbidden_element_present",
      "series_reference_tone_mismatch",
      "series_reference_structure_mismatch",
      "series_reference_cta_mismatch",
      "series_reference_channel_mismatch",
      "series_reference_media_mismatch",
    ]));
    expect(assessment.dimensions.map((dimension) => dimension.dimension)).toEqual([
      "tone", "structure", "callToAction", "channel", "mediaIntent",
    ]);
  });

  it("rejects unsafe or storage-shaped media input instead of carrying it into a prompt", () => {
    expect(() => resolveSagaSeriesReferenceContext({
      reference: {
        sourceDraftId,
        sourceDraftRevision: 1,
        title: "Referens",
        body: "Kort kropp.",
        channels: ["linkedin"],
        media: [{
          kind: "upload",
          contentType: "image/jpeg",
          width: null,
          height: null,
          altText: null,
          status: "ready",
          blobUrl: "https://private.blob.example/never-pass-this",
        }],
        capturedAt: "2026-08-25T09:00:00.000Z",
      },
      controls: {
        objective: "educate",
        audience: "Bilägare",
        tone: "direct",
        requiredElements: [],
        forbiddenElements: [],
        defaultChannels: ["linkedin"],
        reviewRequired: true,
      },
    })).toThrow();
  });
});
