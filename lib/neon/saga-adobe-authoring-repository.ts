import "server-only";

import {
  sagaAdobeAuthoringCandidateSchema,
  sagaAdobeAuthoringCandidateSelectSchema,
  sagaAdobeAuthoringGenerationReceiptSchema,
  sagaAdobeAuthoringGenerationProgressSchema,
  sagaAdobeAuthoringKnowledgeSnapshotSchema,
  sagaAdobeAuthoringReferenceSnapshotSchema,
  sagaAdobeAuthoringRunCreateSchema,
  sagaAdobeAuthoringRunGenerateSchema,
  sagaAdobeAuthoringRunSchema,
  type SagaAdobeAuthoringCandidate,
  type SagaAdobeAuthoringCandidateSelectInput,
  type SagaAdobeAuthoringGenerationCommand,
  type SagaAdobeAuthoringGenerationClaim,
  type SagaAdobeAuthoringGenerationProgress,
  type SagaAdobeAuthoringGenerationReceipt,
  type SagaAdobeAuthoringPrivateCandidateMaterialization,
  type SagaAdobeAuthoringRun,
  type SagaAdobeAuthoringRunCreateInput,
  type SagaAdobeAuthoringRunGenerateInput,
} from "@/lib/domain/saga-adobe-authoring";
import type { AppActor } from "@/lib/neon/auth-repository";
import { createNeonSql, type NeonSql } from "@/lib/neon/database";

type JsonObject = Record<string, unknown>;

type RunRow = {
  id: string;
  reference_draft_id: string;
  reference_draft_revision: number | string;
  reference_snapshot: unknown;
  objective: string;
  author_prompt: string;
  include_author_name: boolean;
  candidate_count: number | string;
  state: string;
  selected_candidate_id: string | null;
  selected_draft_id: string | null;
  failure_message: string | null;
  revision: number | string;
  created_at: string | Date;
  updated_at: string | Date;
};

type KnowledgeRow = { snapshot: unknown };

type CandidateRow = {
  id: string;
  ordinal: number | string;
  state: string;
  generated_content: unknown;
  quality: unknown;
  error_message: string | null;
  revision: number | string;
  selected_draft_id: string | null;
  created_at: string | Date;
  updated_at: string | Date;
};

type ReceiptRow = {
  id: string;
  state: string;
  run_revision: number | string;
  job_count: number | string;
  completed_job_count: number | string;
  failed_job_count: number | string;
  failure_message: string | null;
};

type ClaimRow = {
  job_id: string;
  claim_token: string;
  receipt_id: string;
  run_id: string;
  run_revision: number | string;
  candidate_id: string;
  candidate_ordinal: number | string;
  reference_snapshot: unknown;
  objective: string;
  author_prompt: string;
  include_author_name: boolean;
  author_name_snapshot: string | null;
  knowledge_entries: unknown;
};

export class SagaAdobeAuthoringAccessError extends Error {
  constructor(message = "Du har bara läsrättighet i den här arbetsytan.") {
    super(message);
    this.name = "SagaAdobeAuthoringAccessError";
  }
}

export class SagaAdobeAuthoringNotFoundError extends Error {
  constructor(message = "Författarkörningen hittades inte i den här arbetsytan.") {
    super(message);
    this.name = "SagaAdobeAuthoringNotFoundError";
  }
}

export class SagaAdobeAuthoringConflictError extends Error {
  constructor(message = "Författarkörningen har ändrats eller arbetar redan. Läs in den igen innan du fortsätter.") {
    super(message);
    this.name = "SagaAdobeAuthoringConflictError";
  }
}

export class SagaAdobeAuthoringValidationError extends Error {
  constructor(message = "Författarkörningen kan inte startas med det valda underlaget.") {
    super(message);
    this.name = "SagaAdobeAuthoringValidationError";
  }
}

