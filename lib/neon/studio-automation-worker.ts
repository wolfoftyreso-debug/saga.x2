import "server-only";

import { ZodError } from "zod";
import { contentGenerationInputSchema, type ContentGenerationInput } from "@/lib/domain/content-generation";
import type { ClaimedContentAutomationJob } from "@/lib/domain/content-studio";
import type { SagaEditorialLensPromptContext } from "@/lib/domain/saga-editorial-lens";
import type { AppActor } from "@/lib/neon/auth-repository";
import { getSagaEditorialLensPromptContext } from "@/lib/neon/saga-editorial-lens-repository";
import { getSagaSeriesReferenceGuidanceContext } from "@/lib/neon/saga-series-reference-repository";
import {
  claimDueStudioAutomationJobs,
  failStudioAutomationJob,
  materializeClaimedStudioAutomationDraft,
  materializeStudioAutomationJobs,
  type StudioAutomationDraftPayload,
  type StudioJobMaterializationResult,
} from "@/lib/neon/studio-content-repository";
import {
  ContentGenerationError,
  generateContentDraft,
  type ContentGenerationServerContext,
  type GeneratedContentResult,
} from "@/lib/services/content-generation";
import {
  assessGeneratedContentQuality,
  SagaProductionQualityError,
  type SagaProductionQualityAssessment,
} from "@/lib/services/saga-production-quality";
import type { SagaSeriesReferenceContext } from "@/lib/services/saga-series-reference";
import { executionTimeRemainingMs } from "@/lib/server/execution-deadline";

const MAX_JOBS_PER_RUN = 5;
const DEFAULT_TIME_BUDGET_MS = 45_000;
const MIN_TIME_BUDGET_MS = 5_000;
const MAX_TIME_BUDGET_MS = 50_000;
const RETRY_AFTER_MS = 2 * 60 * 1_000;
const MATERIALIZATION_RULE_LIMIT = 25;
const MATERIALIZATION_JOB_LIMIT = 50;

export type StudioAutomationWorkerDependencies = {
  materializeJobs: (options: {
    now: Date;
    horizonDays: number;
    ruleLimit: number;
    jobLimit: number;
  }) => Promise<StudioJobMaterializationResult>;
  claimDueJobs: (options: {
    now: Date;
    limit: number;
    leaseMs: number;
    workerId: string;
  }) => Promise<ClaimedContentAutomationJob[]>;
  materializeDraft: (input: {
    jobId: string;
    claimToken: string;
    content: StudioAutomationDraftPayload;
    now: Date;
  }) => Promise<{ id: string } | null>;
  failJob: (input: {
    jobId: string;
    claimToken: string;
    errorMessage: string;
    errorCode: string;
    retry: boolean;
    retryAfterMs: number;
    now: Date;
  }) => Promise<boolean>;
  generateContent: (input: ContentGenerationInput, context?: ContentGenerationServerContext) => Promise<GeneratedContentResult>;
  /** Reads only the active doctrine through the leased job's workspace. */
  getEditorialLens: (actor: AppActor) => Promise<SagaEditorialLensPromptContext | null>;
  /** Resolves a persisted, active Series ID; no caller can supply a snapshot. */
  getSeriesReference: (actor: AppActor, seriesId: string) => Promise<SagaSeriesReferenceContext | null>;
};

const defaultDependencies: StudioAutomationWorkerDependencies = {
  materializeJobs: materializeStudioAutomationJobs,
  claimDueJobs: claimDueStudioAutomationJobs,
  materializeDraft: materializeClaimedStudioAutomationDraft,
  failJob: failStudioAutomationJob,
  generateContent: generateContentDraft,
  getEditorialLens: getSagaEditorialLensPromptContext,
  getSeriesReference: getSagaSeriesReferenceGuidanceContext,
};

