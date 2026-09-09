import "server-only";

import type { ContentGenerationInput } from "@/lib/domain/content-generation";
import type { SagaQuarterlyGenerationClaim, SagaQuarterlyPrivateDraftMaterialization } from "@/lib/domain/saga-quarterly-planning";
import type { AppActor } from "@/lib/neon/auth-repository";
import {
  claimSagaQuarterlyActivityPlanJob,
  completeSagaQuarterlyActivityPlanJob,
  failSagaQuarterlyActivityPlanJob,
  listDueSagaQuarterlyActivityPlanMaterializations,
  type SagaQuarterlyDueMaterialization,
} from "@/lib/neon/saga-quarterly-planning-repository";
import { getSagaEditorialLensPromptContext } from "@/lib/neon/saga-editorial-lens-repository";
import { createNeonSql, type NeonSql } from "@/lib/neon/database";
import { ContentGenerationError, generateContentDraft, type GeneratedContentResult } from "@/lib/services/content-generation";
import { executionTimeRemainingMs } from "@/lib/server/execution-deadline";
import {
  assessGeneratedContentQuality,
  type SagaProductionQualityAssessment,
} from "@/lib/services/saga-production-quality";

// A batch may contain ten review items, but a Vercel invocation must stay
// comfortably inside the gateway timeout. The review limit and worker
// concurrency are deliberately separate concepts.
export const SAGA_QUARTERLY_MAX_JOBS_PER_RUN = 5;
const DEFAULT_MAX_JOBS = 1;
const DEFAULT_TIME_BUDGET_MS = 48_000;

export type SagaQuarterlyPlanningWorkerJobResult = {
  jobId: string;
  status: "private_draft_created" | "quality_blocked" | "failed" | "lease_lost";
  draftId?: string;
  code?: string;
  quality?: SagaProductionQualityAssessment;
};

export type SagaQuarterlyPlanningWorkerResult = {
  batchId: string;
  materializationReceiptId: string;
  jobsClaimed: number;
  privateDraftsCreated: number;
  qualityBlocked: number;
  failuresRecorded: number;
  leasesLost: number;
  timeBudgetReached: boolean;
  jobs: SagaQuarterlyPlanningWorkerJobResult[];
  /** The worker never creates media, schedules, publishes, or delivers. */
  noPublication: true;
  media: "manual_action_required";
};

export type SagaQuarterlyPlanningWorkerDependencies = {
  claim: (input: {
    actor: AppActor;
    brandProfileId: string;
    batchId: string;
    materializationReceiptId: string;
    workerId: string;
  }) => Promise<SagaQuarterlyGenerationClaim | null>;
  lens: (actor: AppActor) => Promise<Awaited<ReturnType<typeof getSagaEditorialLensPromptContext>>>
  generate: (input: ContentGenerationInput, context: { editorialLens: Awaited<ReturnType<typeof getSagaEditorialLensPromptContext>> }) => Promise<GeneratedContentResult>;
  assess: typeof assessGeneratedContentQuality;
  complete: (actor: AppActor, input: {
    jobId: string;
    claimToken: string;
    draft: SagaQuarterlyPrivateDraftMaterialization;
  }) => Promise<{ draftId: string | null; stale: boolean }>;
  fail: (actor: AppActor, input: {
    jobId: string;
    claimToken: string;
    errorCode: string;
    errorMessage: string;
  }) => Promise<boolean>;
};

function defaultDependencies(sql: NeonSql): SagaQuarterlyPlanningWorkerDependencies {
  return {
    claim: ({ actor, brandProfileId, batchId, materializationReceiptId, workerId }) => claimSagaQuarterlyActivityPlanJob(
      actor,
      brandProfileId,
      batchId,
      { materializationReceiptId, workerId, leaseSeconds: 90 },
      sql,
    ),
    lens: (actor) => getSagaEditorialLensPromptContext(actor, sql),
    generate: (input, context) => generateContentDraft(input, context),
    assess: assessGeneratedContentQuality,
    complete: (actor, input) => completeSagaQuarterlyActivityPlanJob(actor, input, sql),
    fail: (actor, input) => failSagaQuarterlyActivityPlanJob(actor, input, sql),
  };
}

/**
 * Performs a bounded slice of a single durable receipt. Calling it again with
 * the same receipt is safe: Neon leases one job at a time and final creation
 * rechecks the active plan + revision before writing a private draft.
 */
