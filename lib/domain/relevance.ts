import type { EventCategory, ProfileSettings, RelevanceFactors } from "@/lib/domain/types";

export function calculateRelevance(factors: RelevanceFactors): number {
  return Math.round(
    factors.personalExposure * 0.3 +
      factors.materiality * 0.25 +
      factors.actionability * 0.2 +
      factors.confirmation * 0.15 +
      factors.timeCriticality * 0.1,
  );
}

/**
 * The editorial model supplies an evidence-based score breakdown. User controls
 * alter only the personal-exposure component, preserving the published 30/25/20/15/10 model
 * while making topic and regional settings deterministic at selection time.
 */
export function applyProfileWeights(input: {
  factors: RelevanceFactors;
  category: EventCategory;
  regions: string[];
  settings: Pick<
    ProfileSettings,
    | "economyWeight"
    | "technologyWeight"
    | "regulationWeight"
    | "geopoliticsWeight"
    | "swedenEuWeight"
    | "usaWeight"
    | "gulfWeight"
  >;
}): RelevanceFactors {
  const categoryWeight = categoryPreference(input.category, input.settings);
  const geographicWeight = regionalPreference(input.regions, input.settings);
  const preference = geographicWeight === null ? categoryWeight : Math.round(categoryWeight * 0.6 + geographicWeight * 0.4);
  const adjustedExposure = clamp(Math.round(input.factors.personalExposure + (preference - 50) * 0.5));
  return { ...input.factors, personalExposure: adjustedExposure };
}

function categoryPreference(
  category: EventCategory,
  settings: Pick<ProfileSettings, "economyWeight" | "technologyWeight" | "regulationWeight" | "geopoliticsWeight">,
): number {
  switch (category) {
    case "economy":
    case "payments":
      return settings.economyWeight;
    case "technology":
    case "infrastructure":
      return settings.technologyWeight;
    case "business":
      return Math.round((settings.economyWeight + settings.technologyWeight) / 2);
    case "regulation":
      return settings.regulationWeight;
    case "geopolitics_trade":
    case "security":
    case "energy_logistics":
      return settings.geopoliticsWeight;
    case "local":
    case "personal_interest":
      // These are explicitly selected through the visible profile and brief
      // instructions. Keep the deterministic slider layer neutral rather than
      // silently treating a restaurant or sport preference as geopolitics.
      return 50;
  }
}

function regionalPreference(
  regions: string[],
  settings: Pick<ProfileSettings, "swedenEuWeight" | "usaWeight" | "gulfWeight">,
): number | null {
  const labels = regions.map((region) => region.toLocaleLowerCase("sv-SE"));
  const weights: number[] = [];
  if (labels.some((region) => /sverige|sweden|\beu\b|europeiska unionen|european union|europa/.test(region))) {
    weights.push(settings.swedenEuWeight);
  }
  if (labels.some((region) => /\busa\b|united states|amerika|u\.s\./.test(region))) weights.push(settings.usaWeight);
  if (labels.some((region) => /uae|förenade arabemiraten|united arab emirates|gulf|gulfregionen|gcc|dubai|saudi/.test(region))) {
    weights.push(settings.gulfWeight);
  }
  return weights.length ? Math.max(...weights) : null;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, value));
}

export function shouldPublishEvent(input: {
  score: number;
  materiality: number;
  systemicOverride: boolean;
  materialChange: boolean;
  settings: Pick<ProfileSettings, "relevanceThreshold">;
}): boolean {
  if (!input.materialChange) return false;
  if (input.systemicOverride && input.materiality >= 90) return true;
  return input.score >= input.settings.relevanceThreshold;
}

export function shouldSendDirectAlert(input: {
  score: number;
  systemicOverride: boolean;
  settings: Pick<ProfileSettings, "alertThreshold">;
}): boolean {
  return input.systemicOverride || input.score >= input.settings.alertThreshold;
}
