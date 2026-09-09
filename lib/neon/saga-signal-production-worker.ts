import "server-only";

import {
  blockSagaSignalProductionJob,
  cancelStaleSagaSignalProductionJobs,
  cancelClaimedSagaSignalProductionJob,
  claimDueSagaSignalProductionJob,
  completeSagaSignalProductionJob,
  createPrivateSagaSignalProductionDraft,
  expireExhaustedSagaSignalProductionLeases,
  failSagaSignalProductionJob,
  materializeSagaSignalProductionJobs,
  SagaSignalProductionDraftGuardError,
  type ClaimedSagaSignalProductionJob,
  type SagaSignalProductionDraftInput,
  type SagaSignalProductionDraftResult,
  type SagaSignalProductionMaterialization,
} from "@/lib/neon/saga-signal-production-repository";
import { createNeonSql, type NeonSql } from "@/lib/neon/database";
import {
  assessSagaProductionQuality,
  type SagaContentQualityInput,
  type SagaProductionQualityAssessment,
} from "@/lib/services/saga-production-quality";

const MAX_JOBS_PER_TICK = 3;
const DEFAULT_TIME_BUDGET_MS = 20_000;
const MIN_TIME_BUDGET_MS = 2_000;
const MAX_TIME_BUDGET_MS = 30_000;

export type SagaSignalProductionWorkerJobResult = {
  jobId: string;
  status: "review_draft_created" | "blocked" | "cancelled" | "retry_scheduled" | "failed" | "lease_lost";
  draftId?: string;
  calendarScheduled?: boolean;
  calendarWithheld?: boolean;
  code?: string;
  quality?: SagaProductionQualityAssessment;
};

export type SagaSignalProductionWorkerResult = {
  materialization: SagaSignalProductionMaterialization;
  staleCancelled: number;
  leasesExpired: number;
  jobsClaimed: number;
  reviewDraftsCreated: number;
  qualityBlocked: number;
  retriesScheduled: number;
  failuresRecorded: number;
  leasesLost: number;
  timeBudgetReached: boolean;
  jobs: SagaSignalProductionWorkerJobResult[];
};

export type SagaSignalProductionWorkerDependencies = {
  materialize: (options: { now: Date; limit: number }) => Promise<SagaSignalProductionMaterialization>;
  cancelStale: (now: Date) => Promise<number>;
  expireLeases: (now: Date) => Promise<number>;
  claim: (now: Date, workerId: string) => Promise<ClaimedSagaSignalProductionJob | null>;
  assess: (input: SagaContentQualityInput) => SagaProductionQualityAssessment;
  createDraft: (
    claim: ClaimedSagaSignalProductionJob,
    input: SagaSignalProductionDraftInput,
    now: Date,
  ) => Promise<SagaSignalProductionDraftResult>;
  complete: (
    claim: ClaimedSagaSignalProductionJob,
    draft: SagaSignalProductionDraftResult,
    quality: SagaProductionQualityAssessment,
    now: Date,
  ) => Promise<boolean>;
  block: (claim: ClaimedSagaSignalProductionJob, quality: SagaProductionQualityAssessment, now: Date) => Promise<boolean>;
  cancel: (claim: ClaimedSagaSignalProductionJob, now: Date) => Promise<boolean>;
  fail: (
    claim: ClaimedSagaSignalProductionJob,
    input: { code: string; detail: string; retry: boolean; retryAfterMs?: number },
    now: Date,
  ) => Promise<"retry_scheduled" | "failed" | "lease_lost">;
};

function defaultDependencies(sql: NeonSql): SagaSignalProductionWorkerDependencies {
  return {
    materialize: (options) => materializeSagaSignalProductionJobs(options, sql),
    cancelStale: (now) => cancelStaleSagaSignalProductionJobs(now, sql),
    expireLeases: (now) => expireExhaustedSagaSignalProductionLeases(now, sql),
    claim: (now, workerId) => claimDueSagaSignalProductionJob(now, workerId, sql),
    assess: assessSagaProductionQuality,
    createDraft: (claim, input, now) => createPrivateSagaSignalProductionDraft(claim, input, now, sql),
    complete: (claim, draft, quality, now) => completeSagaSignalProductionJob(claim, draft, quality, now, sql),
    block: (claim, quality, now) => blockSagaSignalProductionJob(claim, quality, now, sql),
    cancel: (claim, now) => cancelClaimedSagaSignalProductionJob(claim, now, sql),
    fail: (claim, input, now) => failSagaSignalProductionJob(claim, input, now, sql),
  };
}

