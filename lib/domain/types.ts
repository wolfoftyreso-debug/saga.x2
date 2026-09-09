import { z } from "zod";
import { isValidIanaTimezone } from "@/lib/utils/date";

export const EVENT_STATUSES = [
  "rumor",
  "reported",
  "proposed",
  "negotiating",
  "announced",
  "signed",
  "adopted",
  "effective",
  "implemented",
  "changed",
  "reversed",
] as const;

export const EVENT_CATEGORIES = [
  "economy",
  "technology",
  "regulation",
  "geopolitics_trade",
  "security",
  "energy_logistics",
  "payments",
  "infrastructure",
  "business",
  "local",
  "personal_interest",
] as const;

export const RESPONSE_RECOMMENDATIONS = ["act", "monitor", "no_action"] as const;
export const CONFIDENCE_LEVELS = ["high", "medium", "low"] as const;
export const SOURCE_TYPES = ["primary", "secondary"] as const;
/**
 * The world pulse is deliberately a compact state assessment, not another
 * event feed. Coverage is explicit so a degraded search can never be rendered
 * as a calm world. Section status uses "stable" only for the reviewed source
 * set, never as an assertion that nothing happened anywhere.
 */
export const WORLD_PULSE_COVERAGE = ["complete", "partial", "unavailable"] as const;
export const WORLD_PULSE_OVERALL_STATES = ["calm", "changed", "partial", "unavailable"] as const;
export const WORLD_PULSE_SECTION_STATES = ["changed", "stable", "uncertain", "unavailable"] as const;
export const WORLD_PULSE_CLAIM_SCOPES = ["none", "policy", "operational", "mixed"] as const;
/**
 * A strategic radar is a compact, source-backed extension to the primary
 * brief. It deliberately lives outside the event register: a future model
 * capability, an open business path, or a dated context can be useful before
 * it becomes a material state change in the user's existing operations.
 */
export const STRATEGIC_RADAR_COVERAGE = ["complete", "partial", "unavailable"] as const;
export const STRATEGIC_RADAR_SECTION_STATUSES = ["items_found", "none_relevant", "unavailable"] as const;
export const STRATEGIC_RADAR_ITEM_KINDS = ["ai_roadmap", "business_opportunity", "context"] as const;
export const STRATEGIC_RADAR_ITEM_STATUSES = [
  "officially_announced",
  "official_roadmap",
  "announced",
  "open",
  "deadline",
  "upcoming",
  "registration_open",
] as const;
export const STRATEGIC_RADAR_EMPTY_SUMMARY = "Ingen relevant post.";
/**
 * A compact factual vector for registry deduplication. Unlike brief prose it
 * describes observable changes in the outside world, so two brief definitions
 * cannot manufacture separate event updates merely by phrasing an impact
 * differently.
 */
export const MATERIAL_FACT_DIMENSIONS = [
  "legal_obligation",
  "scope",
  "deadline",
  "threshold",
  "price_or_cost",
  "access_or_availability",
  "capacity",
  "security_or_risk",
  "supply_or_logistics",
  "capital_or_finance",
  "other",
] as const;
export const MATERIAL_FACT_DIRECTIONS = ["introduced", "removed", "increased", "decreased", "changed"] as const;
export const UPDATE_KINDS = [
  "new_event",
  "status_change",
  "terms_change",
  "effective_date_change",
  "impact_change",
  "verification_change",
  "no_material_change",
] as const;

export type EventStatus = (typeof EVENT_STATUSES)[number];
export type EventCategory = (typeof EVENT_CATEGORIES)[number];
export type Recommendation = (typeof RESPONSE_RECOMMENDATIONS)[number];
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];
export type SourceType = (typeof SOURCE_TYPES)[number];
export type WorldPulseCoverage = (typeof WORLD_PULSE_COVERAGE)[number];
export type WorldPulseOverallState = (typeof WORLD_PULSE_OVERALL_STATES)[number];
export type WorldPulseSectionState = (typeof WORLD_PULSE_SECTION_STATES)[number];
export type WorldPulseClaimScope = (typeof WORLD_PULSE_CLAIM_SCOPES)[number];
export type StrategicRadarCoverage = (typeof STRATEGIC_RADAR_COVERAGE)[number];
export type StrategicRadarSectionStatus = (typeof STRATEGIC_RADAR_SECTION_STATUSES)[number];
export type StrategicRadarItemKind = (typeof STRATEGIC_RADAR_ITEM_KINDS)[number];
export type StrategicRadarItemStatus = (typeof STRATEGIC_RADAR_ITEM_STATUSES)[number];
export type MaterialFactDimension = (typeof MATERIAL_FACT_DIMENSIONS)[number];
export type MaterialFactDirection = (typeof MATERIAL_FACT_DIRECTIONS)[number];
export type UpdateKind = (typeof UPDATE_KINDS)[number];

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Ange datum som YYYY-MM-DD");

