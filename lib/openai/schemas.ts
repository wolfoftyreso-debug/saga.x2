import type { ResponseFormatTextJSONSchemaConfig } from "openai/resources/responses/responses";

const statuses = [
  "rumor", "reported", "proposed", "negotiating", "announced", "signed",
  "adopted", "effective", "implemented", "changed", "reversed",
];
const categories = [
  "economy", "technology", "regulation", "geopolitics_trade", "security", "energy_logistics", "payments", "infrastructure",
  "business", "local", "personal_interest",
];
const worldPulseCoverage = ["complete", "partial", "unavailable"];
const worldPulseOverallStates = ["calm", "changed", "partial", "unavailable"];
const worldPulseSectionStates = ["changed", "stable", "uncertain", "unavailable"];
const worldPulseClaimScopes = ["none", "policy", "operational", "mixed"];
const strategicRadarCoverage = ["complete", "partial", "unavailable"];
const strategicRadarSectionStatuses = ["items_found", "none_relevant", "unavailable"];
const strategicRadarItemKinds = ["ai_roadmap", "business_opportunity", "context"];
const strategicRadarItemStatuses = [
  "officially_announced",
  "official_roadmap",
  "announced",
  "open",
  "deadline",
  "upcoming",
  "registration_open",
];

const nullableString = { type: ["string", "null"] };
const stringList = { type: "array", items: { type: "string" } };

const sourceSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    sourceName: { type: "string" },
    url: { type: "string" },
    sourceType: { type: "string", enum: ["primary", "secondary"] },
    publishedAt: nullableString,
    eventDate: nullableString,
    supportsClaim: { type: "string" },
  },
  required: ["sourceName", "url", "sourceType", "publishedAt", "eventDate", "supportsClaim"],
};

const worldPulseSectionSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: worldPulseSectionStates },
    headline: { type: "string" },
    summary: { type: "string" },
    implication: nullableString,
    claimScope: { type: "string", enum: worldPulseClaimScopes },
    sources: { type: "array", items: sourceSchema, maxItems: 3 },
    linkedEventKeys: { type: "array", items: { type: "string" }, maxItems: 3 },
    coverageNote: { type: "string" },
  },
  required: ["status", "headline", "summary", "implication", "claimScope", "sources", "linkedEventKeys", "coverageNote"],
};

/**
 * This is an evidence-led state pulse, not a fourth event list. The server
 * validates source sufficiency again after the model returns it.
 */
const worldPulseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    coverage: { type: "string", enum: worldPulseCoverage },
    asOf: { type: "string", format: "date-time" },
    overallStatus: { type: "string", enum: worldPulseOverallStates },
    summary: { type: "string" },
    conflictSecurity: worldPulseSectionSchema,
    economy: worldPulseSectionSchema,
    personalExposure: worldPulseSectionSchema,
  },
  required: ["coverage", "asOf", "overallStatus", "summary", "conflictSecurity", "economy", "personalExposure"],
};

const nullableWorldPulseSchema = {
  anyOf: [worldPulseSchema, { type: "null" }],
};

const strategicRadarItemSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    kind: { type: "string", enum: strategicRadarItemKinds },
    title: { type: "string" },
    status: { type: "string", enum: strategicRadarItemStatuses },
    whatChanged: { type: "string" },
    whyRelevant: { type: "string" },
    nextStep: { type: "string" },
    date: nullableString,
    endDate: nullableString,
    location: nullableString,
    sources: { type: "array", items: sourceSchema, minItems: 1, maxItems: 3 },
  },
  required: ["kind", "title", "status", "whatChanged", "whyRelevant", "nextStep", "date", "endDate", "location", "sources"],
};

const strategicRadarSectionSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: strategicRadarSectionStatuses },
    summary: { type: "string" },
    items: { type: "array", items: strategicRadarItemSchema, maxItems: 3 },
  },
  required: ["status", "summary", "items"],
};

const strategicRadarSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    coverage: { type: "string", enum: strategicRadarCoverage },
    asOf: { type: "string", format: "date-time" },
    aiRoadmap: strategicRadarSectionSchema,
    businessOpportunities: strategicRadarSectionSchema,
    contexts: strategicRadarSectionSchema,
  },
  required: ["coverage", "asOf", "aiRoadmap", "businessOpportunities", "contexts"],
};