export async function runSagaQuarterlyActivityPlanWorker(input: {
  actor: AppActor;
  brandProfileId: string;
  batchId: string;
  materializationReceiptId: string;
  maxJobs?: number;
  timeBudgetMs?: number;
  workerId?: string;
  sql?: NeonSql;
  dependencies?: SagaQuarterlyPlanningWorkerDependencies;
}): Promise<SagaQuarterlyPlanningWorkerResult> {
  const maxJobs = bounded(input.maxJobs, DEFAULT_MAX_JOBS, 1, SAGA_QUARTERLY_MAX_JOBS_PER_RUN);
  const timeBudgetMs = bounded(input.timeBudgetMs, DEFAULT_TIME_BUDGET_MS, 2_000, 55_000);
  const workerId = input.workerId?.trim().slice(0, 160) || "vercel-saga-quarterly-plan";
  const dependencies = input.dependencies ?? defaultDependencies(input.sql ?? createNeonSql());
  const startedAt = Date.now();
  const result: SagaQuarterlyPlanningWorkerResult = {
    batchId: input.batchId,
    materializationReceiptId: input.materializationReceiptId,
    jobsClaimed: 0,
    privateDraftsCreated: 0,
    qualityBlocked: 0,
    failuresRecorded: 0,
    leasesLost: 0,
    timeBudgetReached: false,
    jobs: [],
    noPublication: true,
    media: "manual_action_required",
  };

  for (let index = 0; index < maxJobs; index += 1) {
    if (Date.now() - startedAt >= timeBudgetMs || executionTimeRemainingMs() <= 3_500) {
      result.timeBudgetReached = true;
      break;
    }
    const claim = await dependencies.claim({
      actor: input.actor,
      brandProfileId: input.brandProfileId,
      batchId: input.batchId,
      materializationReceiptId: input.materializationReceiptId,
      workerId,
    });
    if (!claim) break;
    result.jobsClaimed += 1;
    const outcome = await processSagaQuarterlyPlanningClaim(claim, { ...input.actor, brandProfileId: input.brandProfileId }, dependencies);
    result.jobs.push(outcome);
    if (outcome.status === "private_draft_created") result.privateDraftsCreated += 1;
    else if (outcome.status === "quality_blocked") result.qualityBlocked += 1;
    else if (outcome.status === "failed") result.failuresRecorded += 1;
    else result.leasesLost += 1;
  }
  return result;
}

/** Vercel Cron only resumes already-requested receipts; it never requests a batch or schedules/publishes it. */
export async function runDueSagaQuarterlyActivityPlanWorker(input: {
  maxBatches?: number;
  maxJobsPerBatch?: number;
  timeBudgetMs?: number;
  workerId?: string;
  sql?: NeonSql;
  listDue?: (limit: number) => Promise<SagaQuarterlyDueMaterialization[]>;
  dependencies?: SagaQuarterlyPlanningWorkerDependencies;
} = {}): Promise<{
  receipts: SagaQuarterlyPlanningWorkerResult[];
  receiptsClaimed: number;
  privateDraftsCreated: number;
  failuresRecorded: number;
  timeBudgetReached: boolean;
  noPublication: true;
}> {
  const sql = input.sql ?? createNeonSql();
  const maxBatches = bounded(input.maxBatches, 1, 1, SAGA_QUARTERLY_MAX_JOBS_PER_RUN);
  const due = await (input.listDue ?? ((limit) => listDueSagaQuarterlyActivityPlanMaterializations(limit, sql)))(maxBatches);
  const receipts: SagaQuarterlyPlanningWorkerResult[] = [];
  for (const receipt of due) {
    receipts.push(await runSagaQuarterlyActivityPlanWorker({
      ...receipt,
      maxJobs: input.maxJobsPerBatch ?? 1,
      timeBudgetMs: input.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS,
      workerId: input.workerId ?? "vercel-saga-quarterly-cron",
      sql,
      dependencies: input.dependencies,
    }));
  }
  return {
    receipts,
    receiptsClaimed: receipts.filter((result) => result.jobsClaimed > 0).length,
    privateDraftsCreated: receipts.reduce((total, result) => total + result.privateDraftsCreated, 0),
    failuresRecorded: receipts.reduce((total, result) => total + result.failuresRecorded + result.qualityBlocked, 0),
    timeBudgetReached: receipts.some((result) => result.timeBudgetReached),
    noPublication: true,
  };
}