function assertCanWrite(actor: AppActor): void {
  if (actor.role === "viewer") throw new SagaAdobeAuthoringAccessError();
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function integer(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new SagaAdobeAuthoringValidationError("Sparad författardata kunde inte läsas säkert.");
  return parsed;
}

function revision(value: unknown): number {
  const parsed = integer(value);
  if (parsed < 1) throw new SagaAdobeAuthoringValidationError("Sparad författardata kunde inte läsas säkert.");
  return parsed;
}

function timestamp(value: unknown): string {
  const parsed = value instanceof Date ? value : new Date(typeof value === "string" ? value : "");
  if (Number.isNaN(parsed.getTime())) throw new SagaAdobeAuthoringValidationError("Sparad författardata kunde inte läsas säkert.");
  return parsed.toISOString();
}

function jsonObject(value: unknown): JsonObject | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as JsonObject;
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonObject : null;
  } catch {
    return null;
  }
}

function jsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function draftHref(value: string | null): string | null {
  return value && isUuid(value) ? `/studio/content/${encodeURIComponent(value)}?edit=1` : null;
}

function mapCandidate(row: CandidateRow): SagaAdobeAuthoringCandidate {
  const content = row.generated_content === null || row.generated_content === undefined
    ? null
    : jsonObject(row.generated_content);
  const quality = row.quality === null || row.quality === undefined ? null : jsonObject(row.quality);
  return sagaAdobeAuthoringCandidateSchema.parse({
    id: row.id,
    ordinal: revision(row.ordinal),
    state: row.state,
    revision: revision(row.revision),
    content,
    quality,
    error: row.error_message,
    selectedDraftId: row.selected_draft_id,
    selectedDraftHref: draftHref(row.selected_draft_id),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  });
}

function mapReceipt(row: ReceiptRow, reused: boolean): SagaAdobeAuthoringGenerationReceipt {
  return sagaAdobeAuthoringGenerationReceiptSchema.parse({
    id: row.id,
    state: row.state,
    runRevision: revision(row.run_revision),
    jobCount: integer(row.job_count),
    completedJobCount: integer(row.completed_job_count),
    failedJobCount: integer(row.failed_job_count),
    failureMessage: row.failure_message,
    reused,
  });
}

function databaseFailure(error: unknown): never {
  if (
    error instanceof SagaAdobeAuthoringAccessError
    || error instanceof SagaAdobeAuthoringNotFoundError
    || error instanceof SagaAdobeAuthoringConflictError
    || error instanceof SagaAdobeAuthoringValidationError
  ) throw error;
  const details = error && typeof error === "object" ? error as { code?: unknown; message?: unknown } : null;
  const code = details?.code;
  const message = typeof details?.message === "string" ? details.message : "";
  if (/saga_adobe_authoring_(run_not_found|candidate_not_found|reference_not_found)/.test(message)) {
    throw new SagaAdobeAuthoringNotFoundError();
  }
  if (message.includes("saga_adobe_authoring_knowledge_entry_not_found_or_expired")) {
    throw new SagaAdobeAuthoringValidationError("Det valda kunskapsunderlaget saknas eller har gallrats. Välj en aktuell daglig insikt igen.");
  }
  if (message.includes("saga_adobe_authoring_reference_unsuitable")) {
    throw new SagaAdobeAuthoringValidationError("Välj ett sparat referensinlägg med titel, brödtext och minst en Studio-kanal.");
  }
  if (message.includes("saga_adobe_authoring_attempts_exhausted")) {
    throw new SagaAdobeAuthoringConflictError("AI-körningen har nått sin säkra retrygräns. Skapa en ny författarkörning från referensen i stället för att låtsas att kandidater skapats.");
  }
  if (
    code === "23505"
    || /saga_adobe_authoring_(create_idempotency_conflict|generation_idempotency_conflict|selection_idempotency_conflict|reference_revision_conflict|run_revision_conflict|candidate_revision_conflict|generation_running|run_closed|candidates_ready|retry_required|no_candidates_to_generate|selection_not_available|candidate_not_selectable|candidate_quality_rejected)/.test(message)
  ) throw new SagaAdobeAuthoringConflictError();
  if (code === "23514" || /saga_adobe_authoring_(invalid|duplicate|too_many|quality_rejected)/.test(message)) {
    throw new SagaAdobeAuthoringValidationError();
  }
  throw error;
}