export const sourceSchema = z.object({
  sourceName: z.string().min(2).max(160),
  url: z.string().url(),
  sourceType: z.enum(SOURCE_TYPES),
  publishedAt: isoDate.nullable(),
  eventDate: isoDate.nullable(),
  supportsClaim: z.string().min(8).max(800),
});

/**
 * A weekly recap is assembled from already published brief items and their
 * event updates. It is not a second news feed and cannot introduce new facts.
 */
export const weeklyRecapItemSchema = z.object({
  eventId: z.string().uuid(),
  eventUpdateId: z.string().uuid(),
  /** Local date of the persisted update in the brief's timezone. */
  date: isoDate,
  title: z.string().min(8).max(180),
  whatChanged: z.string().min(12).max(1_200),
  whyItMatters: z.string().min(8).max(1_000),
  /** Exact stored source chain after source-policy filtering. */
  sources: z.array(sourceSchema).min(1).max(3),
});

export const weeklyRecapSchema = z.object({
  periodStart: isoDate,
  periodEnd: isoDate,
  summary: z.string().min(8).max(300),
  items: z.array(weeklyRecapItemSchema).max(5),
}).superRefine((recap, context) => {
  if (recap.periodStart > recap.periodEnd) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["periodStart"],
      message: "Veckans start får inte ligga efter slutdatumet.",
    });
  }
  const seenUpdates = new Set<string>();
  for (const [index, item] of recap.items.entries()) {
    if (item.date < recap.periodStart || item.date > recap.periodEnd) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["items", index, "date"],
        message: "En veckopost måste ligga inom sammanfattningens period.",
      });
    }
    if (seenUpdates.has(item.eventUpdateId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["items", index, "eventUpdateId"],
        message: "Samma händelseuppdatering får bara visas en gång per vecka.",
      });
    }
    seenUpdates.add(item.eventUpdateId);
  }
});

/**
 * The model selects durable IDs only. The runner rehydrates all prose,
 * dates and sources from the stored brief items before publishing.
 */
export const weeklyRecapSelectionSchema = z.object({
  eventUpdateIds: z.array(z.string().uuid()).max(5),
}).superRefine((selection, context) => {
  if (new Set(selection.eventUpdateIds).size !== selection.eventUpdateIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["eventUpdateIds"],
      message: "Samma händelseuppdatering får bara väljas en gång.",
    });
  }
});

export const worldPulseSectionSchema = z.object({
  status: z.enum(WORLD_PULSE_SECTION_STATES),
  headline: z.string().min(8).max(160),
  summary: z.string().min(12).max(700),
  implication: z.string().min(8).max(500).nullable(),
  /** A changed conflict/security claim declares whether it describes policy or an operational outcome. */
  claimScope: z.enum(WORLD_PULSE_CLAIM_SCOPES),
  /**
   * Each lens remains independently auditable. A calm result is not a guess:
   * it must cite the sources checked for that lens as well. An unavailable
   * lens is the sole exception because it explicitly makes no factual claim.
   */
  sources: z.array(sourceSchema).max(3),
  linkedEventKeys: z.array(z.string().min(8).max(240)).max(3),
  coverageNote: z.string().min(8).max(360),
}).superRefine((section, context) => {
  if (section.status === "unavailable" && section.sources.length > 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sources"],
      message: "En otillgänglig lins får inte ge sken av verifierad täckning.",
    });
  }
  if (section.status !== "unavailable" && section.sources.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sources"],
      message: "En tillgänglig världspulslins måste ha minst en källa.",
    });
  }
  if (section.status === "stable" && section.linkedEventKeys.length > 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["linkedEventKeys"],
      message: "En stabil lins får inte skapa eller länka nya beslutshändelser.",
    });
  }
  if (section.status !== "changed" && section.claimScope !== "none") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["claimScope"],
      message: "Endast en förändrad lins får beskriva ett sakpåstående som policy eller operativt utfall.",
    });
  }
});