/**
 * Vercel Cron worker for the final internal bridge: qualified source signal
 * -> explainable quality gate -> one private Studio review draft.  It does
 * not invoke an AI model, generate/upload an image, enqueue a publish job,
 * send a newsletter, or call any external provider.
 */
export async function runDueSagaSignalProductionWorker(
  options: {
    now?: Date;
    maxJobs?: number;
    materializationLimit?: number;
    timeBudgetMs?: number;
    workerId?: string;
    sql?: NeonSql;
    dependencies?: SagaSignalProductionWorkerDependencies;
  } = {},
): Promise<SagaSignalProductionWorkerResult> {
  const now = options.now ?? new Date();
  const maxJobs = bounded(options.maxJobs, MAX_JOBS_PER_TICK, 1, MAX_JOBS_PER_TICK);
  const materializationLimit = bounded(options.materializationLimit, 12, 1, 20);
  const timeBudgetMs = bounded(options.timeBudgetMs, DEFAULT_TIME_BUDGET_MS, MIN_TIME_BUDGET_MS, MAX_TIME_BUDGET_MS);
  const workerId = options.workerId?.trim().slice(0, 160) || "vercel-saga-signal-production";
  const dependencies = options.dependencies ?? defaultDependencies(options.sql ?? createNeonSql());
  const startedAt = Date.now();

  const [staleCancelled, leasesExpired] = await Promise.all([
    dependencies.cancelStale(now),
    dependencies.expireLeases(now),
  ]);
  const materialization = await dependencies.materialize({ now, limit: materializationLimit });
  const result: SagaSignalProductionWorkerResult = {
    materialization,
    staleCancelled,
    leasesExpired,
    jobsClaimed: 0,
    reviewDraftsCreated: 0,
    qualityBlocked: 0,
    retriesScheduled: 0,
    failuresRecorded: 0,
    leasesLost: 0,
    timeBudgetReached: false,
    jobs: [],
  };

  for (let index = 0; index < maxJobs; index += 1) {
    if (Date.now() - startedAt >= timeBudgetMs) {
      result.timeBudgetReached = true;
      break;
    }
    const claim = await dependencies.claim(now, workerId);
    if (!claim) break;
    result.jobsClaimed += 1;
    const outcome = await processClaimedSagaSignalProductionJob(claim, { now, dependencies });
    result.jobs.push(outcome);
    if (outcome.status === "review_draft_created") result.reviewDraftsCreated += 1;
    else if (outcome.status === "blocked") result.qualityBlocked += 1;
    else if (outcome.status === "cancelled") {
      // A live policy change is an expected safety cancellation, not a worker failure.
    }
    else if (outcome.status === "retry_scheduled") result.retriesScheduled += 1;
    else if (outcome.status === "failed") result.failuresRecorded += 1;
    else result.leasesLost += 1;
  }
  return result;
}

/** Exposed for an exact-once/manual worker test seam; it has no provider boundary. */
export async function processClaimedSagaSignalProductionJob(
  claim: ClaimedSagaSignalProductionJob,
  input: { now?: Date; dependencies: SagaSignalProductionWorkerDependencies },
): Promise<SagaSignalProductionWorkerJobResult> {
  const now = input.now ?? new Date();
  try {
    const draft = signalProductionDraftForClaim(claim);
    const qualityInput = qualityInputForSignalDraft(claim, draft);
    const quality = input.dependencies.assess(qualityInput);
    if (!quality.canCreatePrivateDraft) {
      const blocked = await input.dependencies.block(claim, quality, now);
      return blocked
        ? { jobId: claim.id, status: "blocked", code: "production_quality_rejected", quality }
        : { jobId: claim.id, status: "lease_lost" };
    }
    const saved = await input.dependencies.createDraft(claim, { ...draft, quality }, now);
    const completed = await input.dependencies.complete(claim, saved, quality, now);
    if (!completed) return { jobId: claim.id, status: "lease_lost" };
    return {
      jobId: claim.id,
      status: "review_draft_created",
      draftId: saved.id,
      calendarScheduled: Boolean(saved.scheduledAt),
      calendarWithheld: saved.calendarWithheld,
      quality,
    };
  } catch (error) {
    if (error instanceof SagaSignalProductionDraftGuardError) {
      const cancelled = await input.dependencies.cancel(claim, now);
      return cancelled
        ? { jobId: claim.id, status: "cancelled", code: "production_policy_changed" }
        : { jobId: claim.id, status: "lease_lost" };
    }
    // Never propagate raw provider/database diagnostics into a durable job or
    // a Cron response; a connection string or other secret must not be
    // rendered in an operator UI.  The retry receipt remains explainable.
    const result = await input.dependencies.fail(
      claim,
      {
        code: "signal_production_unavailable",
        detail: "SAGA kunde inte skapa det privata granskningsutkastet just nu.",
        retry: true,
        retryAfterMs: 2 * 60 * 1_000,
      },
      now,
    );
    return result === "lease_lost"
      ? { jobId: claim.id, status: "lease_lost" }
      : { jobId: claim.id, status: result, code: "signal_production_unavailable" };
  }
}