const runSelect = `select
  run.id::text,
  run.reference_draft_id::text,
  run.reference_draft_revision,
  run.reference_snapshot,
  run.objective,
  run.author_prompt,
  run.include_author_name,
  run.candidate_count,
  run.state,
  run.selected_candidate_id::text,
  run.selected_draft_id::text,
  run.failure_message,
  run.revision,
  run.created_at::text,
  run.updated_at::text
from saga_adobe_authoring_runs run`;

async function getRunRow(actor: AppActor, runId: string, sql: NeonSql): Promise<RunRow | null> {
  if (!actor.brandProfileId) throw new SagaAdobeAuthoringValidationError("Välj ett färdigställt varumärke.");
  const rows = await sql.query(
    `${runSelect} where run.workspace_id = $1::uuid and run.id = $2::uuid and run.brand_profile_id = $3::uuid limit 1`,
    [actor.workspaceId, runId, actor.brandProfileId],
  ) as unknown as RunRow[];
  return rows[0] ?? null;
}

async function mapRun(actor: AppActor, row: RunRow, sql: NeonSql): Promise<SagaAdobeAuthoringRun> {
  const [knowledgeRows, candidateRows, healthRows] = await Promise.all([
    sql.query(
      `select snapshot
         from saga_adobe_authoring_run_knowledge_entries
        where workspace_id = $1::uuid and run_id = $2::uuid
        order by ordinal`,
      [actor.workspaceId, row.id],
    ) as unknown as Promise<KnowledgeRow[]>,
    sql.query(
      `select
         candidate.id::text, candidate.ordinal, candidate.state, candidate.generated_content, candidate.quality,
         candidate.error_message, candidate.revision,
         case when run.selected_candidate_id = candidate.id then run.selected_draft_id::text else null end as selected_draft_id,
         candidate.created_at::text, candidate.updated_at::text
       from saga_adobe_authoring_candidates candidate
       join saga_adobe_authoring_runs run
         on run.workspace_id = candidate.workspace_id and run.id = candidate.run_id
       where candidate.workspace_id = $1::uuid and candidate.run_id = $2::uuid
       order by candidate.ordinal`,
      [actor.workspaceId, row.id],
    ) as unknown as Promise<CandidateRow[]>,
    sql.query(
      `select
         count(*) filter (where job.state = 'failed' and job.attempt_count < job.max_attempt_count)::int as retryable_job_count,
         count(*) filter (where job.state = 'failed' and job.attempt_count >= job.max_attempt_count)::int as exhausted_job_count,
         count(*) filter (where job.state = 'processing' and job.lease_expires_at > now())::int as active_job_count,
         count(*) filter (where job.state in ('queued', 'processing'))::int as pending_job_count
       from saga_adobe_authoring_generation_jobs job
       where job.workspace_id = $1::uuid and job.run_id = $2::uuid`,
      [actor.workspaceId, row.id],
    ) as unknown as Promise<Array<{
      retryable_job_count: number | string;
      exhausted_job_count: number | string;
      active_job_count: number | string;
      pending_job_count: number | string;
    }>>,
  ]);
  const candidates = candidateRows.map(mapCandidate);
  const generationProgress = progressForCandidates(candidates, integer(row.candidate_count));
  const health = healthRows[0] ?? { retryable_job_count: 0, exhausted_job_count: 0, active_job_count: 0, pending_job_count: 0 };
  const state = row.state;
  const readyCount = candidates.filter((candidate) => candidate.state === "ready").length;
  const retryable = integer(health.retryable_job_count);
  const hasPendingWork = state === "generating" && integer(health.pending_job_count) > 0;
  return sagaAdobeAuthoringRunSchema.parse({
    id: row.id,
    revision: revision(row.revision),
    state,
    objective: row.objective,
    prompt: row.author_prompt,
    includeAuthorName: row.include_author_name === true,
    candidateCount: integer(row.candidate_count),
    reference: sagaAdobeAuthoringReferenceSnapshotSchema.parse(jsonObject(row.reference_snapshot)),
    knowledge: knowledgeRows.map((entry) => sagaAdobeAuthoringKnowledgeSnapshotSchema.parse(jsonObject(entry.snapshot))),
    candidates,
    selectedCandidateId: row.selected_candidate_id,
    selectedDraftId: row.selected_draft_id,
    selectedDraftHref: draftHref(row.selected_draft_id),
    failureMessage: row.failure_message,
    canGenerate: state === "queued" || (state === "failed" && retryable > 0),
    canRetry: state === "failed" && retryable > 0,
    canSelect: state === "ready_to_select" && readyCount > 0,
    hasPendingWork,
    canContinue: hasPendingWork,
    generationProgress,
    noPublication: true,
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  });
}

