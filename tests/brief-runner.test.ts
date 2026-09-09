import { describe, expect, it } from "vitest";
import { canTransition, statusLabels } from "@/lib/domain/event-lifecycle";
import { isBriefDue } from "@/lib/domain/schedule";
import { hasSufficientVerification, validateSourceDates } from "@/lib/domain/source-policy";
import { allowedDomainsForPolicy, filterSourcesByPolicy } from "@/lib/domain/source-catalog";
import { DEFAULT_PROFILE_SETTINGS, editorialCandidateSchema, strategicRadarSchema, weeklyRecapSchema, type EditorialCandidate, type Source, type StrategicRadar } from "@/lib/domain/types";
import { preparePublishItems, prepareRegistryItems, selectEditorialEventContext } from "@/lib/domain/editorial-gate";
import { buildWeeklyRecap } from "@/lib/services/brief-runner";

const primarySource: Source = {
  sourceName: "Europeiska kommissionen",
  url: "https://ec.europa.eu/example/decision",
  sourceType: "primary",
  publishedAt: "2026-08-18",
  eventDate: "2026-08-18",
  supportsClaim: "Kommissionens officiella beslut beskriver den antagna förändringen.",
};

function decision(overrides: Partial<EditorialCandidate> = {}): EditorialCandidate {
  return {
    canonicalKey: "eu-ai-rules-implementation",
    title: "EU fastställer nästa steg för AI-reglerna",
    category: "regulation",
    actors: ["Europeiska kommissionen"],
    regions: ["Sverige", "EU"],
    status: "adopted",
    eventDate: "2026-08-18",
    effectiveDate: "2026-09-01",
    whatChanged: "Reglerna har antagits med ett fastställt datum för nästa genomförandesteg.",
    termsSummary: "Beslutet fastställer bindande krav och ett datum för nästa steg.",
    materialFacts: [{
      dimension: "legal_obligation",
      direction: "introduced",
      subject: "AI-system som omfattas av EU-reglerna",
      value: "Bindande krav från 2026-09-01",
    }],
    shortTermImpact: "Berörda team behöver kontrollera kravbild och tidsplan.",
    longTermImpact: "Reglerna påverkar produkt- och leverantörsstrategi under kommande år.",
    sources: [primarySource],
    matchedEventId: null,
    previousStatus: null,
    updateKind: "new_event",
    materialChange: true,
    whyRelevant: "Det berör Eriks marknad, produktstrategi och regulatoriska exponering i EU.",
    relevanceFactors: {
      personalExposure: 80,
      materiality: 80,
      actionability: 75,
      confirmation: 95,
      timeCriticality: 70,
    },
    systemicOverride: false,
    recommendation: "monitor",
    confidence: "high",
    verified: true,
    shouldPublish: true,
    ...overrides,
  };
}

function prepare(decisions: EditorialCandidate[], overrides: Partial<typeof DEFAULT_PROFILE_SETTINGS> = {}) {
  return preparePublishItems({
    decisions,
    profile: { ...DEFAULT_PROFILE_SETTINGS, ...overrides },
    events: [],
    states: [],
    knownUpdates: [],
  });
}

function strategicRadar(overrides: Partial<StrategicRadar> = {}): StrategicRadar {
  return {
    coverage: "complete",
    asOf: "2026-08-20T05:00:00.000Z",
    aiRoadmap: {
      status: "items_found",
      summary: "En officiellt annonserad modellförmåga är relevant.",
      items: [{
        kind: "ai_roadmap",
        title: "Leverantören annonserar ny modellförmåga",
        status: "officially_announced",
        whatChanged: "Leverantören har officiellt annonserat en kommande modellförmåga.",
        whyRelevant: "Den berör ett uttalat intresse i användarens teknikprofil.",
        nextStep: "Ingen åtgärd behövs nu. Bevaka det officiella lanseringsdatumet.",
        date: "2026-09-01",
        endDate: null,
        location: null,
        sources: [primarySource],
      }],
    },
    businessOpportunities: {
      status: "none_relevant",
      summary: "Ingen relevant post.",
      items: [],
    },
    contexts: {
      status: "none_relevant",
      summary: "Ingen relevant post.",
      items: [],
    },
    ...overrides,
  };
}