export const worldPulseSchema = z.object({
  coverage: z.enum(WORLD_PULSE_COVERAGE),
  asOf: z.string().datetime({ offset: true }),
  overallStatus: z.enum(WORLD_PULSE_OVERALL_STATES),
  summary: z.string().min(12).max(700),
  conflictSecurity: worldPulseSectionSchema,
  economy: worldPulseSectionSchema,
  personalExposure: worldPulseSectionSchema,
}).superRefine((pulse, context) => {
  const sections = [pulse.conflictSecurity, pulse.economy, pulse.personalExposure];
  const hasChange = sections.some((section) => section.status === "changed");
  const hasIncompleteLens = sections.some((section) => section.status === "uncertain" || section.status === "unavailable");
  if (pulse.coverage === "complete" && hasIncompleteLens) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["coverage"],
      message: "Komplett täckning kan inte innehålla en osäker eller otillgänglig lins.",
    });
  }
  if (pulse.overallStatus === "calm" && (hasChange || hasIncompleteLens || pulse.coverage !== "complete")) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["overallStatus"],
      message: "En lugn världspuls kräver komplett täckning och tre stabila linser.",
    });
  }
  if (pulse.overallStatus === "changed" && !hasChange) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["overallStatus"],
      message: "En förändrad världspuls måste ha minst en materiellt förändrad lins.",
    });
  }
  if (pulse.overallStatus === "unavailable" && pulse.coverage !== "unavailable") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["coverage"],
      message: "Otillgängligt totalläge kräver otillgänglig täckning.",
    });
  }
  if (pulse.coverage === "unavailable" && pulse.overallStatus !== "unavailable") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["overallStatus"],
      message: "Otillgänglig täckning måste visas som ett otillgängligt totalläge.",
    });
  }
  if (pulse.overallStatus === "partial" && pulse.coverage === "complete" && !hasIncompleteLens) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["overallStatus"],
      message: "Partiellt totalläge kräver ett avgränsat eller osäkert underlag.",
    });
  }
});

export const strategicRadarItemSchema = z.object({
  kind: z.enum(STRATEGIC_RADAR_ITEM_KINDS),
  title: z.string().min(8).max(180),
  status: z.enum(STRATEGIC_RADAR_ITEM_STATUSES),
  /** The verified fact: no model prediction, sales pitch or investment view. */
  whatChanged: z.string().min(12).max(700),
  /** Direct profile-based reason, never an assumed private holding or plan. */
  whyRelevant: z.string().min(12).max(500),
  /** A concrete next move, or an explicit "Ingen åtgärd behövs nu." */
  nextStep: z.string().min(8).max(360),
  /** A public launch, application, deadline or event date when one exists. */
  date: isoDate.nullable(),
  /** Optional end date for multi-day contexts. */
  endDate: isoDate.nullable(),
  /** Required for contexts: physical place or exactly "Digitalt". */
  location: z.string().min(2).max(180).nullable(),
  sources: z.array(sourceSchema).min(1).max(3),
}).superRefine((item, context) => {
  const allowedStatuses: Record<StrategicRadarItemKind, StrategicRadarItemStatus[]> = {
    ai_roadmap: ["officially_announced", "official_roadmap"],
    business_opportunity: ["announced", "open", "deadline"],
    context: ["upcoming", "registration_open", "deadline"],
  };
  if (!allowedStatuses[item.kind].includes(item.status)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["status"],
      message: "Statusen passar inte den strategiska radarns posttyp.",
    });
  }
  if (item.kind === "context" && !item.date) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["date"],
      message: "Ett sammanhang måste ha ett verifierat datum.",
    });
  }
  if (item.kind === "context" && !item.location) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["location"],
      message: "Ett sammanhang måste ha en plats eller vara markerat som Digitalt.",
    });
  }
  if (item.endDate && item.date && item.endDate < item.date) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["endDate"],
      message: "Slutdatum kan inte infalla före startdatum.",
    });
  }
});