/** Candidate rows are created together with the run, so a mismatch is corrupt data, not an empty UI state. */
function progressForCandidates(
  candidates: readonly SagaAdobeAuthoringCandidate[],
  candidateCount: number,
): SagaAdobeAuthoringGenerationProgress {
  if (candidates.length !== candidateCount) {
    throw new SagaAdobeAuthoringValidationError("Författarkörningen saknar en komplett kandidatuppsättning. Läs inte in den som färdig.");
  }
  const progress: SagaAdobeAuthoringGenerationProgress = {
    total: candidateCount,
    pending: 0,
    completed: 0,
    queued: 0,
    generating: 0,
    ready: 0,
    blocked: 0,
    failed: 0,
    selected: 0,
    notSelected: 0,
  };
  for (const candidate of candidates) {
    switch (candidate.state) {
      case "queued": progress.queued += 1; break;
      case "generating": progress.generating += 1; break;
      case "ready": progress.ready += 1; break;
      case "blocked": progress.blocked += 1; break;
      case "failed": progress.failed += 1; break;
      case "selected": progress.selected += 1; break;
      case "not_selected": progress.notSelected += 1; break;
    }
  }
  progress.pending = progress.queued + progress.generating;
  progress.completed = progress.total - progress.pending;
  return sagaAdobeAuthoringGenerationProgressSchema.parse(progress);
}

async function getReceipt(
  actor: AppActor,
  receiptId: string,
  reused: boolean,
  sql: NeonSql,
): Promise<SagaAdobeAuthoringGenerationReceipt> {
  const rows = await sql.query(
    `select
       receipt.id::text, receipt.state, receipt.run_revision, receipt.job_count, receipt.failure_message,
       count(*) filter (where job.state = 'completed')::int as completed_job_count,
       count(*) filter (where job.state in ('failed', 'cancelled'))::int as failed_job_count
     from saga_adobe_authoring_generation_receipts receipt
     join saga_adobe_authoring_runs run on run.id = receipt.run_id and run.workspace_id = receipt.workspace_id
     left join saga_adobe_authoring_generation_jobs job
       on job.workspace_id = receipt.workspace_id and job.generation_receipt_id = receipt.id
     where receipt.workspace_id = $1::uuid and receipt.id = $2::uuid
       and run.brand_profile_id = $3::uuid
     group by receipt.id
     limit 1`,
    [actor.workspaceId, receiptId, actor.brandProfileId ?? null],
  ) as unknown as ReceiptRow[];
  if (!rows[0]) throw new SagaAdobeAuthoringConflictError("Produktionskvittot kunde inte läsas efter starten.");
  return mapReceipt(rows[0], reused);
}

/** Reads one actor-scoped durable receipt after a bounded worker slice. */
export async function getSagaAdobeAuthoringGenerationReceipt(
  actor: AppActor,
  receiptId: string,
  reused = false,
  sql: NeonSql = createNeonSql(),
): Promise<SagaAdobeAuthoringGenerationReceipt | null> {
  if (!isUuid(receiptId)) throw new SagaAdobeAuthoringNotFoundError();
  try {
    const rows = await sql.query(
      `select receipt.id::text
         from saga_adobe_authoring_generation_receipts receipt
         join saga_adobe_authoring_runs run on run.id = receipt.run_id and run.workspace_id = receipt.workspace_id
        where receipt.workspace_id = $1::uuid and receipt.id = $2::uuid and run.brand_profile_id = $3::uuid
        limit 1`,
      [actor.workspaceId, receiptId, actor.brandProfileId ?? null],
    ) as unknown as Array<{ id: string }>;
    return rows[0] ? await getReceipt(actor, receiptId, reused, sql) : null;
  } catch (error) {
    return databaseFailure(error);
  }
}

