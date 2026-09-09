import "server-only";

import {
  cancelClaimedSagaDailyKnowledgeJob,
  cancelStaleSagaDailyKnowledgeJobs,
  claimDueSagaDailyKnowledgeJob,
  completeSagaDailyKnowledgeJob,
  expireExhaustedSagaDailyKnowledgeLeases,
  failSagaDailyKnowledgeJob,
  isCurrentSagaDailyKnowledgeClaim,
  listSagaDailyKnowledgeEvidenceForClaim,
  materializeSagaDailyKnowledgeJobs,
  persistSagaDailyKnowledgeEntries,
  pruneSagaDailyKnowledgeRetention,
  sagaDailyKnowledgeTopicKey,
  SagaDailyKnowledgePolicyGuardError,
  type ClaimedSagaDailyKnowledgeJob,
  type SagaDailyKnowledgeEntryWrite,
  type SagaDailyKnowledgeEvidenceCandidate,
  type SagaDailyKnowledgeMaterialization,
} from "@/lib/neon/saga-daily-knowledge-repository";
import { createNeonSql, type NeonSql } from "@/lib/neon/database";
import { normalizedSagaDailyKnowledgeTopic } from "@/lib/domain/saga-daily-knowledge";

const MAX_JOBS_PER_TICK = 2;
const DEFAULT_TIME_BUDGET_MS = 12_000;
const MIN_TIME_BUDGET_MS = 2_000;
const MAX_TIME_BUDGET_MS = 24_000;

export type SagaDailyKnowledgeWorkerJobResult = {
  jobId: string;
  status: "knowledge_bundle_created" | "no_qualifying_evidence" | "cancelled" | "retry_scheduled" | "failed" | "lease_lost";
  entriesCreated?: number;
  code?: string;
};

export type SagaDailyKnowledgeWorkerResult = {
  materialization: SagaDailyKnowledgeMaterialization;
  staleCancelled: number;
  leasesExpired: number;
  retentionPruned: number;
  jobsClaimed: number;
  knowledgeBundlesCreated: number;
  noQualifyingEvidence: number;
  retriesScheduled: number;
  failuresRecorded: number;
  leasesLost: number;
  timeBudgetReached: boolean;
  jobs: SagaDailyKnowledgeWorkerJobResult[];
};

export type SagaDailyKnowledgeWorkerDependencies = {
  materialize: (options: { now: Date; limit: number }) => Promise<SagaDailyKnowledgeMaterialization>;
  cancelStale: (now: Date) => Promise<number>;
  expireLeases: (now: Date) => Promise<number>;
  pruneRetention: (now: Date) => Promise<number>;
  claim: (now: Date, workerId: string) => Promise<ClaimedSagaDailyKnowledgeJob | null>;
  isCurrent: (claim: ClaimedSagaDailyKnowledgeJob) => Promise<boolean>;
  listEvidence: (claim: ClaimedSagaDailyKnowledgeJob, now: Date) => Promise<SagaDailyKnowledgeEvidenceCandidate[]>;
  persist: (claim: ClaimedSagaDailyKnowledgeJob, entries: SagaDailyKnowledgeEntryWrite[], now: Date) => Promise<void>;
  complete: (claim: ClaimedSagaDailyKnowledgeJob, entryCount: number, now: Date) => Promise<boolean>;
  cancel: (claim: ClaimedSagaDailyKnowledgeJob, now: Date) => Promise<boolean>;
  fail: (
    claim: ClaimedSagaDailyKnowledgeJob,
    input: { code: string; detail: string; retry: boolean; retryAfterMs?: number },
    now: Date,
  ) => Promise<"retry_scheduled" | "failed" | "lease_lost">;
};

function defaultDependencies(sql: NeonSql): SagaDailyKnowledgeWorkerDependencies {
  return {
    materialize: (options) => materializeSagaDailyKnowledgeJobs(options, sql),
    cancelStale: (now) => cancelStaleSagaDailyKnowledgeJobs(now, sql),
    expireLeases: (now) => expireExhaustedSagaDailyKnowledgeLeases(now, sql),
    pruneRetention: (now) => pruneSagaDailyKnowledgeRetention(now, sql),
    claim: (now, workerId) => claimDueSagaDailyKnowledgeJob(now, workerId, sql),
    isCurrent: (claim) => isCurrentSagaDailyKnowledgeClaim(claim, sql),
    listEvidence: (claim, now) => listSagaDailyKnowledgeEvidenceForClaim(claim, now, sql),
    persist: (claim, entries, now) => persistSagaDailyKnowledgeEntries(claim, entries, now, sql),
    complete: (claim, entryCount, now) => completeSagaDailyKnowledgeJob(claim, entryCount, now, sql),
    cancel: (claim, now) => cancelClaimedSagaDailyKnowledgeJob(claim, now, sql),
    fail: (claim, input, now) => failSagaDailyKnowledgeJob(claim, input, now, sql),
  };
}

