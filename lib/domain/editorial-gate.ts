import { createHash } from "node:crypto";
import { canTransition, canonicalizeEventKey, isMaterialEventChange } from "@/lib/domain/event-lifecycle";
import { applyProfileWeights, calculateRelevance, shouldPublishEvent, shouldSendDirectAlert } from "@/lib/domain/relevance";
import { hasSufficientVerification, normalizePublicationSources, validateSourceDates } from "@/lib/domain/source-policy";
import type { CandidateEvent, EditorialCandidate, MaterialFact, ProfileSettings } from "@/lib/domain/types";

export type StoredEvent = {
  id: string;
  canonicalKey: string;
  title: string;
  category: string;
  actors: string[];
  regions: string[];
  status: EditorialCandidate["status"];
  termsSummary: string | null;
  effectiveDate: string | null;
  confidence: string;
  shortTermImpact: string | null;
  longTermImpact: string | null;
};

export type UserEventState = { eventId: string; lastPublishedUpdateId: string | null };
/**
 * An update already in the global event register. It can be delivered once to
 * each brief definition without creating a second global event_update. The
 * optional fields preserve compatibility with older callers while the runner
 * supplies the full delivery cursor.
 */
export type KnownUpdate = {
  id: string;
  eventId: string;
  materialFingerprint: string;
  previousStatus?: EditorialCandidate["previousStatus"];
  nextStatus?: EditorialCandidate["status"];
  occurredAt?: string;
};

/** A verified, material state change that belongs in the durable event register. */
export type RegistryItem = EditorialCandidate & {
  canonicalKey: string;
  previousStatus: EditorialCandidate["previousStatus"];
  relevanceFactors: EditorialCandidate["relevanceFactors"];
  relevanceScore: number;
  materialFingerprint: string;
};

/** A registry item that additionally earned a place in this user's brief. */
export type PublishItem = RegistryItem & {
  directAlert: boolean;
};

/**
 * Server-enforced registry gate. A valid event update is durable even when it
 * does not earn a place in this particular user's 0–5 item brief.
 */
export function prepareRegistryItems(input: {
  decisions: EditorialCandidate[];
  profile: ProfileSettings;
  events: StoredEvent[];
  knownUpdates?: KnownUpdate[];
  /** Only replay global updates observed during this definition's coverage. */
  coverageFrom?: string;
}): RegistryItem[] {
  const bestByEventKey = new Map<string, RegistryItem>();

  for (const decision of input.decisions) {
    const existing = resolveExistingEvent(decision, input.events);
    const canonicalKey = existing?.canonicalKey ?? stableCanonicalKey(decision);
    const factualFingerprint = materialFingerprint({ ...decision, canonicalKey });
    const latestKnownUpdate = existing ? latestKnownUpdateForEvent(existing.id, input.knownUpdates ?? []) : undefined;
    const replay = existing
      ? findReplayableKnownUpdate(decision, existing, factualFingerprint, input.knownUpdates ?? [], input.coverageFrom)
      : undefined;
    const previousStatus = replay?.previousStatus ?? existing?.status ?? null;
    const relevanceFactors = applyProfileWeights({
      factors: decision.relevanceFactors,
      category: decision.category,
      regions: decision.regions,
      settings: input.profile,
    });
    const relevanceScore = calculateRelevance(relevanceFactors);
    const materialChange = isMaterialEventChange({
      previousStatus,
      nextStatus: decision.status,
      priorTerms: existing?.termsSummary,
      nextTerms: decision.termsSummary,
      priorMaterialFingerprint: latestKnownUpdate?.materialFingerprint,
      nextMaterialFingerprint: factualFingerprint,
      priorEffectiveDate: existing?.effectiveDate,
      nextEffectiveDate: decision.effectiveDate,
      priorConfidence: existing?.confidence,
      nextConfidence: decision.confidence,
    });
    const sources = normalizePublicationSources(decision.sources);
    const sourcesValid =
      sources !== null &&
      hasSufficientVerification(sources) &&
      sources.every(validateSourceDates);
    const languageSafe = !containsInvestmentAdvice([
      decision.whatChanged,
      decision.whyRelevant,
      decision.shortTermImpact,
      decision.longTermImpact,
    ]);
    // A monitor or another brief may already have persisted this exact factual
    // update. It remains a legitimate, *per-definition* delivery candidate as
    // long as it appeared in this brief's coverage window. Reusing its stable
    // fingerprint lets the SQL publisher attach the existing event_update
    // rather than manufacturing a duplicate because a different brief wrote
    // a different relevance explanation.
    const freshMaterialChange = decision.materialChange && materialChange && canTransition(existing?.status ?? null, decision.status);
    const shouldRegister =
      decision.verified &&
      (freshMaterialChange || Boolean(replay)) &&
      sourcesValid &&
      languageSafe &&
      (Boolean(replay) || canTransition(previousStatus, decision.status));
    if (!shouldRegister || !sources) continue;

    const item: RegistryItem = {
      ...decision,
      sources,
      canonicalKey,
      previousStatus,
      relevanceFactors,
      relevanceScore,
      materialFingerprint: replay?.materialFingerprint ?? factualFingerprint,
    };
    const current = bestByEventKey.get(canonicalKey);
    if (!current || item.relevanceScore > current.relevanceScore) bestByEventKey.set(canonicalKey, item);
  }

  return [...bestByEventKey.values()];
}