export type StudioAutomationWorkerOptions = {
  now?: Date;
  /** Hard-capped at five. The worker claims one job at a time to avoid leased work it cannot finish. */
  maxJobs?: number;
  /** Hard-capped below the route duration. No new lease is taken after this point. */
  timeBudgetMs?: number;
  workerId?: string;
  /** Manual callers can skip schedule discovery and leave it to the next cron tick. */
  materializeScheduledJobs?: boolean;
  horizonDays?: number;
};

export type StudioAutomationWorkerJobResult = {
  jobId: string;
  status: "draft_created" | "retry_scheduled" | "failed" | "lease_lost";
  draftId?: string;
  code?: string;
  /** Present for a completed private draft; no model judges its own result. */
  quality?: SagaProductionQualityAssessment;
};

export type StudioAutomationWorkerResult = {
  materialization: StudioJobMaterializationResult;
  jobsClaimed: number;
  draftsCreated: number;
  retriesScheduled: number;
  failuresRecorded: number;
  leasesLost: number;
  timeBudgetReached: boolean;
  jobs: StudioAutomationWorkerJobResult[];
};

class AutomationWorkerInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutomationWorkerInputError";
  }
}

type FailureDetails = {
  code: string;
  message: string;
  retry: boolean;
};

/**
 * Runs the Vercel-first automation queue. It performs only this durable flow:
 * schedule receipt -> leased generation job -> private unscheduled draft.
 * It never adds a publish job, calls a social provider, or sends a newsletter.
 */
export async function runNeonStudioAutomationWorker(
  options: StudioAutomationWorkerOptions = {},
  dependencies: StudioAutomationWorkerDependencies = defaultDependencies,
): Promise<StudioAutomationWorkerResult> {
  const now = options.now ?? new Date();
  const maxJobs = boundedInteger(options.maxJobs, MAX_JOBS_PER_RUN, 1, MAX_JOBS_PER_RUN);
  const timeBudgetMs = boundedInteger(options.timeBudgetMs, DEFAULT_TIME_BUDGET_MS, MIN_TIME_BUDGET_MS, MAX_TIME_BUDGET_MS);
  const workerId = options.workerId?.trim().slice(0, 160) || "vercel-cron";
  const startedAt = Date.now();

  const materialization = options.materializeScheduledJobs === false
    ? { rulesScanned: 0, jobsCreated: 0, nextRunsUpdated: 0 }
    : await dependencies.materializeJobs({
      now,
      horizonDays: boundedInteger(options.horizonDays, 14, 1, 31),
      ruleLimit: MATERIALIZATION_RULE_LIMIT,
      jobLimit: MATERIALIZATION_JOB_LIMIT,
    });

  const result: StudioAutomationWorkerResult = {
    materialization,
    jobsClaimed: 0,
    draftsCreated: 0,
    retriesScheduled: 0,
    failuresRecorded: 0,
    leasesLost: 0,
    timeBudgetReached: false,
    jobs: [],
  };

  for (let index = 0; index < maxJobs; index += 1) {
    if (Date.now() - startedAt >= timeBudgetMs || executionTimeRemainingMs() <= 3_500) {
      result.timeBudgetReached = true;
      break;
    }

    // Claim only one row per pass. This keeps all unprocessed rows available
    // to another invocation instead of sitting in our lease while an AI call
    // is in progress.
    const [claim] = await dependencies.claimDueJobs({
      now,
      limit: 1,
      leaseMs: Math.max(2 * timeBudgetMs, 60_000),
      workerId,
    });
    if (!claim) break;

    result.jobsClaimed += 1;
    const outcome = await processNeonStudioAutomationClaim(claim, { now, dependencies });
    result.jobs.push(outcome);
    if (outcome.status === "draft_created") result.draftsCreated += 1;
    else if (outcome.status === "retry_scheduled") result.retriesScheduled += 1;
    else if (outcome.status === "failed") result.failuresRecorded += 1;
    else result.leasesLost += 1;
  }

  return result;
}

/**
 * Processes one already-leased job. Exposed so a future exact manual-claim
 * route can reuse the same generation, failure and private-draft rules.
 */