/** Lists private authoring runs owned by the signed actor's workspace. */
export async function listSagaAdobeAuthoringRuns(
  actor: AppActor,
  sql: NeonSql = createNeonSql(),
): Promise<SagaAdobeAuthoringRun[]> {
  try {
    const rows = await sql.query(
      `${runSelect} where run.workspace_id = $1::uuid and run.brand_profile_id = $2::uuid order by run.updated_at desc, run.id desc limit 30`,
      [actor.workspaceId, actor.brandProfileId ?? null],
    ) as unknown as RunRow[];
    return Promise.all(rows.map((row) => mapRun(actor, row, sql)));
  } catch (error) {
    return databaseFailure(error);
  }
}

/** Reads a run, candidates and safe knowledge snapshots only inside the actor's current workspace. */
export async function getSagaAdobeAuthoringRun(
  actor: AppActor,
  runId: string,
  sql: NeonSql = createNeonSql(),
): Promise<SagaAdobeAuthoringRun | null> {
  if (!isUuid(runId)) throw new SagaAdobeAuthoringNotFoundError();
  try {
    const row = await getRunRow(actor, runId, sql);
    return row ? await mapRun(actor, row, sql) : null;
  } catch (error) {
    return databaseFailure(error);
  }
}

/**
 * Resolves only still-retained Daily Knowledge entry summaries for a transient
 * first-draft request. It deliberately does not read `evidence`, URLs or any
 * News Core body text. Durable runs use the equivalent SQL snapshot during
 * creation so a later retention prune cannot change their input.
 */
export async function resolveSagaAdobeAuthoringKnowledgeSnapshots(
  actor: AppActor,
  entryIds: readonly string[],
  sql: NeonSql = createNeonSql(),
): Promise<ReturnType<typeof sagaAdobeAuthoringKnowledgeSnapshotSchema.parse>[]> {
  if (entryIds.length > 12 || new Set(entryIds).size !== entryIds.length || entryIds.some((entryId) => !isUuid(entryId))) {
    throw new SagaAdobeAuthoringValidationError("Välj högst tolv unika dagliga kunskapsunderlag.");
  }
  if (!entryIds.length) return [];
  try {
    const rows = await sql.query(
      `select id::text, policy_revision, knowledge_date::text, topic, headline, summary,
              evidence_count, independent_publisher_count, created_at::text
         from saga_daily_knowledge_entries
        where workspace_id = $1::uuid
          and id = any($2::uuid[])
          and exists (select 1 from saga_daily_knowledge_policies policy
            where policy.workspace_id = saga_daily_knowledge_entries.workspace_id
              and policy.id = saga_daily_knowledge_entries.policy_id and policy.brand_profile_id = $3::uuid)
          and retention_expires_at > now()`,
      [actor.workspaceId, [...entryIds], actor.brandProfileId ?? null],
    ) as unknown as Array<{
      id: string;
      policy_revision: number | string;
      knowledge_date: string | Date;
      topic: string;
      headline: string;
      summary: string;
      evidence_count: number | string;
      independent_publisher_count: number | string;
      created_at: string | Date;
    }>;
    if (rows.length !== entryIds.length) {
      throw new SagaAdobeAuthoringValidationError("Det valda kunskapsunderlaget saknas eller har gallrats. Välj en aktuell daglig insikt igen.");
    }
    const snapshots = new Map(rows.map((row) => [row.id, sagaAdobeAuthoringKnowledgeSnapshotSchema.parse({
      entryId: row.id,
      policyRevision: revision(row.policy_revision),
      knowledgeDate: timestamp(row.knowledge_date).slice(0, 10),
      topic: row.topic,
      headline: row.headline,
      summary: row.summary,
      evidenceCount: integer(row.evidence_count),
      independentPublisherCount: integer(row.independent_publisher_count),
      capturedAt: timestamp(row.created_at),
    })]));
    return entryIds.map((entryId) => {
      const entry = snapshots.get(entryId);
      if (!entry) throw new SagaAdobeAuthoringValidationError("Det valda kunskapsunderlaget kunde inte läsas säkert.");
      return entry;
    });
  } catch (error) {
    return databaseFailure(error);
  }
}

