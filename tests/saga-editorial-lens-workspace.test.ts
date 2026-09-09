import { describe, expect, it } from "vitest";
import {
  addLensSourceSelection,
  editorialLensForm,
  editorialLensInput,
  lensSourceOptionsFromPayload,
  productFailureMessage,
  removeLensSourceSelection,
  setLensSourceSelectionRole,
} from "@/components/saga-editorial-lens-workspace";
import type { SagaEditorialLens } from "@/lib/domain/saga-editorial-lens";

const lens: SagaEditorialLens = {
  id: "11111111-1111-4111-8111-111111111111",
  createdByUserId: "22222222-2222-4222-8222-222222222222",
  updatedByUserId: "22222222-2222-4222-8222-222222222222",
  brandProfileId: null,
  name: "Verkstadens Lens",
  mission: "Gör bilservice begriplig.",
  strategicPerspective: "Bygg förtroende före räckvidd.",
  industry: "Bilservice",
  audience: "Bilägare i Borås",
  themes: ["trygg service", "enklare vardag"],
  forbiddenThemes: ["skrämsel"],
  tone: { directness: 4, warmth: 3, formality: 2, technicalDepth: 3, pointOfView: "you", avoidJargon: true, preferredWords: ["trygg"], avoidedWords: ["billigast"] },
  construction: { openingStyle: "direct", paragraphStyle: "short", callToAction: "soft", useHeadings: true, maxParagraphs: 5, maxSentencesPerParagraph: 3, includeSourceNotes: true },
  evidenceThreshold: "one_primary_or_two_independent",
  sourceRules: { requireAllowedSources: true, requireCitations: true, minimumUniqueSources: 2, allowedSourceKinds: ["website", "rss", "social_profile"], blockedDomains: ["clickbait.example"], allowUnsupportedInference: false },
  sourceSelections: [{ sourceId: "33333333-3333-4333-8333-333333333333", role: "preferred", priority: 1 }],
  controlMode: "review_required",
  active: true,
  createdAt: "2026-08-24T12:00:00.000Z",
  updatedAt: "2026-08-24T12:00:00.000Z",
};

describe("SAGA Editorial Lens workspace form", () => {
  it("starts with a constructive, review-first doctrine instead of a publish setting", () => {
    const form = editorialLensForm(null);

    expect(form.controlMode).toBe("review_required");
    expect(form.requireAllowedSources).toBe(true);
    expect(form.requireCitations).toBe(true);
    expect(form.minimumUniqueSources).toBe(2);
  });

  it("round-trips the saved human direction without inventing, losing, or widening source scope", () => {
    const input = editorialLensInput(editorialLensForm(lens));

    expect(input).toMatchObject({
      mission: lens.mission,
      strategicPerspective: lens.strategicPerspective,
      themes: lens.themes,
      forbiddenThemes: lens.forbiddenThemes,
      controlMode: "review_required",
      sourceRules: expect.objectContaining({ minimumUniqueSources: 2, requireCitations: true }),
    });
    expect(input.sourceSelections).toEqual(lens.sourceSelections);
    expect(input.sourceRules?.allowedSourceKinds).toEqual(lens.sourceRules.allowedSourceKinds);
    expect(input.sourceRules?.blockedDomains).toEqual(lens.sourceRules.blockedDomains);
    expect(input).not.toHaveProperty("workspaceId");
  });

  it("shows only active, allowed actor-scoped source metadata in the Lens picker", () => {
    const options = lensSourceOptionsFromPayload({
      data: {
        sources: [
          { id: "33333333-3333-4333-8333-333333333333", name: "Verkstadsbloggen", sourceKind: "website", active: true, isAllowed: true, referenceText: "never copied into picker state" },
          { id: "44444444-4444-4444-8444-444444444444", name: "Avstängd", sourceKind: "rss", active: false, isAllowed: true },
          { id: "55555555-5555-4555-8555-555555555555", name: "Inte godkänd", sourceKind: "manual", active: true, isAllowed: false },
        ],
      },
    });

    expect(options).toEqual([{ id: "33333333-3333-4333-8333-333333333333", name: "Verkstadsbloggen", sourceKind: "website" }]);
    expect(options[0]).not.toHaveProperty("referenceText");
  });

  it("lets the Lens select, classify, and remove explicit source IDs without widening the saved set", () => {
    const added = addLensSourceSelection(lens.sourceSelections, "44444444-4444-4444-8444-444444444444");
    const required = setLensSourceSelectionRole(added, "44444444-4444-4444-8444-444444444444", "required");
    const removed = removeLensSourceSelection(required, "33333333-3333-4333-8333-333333333333");

    expect(added).toEqual([
      ...lens.sourceSelections,
      { sourceId: "44444444-4444-4444-8444-444444444444", role: "preferred", priority: 2 },
    ]);
    expect(required.at(-1)).toMatchObject({ role: "required", priority: 2 });
    expect(removed).toEqual([{ sourceId: "44444444-4444-4444-8444-444444444444", role: "required", priority: 1 }]);
  });

  it("never creates an invalid 51st Lens priority after a full source selection changes", () => {
    const full = Array.from({ length: 50 }, (_, index) => ({
      sourceId: `${String(index + 1).padStart(8, "0")}-0000-4000-8000-000000000000`,
      role: "preferred" as const,
      priority: index + 1,
    }));
    const removed = removeLensSourceSelection(full, full[0]!.sourceId);
    const added = addLensSourceSelection(removed, "99999999-9999-4999-8999-999999999999");

    expect(added).toHaveLength(50);
    expect(Math.max(...added.map((selection) => selection.priority))).toBe(50);
    expect(new Set(added.map((selection) => selection.priority)).size).toBe(50);
  });

  it("keeps infrastructure failures out of the editorial workspace copy", () => {
    expect(productFailureMessage(503, "Din redaktionella riktning kan inte läsas just nu.")).toBe("Din redaktionella riktning kan inte läsas just nu.");
    expect(productFailureMessage(401, "fallback")).toBe("Logga in för att öppna din redaktionella riktning.");
  });
});