export const strategicRadarSectionSchema = z.object({
  status: z.enum(STRATEGIC_RADAR_SECTION_STATUSES),
  summary: z.string().min(1).max(280),
  items: z.array(strategicRadarItemSchema).max(3),
}).superRefine((section, context) => {
  if (section.status === "items_found" && section.items.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["items"],
      message: "En sektion med träffar måste innehålla minst en verifierad post.",
    });
  }
  if (section.status === "none_relevant" && (section.items.length > 0 || section.summary !== STRATEGIC_RADAR_EMPTY_SUMMARY)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "En tom strategisk sektion måste säga exakt 'Ingen relevant post.' och sakna poster.",
    });
  }
  if (section.status === "unavailable" && section.items.length > 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["items"],
      message: "En otillgänglig strategisk sektion får inte innehålla obekräftade poster.",
    });
  }
});

export const strategicRadarSchema = z.object({
  coverage: z.enum(STRATEGIC_RADAR_COVERAGE),
  asOf: z.string().datetime({ offset: true }),
  aiRoadmap: strategicRadarSectionSchema,
  businessOpportunities: strategicRadarSectionSchema,
  contexts: strategicRadarSectionSchema,
}).superRefine((radar, context) => {
  const sections = [radar.aiRoadmap, radar.businessOpportunities, radar.contexts];
  const unavailableCount = sections.filter((section) => section.status === "unavailable").length;
  if (radar.coverage === "complete" && unavailableCount > 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["coverage"],
      message: "Komplett radartäckning kan inte innehålla en otillgänglig sektion.",
    });
  }
  if (radar.coverage === "partial" && unavailableCount === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["coverage"],
      message: "Partiell radartäckning måste ha minst en otillgänglig sektion.",
    });
  }
  if (radar.coverage === "unavailable" && unavailableCount !== sections.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["coverage"],
      message: "Otillgänglig radartäckning kräver att alla sektioner är otillgängliga.",
    });
  }
  for (const item of radar.aiRoadmap.items) {
    if (item.kind !== "ai_roadmap") {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["aiRoadmap", "items"], message: "AI-sektionen får bara innehålla modellroadmap-poster." });
    }
  }
  for (const item of radar.businessOpportunities.items) {
    if (item.kind !== "business_opportunity") {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["businessOpportunities", "items"], message: "Affärssektionen får bara innehålla affärsmöjligheter." });
    }
  }
  for (const item of radar.contexts.items) {
    if (item.kind !== "context") {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["contexts", "items"], message: "Sammanhangssektionen får bara innehålla daterade sammanhang." });
    }
  }
});

export const relevanceFactorsSchema = z.object({
  personalExposure: z.number().min(0).max(100),
  materiality: z.number().min(0).max(100),
  actionability: z.number().min(0).max(100),
  confirmation: z.number().min(0).max(100),
  timeCriticality: z.number().min(0).max(100),
});

export const materialFactSchema = z.object({
  dimension: z.enum(MATERIAL_FACT_DIMENSIONS),
  direction: z.enum(MATERIAL_FACT_DIRECTIONS),
  /** The objectively affected rule, product, market, system or population. */
  subject: z.string().min(2).max(160),
  /** A compact factual value, threshold, date or scope; never personal advice. */
  value: z.string().min(1).max(240).nullable(),
});

export const candidateEventSchema = z.object({
  canonicalKey: z.string().min(8).max(240),
  title: z.string().min(8).max(180),
  category: z.enum(EVENT_CATEGORIES),
  actors: z.array(z.string().min(2).max(100)).max(12),
  regions: z.array(z.string().min(2).max(80)).max(12),
  status: z.enum(EVENT_STATUSES),
  eventDate: isoDate.nullable(),
  effectiveDate: isoDate.nullable(),
  whatChanged: z.string().min(15).max(1_200),
  termsSummary: z.string().min(8).max(1_200),
  materialFacts: z.array(materialFactSchema).max(8),
  shortTermImpact: z.string().min(8).max(800),
  longTermImpact: z.string().min(8).max(800),
  sources: z.array(sourceSchema).min(1).max(8),
});

export const discoveryResultSchema = z.object({
  searchedUntil: z.string().min(10),
  candidates: z.array(candidateEventSchema).max(60),
  /** Null for narrow watch runs; primary daily briefs always request it. */
  worldPulseScan: worldPulseSchema.nullable(),
  /** Primary brief only: verified leads for the final strategic radar. */
  strategicRadarScan: strategicRadarSchema.nullable(),
});