/** Captures only server-resolved saved-draft and Daily Knowledge snapshots. */
export async function createSagaAdobeAuthoringRun(
  actor: AppActor,
  input: SagaAdobeAuthoringRunCreateInput,
  sql: NeonSql = createNeonSql(),
): Promise<{ run: SagaAdobeAuthoringRun; reused: boolean }> {
  assertCanWrite(actor);
  const payload = sagaAdobeAuthoringRunCreateSchema.parse(input);
  try {
    if (!actor.brandProfileId) throw new SagaAdobeAuthoringValidationError("Välj ett färdigställt varumärke.");
    const reference = await sql.query(
      `select id::text from studio_drafts where workspace_id = $1::uuid and id = $2::uuid and brand_profile_id = $3::uuid`,
      [actor.workspaceId, payload.referenceDraftId, actor.brandProfileId],
    );
    if (!reference[0]) throw new SagaAdobeAuthoringNotFoundError("Referensutkastet tillhör inte det valda varumärket.");
    await resolveSagaAdobeAuthoringKnowledgeSnapshots(actor, payload.selectedKnowledgeEntryIds, sql);
    const rows = await sql.query(
      `select run_id::text, reused
         from saga_create_adobe_authoring_run(
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::int, $6, $7, $8::boolean, $9::uuid[], $10::int
         )`,
      [
        actor.workspaceId, actor.userId, payload.idempotencyKey, payload.referenceDraftId,
        payload.expectedReferenceDraftRevision, payload.objective, payload.prompt, payload.includeAuthorName,
        payload.selectedKnowledgeEntryIds, payload.candidateCount,
      ],
    ) as unknown as Array<{ run_id: string; reused: boolean }>;
    const result = rows[0];
    if (!result?.run_id) throw new SagaAdobeAuthoringConflictError("Författarkörningen kunde inte läsas efter sparandet.");
    const run = await getSagaAdobeAuthoringRun(actor, result.run_id, sql);
    if (!run) throw new SagaAdobeAuthoringConflictError("Författarkörningen kunde inte läsas efter sparandet.");
    return { run, reused: result.reused === true };
  } catch (error) {
    return databaseFailure(error);
  }
}

/** Starts/resumes an already requested run and returns a durable generation receipt. */
export async function prepareSagaAdobeAuthoringRunGeneration(
  actor: AppActor,
  runId: string,
  input: SagaAdobeAuthoringRunGenerateInput,
  sql: NeonSql = createNeonSql(),
): Promise<{
  run: SagaAdobeAuthoringRun;
  receipt: SagaAdobeAuthoringGenerationReceipt;
  command: SagaAdobeAuthoringGenerationCommand;
}> {
  assertCanWrite(actor);
  if (!isUuid(runId)) throw new SagaAdobeAuthoringNotFoundError();
  const payload = sagaAdobeAuthoringRunGenerateSchema.parse(input);
  try {
    if (!await getRunRow(actor, runId, sql)) throw new SagaAdobeAuthoringNotFoundError();
    const rows = await sql.query(
      `select run_id::text, receipt_id::text, command_id::text,
              command_claim_token::text, reused, should_process
         from saga_prepare_adobe_authoring_run_generation($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::int, $6::boolean)`,
      [actor.workspaceId, actor.userId, runId, payload.idempotencyKey, payload.expectedRunRevision, payload.retryFailed],
    ) as unknown as Array<{
      run_id: string;
      receipt_id: string;
      command_id: string;
      command_claim_token: string | null;
      reused: boolean;
      should_process: boolean;
    }>;
    const result = rows[0];
    if (!result?.run_id || !result.receipt_id || !result.command_id) {
      throw new SagaAdobeAuthoringConflictError("Den privata kandidatproduktionen kunde inte reserveras.");
    }
    if (result.should_process === true && !isUuid(result.command_claim_token ?? "")) {
      throw new SagaAdobeAuthoringConflictError("Produktionskommandot saknar en giltig lease. Försök igen utan att skapa en ny körning.");
    }
    const [run, receipt] = await Promise.all([
      getSagaAdobeAuthoringRun(actor, result.run_id, sql),
      getReceipt(actor, result.receipt_id, result.reused === true, sql),
    ]);
    if (!run) throw new SagaAdobeAuthoringNotFoundError();
    return {
      run,
      receipt,
      command: {
        id: result.command_id,
        claimToken: result.should_process === true ? result.command_claim_token : null,
        shouldProcess: result.should_process === true,
      },
    };
  } catch (error) {
    return databaseFailure(error);
  }
}

