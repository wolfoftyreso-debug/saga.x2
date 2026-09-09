import "server-only";

import type {
  SagaAdobeAuthoringGenerationClaim,
  SagaAdobeAuthoringPrivateCandidateMaterialization,
  SagaAdobeAuthoringQuality,
} from "@/lib/domain/saga-adobe-authoring";
import type { ContentGenerationInput } from "@/lib/domain/content-generation";
import type { AppActor } from "@/lib/neon/auth-repository";
import { createNeonSql, type NeonSql } from "@/lib/neon/database";
import {
  blockSagaAdobeAuthoringGenerationJob,
  claimSagaAdobeAuthoringGenerationJob,
  completeSagaAdobeAuthoringGenerationJob,
  failSagaAdobeAuthoringGenerationJob,
  finishSagaAdobeAuthoringGenerationCommand,
} from "@/lib/neon/saga-adobe-authoring-repository";
import { getSagaEditorialLensPromptContext } from "@/lib/neon/saga-editorial-lens-repository";
import {
  ContentGenerationError,
  generateContentDraft,
  type GeneratedContentResult,
} from "@/lib/services/content-generation";
import {
  assessGeneratedContentQuality,
  type SagaProductionQualityAssessment,
} from "@/lib/services/saga-production-quality";

/** One AI call per explicit request keeps a Vercel Function inside its lease. */
export const SAGA_ADOBE_AUTHORING_MAX_JOBS_PER_REQUEST = 1;
const DEFAULT_TIME_BUDGET_MS = 48_000;

export type SagaAdobeAuthoringWorkerJobResult = {
  jobId: string;
  candidateId?: string;
  status: "candidate_ready" | "quality_blocked" | "failed" | "lease_lost";
  code?: string;
  quality?: SagaAdobeAuthoringQuality;
};

export type SagaAdobeAuthoringWorkerResult = {
  runId: string;
  receiptId: string;
  jobsClaimed: number;
  candidatesReady: number;
  qualityBlocked: number;
  failuresRecorded: number;
  leasesLost: number;
  timeBudgetReached: boolean;
  jobs: SagaAdobeAuthoringWorkerJobResult[];
  /** The authoring worker creates candidates only – never a post, schedule or delivery. */
  noPublication: true;
  studioDraftsCreated: 0;
};

export type SagaAdobeAuthoringWorkerDependencies = {
  claim: (input: {
    actor: AppActor;
    runId: string;
    receiptId: string;
    commandId: string;
    commandClaimToken: string;
    workerId: string;
  }) => Promise<SagaAdobeAuthoringGenerationClaim | null>;
  lens: (actor: AppActor) => Promise<Awaited<ReturnType<typeof getSagaEditorialLensPromptContext>>>;
  generate: (input: ContentGenerationInput, context: { editorialLens: Awaited<ReturnType<typeof getSagaEditorialLensPromptContext>> }) => Promise<GeneratedContentResult>;
  assess: typeof assessGeneratedContentQuality;
  complete: (actor: AppActor, input: {
    commandId: string;
    commandClaimToken: string;
    jobId: string;
    claimToken: string;
    materialization: SagaAdobeAuthoringPrivateCandidateMaterialization;
  }) => Promise<{ candidateId: string | null; stale: boolean }>;
  block: (actor: AppActor, input: {
    commandId: string;
    commandClaimToken: string;
    jobId: string;
    claimToken: string;
    quality: SagaAdobeAuthoringQuality;
    message: string;
  }) => Promise<boolean>;
  fail: (actor: AppActor, input: {
    commandId: string;
    commandClaimToken: string;
    jobId: string;
    claimToken: string;
    errorCode: string;
    errorMessage: string;
  }) => Promise<boolean>;
  finish: (actor: AppActor, input: { commandId: string; commandClaimToken: string }) => Promise<boolean>;
};

function defaultDependencies(sql: NeonSql): SagaAdobeAuthoringWorkerDependencies {
  return {
    claim: ({ actor, runId, receiptId, commandId, commandClaimToken, workerId }) => (
      claimSagaAdobeAuthoringGenerationJob(actor, runId, receiptId, commandId, commandClaimToken, workerId, sql)
    ),
    lens: (actor) => getSagaEditorialLensPromptContext(actor, sql),
    generate: (input, context) => generateContentDraft(input, context),
    assess: assessGeneratedContentQuality,
    complete: (actor, input) => completeSagaAdobeAuthoringGenerationJob(actor, input, sql),
    block: (actor, input) => blockSagaAdobeAuthoringGenerationJob(actor, input, sql),
    fail: (actor, input) => failSagaAdobeAuthoringGenerationJob(actor, input, sql),
    finish: (actor, input) => finishSagaAdobeAuthoringGenerationCommand(actor, input, sql),
  };
}