export async function processNeonStudioAutomationClaim(
  claim: ClaimedContentAutomationJob,
  input: { now?: Date; dependencies?: StudioAutomationWorkerDependencies } = {},
): Promise<StudioAutomationWorkerJobResult> {
  const now = input.now ?? new Date();
  const dependencies = input.dependencies ?? defaultDependencies;

  try {
    const generationInput = generationInputForClaim(claim);
    const generationContext = await generationContextForClaim(claim, dependencies);
    const generated = await dependencies.generateContent(generationInput, generationContext);
    const quality = assessGeneratedContentQuality(
      generationInput,
      generated.draft,
      "private_draft",
      generationContext.seriesReference ?? null,
      generationContext.editorialLens ?? null,
    );
    if (!quality.canCreatePrivateDraft) {
      throw new SagaProductionQualityError(
        quality.findings.find((finding) => finding.severity === "blocker")?.message
          ?? "AI-utkastet klarade inte SAGA:s produktionskvalitet.",
        quality,
      );
    }
    const draft = await dependencies.materializeDraft({
      jobId: claim.id,
      claimToken: claim.claimToken,
      content: payloadFromGeneratedContent(claim, generated, quality, generationContext),
      now,
    });

    // A null result means another worker owns/completed this lease now. It is
    // not an error and must never be overwritten by a stale failure receipt.
    if (!draft) return { jobId: claim.id, status: "lease_lost" };
    return { jobId: claim.id, status: "draft_created", draftId: draft.id, quality };
  } catch (error) {
    const failure = failureDetails(error);
    let recorded: boolean;
    try {
      recorded = await dependencies.failJob({
        jobId: claim.id,
        claimToken: claim.claimToken,
        errorMessage: failure.message,
        errorCode: failure.code,
        retry: failure.retry,
        retryAfterMs: RETRY_AFTER_MS,
        now,
      });
    } catch {
      // The original failure has not been durably recorded. Surface this to
      // cron as an infrastructure error rather than falsely acknowledging it.
      throw new Error("Automationsjobbet kunde inte registrera sitt felkvittens säkert.");
    }
    if (!recorded) return { jobId: claim.id, status: "lease_lost" };
    return {
      jobId: claim.id,
      status: failure.retry ? "retry_scheduled" : "failed",
      code: failure.code,
    };
  }
}

/** Maps a trusted Neon rule/template configuration into the shared AI schema. */
export function generationInputForClaim(claim: ClaimedContentAutomationJob): ContentGenerationInput {
  if (claim.rule.language !== "sv") {
    throw new AutomationWorkerInputError("Automatiserad AI-skrivning stöder just nu bara svenska.");
  }

  return contentGenerationInputSchema.parse({
    contentType: claim.rule.contentType,
    channels: claim.rule.channels,
    topic: claim.rule.generationPrompt,
    brief: "",
    voice: claim.rule.tone ?? "Rak, varm och konkret svenska.",
    targetLength: lengthFromDesiredWordCount(claim.rule.desiredLength),
    templateInstructions: claim.template?.generationPrompt ?? "",
    desiredCallToAction: claim.template?.defaultCta ?? "",
    imageDirection: claim.rule.imagePrompt || claim.template?.imagePrompt || "",
    language: "sv",
  });
}

function payloadFromGeneratedContent(
  claim: ClaimedContentAutomationJob,
  generated: GeneratedContentResult,
  quality: SagaProductionQualityAssessment,
  generationContext: ContentGenerationServerContext,
): StudioAutomationDraftPayload {
  return {
    title: generated.draft.title,
    headline: generated.draft.headline,
    subject: generated.draft.subject,
    body: generated.draft.body,
    cta: generated.draft.callToAction,
    excerpt: generated.draft.excerpt,
    hashtags: generated.draft.hashtags,
    generationPrompt: claim.rule.generationPrompt,
    imagePrompt: generated.draft.imagePrompt,
    language: "sv",
    quality,
    qualityContext: {
      targetLength: claim.rule.desiredLength ? lengthFromDesiredWordCount(claim.rule.desiredLength) : "medium",
      editorialLens: generationContext.editorialLens ?? null,
      seriesReference: generationContext.seriesReference ?? null,
    },
  };
}