/** Server-only worker seam. It has no way to choose another workspace or candidate. */
export async function claimSagaAdobeAuthoringGenerationJob(
  actor: AppActor,
  runId: string,
  receiptId: string,
  commandId: string,
  commandClaimToken: string,
  workerId: string,
  sql: NeonSql = createNeonSql(),
): Promise<SagaAdobeAuthoringGenerationClaim | null> {
  if (!isUuid(runId) || !isUuid(receiptId) || !isUuid(commandId) || !isUuid(commandClaimToken)) {
    throw new SagaAdobeAuthoringNotFoundError();
  }
  try {
    if (!await getRunRow(actor, runId, sql)) throw new SagaAdobeAuthoringNotFoundError();
    const rows = await sql.query(
      `select * from saga_claim_adobe_authoring_generation_job(
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7::int
       )`,
      [actor.workspaceId, runId, receiptId, commandId, commandClaimToken, workerId.slice(0, 160), 90],
    ) as unknown as ClaimRow[];
    const row = rows[0];
    if (!row) return null;
    return {
      commandId,
      commandClaimToken,
      jobId: row.job_id,
      claimToken: row.claim_token,
      receiptId: row.receipt_id,
      runId: row.run_id,
      runRevision: revision(row.run_revision),
      candidateId: row.candidate_id,
      candidateOrdinal: revision(row.candidate_ordinal),
      reference: sagaAdobeAuthoringReferenceSnapshotSchema.parse(jsonObject(row.reference_snapshot)),
      objective: row.objective,
      authorPrompt: row.author_prompt,
      includeAuthorName: row.include_author_name === true,
      authorName: row.author_name_snapshot,
      knowledge: jsonArray(row.knowledge_entries).map((entry) => sagaAdobeAuthoringKnowledgeSnapshotSchema.parse(jsonObject(entry))),
    };
  } catch (error) {
    return databaseFailure(error);
  }
}

/** Finalizes one immutable candidate. The SQL boundary rejects blocked quality and a stale lease. */
export async function completeSagaAdobeAuthoringGenerationJob(
  actor: AppActor,
  input: {
    commandId: string;
    commandClaimToken: string;
    jobId: string;
    claimToken: string;
    materialization: SagaAdobeAuthoringPrivateCandidateMaterialization;
  },
  sql: NeonSql = createNeonSql(),
): Promise<{ candidateId: string | null; stale: boolean }> {
  if (!isUuid(input.commandId) || !isUuid(input.commandClaimToken) || !isUuid(input.jobId) || !isUuid(input.claimToken)) {
    throw new SagaAdobeAuthoringNotFoundError();
  }
  try {
    const rows = await sql.query(
      `select candidate_id::text, stale
         from saga_complete_adobe_authoring_generation_job(
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::jsonb
         )`,
      [
        actor.workspaceId, input.commandId, input.commandClaimToken,
        input.jobId, input.claimToken, JSON.stringify(input.materialization),
      ],
    ) as unknown as Array<{ candidate_id: string | null; stale: boolean }>;
    const row = rows[0];
    return { candidateId: row?.candidate_id ?? null, stale: row?.stale === true };
  } catch (error) {
    return databaseFailure(error);
  }
}

