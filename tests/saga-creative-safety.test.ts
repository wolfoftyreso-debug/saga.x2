import { describe, expect, it } from "vitest";
import {
  assertSagaCreativeBriefCanGenerate,
  assessSagaCreativeBrief,
  buildSagaCreativePromptPolicy,
  SagaCreativeSafetyError,
} from "@/lib/services/saga-creative-safety";

function verifiedWinterTyreBrief() {
  return {
    format: "short_form_video" as const,
    hook: "Känns det som att hösten alltid kommer snabbare än planerat?",
    value: "Boka i lugn takt och få hjälp att byta till vinterdäck innan vardagen blir fullbokad.",
    offer: {
      copy: "Hjulskifte från 1 295 kr inklusive moms.",
      terms: "Gäller bokningar hos Sätra Däckservice 1–30 oktober 2026, i mån av lediga tider.",
      verification: {
        status: "verified" as const,
        sourceReference: "Kampanjblad Vinterhjul 2026, godkänt av kampanjansvarig.",
        verifiedAt: "2026-08-24T09:00:00.000Z",
      },
    },
    callToAction: "Boka hjulskifte i Sätra.",
    visualMetaphor: "calendar_turn" as const,
  };
}

describe("SAGA Creative Safety", () => {
  it("requires a verified Hook → value → offer → CTA flow for a publishable short-form creative", () => {
    const assessment = assessSagaCreativeBrief(verifiedWinterTyreBrief());
    const policy = buildSagaCreativePromptPolicy(verifiedWinterTyreBrief());

    expect(assessment.flow).toEqual(["hook", "value", "offer", "cta"]);
    expect(assessment.draftAllowed).toBe(true);
    expect(assessment.publishable).toBe(true);
    expect(policy.offer).toMatchObject({
      exactCopy: "Hjulskifte från 1 295 kr inklusive moms.",
      sourceReference: expect.stringContaining("Kampanjblad"),
    });
    expect(policy.instructions).toContain("Hook → värde → erbjudande → CTA");
    expect(policy.instructions).toContain("Hjulskifte från 1 295 kr inklusive moms.");
  });

  it("rejects a falling-wheel shock scene before a model could receive it and returns a safe rewrite", () => {
    const unsafe = {
      ...verifiedWinterTyreBrief(),
      customVisualDirection: "Ett hjul kommer flygande från en balkong på tionde våningen. Precis innan hjulet faller ner i folksamlingen bryter klippet.",
    };

    const assessment = assessSagaCreativeBrief(unsafe);

    expect(assessment.draftAllowed).toBe(false);
    expect(assessment.publishable).toBe(false);
    expect(assessment.violations).toContainEqual(expect.objectContaining({
      code: "unsafe_scene",
      field: "customVisualDirection",
    }));
    expect(assessment.safeRewrite).toMatchObject({
      visualMetaphor: "calendar_turn",
      visualDirection: expect.stringContaining("kalenderblad"),
    });
    expect(() => assertSagaCreativeBriefCanGenerate(unsafe)).toThrow(SagaCreativeSafetyError);
  });

  it("also blocks the same imminent-injury pattern when an English provider prompt is supplied", () => {
    const assessment = assessSagaCreativeBrief({
      ...verifiedWinterTyreBrief(),
      customVisualDirection: "A falling object drops toward a crowd just before it can hit people.",
    });

    expect(assessment.draftAllowed).toBe(false);
    expect(assessment.violations).toContainEqual(expect.objectContaining({ code: "unsafe_scene" }));
  });

  it("keeps an unverified price or discount as a non-publishable draft rather than inventing or using the claim", () => {
    const unverified = {
      ...verifiedWinterTyreBrief(),
      offer: {
        copy: "20 % rabatt på hjulskifte den här veckan.",
        terms: "Villkor behöver bekräftas.",
        verification: { status: "unverified" as const, sourceReference: "" },
      },
    };

    const assessment = assessSagaCreativeBrief(unverified);
    const policy = buildSagaCreativePromptPolicy(unverified);

    expect(assessment.draftAllowed).toBe(true);
    expect(assessment.publishable).toBe(false);
    expect(assessment.verifiedOffer.exactCopy).toBeNull();
    expect(assessment.violations).toContainEqual(expect.objectContaining({ code: "unverified_offer" }));
    expect(policy.offer.exactCopy).toBeNull();
    expect(policy.instructions).toContain("Ingen verifierad erbjudandetext finns");
    expect(policy.instructions).not.toContain("20 % rabatt på hjulskifte den här veckan.");
  });

  it("does not permit a price or discount to be smuggled into the hook, value or CTA", () => {
    const assessment = assessSagaCreativeBrief({
      ...verifiedWinterTyreBrief(),
      hook: "20 % rabatt innan du ens hinner tänka på vinterdäcken.",
    });

    expect(assessment.draftAllowed).toBe(true);
    expect(assessment.publishable).toBe(false);
    expect(assessment.violations).toContainEqual(expect.objectContaining({
      code: "unverified_commercial_claim",
      field: "hook",
    }));
  });

  it("fails closed when a creative brief is missing a required flow stage", () => {
    const incomplete = { ...verifiedWinterTyreBrief(), callToAction: "" };

    expect(() => assessSagaCreativeBrief(incomplete)).toThrow(/Hook, värde, erbjudande och CTA/u);
  });
});
