import { describe, expect, it } from "vitest";
import { discoveryInstructions, editorialInput, editorialInstructions } from "@/lib/openai/prompts";
import { DEFAULT_PROFILE_SETTINGS } from "@/lib/domain/types";

describe("strategisk radar", () => {
  it("prioriterar profilens intressen och möjligheter i båda modellstegen", () => {
    const personalContext = {
      interests: ["modellroadmaps", "relevanta AI-konferenser"],
      opportunities: ["offentliga upphandlingar", "partnerskap"],
    };
    const discovery = discoveryInstructions({
      profile: DEFAULT_PROFILE_SETTINGS,
      coverageFrom: "2026-08-19T07:00:00.000Z",
      now: "2026-08-20T07:00:00.000Z",
      personalContext,
      includeStrategicRadar: true,
    });
    const editorial = editorialInstructions({
      profile: DEFAULT_PROFILE_SETTINGS,
      existingEvents: [],
      coverageFrom: "2026-08-19T07:00:00.000Z",
      personalContext,
      includeStrategicRadar: true,
    });

    expect(discovery).toContain("personalContext.interests och personalContext.opportunities");
    expect(discovery).toContain("strategicRadarScan");
    expect(discovery).toContain("officiellt annonserat");
    expect(editorial).toContain("strategicRadar");
    expect(editorial).toContain("Ingen relevant post.");
    expect(editorial).toContain('exakt "Digitalt"');
  });

  it("skickar radarn som ett separat, strukturerat underlag till redaktionella steget", () => {
    const input = editorialInput([], null, null, null);
    expect(input).toContain("strategicRadarScan");
  });
});
