import { describe, expect, it } from "vitest";
import { DEFAULT_PROFILE_SETTINGS, editorialResultSchema } from "@/lib/domain/types";
import { editorialInput, editorialInstructions } from "@/lib/openai/prompts";

const updateId = "41a8fb13-540b-4b2c-93cf-a12c7395d963";

describe("veckan hittills", () => {
  it("ger redaktionen endast redan sparade uppdaterings-id:n att välja mellan", () => {
    const instructions = editorialInstructions({
      profile: DEFAULT_PROFILE_SETTINGS,
      existingEvents: [],
      coverageFrom: "2026-08-19T07:00:00.000Z",
      includeWeeklyRecap: true,
    });
    const input = editorialInput([], null, {
      periodStart: "2026-08-17",
      periodEnd: "2026-08-20",
      items: [{
        eventId: "d4e9973e-9ad3-4ba4-b4cc-5bc2c84a320f",
        eventUpdateId: updateId,
        date: "2026-08-19",
        title: "EU fastställer nästa steg för AI-reglerna",
        whatChanged: "Reglerna har antagits med ett fastställt datum.",
        whyItMatters: "Det påverkar företag med AI-system på EU-marknaden.",
        relevanceScore: 84,
      }],
    }, null);

    expect(instructions).toContain("weeklyRecap som ett objekt med eventUpdateIds");
    expect(instructions).toContain("Hitta inte på ett id");
    expect(input).toContain("weeklyRecapContext");
    expect(input).toContain(updateId);
  });

  it("validerar en liten, unik veckoselektion i det strukturerade svaret", () => {
    const base = {
      assessment: "Inget kräver åtgärd just nu.",
      decisions: [],
      watchlist: [],
      worldPulse: null,
      strategicRadar: null,
    };
    expect(editorialResultSchema.safeParse({
      ...base,
      weeklyRecap: { eventUpdateIds: [updateId] },
    }).success).toBe(true);
    expect(editorialResultSchema.safeParse({
      ...base,
      weeklyRecap: { eventUpdateIds: [updateId, updateId] },
    }).success).toBe(false);
  });
});