/** Pure publication gate. The model may suggest, but it cannot bypass this. */
export function preparePublishItems(input: {
  decisions: EditorialCandidate[];
  profile: ProfileSettings;
  events: StoredEvent[];
  states: UserEventState[];
  knownUpdates: KnownUpdate[];
  coverageFrom?: string;
}): PublishItem[] {
  const stateByEventId = new Map(input.states.map((state) => [state.eventId, state]));
  const knownByEventAndFingerprint = new Map(
    input.knownUpdates.map((update) => [update.eventId + ":" + update.materialFingerprint, update]),
  );
  const items: PublishItem[] = [];

  for (const item of prepareRegistryItems(input)) {
    if (
      !item.shouldPublish ||
      !shouldPublishEvent({
        score: item.relevanceScore,
        materiality: item.relevanceFactors.materiality,
        systemicOverride: item.systemicOverride,
        materialChange: true,
        settings: input.profile,
      })
    ) {
      continue;
    }

    const existing = resolveExistingEvent(item, input.events);
    const known = existing ? knownByEventAndFingerprint.get(existing.id + ":" + item.materialFingerprint) : undefined;
    const deliveryState = existing ? stateByEventId.get(existing.id) : undefined;
    if (known && deliveryState?.lastPublishedUpdateId === known.id) continue;

    items.push({
      ...item,
      directAlert: shouldSendDirectAlert({
        score: item.relevanceScore,
        systemicOverride: item.systemicOverride,
        settings: input.profile,
      }),
    });
  }

  return items;
}

/** Only these compact candidate matches are sent to the editorial model. The
 * server-side publication gate still searches the full permanent register. */
export function selectEditorialEventContext(
  candidates: CandidateEvent[],
  events: StoredEvent[],
): StoredEvent[] {
  const matches = new Map<string, StoredEvent>();
  for (const candidate of candidates) {
    const match = resolveExistingEvent(candidate, events);
    if (match) matches.set(match.id, match);
  }
  return [...matches.values()];
}

function resolveExistingEvent(
  decision: {
    matchedEventId?: string | null;
    canonicalKey: string;
    title: string;
    actors: string[];
    category: string;
  },
  events: StoredEvent[],
): StoredEvent | undefined {
  if (decision.matchedEventId) {
    const match = events.find((event) => event.id === decision.matchedEventId);
    if (match) return match;
  }
  const exactKey = events.find((event) => event.canonicalKey === decision.canonicalKey);
  if (exactKey) return exactKey;

  const normalizedCandidate = stableCanonicalKey(decision);
  const generatedKey = events.find((event) => stableCanonicalKey(event) === normalizedCandidate);
  if (generatedKey) return generatedKey;

  const candidateActors = new Set(decision.actors.map(normalizeToken));
  const titleTokens = new Set(tokenize(decision.title));
  return events.find((event) => {
    if (event.category !== decision.category) return false;
    const sameActor = event.actors.some((actor) => candidateActors.has(normalizeToken(actor)));
    return sameActor && jaccard(titleTokens, new Set(tokenize(event.title))) >= 0.45;
  });
}

