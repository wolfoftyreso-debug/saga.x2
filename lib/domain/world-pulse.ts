import { classifySourceUrl, sourceDomain } from "@/lib/domain/source-policy";
import type { Source, WorldPulse, WorldPulseSection } from "@/lib/domain/types";

/**
 * A party can reliably describe its own policy but not battlefield outcomes.
 * Operational or mixed conflict claims therefore require two independent
 * editorial publishers. A conservative wording guard handles a model that
 * mislabeled an operational claim as a policy claim.
 */
export function requiresIndependentConflictEvidence(section: WorldPulseSection): boolean {
  if (section.status !== "changed") return false;
  if (section.claimScope === "operational" || section.claimScope === "mixed") return true;
  return /\b(territor|frontlin|fronten|strid|attack|bomb|missil|drönar|död|skad|förlust|trupp|militär|ockuper|erövr|kontroll över|casualt|battlefield|territory|troop|strike)\b/iu
    .test(`${section.headline} ${section.summary}`);
}

export function hasIndependentEditorialSources(sources: Source[]): boolean {
  const publishers = new Set(
    sources
      .filter((source) => classifySourceUrl(source.url) === "secondary")
      .map((source) => sourceDomain(source.url))
      .filter((domain): domain is string => Boolean(domain)),
  );
  return publishers.size >= 2;
}

/**
 * The primary brief is the user's daily orientation. Its fully verified pulse
 * therefore deserves a durable delivery even when no individual event card
 * cleared the personal relevance threshold. Custom only-when-changed briefs
 * intentionally retain their existing quiet behaviour in V1.
 */
export function shouldPublishDailyWorldPulse(input: {
  itemCount: number;
  onlyWhenChanged: boolean;
  isPrimary: boolean;
  pulse: WorldPulse | null;
}): boolean {
  return input.itemCount > 0
    || !input.onlyWhenChanged
    || (input.isPrimary && input.pulse?.coverage === "complete");
}