/** Individual claim seam for exact worker tests; it has no publishing or media branch. */
export async function processSagaQuarterlyPlanningClaim(
  claim: SagaQuarterlyGenerationClaim,
  actor: AppActor,
  dependencies: SagaQuarterlyPlanningWorkerDependencies,
): Promise<SagaQuarterlyPlanningWorkerJobResult> {
  try {
    const lens = await dependencies.lens(actor);
    const generationInput = generationInputForSagaQuarterlyClaim(claim);
    const generated = await dependencies.generate(generationInput, { editorialLens: lens });
    const quality = dependencies.assess(generationInput, generated.draft, "private_draft", null, lens);
    if (!quality.canCreatePrivateDraft || quality.decision === "blocked" || quality.canDeliver) {
      const persisted = await dependencies.fail(actor, {
        jobId: claim.jobId,
        claimToken: claim.claimToken,
        errorCode: "production_quality_rejected",
        errorMessage: "Kvalitetskontrollen stoppade AI-utkastet innan något privat utkast sparades.",
      });
      return persisted
        ? { jobId: claim.jobId, status: "quality_blocked", code: "production_quality_rejected", quality }
        : { jobId: claim.jobId, status: "lease_lost" };
    }
    const draft = materializationForSagaQuarterlyClaim(claim, generationInput, generated, quality);
    const completion = await dependencies.complete(actor, { jobId: claim.jobId, claimToken: claim.claimToken, draft });
    if (!completion.draftId || completion.stale) return { jobId: claim.jobId, status: "lease_lost" };
    return { jobId: claim.jobId, status: "private_draft_created", draftId: completion.draftId, quality };
  } catch (error) {
    const failure = failureForSagaQuarterlyError(error);
    const persisted = await dependencies.fail(actor, {
      jobId: claim.jobId,
      claimToken: claim.claimToken,
      errorCode: failure.code,
      errorMessage: failure.message,
    });
    return persisted
      ? { jobId: claim.jobId, status: "failed", code: failure.code }
      : { jobId: claim.jobId, status: "lease_lost" };
  }
}

export function generationInputForSagaQuarterlyClaim(claim: SagaQuarterlyGenerationClaim): ContentGenerationInput {
  const voice = safeVoiceSummary(claim.brand.voice);
  return {
    contentType: claim.slot.contentType,
    channels: [claim.slot.channel],
    topic: `${claim.slot.theme.title}: ${claim.slot.theme.intent}`.slice(0, 2_000),
    brief: [
      `Varumärke: ${claim.brand.name}.`,
      claim.brand.summary ? `Underlag från varumärkesprofil: ${claim.brand.summary}` : "Skriv bara utifrån den godkända planens tema och riktning.",
      `Planens mål: ${claim.slot.objective}`,
      `Godkänd innehållsriktning: ${claim.slot.contentDirection}`,
      "Skriv inga publik-, räckvidds-, resultat- eller prestationspåståenden om de inte finns i underlaget.",
    ].join("\n"),
    voice,
    targetLength: claim.slot.targetLength,
    templateInstructions: "Det här är ett privat granskningsutkast från en 13-veckorsplan. Skapa inte schema, publicering, leverans eller bildfil.",
    desiredCallToAction: claim.slot.desiredCallToAction,
    avoid: "Hitta inte på siffror, case, citat, erbjudanden, rabatter eller extern leverans. Påstå inte att inlägget redan är publicerat.",
    imageDirection: claim.slot.imageDirection || "Dokumentär, vardaglig miljö med naturligt ljus och en liten fysisk detalj som knyter an till texten. Ingen text, logotyp eller watermark i bilden.",
    language: "sv",
  };
}

function materializationForSagaQuarterlyClaim(
  claim: SagaQuarterlyGenerationClaim,
  input: ContentGenerationInput,
  generated: GeneratedContentResult,
  quality: SagaProductionQualityAssessment,
): SagaQuarterlyPrivateDraftMaterialization {
  return {
    contentType: claim.slot.contentType,
    channels: [claim.slot.channel],
    title: generated.draft.title,
    headline: generated.draft.headline || null,
    subject: generated.draft.subject || null,
    body: generated.draft.body,
    cta: generated.draft.callToAction || null,
    excerpt: generated.draft.excerpt || null,
    hashtags: generated.draft.hashtags,
    generationPrompt: input.topic,
    imagePrompt: generated.draft.imagePrompt,
    targetLength: claim.slot.targetLength,
    timezone: claim.slot.timezone,
    quality: { ...quality, findings: [...quality.findings], canCreatePrivateDraft: true, canDeliver: false },
  };
}

function safeVoiceSummary(value: Record<string, unknown>): string {
  const values = Object.values(value)
    .flatMap((entry) => typeof entry === "string" ? [entry.trim()] : [])
    .filter(Boolean)
    .join(". ")
    .slice(0, 260);
  return values || "Rak, varm och konkret svenska.";
}

function failureForSagaQuarterlyError(error: unknown): { code: string; message: string } {
  if (error instanceof ContentGenerationError) {
    return {
      code: error.status === 503 ? "ai_gateway_unavailable" : "ai_generation_unavailable",
      message: error.status === 503
        ? "AI-skrivningen är inte konfigurerad eller tillgänglig just nu. Inget utkast sparades."
        : "AI-utkastet kunde inte skapas just nu. Inget utkast sparades.",
    };
  }
  return {
    code: "quarterly_generation_unavailable",
    message: "Det privata AI-utkastet kunde inte skapas just nu. Inget utkast sparades.",
  };
}

function bounded(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(Math.floor(value as number), maximum));
}
