import { describe, expect, it } from "vitest";
import {
  SAGA_NATURE_FIRST_CONCEPT_DIRECTIONS,
  buildSagaVisualArtDirectionPolicy,
  sagaDocumentaryImagePromptBaseline,
  sagaVisualDirectionForImagePrompt,
} from "@/lib/services/saga-visual-art-direction";

describe("SAGA visual art direction", () => {
  it("defaults media to a nature-first, restrained documentary treatment", () => {
    const policy = buildSagaVisualArtDirectionPolicy("day_to_evening");

    expect(policy).toMatchObject({
      version: "saga-visual-art-direction/v1",
      concept: "day_to_evening",
      naturePriority: "nature_first",
      rendering: {
        visualCharacter: "documentary_restraint",
      },
    });
    expect(policy.instructions).toContain("Prioritera natur");
    expect(policy.instructions).toContain("fuktig sand");
    expect(policy.instructions).toContain("lätt analogt korn");
    expect(policy.instructions).toContain("inte dokumentation av en specifik verklig händelse");
  });

  it("keeps the narrative detail physical and non-readable for every approved concept", () => {
    for (const concept of Object.keys(SAGA_NATURE_FIRST_CONCEPT_DIRECTIONS) as Array<keyof typeof SAGA_NATURE_FIRST_CONCEPT_DIRECTIONS>) {
      const policy = buildSagaVisualArtDirectionPolicy(concept);

      expect(policy.conceptDirection.physicalNarrativeDetail).toMatch(/utan|aldrig|inga|icke-läsbart/u);
      expect(policy.instructions).toContain(policy.conceptDirection.physicalNarrativeDetail);
      expect(policy.restrictions).toEqual(expect.arrayContaining([
        expect.stringContaining("Ingen läsbar text"),
        expect.stringContaining("Ingen logotyp"),
      ]));
    }
  });

  it("exports a generic static baseline without accidentally picking a specific post scene", () => {
    const baseline = sagaDocumentaryImagePromptBaseline();

    expect(baseline).toContain("Prioritera natur");
    expect(baseline).toContain("lätt analogt korn");
    expect(baseline).toContain("Ingen läsbar text");
    expect(baseline).not.toContain("morgonfrosten");
    expect(baseline).not.toContain("fuktig sand");
    expect(baseline).not.toContain("hackmönster");
  });

  it("exposes the same finite direction through the reusable image-prompt helper", () => {
    expect(sagaVisualDirectionForImagePrompt("prepared_shelf"))
      .toBe(buildSagaVisualArtDirectionPolicy("prepared_shelf").instructions);
  });
});