const nullableStrategicRadarSchema = {
  anyOf: [strategicRadarSchema, { type: "null" }],
};

/**
 * The model chooses only event-update IDs from the persisted weekly context.
 * The runner rejects unknown IDs and rehydrates the display text and sources.
 */
const weeklyRecapSelectionSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    eventUpdateIds: { type: "array", items: { type: "string" }, maxItems: 5 },
  },
  required: ["eventUpdateIds"],
};

const nullableWeeklyRecapSelectionSchema = {
  anyOf: [weeklyRecapSelectionSchema, { type: "null" }],
};

const materialFactSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    dimension: {
      type: "string",
      enum: [
        "legal_obligation", "scope", "deadline", "threshold", "price_or_cost",
        "access_or_availability", "capacity", "security_or_risk", "supply_or_logistics",
        "capital_or_finance", "other",
      ],
    },
    direction: { type: "string", enum: ["introduced", "removed", "increased", "decreased", "changed"] },
    subject: { type: "string" },
    value: nullableString,
  },
  required: ["dimension", "direction", "subject", "value"],
};

const candidateProperties = {
  canonicalKey: { type: "string" },
  title: { type: "string" },
  category: { type: "string", enum: categories },
  actors: stringList,
  regions: stringList,
  status: { type: "string", enum: statuses },
  eventDate: nullableString,
  effectiveDate: nullableString,
  whatChanged: { type: "string" },
  termsSummary: { type: "string" },
  materialFacts: { type: "array", items: materialFactSchema },
  shortTermImpact: { type: "string" },
  longTermImpact: { type: "string" },
  sources: { type: "array", items: sourceSchema },
};

const candidateSchema = {
  type: "object",
  additionalProperties: false,
  properties: candidateProperties,
  required: Object.keys(candidateProperties),
};

export const discoveryResponseFormat: ResponseFormatTextJSONSchemaConfig = {
  type: "json_schema",
  name: "daily_brief_discovery",
  description: "Potentially relevant, source-backed real-world state changes.",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      searchedUntil: { type: "string" },
      candidates: { type: "array", items: candidateSchema },
      worldPulseScan: nullableWorldPulseSchema,
      strategicRadarScan: nullableStrategicRadarSchema,
    },
    required: ["searchedUntil", "candidates", "worldPulseScan", "strategicRadarScan"],
  },
};

const factorSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    personalExposure: { type: "number" },
    materiality: { type: "number" },
    actionability: { type: "number" },
    confirmation: { type: "number" },
    timeCriticality: { type: "number" },
  },
  required: ["personalExposure", "materiality", "actionability", "confirmation", "timeCriticality"],
};

const editorialProperties = {
  ...candidateProperties,
  matchedEventId: nullableString,
  previousStatus: { type: ["string", "null"], enum: [...statuses, null] },
  updateKind: {
    type: "string",
    enum: ["new_event", "status_change", "terms_change", "effective_date_change", "impact_change", "verification_change", "no_material_change"],
  },
  materialChange: { type: "boolean" },
  whyRelevant: { type: "string" },
  relevanceFactors: factorSchema,
  systemicOverride: { type: "boolean" },
  recommendation: { type: "string", enum: ["act", "monitor", "no_action"] },
  confidence: { type: "string", enum: ["high", "medium", "low"] },
  verified: { type: "boolean" },
  shouldPublish: { type: "boolean" },
};

const editorialCandidateSchema = {
  type: "object",
  additionalProperties: false,
  properties: editorialProperties,
  required: Object.keys(editorialProperties),
};

export const editorialResponseFormat: ResponseFormatTextJSONSchemaConfig = {
  type: "json_schema",
  name: "daily_brief_editorial",
  description: "Editorial decisions about whether source-backed candidates are material enough for a personal brief.",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      assessment: { type: "string" },
      decisions: { type: "array", items: editorialCandidateSchema },
      worldPulse: nullableWorldPulseSchema,
      weeklyRecap: nullableWeeklyRecapSelectionSchema,
      strategicRadar: nullableStrategicRadarSchema,
      watchlist: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            question: { type: "string" },
            expectedBy: nullableString,
            whyItMatters: { type: "string" },
          },
          required: ["question", "expectedBy", "whyItMatters"],
        },
      },
    },
    required: ["assessment", "decisions", "worldPulse", "weeklyRecap", "strategicRadar", "watchlist"],
  },
};