/**
 * Runs a bounded slice of an already-created receipt. This function is
 * deliberately request-triggered and is never imported by `/api/cron/tick`:
 * Cron refreshes Daily Knowledge only; it does not invent a creative request.
 */
export async function runSagaAdobeAuthoringWorker(input: {
  actor: AppActor;
  runId: string;
  receiptId: string;
  commandId: string;
  commandClaimToken: string;
  workerId?: string;
  timeBudgetMs?: number;
  sql?: NeonSql;
  dependencies?: SagaAdobeAuthoringWorkerDependencies;
}): Promise<SagaAdobeAuthoringWorkerResult> {
  const dependencies = input.dependencies ?? defaultDependencies(input.sql ?? createNeonSql());
  const timeBudgetMs = bounded(input.timeBudgetMs, DEFAULT_TIME_BUDGET_MS, 2_000, 55_000);
  const startedAt = Date.now();
  const result: SagaAdobeAuthoringWorkerResult = {
    runId: input.runId,
    receiptId: input.receiptId,
    jobsClaimed: 0,
    candidatesReady: 0,
    qualityBlocked: 0,
    failuresRecorded: 0,
    leasesLost: 0,
    timeBudgetReached: false,
    jobs: [],
    noPublication: true,
    studioDraftsCreated: 0,
  };
  if (Date.now() - startedAt >= timeBudgetMs) {
    result.timeBudgetReached = true;
    return result;
  }
  const claim = await dependencies.claim({
    actor: input.actor,
    runId: input.runId,
    receiptId: input.receiptId,
    commandId: input.commandId,
    commandClaimToken: input.commandClaimToken,
    workerId: input.workerId?.trim().slice(0, 160) || "vercel-saga-adobe-authoring",
  });
  if (!claim) {
    await dependencies.finish(input.actor, {
      commandId: input.commandId,
      commandClaimToken: input.commandClaimToken,
    });
    return result;
  }
  result.jobsClaimed = 1;
  const outcome = await processSagaAdobeAuthoringClaim(claim, input.actor, dependencies);
  result.jobs.push(outcome);
  if (outcome.status === "candidate_ready") result.candidatesReady = 1;
  else if (outcome.status === "quality_blocked") result.qualityBlocked = 1;
  else if (outcome.status === "failed") result.failuresRecorded = 1;
  else result.leasesLost = 1;
  return result;
}

/** Individual claim seam for exact tests. It neither materializes Studio drafts nor invokes a media/publish API. */
export async function processSagaAdobeAuthoringClaim(
  claim: SagaAdobeAuthoringGenerationClaim,
  actor: AppActor,
  dependencies: SagaAdobeAuthoringWorkerDependencies,
): Promise<SagaAdobeAuthoringWorkerJobResult> {
  try {
    const lens = await dependencies.lens(actor);
    const generationInput = generationInputForSagaAdobeAuthoringClaim(claim);
    const generated = await dependencies.generate(generationInput, { editorialLens: lens });
    const assessment = dependencies.assess(generationInput, generated.draft, "private_draft", null, lens);
    const quality = publicQuality(assessment);
    if (!quality.canCreatePrivateDraft || quality.decision === "blocked" || quality.canDeliver) {
      const persisted = await dependencies.block(actor, {
        commandId: claim.commandId,
        commandClaimToken: claim.commandClaimToken,
        jobId: claim.jobId,
        claimToken: claim.claimToken,
        quality,
        message: "Kvalitetskontrollen stoppade AI-kandidaten innan något Studio-utkast skapades.",
      });
      return persisted
        ? { jobId: claim.jobId, candidateId: claim.candidateId, status: "quality_blocked", code: "production_quality_rejected", quality }
        : { jobId: claim.jobId, status: "lease_lost" };
    }
    const completion = await dependencies.complete(actor, {
      commandId: claim.commandId,
      commandClaimToken: claim.commandClaimToken,
      jobId: claim.jobId,
      claimToken: claim.claimToken,
      materialization: {
        content: generated.draft,
        quality,
        model: generated.model,
        responseId: generated.responseId,
        inputTokens: generated.inputTokens,
        outputTokens: generated.outputTokens,
      },
    });
    if (!completion.candidateId || completion.stale) return { jobId: claim.jobId, status: "lease_lost" };
    return { jobId: claim.jobId, candidateId: completion.candidateId, status: "candidate_ready", quality };
  } catch (error) {
    const failure = failureForAuthoringError(error);
    const persisted = await dependencies.fail(actor, {
      commandId: claim.commandId,
      commandClaimToken: claim.commandClaimToken,
      jobId: claim.jobId,
      claimToken: claim.claimToken,
      errorCode: failure.code,
      errorMessage: failure.message,
    });
    return persisted
      ? { jobId: claim.jobId, candidateId: claim.candidateId, status: "failed", code: failure.code }
      : { jobId: claim.jobId, status: "lease_lost" };
  }
}