/**
 * Builds the one server-owned context passed into generation and the quality
 * gate. The public rule only stores an optional Series UUID; the active Lens
 * and frozen Series snapshot are fetched after a workspace-scoped job lease
 * exists. This worker never fetches a URL, live article, Blob, or provider.
 */
async function generationContextForClaim(
  claim: ClaimedContentAutomationJob,
  dependencies: StudioAutomationWorkerDependencies,
): Promise<ContentGenerationServerContext> {
  const workspaceId = claim.workspaceId?.trim();
  if (!workspaceId) {
    throw new AutomationWorkerInputError("Automationsjobbet saknar en säker arbetsytekontext.");
  }
  const brandProfileId = claim.rule.brandProfileId?.trim();
  if (!brandProfileId) throw new AutomationWorkerInputError("Automationsjobbet saknar ett entydigt varumärke.");
  const actor: AppActor = {
    userId: claim.userId,
    workspaceId,
    brandProfileId,
    // Both readers are read-only and enforce workspace scope in SQL. The role
    // is present only to satisfy the internal actor DTO; it grants no write.
    role: "editor",
    email: null,
    displayName: null,
  };
  const seriesId = typeof claim.rule.seriesId === "string" && claim.rule.seriesId.trim()
    ? claim.rule.seriesId.trim()
    : null;
  const [editorialLens, seriesReference] = await Promise.all([
    dependencies.getEditorialLens(actor),
    seriesId ? dependencies.getSeriesReference(actor, seriesId) : Promise.resolve(null),
  ]);
  if (seriesId && !seriesReference) {
    throw new AutomationWorkerInputError("Automationens valda SAGA-serie är inte längre aktiv i arbetsytan.");
  }
  return {
    editorialLens,
    seriesReference,
    automation: {
      name: claim.rule.name,
      template: claim.template
        ? {
          name: claim.template.name,
          description: claim.template.description,
          contentType: claim.template.contentType,
          channels: claim.template.channels,
        }
        : null,
    },
  };
}

function failureDetails(error: unknown): FailureDetails {
  if (error instanceof AutomationWorkerInputError || error instanceof ZodError) {
    return { code: "automation_configuration_invalid", message: "Automationens innehållsinställningar är ogiltiga.", retry: false };
  }
  if (error instanceof ContentGenerationError) {
    return {
      code: error.status === 503 ? "ai_configuration_unavailable" : "ai_generation_failed",
      message: error.message,
      retry: error.status >= 500 || error.status === 429,
    };
  }
  if (error instanceof SagaProductionQualityError) {
    return {
      code: "production_quality_rejected",
      message: error.message,
      retry: false,
    };
  }

  const status = error && typeof error === "object" && "status" in error && typeof error.status === "number"
    ? error.status
    : null;
  if (status !== null) {
    return {
      code: status >= 500 || status === 429 ? "automation_dependency_unavailable" : "automation_worker_rejected",
      message: status >= 500 || status === 429
        ? "En tillfällig tjänst kunde inte skapa utkastet."
        : "Automationen kunde inte skapa ett giltigt utkast.",
      retry: status >= 500 || status === 429,
    };
  }

  // Database/network failures without an HTTP status are treated as transient;
  // deterministic schema and generation input errors are handled above.
  return {
    code: "automation_worker_unavailable",
    message: "Automationsmotorn kunde inte slutföra utkastet just nu.",
    retry: true,
  };
}

function lengthFromDesiredWordCount(value: number | null): "short" | "medium" | "long" {
  if (!value) return "medium";
  if (value <= 100) return "short";
  if (value >= 280) return "long";
  return "medium";
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(Math.floor(value as number), maximum));
}