/**
 * Builds a reviewable editorial handoff, not a purported article written by
 * AI.  The source’s own words remain labelled as an observation and a person
 * must form the organisation’s actual point of view before delivery.
 */
export function signalProductionDraftForClaim(claim: ClaimedSagaSignalProductionJob): Omit<SagaSignalProductionDraftInput, "quality"> {
  const signal = claim.signal;
  const evidence = `${signal.evidenceCount} underlag från ${signal.independentSourceCount} oberoende källor och ${signal.distinctPublisherCount} publicister`;
  const observation = signal.summary.trim() || signal.headline.trim();
  const angle = signal.editorialAngle.trim() || "Vilken konkret fråga väcker signalen för vår bransch, våra kunder och vår mission?";
  const body = [
    "Det här är ett privat redaktionellt underlag från SAGA Research. Ingen text, bild eller publicering har skapats utanför arbetsytan.",
    `Signalen är kvalificerad genom ${evidence}. Den ska behandlas som ett spårbart underlag, inte som en färdig slutsats.`,
    `Observerat i källunderlaget: ${observation}`,
    `Föreslagen redaktionell fråga: ${angle}`,
    "Arbeta långsamt nog för att skilja observation från tolkning. Knyt bara ämnet till ett erbjudande när relevans, fakta och kundnytta är tydliga.",
    "Nästa steg är att läsa källorna, kontrollera sammanhanget och formulera en egen konstruktiv vinkel. Lägg bara in den i kalendern när den mänskliga granskningen är klar.",
  ].join("\n\n");
  return {
    title: `SAGA Research: ${signal.headline}`.slice(0, 240),
    headline: signal.headline.slice(0, 280),
    body,
    excerpt: `Kvalificerad signal med ${evidence}.`.slice(0, 320),
    cta: "Granska källunderlaget och avgör om ämnet ska utvecklas vidare.",
    // Deliberately static: source headlines must not become a direct image
    // prompt. A person may later choose a factual, channel-specific image.
    imagePrompt: "Redaktionell referensbild utan text, logotyp eller watermark. Verklighetsnära, trygg och saklig gestaltning med mänsklig närvaro. Slutlig bildriktning kräver mänsklig granskning.",
  };
}

/** Shared deterministic input: source evidence is explicit; no model is asked to self-certify. */
export function qualityInputForSignalDraft(
  claim: ClaimedSagaSignalProductionJob,
  draft: Omit<SagaSignalProductionDraftInput, "quality">,
): SagaContentQualityInput {
  return {
    kind: "content_draft",
    contentType: "article",
    channels: [],
    targetLength: "medium",
    title: draft.title,
    headline: draft.headline,
    subject: null,
    previewText: null,
    body: draft.body,
    callToAction: draft.cta,
    imagePrompt: draft.imagePrompt,
    claimEvidence: claim.signal.evidenceCount >= 2 && claim.signal.independentSourceCount >= 2
      ? [{ sourceReference: `saga-news-signal:${claim.signalCandidateId}`, verifiedAt: claim.signal.lastSeenAt }]
      : [],
    deliveryIntent: "private_draft",
  };
}

function bounded(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(Math.floor(value as number), maximum));
}