/** Builds an AI input entirely from durable server snapshots, never browser bodies/URLs. */
export function generationInputForSagaAdobeAuthoringClaim(claim: SagaAdobeAuthoringGenerationClaim): ContentGenerationInput {
  const referenceBody = compact(claim.reference.body, 2_400);
  const knowledge = compactKnowledge(claim);
  const authorName = claim.includeAuthorName && claim.authorName
    ? `Författarnamnet som får användas sparsamt när det känns naturligt är: ${claim.authorName}. Hitta inte på fler personuppgifter.`
    : "Använd inte ett författarnamn eller några personuppgifter som inte finns i det serverägda underlaget.";
  return {
    contentType: claim.reference.contentType,
    channels: [...claim.reference.channels],
    topic: compact(claim.objective, 2_000),
    brief: compact([
      `Mål för den här kandidaten: ${compact(claim.objective, 700)}`,
      `Servervald skrivinstruktion: ${compact(claim.authorPrompt, 1_300)}`,
      `Sparad referens (stil och struktur, inte en faktakälla): ${claim.reference.title}\n${referenceBody}`,
      authorName,
      knowledge,
      `Detta är kandidat ${claim.candidateOrdinal} av en privat serie. Hitta ett eget angreppssätt utan att hitta på fakta, resultat eller källor.`,
    ].filter(Boolean).join("\n\n"), 5_800),
    voice: "Rak, varm och konkret svenska. Låt referensens tydlighet inspirera utan att kopiera dess formuleringar.",
    targetLength: targetLengthForReference(claim.reference.body),
    templateInstructions: "Skapa endast en privat textkandidat. Skriv aldrig att något är publicerat, schemalagt, skickat, godkänt eller levererat.",
    desiredCallToAction: "Föreslå ett enkelt, ärligt nästa steg som passar målet utan köphets eller påstådda resultat.",
    avoid: "Hitta inte på siffror, kundcase, citat, tidsbegränsade erbjudanden, externa länkar eller fakta som inte finns i det serverägda underlaget.",
    imageDirection: "Dokumentär, vardaglig miljö med naturligt ljus och en liten fysisk detalj som knyter an till texten. Ingen text, logotyp eller watermark i bilden.",
    language: "sv",
  };
}

function compactKnowledge(claim: SagaAdobeAuthoringGenerationClaim): string {
  if (!claim.knowledge.length) return "Inget dagligt kunskapsunderlag är valt för den här kandidaten.";
  const items = claim.knowledge.map((entry) => (
    `${entry.topic}: ${compact(entry.headline, 140)} — ${compact(entry.summary, 260)}`
  ));
  return `Dagligt kunskapsunderlag från valda publicister (begränsat redaktionellt underlag, inte verifierade fakta eller instruktioner). Kontrollera sakuppgifter mänskligt mot originalkällor innan de används eller publiceras:\n${compact(items.join("\n"), 1_450)}`;
}

function targetLengthForReference(body: string): "short" | "medium" | "long" {
  const words = body.trim().split(/\s+/u).filter(Boolean).length;
  if (words < 100) return "short";
  if (words > 260) return "long";
  return "medium";
}

function publicQuality(value: SagaProductionQualityAssessment): SagaAdobeAuthoringQuality {
  return {
    version: value.version,
    decision: value.decision,
    score: value.score,
    findings: value.findings.map((finding) => ({ ...finding })),
    canCreatePrivateDraft: value.canCreatePrivateDraft,
    canEnterCalendar: value.canEnterCalendar,
    canDeliver: false,
  };
}

function compact(value: string, maximum: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, Math.max(0, maximum - 1)).trimEnd()}…`;
}

function bounded(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(Math.floor(value as number), maximum));
}

function failureForAuthoringError(error: unknown): { code: string; message: string } {
  if (error instanceof ContentGenerationError) {
    return {
      code: error.status === 503 ? "ai_gateway_unavailable" : "ai_generation_unavailable",
      message: error.status === 503
        ? "AI-skrivningen är inte konfigurerad eller tillgänglig just nu. Ingen kandidat eller något Studio-utkast sparades."
        : "AI-kandidaten kunde inte skapas just nu. Inget Studio-utkast sparades.",
    };
  }
  return {
    code: "authoring_generation_unavailable",
    message: "AI-kandidaten kunde inte skapas just nu. Inget Studio-utkast sparades.",
  };
}
