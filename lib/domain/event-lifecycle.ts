import type { EventStatus } from "@/lib/domain/types";

/**
 * Source coverage is often incomplete: the first trustworthy account we find may
 * describe a state several steps ahead of the previously stored one. Normal
 * lifecycle states therefore progress monotonically and may skip intermediate
 * labels; they can never silently move backwards.
 */
const progression: readonly EventStatus[] = [
  "rumor",
  "reported",
  "proposed",
  "negotiating",
  "announced",
  "signed",
  "adopted",
  "effective",
  "implemented",
];

const progressionRank = new Map(progression.map((status, index) => [status, index]));

export const statusLabels: Record<EventStatus, string> = {
  rumor: "Rykte",
  reported: "Rapporterat",
  proposed: "Föreslaget",
  negotiating: "Under förhandling",
  announced: "Officiellt annonserat",
  signed: "Undertecknat",
  adopted: "Antaget",
  effective: "I kraft",
  implemented: "Implementerat",
  changed: "Ändrat",
  reversed: "Upphävt eller återkallat",
};

export function canTransition(from: EventStatus | null, to: EventStatus): boolean {
  if (from === null || from === to) return true;
  if (to === "changed" || to === "reversed") return true;
  if (from === "changed") return to !== "rumor";
  if (from === "reversed") {
    return ["proposed", "negotiating", "announced", "signed", "adopted", "effective", "implemented"].includes(to);
  }

  const fromRank = progressionRank.get(from);
  const toRank = progressionRank.get(to);
  return fromRank !== undefined && toRank !== undefined && toRank >= fromRank;
}

export function canonicalizeEventKey(input: {
  title: string;
  actors: string[];
  category: string;
}): string {
  const normalized = [
    input.category,
    ...input.actors.map(normalize).sort(),
    normalize(input.title)
      .replace(/\b(undertecknat|antaget|annonserat|proposed|signed|adopted|announced)\b/g, "")
      .trim(),
  ]
    .filter(Boolean)
    .join("|");

  return normalized.slice(0, 240);
}

function normalize(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("sv-SE")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function isMaterialEventChange(input: {
  previousStatus: EventStatus | null;
  nextStatus: EventStatus;
  priorTerms?: string | null;
  nextTerms: string;
  /** Versioned factual fingerprint of the currently stored event state. */
  priorMaterialFingerprint?: string | null;
  /** Versioned factual fingerprint produced for the candidate state. */
  nextMaterialFingerprint?: string | null;
  priorEffectiveDate?: string | null;
  nextEffectiveDate?: string | null;
  priorConfidence?: string | null;
  nextConfidence: string;
}): boolean {
  if (input.previousStatus === null || input.previousStatus !== input.nextStatus) return true;
  if (input.priorEffectiveDate !== input.nextEffectiveDate) return true;
  if (input.priorConfidence !== input.nextConfidence) return true;

  if (input.priorMaterialFingerprint && input.nextMaterialFingerprint) {
    return input.priorMaterialFingerprint !== input.nextMaterialFingerprint;
  }
  const changedText = (previous: string | null | undefined, next: string) => normalize(previous ?? "") !== normalize(next);
  // Legacy rows created before factual vectors existed have no comparable
  // fingerprint. Fall back to their neutral terms summary until the next
  // verified update writes a versioned factual fingerprint.
  return changedText(input.priorTerms, input.nextTerms);
}