/**
 * Executes only metadata aggregation. There is deliberately no model call,
 * prompt construction, draft creation, image request, channel selection or
 * outbound publication anywhere in this worker.
 */
export async function runDueSagaDailyKnowledgeWorker(
  options: {
    now?: Date;
    maxJobs?: number;
    timeBudgetMs?: number;
    workerId?: string;
    dependencies?: SagaDailyKnowledgeWorkerDependencies;
  } = {},
  sql: NeonSql = createNeonSql(),
): Promise<SagaDailyKnowledgeWorkerResult> {
  const now = options.now ?? new Date();
  const maxJobs = bounded(options.maxJobs, MAX_JOBS_PER_TICK, 1, MAX_JOBS_PER_TICK);
  const timeBudgetMs = bounded(options.timeBudgetMs, DEFAULT_TIME_BUDGET_MS, MIN_TIME_BUDGET_MS, MAX_TIME_BUDGET_MS);
  const workerId = (options.workerId?.trim() || "saga-daily-knowledge-worker").slice(0, 160);
  const dependencies = options.dependencies ?? defaultDependencies(sql);
  const startedAt = Date.now();
  const materialization = await dependencies.materialize({ now, limit: maxJobs * 2 });
  const [staleCancelled, leasesExpired, retentionPruned] = await Promise.all([
    dependencies.cancelStale(now),
    dependencies.expireLeases(now),
    dependencies.pruneRetention(now),
  ]);
  const result: SagaDailyKnowledgeWorkerResult = {
    materialization,
    staleCancelled,
    leasesExpired,
    retentionPruned,
    jobsClaimed: 0,
    knowledgeBundlesCreated: 0,
    noQualifyingEvidence: 0,
    retriesScheduled: 0,
    failuresRecorded: 0,
    leasesLost: 0,
    timeBudgetReached: false,
    jobs: [],
  };

  while (result.jobsClaimed < maxJobs) {
    if (Date.now() - startedAt >= timeBudgetMs) {
      result.timeBudgetReached = true;
      break;
    }
    const claim = await dependencies.claim(now, workerId);
    if (!claim) break;
    result.jobsClaimed += 1;
    const outcome = await processClaimedSagaDailyKnowledgeJob(claim, { now, dependencies });
    result.jobs.push(outcome);
    if (outcome.status === "knowledge_bundle_created") result.knowledgeBundlesCreated += 1;
    else if (outcome.status === "no_qualifying_evidence") result.noQualifyingEvidence += 1;
    else if (outcome.status === "retry_scheduled") result.retriesScheduled += 1;
    else if (outcome.status === "failed") result.failuresRecorded += 1;
    else if (outcome.status === "lease_lost") result.leasesLost += 1;
  }
  return result;
}

/** Exact-once test seam. It aggregates evidence only and never calls an AI/provider boundary. */
export async function processClaimedSagaDailyKnowledgeJob(
  claim: ClaimedSagaDailyKnowledgeJob,
  input: { now?: Date; dependencies: SagaDailyKnowledgeWorkerDependencies },
): Promise<SagaDailyKnowledgeWorkerJobResult> {
  const now = input.now ?? new Date();
  try {
    if (!(await input.dependencies.isCurrent(claim))) {
      const cancelled = await input.dependencies.cancel(claim, now);
      return cancelled
        ? { jobId: claim.id, status: "cancelled", code: "daily_knowledge_policy_changed" }
        : { jobId: claim.id, status: "lease_lost" };
    }
    const evidence = await input.dependencies.listEvidence(claim, now);
    const entries = buildSagaDailyKnowledgeEntries(claim, evidence);
    await input.dependencies.persist(claim, entries, now);
    const completed = await input.dependencies.complete(claim, entries.length, now);
    if (!completed) return { jobId: claim.id, status: "lease_lost" };
    return entries.length > 0
      ? { jobId: claim.id, status: "knowledge_bundle_created", entriesCreated: entries.length }
      : { jobId: claim.id, status: "no_qualifying_evidence", entriesCreated: 0 };
  } catch (error) {
    if (error instanceof SagaDailyKnowledgePolicyGuardError) {
      const cancelled = await input.dependencies.cancel(claim, now);
      return cancelled
        ? { jobId: claim.id, status: "cancelled", code: "daily_knowledge_policy_changed" }
        : { jobId: claim.id, status: "lease_lost" };
    }
    // Never store source/database diagnostics: they could contain endpoint
    // details and add no value to an editor. The durable receipt remains safe.
    const outcome = await input.dependencies.fail(
      claim,
      {
        code: "daily_knowledge_unavailable",
        detail: "SAGA kunde inte sammanställa dagens källunderlag just nu.",
        retry: true,
        retryAfterMs: 2 * 60 * 1_000,
      },
      now,
    );
    return outcome === "lease_lost"
      ? { jobId: claim.id, status: "lease_lost" }
      : { jobId: claim.id, status: outcome, code: "daily_knowledge_unavailable" };
  }
}