export async function blockSagaAdobeAuthoringGenerationJob(
  actor: AppActor,
  input: {
    commandId: string;
    commandClaimToken: string;
    jobId: string;
    claimToken: string;
    quality: unknown;
    message: string;
  },
  sql: NeonSql = createNeonSql(),
): Promise<boolean> {
  if (!isUuid(input.commandId) || !isUuid(input.commandClaimToken) || !isUuid(input.jobId) || !isUuid(input.claimToken)) {
    return false;
  }
  try {
    const rows = await sql.query(
      `select saga_block_adobe_authoring_generation_job(
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::jsonb, $7
       ) as blocked`,
      [
        actor.workspaceId, input.commandId, input.commandClaimToken,
        input.jobId, input.claimToken, JSON.stringify(input.quality), input.message.slice(0, 1200),
      ],
    ) as unknown as Array<{ blocked: boolean }>;
    return rows[0]?.blocked === true;
  } catch (error) {
    return databaseFailure(error);
  }
}

export async function failSagaAdobeAuthoringGenerationJob(
  actor: AppActor,
  input: {
    commandId: string;
    commandClaimToken: string;
    jobId: string;
    claimToken: string;
    errorCode: string;
    errorMessage: string;
  },
  sql: NeonSql = createNeonSql(),
): Promise<boolean> {
  if (!isUuid(input.commandId) || !isUuid(input.commandClaimToken) || !isUuid(input.jobId) || !isUuid(input.claimToken)) {
    return false;
  }
  try {
    const rows = await sql.query(
      `select saga_fail_adobe_authoring_generation_job(
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7
       ) as failed`,
      [
        actor.workspaceId, input.commandId, input.commandClaimToken,
        input.jobId, input.claimToken, input.errorCode.slice(0, 120), input.errorMessage.slice(0, 1200),
      ],
    ) as unknown as Array<{ failed: boolean }>;
    return rows[0]?.failed === true;
  } catch (error) {
    return databaseFailure(error);
  }
}

/** Releases a leased command that did not find a job. Normal job terminal writes release it atomically. */
export async function finishSagaAdobeAuthoringGenerationCommand(
  actor: AppActor,
  input: { commandId: string; commandClaimToken: string },
  sql: NeonSql = createNeonSql(),
): Promise<boolean> {
  if (!isUuid(input.commandId) || !isUuid(input.commandClaimToken)) return false;
  try {
    const rows = await sql.query(
      `select saga_finish_adobe_authoring_generation_command($1::uuid, $2::uuid, $3::uuid) as finished`,
      [actor.workspaceId, input.commandId, input.commandClaimToken],
    ) as unknown as Array<{ finished: boolean }>;
    return rows[0]?.finished === true;
  } catch (error) {
    return databaseFailure(error);
  }
}

/** Creates exactly one editable, unscheduled Studio `in_review` draft from a ready candidate. */
export async function selectSagaAdobeAuthoringCandidate(
  actor: AppActor,
  runId: string,
  candidateId: string,
  input: SagaAdobeAuthoringCandidateSelectInput,
  sql: NeonSql = createNeonSql(),
): Promise<{ run: SagaAdobeAuthoringRun; draftId: string; reused: boolean }> {
  assertCanWrite(actor);
  if (!isUuid(runId) || !isUuid(candidateId)) throw new SagaAdobeAuthoringNotFoundError();
  const payload = sagaAdobeAuthoringCandidateSelectSchema.parse(input);
  try {
    if (!await getRunRow(actor, runId, sql)) throw new SagaAdobeAuthoringNotFoundError();
    const rows = await sql.query(
      `select run_id::text, candidate_id::text, studio_draft_id::text, reused
         from saga_select_adobe_authoring_candidate($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::int, $7::int)`,
      [
        actor.workspaceId, actor.userId, runId, candidateId, payload.idempotencyKey,
        payload.expectedRunRevision, payload.expectedCandidateRevision,
      ],
    ) as unknown as Array<{ run_id: string; candidate_id: string; studio_draft_id: string; reused: boolean }>;
    const result = rows[0];
    if (!result?.run_id || !result.studio_draft_id) throw new SagaAdobeAuthoringConflictError("Det valda utkastet kunde inte läsas efter valet.");
    const run = await getSagaAdobeAuthoringRun(actor, result.run_id, sql);
    if (!run) throw new SagaAdobeAuthoringNotFoundError();
    return { run, draftId: result.studio_draft_id, reused: result.reused === true };
  } catch (error) {
    return databaseFailure(error);
  }
}