function stableCanonicalKey(event: { canonicalKey: string; title: string; actors: string[]; category: string }): string {
  const supplied = event.canonicalKey.trim().toLocaleLowerCase("sv-SE").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
  return supplied.length >= 8 ? supplied.slice(0, 240) : canonicalizeEventKey(event);
}

/**
 * A global event-update key must represent facts, not how a particular brief
 * phrases personal consequences. `whyRelevant`, `whatChanged`, terms prose
 * and impact copy are deliberately definition-specific and live on
 * brief_items instead. The fingerprint receives only a normalized structured
 * factual vector, making dedupe stable across brief wording.
 */
function materialFingerprint(item: Pick<RegistryItem, "canonicalKey" | "status" | "materialFacts" | "effectiveDate" | "confidence" | "eventDate">): string {
  return createHash("sha256")
    .update(JSON.stringify({
      version: 2,
      key: item.canonicalKey,
      status: item.status,
      facts: normalizeMaterialFacts(item.materialFacts),
      eventDate: item.eventDate,
      effectiveDate: item.effectiveDate,
      confidence: item.confidence,
    }))
    .digest("hex");
}

/** The current state is represented by the latest durable update, not prose. */
function latestKnownUpdateForEvent(eventId: string, knownUpdates: KnownUpdate[]): KnownUpdate | undefined {
  return knownUpdates
    .filter((update) => update.eventId === eventId && Boolean(update.occurredAt))
    .sort((left, right) => new Date(right.occurredAt ?? 0).getTime() - new Date(left.occurredAt ?? 0).getTime())[0];
}

function findReplayableKnownUpdate(
  decision: EditorialCandidate,
  existing: StoredEvent,
  factualFingerprint: string,
  knownUpdates: KnownUpdate[],
  coverageFrom?: string,
): KnownUpdate | undefined {
  if (!coverageFrom) return undefined;
  const cutoff = new Date(coverageFrom).getTime();
  if (!Number.isFinite(cutoff)) return undefined;

  return knownUpdates
    .filter((update) => {
      if (
        update.eventId !== existing.id
        || update.nextStatus !== decision.status
        || update.materialFingerprint !== factualFingerprint
        || !update.occurredAt
      ) return false;
      const occurredAt = new Date(update.occurredAt).getTime();
      return Number.isFinite(occurredAt) && occurredAt >= cutoff;
    })
    .sort((left, right) => new Date(right.occurredAt ?? 0).getTime() - new Date(left.occurredAt ?? 0).getTime())[0];
}

function normalizeMaterialFacts(facts: MaterialFact[]): Array<Pick<MaterialFact, "dimension" | "direction" | "subject" | "value">> {
  const normalized = facts.map((fact) => ({
    dimension: fact.dimension,
    direction: fact.direction,
    subject: fingerprintText(fact.subject),
    value: fact.value ? fingerprintText(fact.value) : null,
  }));
  const unique = new Map(normalized.map((fact) => [JSON.stringify(fact), fact]));
  return [...unique.values()].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right), "sv"));
}

function fingerprintText(value: string): string {
  return value.trim().toLocaleLowerCase("sv-SE").replace(/\s+/g, " ");
}

function tokenize(value: string): string[] {
  return value.toLocaleLowerCase("sv-SE").match(/[\p{L}\p{N}]{3,}/gu) ?? [];
}

function normalizeToken(value: string): string {
  return value.toLocaleLowerCase("sv-SE").replace(/[^\p{L}\p{N}]/gu, "");
}

function jaccard(left: Set<string>, right: Set<string>): number {
  const union = new Set([...left, ...right]);
  if (!union.size) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared++;
  return shared / union.size;
}

function containsInvestmentAdvice(texts: string[]): boolean {
  return /\b(köp|sälj|köprekommendation|säljrekommendation|buy|sell|overweight|underweight)\b/i.test(texts.join(" "));
}
