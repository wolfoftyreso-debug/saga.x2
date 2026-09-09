import { describe, expect, it } from "vitest";
import { candidateEventSchema, DEFAULT_PROFILE_SETTINGS } from "@/lib/domain/types";
import { applyProfileWeights } from "@/lib/domain/relevance";

describe("bredare intresseområden", () => {
  it("accepterar lokala och personliga händelser utan att felaktigt ge dem en affärskategori", () => {
    const candidate = candidateEventSchema.parse({
      canonicalKey: "stockholm-new-neighborhood-brewery",
      title: "Nytt bryggeri öppnar i Södermalm",
      category: "personal_interest",
      actors: ["Bryggeriet"],
      regions: ["Stockholm"],
      status: "announced",
      eventDate: "2026-08-18",
      effectiveDate: null,
      whatChanged: "Ett nytt lokalt bryggeri har annonserat sin öppning i Södermalm.",
      termsSummary: "Öppningen har officiellt annonserats av verksamheten.",
      materialFacts: [{
        dimension: "scope",
        direction: "introduced",
        subject: "Bryggeriets verksamhet i Södermalm",
        value: "Officiellt annonserad öppning",
      }],
      shortTermImpact: "Kan vara relevant för användarens uttryckliga intresse för öl och lokala upplevelser.",
      longTermImpact: "Ger ett nytt lokalt alternativ att följa när öppningsdatum och program bekräftas.",
      sources: [{
        sourceName: "Bryggeriet",
        url: "https://example.com/opening",
        sourceType: "primary",
        publishedAt: "2026-08-18",
        eventDate: "2026-08-18",
        supportsClaim: "Företagets officiella öppningsannonsering beskriver den nya verksamheten.",
      }],
    });
    expect(candidate.category).toBe("personal_interest");
  });

  it("håller den explicita reglagevikten neutral för personlig-intresse-kategorin", () => {
    const adjusted = applyProfileWeights({
      factors: { personalExposure: 60, materiality: 50, actionability: 45, confirmation: 90, timeCriticality: 30 },
      category: "personal_interest",
      regions: ["Stockholm"],
      settings: DEFAULT_PROFILE_SETTINGS,
    });
    expect(adjusted.personalExposure).toBe(60);
  });
});