export const editorialCandidateSchema = candidateEventSchema.extend({
  matchedEventId: z.string().uuid().nullable(),
  previousStatus: z.enum(EVENT_STATUSES).nullable(),
  updateKind: z.enum(UPDATE_KINDS),
  materialChange: z.boolean(),
  whyRelevant: z.string().min(15).max(1_000),
  relevanceFactors: relevanceFactorsSchema,
  systemicOverride: z.boolean(),
  recommendation: z.enum(RESPONSE_RECOMMENDATIONS),
  confidence: z.enum(CONFIDENCE_LEVELS),
  verified: z.boolean(),
  shouldPublish: z.boolean(),
}).superRefine((candidate, context) => {
  if (
    candidate.materialChange
    && (candidate.updateKind === "terms_change" || candidate.updateKind === "impact_change")
    && candidate.materialFacts.length === 0
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["materialFacts"],
      message: "En villkors- eller påverkanförändring måste ha minst en strukturerad, observerbar material fact.",
    });
  }
});

export const editorialResultSchema = z.object({
  assessment: z.string().min(10).max(700),
  decisions: z.array(editorialCandidateSchema).max(60),
  watchlist: z
    .array(
      z.object({
        question: z.string().min(8).max(220),
        expectedBy: isoDate.nullable(),
        whyItMatters: z.string().min(8).max(500),
      }),
    )
    .max(3),
  /** Final source-backed daily pulse; null for watches and custom briefs. */
  worldPulse: worldPulseSchema.nullable(),
  /** Durable, ID-only weekly selection for the primary brief. */
  weeklyRecap: weeklyRecapSelectionSchema.nullable(),
  /** Final source-backed strategic radar; null for watches and custom briefs. */
  strategicRadar: strategicRadarSchema.nullable(),
});

export const profileSettingsSchema = z.object({
  economyWeight: z.number().int().min(0).max(100),
  technologyWeight: z.number().int().min(0).max(100),
  regulationWeight: z.number().int().min(0).max(100),
  geopoliticsWeight: z.number().int().min(0).max(100),
  swedenEuWeight: z.number().int().min(0).max(100),
  usaWeight: z.number().int().min(0).max(100),
  gulfWeight: z.number().int().min(0).max(100),
  maxItems: z.number().int().min(0).max(5),
  briefDepth: z.enum(["short", "deep"]),
  relevanceThreshold: z.number().int().min(0).max(100),
  alertThreshold: z.number().int().min(0).max(100),
  baseRegion: z.string().min(2).max(80),
  dailyBriefTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  timezone: z.string().min(3).max(80).refine(isValidIanaTimezone, "Ange en giltig IANA-tidszon, till exempel Europe/Stockholm."),
});

export type Source = z.infer<typeof sourceSchema>;
export type WeeklyRecapItem = z.infer<typeof weeklyRecapItemSchema>;
export type WeeklyRecap = z.infer<typeof weeklyRecapSchema>;
export type WeeklyRecapSelection = z.infer<typeof weeklyRecapSelectionSchema>;
export type WorldPulseSection = z.infer<typeof worldPulseSectionSchema>;
export type WorldPulse = z.infer<typeof worldPulseSchema>;
export type StrategicRadarItem = z.infer<typeof strategicRadarItemSchema>;
export type StrategicRadarSection = z.infer<typeof strategicRadarSectionSchema>;
export type StrategicRadar = z.infer<typeof strategicRadarSchema>;
export type RelevanceFactors = z.infer<typeof relevanceFactorsSchema>;
export type MaterialFact = z.infer<typeof materialFactSchema>;
export type CandidateEvent = z.infer<typeof candidateEventSchema>;
export type DiscoveryResult = z.infer<typeof discoveryResultSchema>;
export type EditorialCandidate = z.infer<typeof editorialCandidateSchema>;
export type EditorialResult = z.infer<typeof editorialResultSchema>;
export type ProfileSettings = z.infer<typeof profileSettingsSchema>;

export const DEFAULT_PROFILE_SETTINGS: ProfileSettings = {
  economyWeight: 75,
  technologyWeight: 90,
  regulationWeight: 85,
  geopoliticsWeight: 75,
  swedenEuWeight: 100,
  usaWeight: 90,
  gulfWeight: 70,
  maxItems: 5,
  briefDepth: "short",
  relevanceThreshold: 65,
  alertThreshold: 85,
  baseRegion: "Sverige",
  dailyBriefTime: "07:00",
  timezone: "Europe/Stockholm",
};