/**
 * A deterministic relevance filter for manually selected topics. It makes no
 * semantic/model claim: topic tokens must visibly occur in title or the
 * bounded source excerpt. This keeps the result inspectable and conservative.
 */
export function buildSagaDailyKnowledgeEntries(
  claim: ClaimedSagaDailyKnowledgeJob,
  candidates: SagaDailyKnowledgeEvidenceCandidate[],
): SagaDailyKnowledgeEntryWrite[] {
  return claim.policy.topics.flatMap((topic) => {
    const matched = dedupeEvidence(candidates.filter((candidate) => candidateMatchesTopic(candidate, topic)));
    const evidence = selectIndependentEvidence(matched, claim.policy.maximumEvidenceItems);
    const independentPublisherCount = new Set(evidence.map((candidate) => candidate.publisherDomain)).size;
    if (evidence.length < claim.policy.minimumEvidenceItems
      || independentPublisherCount < claim.policy.minimumIndependentPublishers) return [];

    const countLabel = evidence.length === 1 ? "källunderlag" : "källunderlag";
    const publisherLabel = independentPublisherCount === 1 ? "publicistdomän" : "publicistdomäner";
    return [{
      policyId: claim.policyId,
      jobId: claim.id,
      policyRevision: claim.policyRevision,
      knowledgeDate: claim.knowledgeDate,
      topic,
      topicKey: sagaDailyKnowledgeTopicKey(topic),
      headline: `Dagens kunskapsunderlag: ${topic}`.slice(0, 320),
      summary: `${evidence.length} ${countLabel} från ${independentPublisherCount} ${publisherLabel} i de valda källorna om ${topic}. Detta sammanfattar matchande titlar och utdrag, inte ett färdigt inlägg; läs ursprungskällorna innan en egen tolkning görs.`.slice(0, 1_200),
      evidenceCount: evidence.length,
      independentPublisherCount,
      evidence,
    }];
  });
}

export function candidateMatchesTopic(candidate: SagaDailyKnowledgeEvidenceCandidate, topic: string): boolean {
  const tokens = topicTokens(topic);
  if (tokens.length === 0) return false;
  const haystack = normalizedSagaDailyKnowledgeTopic(`${candidate.title} ${candidate.excerpt}`);
  const matches = tokens.filter((token) => haystack.includes(token)).length;
  // Single-word themes must appear exactly. Multi-word themes need a visible
  // majority, which avoids treating a coincidental generic word as a signal.
  return tokens.length === 1 ? matches === 1 : matches >= Math.ceil(tokens.length * 0.6);
}

function topicTokens(topic: string): string[] {
  return [...new Set((normalizedSagaDailyKnowledgeTopic(topic).match(/[\p{L}\p{N}]{3,}/gu) ?? []))].slice(0, 8);
}

function dedupeEvidence(candidates: SagaDailyKnowledgeEvidenceCandidate[]): SagaDailyKnowledgeEvidenceCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.publisherDomain}\u0000${candidate.canonicalUrl}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Select one fresh reference per publisher first, then fill remaining slots. */
function selectIndependentEvidence(
  candidates: SagaDailyKnowledgeEvidenceCandidate[],
  maximum: number,
): SagaDailyKnowledgeEvidenceCandidate[] {
  const selected: SagaDailyKnowledgeEvidenceCandidate[] = [];
  const publishers = new Set<string>();
  for (const candidate of candidates) {
    if (publishers.has(candidate.publisherDomain)) continue;
    publishers.add(candidate.publisherDomain);
    selected.push(candidate);
    if (selected.length >= maximum) return selected;
  }
  for (const candidate of candidates) {
    if (selected.includes(candidate)) continue;
    selected.push(candidate);
    if (selected.length >= maximum) break;
  }
  return selected;
}

function bounded(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(Math.floor(value as number), maximum));
}
