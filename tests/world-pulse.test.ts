import { describe, expect, it } from "vitest";
import { discoveryInstructions, editorialInput, editorialInstructions } from "@/lib/openai/prompts";
import { DEFAULT_PROFILE_SETTINGS, type Source, type WorldPulse, worldPulseSchema } from "@/lib/domain/types";
import { hasIndependentEditorialSources, requiresIndependentConflictEvidence, shouldPublishDailyWorldPulse } from "@/lib/domain/world-pulse";

const primarySource: Source = {
  sourceName: "Europeiska kommissionen",
  url: "https://ec.europa.eu/example/decision",
  sourceType: "primary",
  publishedAt: "2026-08-19",
  eventDate: "2026-08-19",
  supportsClaim: "Den officiella publiceringen styrker den avgränsade lägesbedömningen.",
};

function stableSection(headline: string) {
  return {
    status: "stable" as const,
    headline,
    summary: "Ingen verifierad materiell förändring hittades i det granskade underlaget sedan föregående brief.",
    implication: null,
    claimScope: "none" as const,
    sources: [primarySource],
    linkedEventKeys: [],
    coverageNote: "Kontrollerad mot en aktuell primärkälla inom den avgränsade täckningsperioden.",
  };
}

function calmPulse(): WorldPulse {
  return {
    coverage: "complete" as const,
    asOf: "2026-08-19T07:00:00.000Z",
    overallStatus: "calm" as const,
    summary: "Det granskade underlaget visar inga verifierade materiella skiften som kräver en ny åtgärd i dag.",
    conflictSecurity: stableSection("Värld och säkerhet"),
    economy: stableSection("Ekonomi och marknader"),
    personalExposure: stableSection("Din exponering"),
  };
}

describe("daglig world pulse", () => {
  it("accepterar en komplett, källstödd och avgränsad lugn lägesbild", () => {
    expect(worldPulseSchema.safeParse(calmPulse()).success).toBe(true);
  });

  it("tillåter inte att partiell täckning ser ut som ett lugnt all-clear", () => {
    const pulse = calmPulse();
    pulse.coverage = "partial";
    expect(worldPulseSchema.safeParse(pulse).success).toBe(false);
  });

  it("kräver en giltig ISO-tidpunkt för säkra datumformat i gränssnittet", () => {
    const pulse = calmPulse();
    pulse.asOf = "i morse";
    expect(worldPulseSchema.safeParse(pulse).success).toBe(false);
  });

  it("låter inte en stabil lins skapa en händelselänk", () => {
    const pulse = calmPulse();
    pulse.economy.linkedEventKeys = ["global-rates-decision"];
    expect(worldPulseSchema.safeParse(pulse).success).toBe(false);
  });

  it("kräver källor för varje tillgänglig lins", () => {
    const pulse = calmPulse();
    pulse.personalExposure.sources = [];
    expect(worldPulseSchema.safeParse(pulse).success).toBe(false);
  });

  it("gör tre-lins-kontrollen synlig för både discovery och editorial", () => {
    const discovery = discoveryInstructions({
      profile: DEFAULT_PROFILE_SETTINGS,
      coverageFrom: "2026-08-18T07:00:00.000Z",
      now: "2026-08-19T07:00:00.000Z",
      includeWorldPulse: true,
    });
    const editorial = editorialInstructions({
      profile: DEFAULT_PROFILE_SETTINGS,
      existingEvents: [],
      coverageFrom: "2026-08-18T07:00:00.000Z",
      includeWorldPulse: true,
    });
    expect(discovery).toContain("worldPulseScan");
    expect(discovery).toContain("två oberoende etablerade redaktionella källor");
    expect(editorial).toContain("worldPulse");
    expect(editorial).toContain("aldrig ett operativt utfall");
  });

  it("kräver rak svensk brieftext i båda redaktionella stegen", () => {
    const discovery = discoveryInstructions({
      profile: DEFAULT_PROFILE_SETTINGS,
      coverageFrom: "2026-08-18T07:00:00.000Z",
      now: "2026-08-19T07:00:00.000Z",
    });
    const editorial = editorialInstructions({
      profile: DEFAULT_PROFILE_SETTINGS,
      existingEvents: [],
      coverageFrom: "2026-08-18T07:00:00.000Z",
    });
    expect(discovery).toContain("SPRÅK I DISCOVERY");
    expect(editorial).toContain("RAK SVENSK BRIEFPOLICY (BINDANDE)");
    expect(editorial).toContain("Ingen åtgärd behövs nu.");
    expect(editorial).toContain('"kan" endast när det finns verklig, kvarvarande osäkerhet');
  });

  it("skickar discovery-pulsen som ett separat underlag till redaktionella steget", () => {
    const input = editorialInput([], calmPulse());
    expect(input).toContain("worldPulseScan");
    expect(input).toContain("conflictSecurity");
  });

  it("kräver oberoende redaktionell verifiering för operativa konfliktpåståenden", () => {
    const conflict = {
      ...worldPulseSchema.parse(calmPulse()).conflictSecurity,
      status: "changed" as const,
      claimScope: "operational" as const,
      headline: "Kontrollerat område uppges ha ändrats efter strider",
      summary: "Ett operativt utfall har rapporterats och behöver oberoende redaktionell verifiering.",
    };
    const reuters = { ...primarySource, sourceName: "Reuters", url: "https://www.reuters.com/world/example", sourceType: "secondary" as const };
    const ap = { ...primarySource, sourceName: "Associated Press", url: "https://apnews.com/article/example", sourceType: "secondary" as const };
    expect(requiresIndependentConflictEvidence(conflict)).toBe(true);
    expect(hasIndependentEditorialSources([reuters])).toBe(false);
    expect(hasIndependentEditorialSources([reuters, ap])).toBe(true);
  });

  it("sparar huvudbriefens lugna dag men lämnar en specialbrief tyst", () => {
    expect(shouldPublishDailyWorldPulse({
      itemCount: 0,
      onlyWhenChanged: true,
      isPrimary: true,
      pulse: calmPulse(),
    })).toBe(true);
    expect(shouldPublishDailyWorldPulse({
      itemCount: 0,
      onlyWhenChanged: true,
      isPrimary: false,
      pulse: calmPulse(),
    })).toBe(false);
  });
});