describe("redaktionell publiceringsgrind", () => {
  it("bygger veckosammanfattningen enbart från sparade händelseuppdateringar", () => {
    const recap = buildWeeklyRecap({
      context: {
        periodStart: "2026-08-17",
        periodEnd: "2026-08-20",
        items: [{
          eventId: "d4e9973e-9ad3-4ba4-b4cc-5bc2c84a320f",
          eventUpdateId: "41a8fb13-540b-4b2c-93cf-a12c7395d963",
          date: "2026-08-19",
          title: "EU fastställer nästa steg för AI-reglerna",
          whatChanged: "Reglerna har antagits med ett fastställt datum för nästa genomförandesteg.",
          whyItMatters: "Det påverkar Eriks marknad, produktstrategi och regulatoriska exponering i EU.",
          relevanceScore: 84,
          sources: [primarySource],
        }],
      },
      selection: { eventUpdateIds: ["41a8fb13-540b-4b2c-93cf-a12c7395d963"] },
    });

    expect(weeklyRecapSchema.safeParse(recap).success).toBe(true);
    expect(recap.items).toHaveLength(1);
    expect(recap.items[0]).toMatchObject({
      eventId: "d4e9973e-9ad3-4ba4-b4cc-5bc2c84a320f",
      eventUpdateId: "41a8fb13-540b-4b2c-93cf-a12c7395d963",
      date: "2026-08-19",
      whatChanged: "Reglerna har antagits med ett fastställt datum för nästa genomförandesteg.",
      sources: [primarySource],
    });
    expect(recap.summary).toContain("Dagens nya beslutskort visas ovanför.");
  });

  it("faller tillbaka till sparade veckoposter när modellen inte väljer något", () => {
    const recap = buildWeeklyRecap({
      context: {
        periodStart: "2026-08-17",
        periodEnd: "2026-08-20",
        items: [{
          eventId: "d4e9973e-9ad3-4ba4-b4cc-5bc2c84a320f",
          eventUpdateId: "41a8fb13-540b-4b2c-93cf-a12c7395d963",
          date: "2026-08-19",
          title: "EU fastställer nästa steg för AI-reglerna",
          whatChanged: "Reglerna har antagits med ett fastställt datum för nästa genomförandesteg.",
          whyItMatters: "Det påverkar Eriks marknad, produktstrategi och regulatoriska exponering i EU.",
          relevanceScore: 84,
          sources: [primarySource],
        }],
      },
      selection: { eventUpdateIds: [] },
    });

    expect(recap.items.map((item) => item.eventUpdateId)).toEqual(["41a8fb13-540b-4b2c-93cf-a12c7395d963"]);
  });

  it("stoppar en veckoselektion som hänvisar till en osparad uppdatering", () => {
    expect(() => buildWeeklyRecap({
      context: { periodStart: "2026-08-17", periodEnd: "2026-08-20", items: [] },
      selection: { eventUpdateIds: ["41a8fb13-540b-4b2c-93cf-a12c7395d963"] },
    })).toThrow("inte finns i den sparade briefhistoriken");
  });

  it("kräver officiell status för AI-roadmap och ett exakt tomt-besked", () => {
    expect(strategicRadarSchema.safeParse(strategicRadar()).success).toBe(true);
    expect(strategicRadarSchema.safeParse(strategicRadar({
      aiRoadmap: {
        status: "items_found",
        summary: "En post.",
        items: [{
          ...strategicRadar().aiRoadmap.items[0]!,
          status: "open",
        }],
      },
    })).success).toBe(false);
    expect(strategicRadarSchema.safeParse(strategicRadar({
      businessOpportunities: { status: "none_relevant", summary: "Inget nytt.", items: [] },
    })).success).toBe(false);
  });

  it("kräver datum och plats eller Digitalt för sammanhang", () => {
    const contextItem = {
      kind: "context" as const,
      title: "Verifierad AI-konferens",
      status: "upcoming" as const,
      whatChanged: "Arrangören har bekräftat nästa års konferensdatum.",
      whyRelevant: "Konferensen matchar ett uttalat intresse i användarens profil.",
      nextStep: "Registrera intresse före sista anmälningsdag.",
      date: "2026-10-12",
      endDate: "2026-10-13",
      location: "Digitalt",
      sources: [primarySource],
    };
    expect(strategicRadarSchema.safeParse(strategicRadar({
      contexts: { status: "items_found", summary: "Ett relevant sammanhang är öppet.", items: [contextItem] },
    })).success).toBe(true);
    expect(strategicRadarSchema.safeParse(strategicRadar({
      contexts: { status: "items_found", summary: "Ett relevant sammanhang är öppet.", items: [{ ...contextItem, date: null, location: null }] },
    })).success).toBe(false);
  });

  it("låter en lugn dag resultera i noll händelser", () => {
    expect(prepare([])).toEqual([]);
  });

  it("bevarar en verifierad händelse i registret även när den inte får plats i briefen", () => {
    const candidate = decision({ shouldPublish: false });
    expect(prepareRegistryItems({ decisions: [candidate], profile: DEFAULT_PROFILE_SETTINGS, events: [] })).toHaveLength(1);
    expect(prepare([candidate])).toHaveLength(0);
  });

  it("kräver en strukturerad faktaförändring för villkors- och påverkanposter", () => {
    expect(editorialCandidateSchema.safeParse(decision({
      updateKind: "impact_change",
      materialChange: true,
      materialFacts: [],
    })).success).toBe(false);
  });

  it("slår ihop tio artiklar om samma avtal till en permanent händelse", () => {
    const tenReports = Array.from({ length: 10 }, (_, index) =>
      decision({
        title: `EU-uppgörelse, artikel ${index + 1}`,
        canonicalKey: "eu-shared-trade-agreement",
        relevanceFactors: { personalExposure: 78 + (index % 3), materiality: 80, actionability: 70, confirmation: 95, timeCriticality: 65 },
      }),
    );
    const items = prepare(tenReports);
    expect(items).toHaveLength(1);
    expect(items[0].canonicalKey).toBe("eu-shared-trade-agreement");
  });

  it("skickar bara kandidatmatchningar, inte hela registret, till redaktionella steget", () => {
    const matched = {
      id: "d4e9973e-9ad3-4ba4-b4cc-5bc2c84a320f",
      canonicalKey: "eu-ai-rules-implementation",
      title: "EU fastställer nästa steg för AI-reglerna",
      category: "regulation",
      actors: ["Europeiska kommissionen"],
      regions: ["Sverige", "EU"],
      status: "adopted" as const,
      termsSummary: "Beslutet fastställer bindande krav och ett datum för nästa steg.",
      effectiveDate: "2026-09-01",
      confidence: "high",
      shortTermImpact: "Berörda team behöver kontrollera kravbild och tidsplan.",
      longTermImpact: "Reglerna påverkar produkt- och leverantörsstrategi under kommande år.",
    };
    const unrelated = { ...matched, id: "a34ff997-9ad3-4ba4-b4cc-5bc2c84a999f", canonicalKey: "unrelated-event", title: "En helt annan händelse", actors: ["En annan aktör"] };
    const context = selectEditorialEventContext([decision()], [unrelated, matched]);
    expect(context.map((event) => event.id)).toEqual([matched.id]);
  });

  it("bevarar föreslagen status i stället för att uppgradera den till undertecknad", () => {
    const [item] = prepare([decision({ status: "proposed", updateKind: "new_event" })]);
    expect(item.status).toBe("proposed");
    expect(statusLabels[item.status]).toBe("Föreslaget");
  });

  it("upprepar inte en händelse utan en materiell förändring", () => {
    const existing = {
      id: "d4e9973e-9ad3-4ba4-b4cc-5bc2c84a320f",
      canonicalKey: "eu-ai-rules-implementation",
      title: "EU fastställer nästa steg för AI-reglerna",
      category: "regulation" as const,
      actors: ["Europeiska kommissionen"],
      regions: ["Sverige", "EU"],
      status: "adopted" as const,
      termsSummary: "Beslutet fastställer bindande krav och ett datum för nästa steg.",
      effectiveDate: "2026-09-01",
      confidence: "high",
      shortTermImpact: "Berörda team behöver kontrollera kravbild och tidsplan.",
      longTermImpact: "Reglerna påverkar produkt- och leverantörsstrategi under kommande år.",
    };
    const items = preparePublishItems({
      decisions: [decision({ matchedEventId: existing.id, previousStatus: "adopted", updateKind: "no_material_change" })],
      profile: DEFAULT_PROFILE_SETTINGS,
      events: [existing],
      states: [],
      knownUpdates: [],
    });
    expect(items).toHaveLength(0);
  });

  it("kräver en primärkälla eller två oberoende trovärdiga sekundärkällor", () => {
    expect(hasSufficientVerification([primarySource])).toBe(true);
    expect(hasSufficientVerification([
      { ...primarySource, sourceName: "Reuters", url: "https://www.reuters.com/world/example", sourceType: "secondary" },
      { ...primarySource, sourceName: "Associated Press", url: "https://apnews.com/article/example", sourceType: "secondary" },
    ])).toBe(true);
    expect(hasSufficientVerification([{ ...primarySource, sourceName: "Obekräftad blogg", url: "https://example.com/post", sourceType: "secondary" }])).toBe(false);
  });

  it("litar inte på modellens egen etikett för en sekundärkälla", () => {
    const reutersMislabelledAsPrimary = {
      ...primarySource,
      sourceName: "Reuters",
      url: "https://www.reuters.com/world/example",
      sourceType: "primary" as const,
    };
    expect(prepare([decision({ sources: [reutersMislabelledAsPrimary] })])).toHaveLength(0);
  });

  it("gör reglagen till en deterministisk del av urvalet", () => {
    const candidate = decision({
      category: "technology",
      regions: ["USA"],
      relevanceFactors: { personalExposure: 70, materiality: 75, actionability: 70, confirmation: 100, timeCriticality: 70 },
    });
    const highPriority = prepare([candidate], { relevanceThreshold: 75, technologyWeight: 100, usaWeight: 100 });
    const lowPriority = prepare([candidate], { relevanceThreshold: 75, technologyWeight: 0, usaWeight: 0 });
    expect(highPriority).toHaveLength(1);
    expect(lowPriority).toHaveLength(0);
  });

  it("släpper igenom ett verifierat systemiskt undantag trots låg ämnesvikt", () => {
    const items = prepare(
      [decision({ systemicOverride: true, relevanceFactors: { personalExposure: 15, materiality: 96, actionability: 30, confirmation: 95, timeCriticality: 30 } })],
      { relevanceThreshold: 99, regulationWeight: 0, swedenEuWeight: 0 },
    );
    expect(items).toHaveLength(1);
  });

  it("släpper igenom ett statussteg som källorna redan har passerat", () => {
    const existing = {
      id: "d4e9973e-9ad3-4ba4-b4cc-5bc2c84a320f",
      canonicalKey: "eu-ai-rules-implementation",
      title: "EU fastställer nästa steg för AI-reglerna",
      category: "regulation" as const,
      actors: ["Europeiska kommissionen"],
      regions: ["Sverige", "EU"],
      status: "reported" as const,
      termsSummary: "Tidigare rapportering beskrev det väntade beslutet.",
      effectiveDate: null,
      confidence: "medium",
      shortTermImpact: "Avvakta formell bekräftelse.",
      longTermImpact: "Den långsiktiga påverkan var ännu osäker.",
    };
    const items = preparePublishItems({
      decisions: [decision({ matchedEventId: existing.id, status: "signed", updateKind: "status_change" })],
      profile: DEFAULT_PROFILE_SETTINGS,
      events: [existing],
      states: [],
      knownUpdates: [],
    });
    expect(canTransition("reported", "signed")).toBe(true);
    expect(items).toHaveLength(1);
  });

  it("publicerar ändrade faktiska villkor även när statusen är densamma", () => {
    const existing = {
      id: "d4e9973e-9ad3-4ba4-b4cc-5bc2c84a320f",
      canonicalKey: "eu-ai-rules-implementation",
      title: "EU fastställer nästa steg för AI-reglerna",
      category: "regulation" as const,
      actors: ["Europeiska kommissionen"],
      regions: ["Sverige", "EU"],
      status: "adopted" as const,
      termsSummary: "Beslutet fastställer bindande krav och ett datum för nästa steg.",
      effectiveDate: "2026-09-01",
      confidence: "high",
      shortTermImpact: "Berörda team behöver kontrollera kravbild och tidsplan.",
      longTermImpact: "Reglerna påverkar produkt- och leverantörsstrategi under kommande år.",
    };
    const items = preparePublishItems({
      decisions: [decision({
        matchedEventId: existing.id,
        previousStatus: "adopted",
        updateKind: "terms_change",
        termsSummary: "Beslutet fastställer bindande krav, utökad dokumentation och ett datum för nästa steg.",
        materialFacts: [{
          dimension: "legal_obligation",
          direction: "introduced",
          subject: "AI-system som omfattas av EU-reglerna",
          value: "Bindande krav och utökad dokumentation från 2026-09-01",
        }],
      })],
      profile: DEFAULT_PROFILE_SETTINGS,
      events: [existing],
      states: [],
      knownUpdates: [],
    });
    expect(items).toHaveLength(1);
  });

  it("återspelar en identisk känd uppdatering till en ny briefdefinition", () => {
    const initial = prepareRegistryItems({
      decisions: [decision()],
      profile: DEFAULT_PROFILE_SETTINGS,
      events: [],
    })[0]!;
    const existing = {
      id: "d4e9973e-9ad3-4ba4-b4cc-5bc2c84a320f",
      canonicalKey: initial.canonicalKey,
      title: initial.title,
      category: initial.category,
      actors: initial.actors,
      regions: initial.regions,
      status: initial.status,
      termsSummary: initial.termsSummary,
      effectiveDate: initial.effectiveDate,
      confidence: initial.confidence,
      shortTermImpact: initial.shortTermImpact,
      longTermImpact: initial.longTermImpact,
    };
    const knownUpdate = {
      id: "41a8fb13-540b-4b2c-93cf-a12c7395d963",
      eventId: existing.id,
      materialFingerprint: initial.materialFingerprint,
      previousStatus: null,
      nextStatus: initial.status,
      occurredAt: "2026-08-18T07:15:00.000Z",
    };

    const items = preparePublishItems({
      decisions: [decision({ matchedEventId: existing.id, previousStatus: "adopted", updateKind: "no_material_change" })],
      profile: DEFAULT_PROFILE_SETTINGS,
      events: [existing],
      // En tom statuslista representerar en separat briefdefinition som ännu
      // inte har fått den globala uppdateringen.
      states: [],
      knownUpdates: [knownUpdate],
      coverageFrom: "2026-08-18T07:00:00.000Z",
    });

    expect(items).toHaveLength(1);
    expect(items[0].materialFingerprint).toBe(knownUpdate.materialFingerprint);
    expect(items[0].updateKind).toBe("no_material_change");
  });

  it("återanvänder inte en gammal uppdatering när de faktiska villkoren har ändrats", () => {
    const initial = prepareRegistryItems({
      decisions: [decision()],
      profile: DEFAULT_PROFILE_SETTINGS,
      events: [],
    })[0]!;
    const existing = {
      id: "d4e9973e-9ad3-4ba4-b4cc-5bc2c84a320f",
      canonicalKey: initial.canonicalKey,
      title: initial.title,
      category: initial.category,
      actors: initial.actors,
      regions: initial.regions,
      status: initial.status,
      termsSummary: initial.termsSummary,
      effectiveDate: initial.effectiveDate,
      confidence: initial.confidence,
      shortTermImpact: initial.shortTermImpact,
      longTermImpact: initial.longTermImpact,
    };
    const knownUpdate = {
      id: "41a8fb13-540b-4b2c-93cf-a12c7395d963",
      eventId: existing.id,
      materialFingerprint: initial.materialFingerprint,
      previousStatus: null,
      nextStatus: initial.status,
      occurredAt: "2026-08-18T07:15:00.000Z",
    };

    const items = preparePublishItems({
      decisions: [decision({
        matchedEventId: existing.id,
        previousStatus: "adopted",
        updateKind: "terms_change",
        termsSummary: "Beslutet fastställer bindande krav, utökad dokumentation och ett datum för nästa steg.",
        materialFacts: [{
          dimension: "legal_obligation",
          direction: "introduced",
          subject: "AI-system som omfattas av EU-reglerna",
          value: "Bindande krav och utökad dokumentation från 2026-09-01",
        }],
      })],
      profile: DEFAULT_PROFILE_SETTINGS,
      events: [existing],
      states: [],
      knownUpdates: [knownUpdate],
      coverageFrom: "2026-08-18T07:00:00.000Z",
    });

    expect(items).toHaveLength(1);
    expect(items[0].materialFingerprint).not.toBe(knownUpdate.materialFingerprint);
    expect(items[0].previousStatus).toBe("adopted");
  });

  it("skapar inte en ny post för omskrivna villkor när materialFacts redan har samma fingerprint", () => {
    const initial = prepareRegistryItems({
      decisions: [decision()],
      profile: DEFAULT_PROFILE_SETTINGS,
      events: [],
    })[0]!;
    const existing = {
      id: "d4e9973e-9ad3-4ba4-b4cc-5bc2c84a320f",
      canonicalKey: initial.canonicalKey,
      title: initial.title,
      category: initial.category,
      actors: initial.actors,
      regions: initial.regions,
      status: initial.status,
      termsSummary: initial.termsSummary,
      effectiveDate: initial.effectiveDate,
      confidence: initial.confidence,
      shortTermImpact: initial.shortTermImpact,
      longTermImpact: initial.longTermImpact,
    };
    const knownUpdate = {
      id: "41a8fb13-540b-4b2c-93cf-a12c7395d963",
      eventId: existing.id,
      materialFingerprint: initial.materialFingerprint,
      previousStatus: null,
      nextStatus: initial.status,
      occurredAt: "2026-08-18T07:15:00.000Z",
    };

    const items = preparePublishItems({
      decisions: [decision({
        matchedEventId: existing.id,
        previousStatus: "adopted",
        updateKind: "terms_change",
        termsSummary: "De bindande kraven gäller från 1 september 2026 i nästa genomförandefas.",
        materialFacts: initial.materialFacts,
      })],
      profile: DEFAULT_PROFILE_SETTINGS,
      events: [existing],
      states: [],
      knownUpdates: [knownUpdate],
      // Uppdateringen ligger utanför denna definitions täckningsfönster och
      // får därför inte återspelas som en ny briefpost.
      coverageFrom: "2026-08-18T08:00:00.000Z",
    });

    expect(items).toHaveLength(0);
  });

  it("använder direktnotiströskeln som ett separat, sparat urval", () => {
    expect(prepare([decision()], { alertThreshold: 75 })[0].directAlert).toBe(true);
    expect(prepare([decision()], { alertThreshold: 95 })[0].directAlert).toBe(false);
  });

  it("kör vid eller efter användarens valda lokala tid", () => {
    const settings = { ...DEFAULT_PROFILE_SETTINGS, dailyBriefTime: "07:30" };
    expect(isBriefDue(settings, new Date("2026-08-18T05:00:00Z"))).toBe(false); // 07:00 Stockholm (CEST)
    expect(isBriefDue(settings, new Date("2026-08-18T05:45:00Z"))).toBe(true); // 07:45 Stockholm (CEST)
  });

  it("håller isär händelse- och publiceringsdatum", () => {
    expect(validateSourceDates({ ...primarySource, eventDate: "2026-08-19", publishedAt: "2026-08-18" })).toBe(false);
    expect(validateSourceDates(primarySource)).toBe(true);
  });

  it("blockerar text som innehåller köp- eller säljrekommendationer", () => {
    const items = prepare([decision({ shortTermImpact: "Köp aktien omedelbart före marknadens öppning." })]);
    expect(items).toHaveLength(0);
  });

  it("tar bort en blockerad källa både från sökning och publicerad källkedja", () => {
    const cnn = { ...primarySource, sourceName: "CNN", url: "https://www.cnn.com/example", sourceType: "secondary" as const };
    const policy = [{
      domain: "cnn.com",
      sourceName: "CNN",
      sourceKind: "editorial" as const,
      active: false,
      blocked: true,
      priority: "normal" as const,
      roles: [],
      topicFilter: "",
      verificationRequirement: "verify_material" as const,
      frequency: "material" as const,
    }];
    expect(allowedDomainsForPolicy(policy)).not.toContain("cnn.com");
    expect(filterSourcesByPolicy([cnn], policy)).toEqual([]);
  });
});
