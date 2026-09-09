import "server-only";

import { randomUUID } from "node:crypto";
import { z, ZodError } from "zod";
import {
  executionAbortSignal,
  executionTimeRemainingMs,
  withExecutionDeadline,
  withExecutionReserve,
} from "@/lib/server/execution-deadline";
import type { SagaCreativeBrief } from "@/lib/services/saga-creative-safety";
import {
  SagaMediaGenerationError,
  generateSagaPrivateMedia,
  type SagaGeneratedPrivateMedia,
  type SagaPrivateMediaGenerationInput,
} from "@/lib/services/saga-media-generation";
import { createNeonSql, type NeonSql } from "@/lib/neon/database";
import {
  getPrivateStudioBlobMetadata,
  assertTrustedStudioBlobPath,
  type UploadedStudioBlob,
} from "@/lib/vercel/blob-media";

/**
 * Media is deliberately a second, durable phase after text generation. The
 * generic Studio cron only writes this receipt; a dedicated Vercel cron does
 * one bounded image run at a time. Neither path can publish or expose a Blob
 * URL to a browser.
 */
export const SAGA_AUTOMATION_MEDIA_JOB_PAYLOAD_VERSION = "saga-automation-media/v1" as const;

const MAX_MATERIALIZATION_BATCH = 8;
const MAX_MEDIA_JOBS_PER_RUN = 1;
const DEFAULT_TIME_BUDGET_MS = 50_000;
const MIN_TIME_BUDGET_MS = 5_000;
const MAX_TIME_BUDGET_MS = 52_000;
const DEFAULT_LEASE_MS = 75_000;
const COMPLETION_RESERVE_MS = 5_000;
const RETRY_AFTER_MS = 5 * 60 * 1_000;
/** Initial attempt plus the single automatic retry declared by the media seam. */
const MAX_MEDIA_JOB_ATTEMPTS = 2;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const mediaOutputSchema = z.object({
  aspectRatio: z.enum(["square", "portrait", "landscape"]),
  altText: z.string().trim().min(2).max(500),
  label: z.string().trim().min(2).max(96),
}).strict();

const mediaJobPayloadSchema = z.object({
  version: z.literal(SAGA_AUTOMATION_MEDIA_JOB_PAYLOAD_VERSION),
  /** The frozen post revision that passed the private-draft quality gate. */
  draftRevision: z.number().int().positive(),
  creativeBrief: z.object({
    format: z.enum(["short_form_video", "paid_social", "display"]),
    hook: z.string().trim().min(2).max(1_200),
    value: z.string().trim().min(2).max(1_200),
    offer: z.object({
      copy: z.string().trim().min(2).max(900),
      terms: z.string().trim().max(2_000),
      verification: z.object({
        status: z.enum(["verified", "unverified"]),
        sourceReference: z.string().trim().max(240),
      }).strict(),
    }).strict(),
    callToAction: z.string().trim().min(2).max(1_200),
    visualMetaphor: z.enum(["calendar_turn", "day_to_evening", "tread_transition", "prepared_shelf"]),
    customVisualDirection: z.string().trim().max(1_500),
  }).strict(),
  output: mediaOutputSchema,
}).strict();

type SagaAutomationMediaJobPayload = z.infer<typeof mediaJobPayloadSchema>;

type CandidateRow = {
  draft_id: string;
  workspace_id: string;
  author_user_id: string;
  source_automation_id: string | null;
  revision: number | string;
  title: string;
  body: string;
  publication_channels: unknown;
  metadata: unknown;
};

type MediaJobRow = {
  id: string;
  workspace_id: string;
  draft_id: string;
  automation_id: string | null;
  claim_token: string | null;
  attempts: number | string;
  max_attempts: number | string;
  payload: unknown;
};

export type ClaimedSagaAutomationMediaJob = {
  id: string;
  workspaceId: string;
  draftId: string;
  automationId: string | null;
  claimToken: string;
  attempts: number;
  maxAttempts: number;
  payload: SagaAutomationMediaJobPayload;
  /** A corrupt durable receipt is failed before it can reach Gateway/Blob. */
  invalidPayload?: boolean;
};

export type SagaAutomationMediaMaterializationResult = {
  candidatesScanned: number;
  jobsCreated: number;
};

export type SagaAutomationMediaWorkerJobResult = {
  jobId: string;
  status: "media_attached" | "retry_scheduled" | "failed" | "draft_revised" | "lease_lost";
  mediaId?: string;
  code?: string;
};

export type SagaAutomationMediaWorkerResult = {
  jobsClaimed: number;
  mediaAttached: number;
  retriesScheduled: number;
  failuresRecorded: number;
  draftsRevised: number;
  leasesLost: number;
  timeBudgetReached: boolean;
  jobs: SagaAutomationMediaWorkerJobResult[];
};

/** Keeps confirmed progress when a later network operation has an unknown outcome. */
export class SagaAutomationMediaWorkerError extends Error {
  constructor(readonly progress: SagaAutomationMediaWorkerResult) {
    super("SAGA:s bildkörning kunde inte bekräfta alla beständiga kvittenser.");
    this.name = "SagaAutomationMediaWorkerError";
  }
}

export type SagaAutomationMediaWorkerDependencies = {
  claimDueJobs: (input: { now: Date; limit: number; leaseMs: number; workerId: string }) => Promise<ClaimedSagaAutomationMediaJob[]>;
  findAttachedMedia: (claim: ClaimedSagaAutomationMediaJob) => Promise<string | null>;
  resolveUploadedBlob: (input: {
    workspaceId: string;
    draftId: string;
    generated: SagaGeneratedPrivateMedia;
  }) => Promise<UploadedStudioBlob>;
  attachGeneratedMedia: (input: {
    claim: ClaimedSagaAutomationMediaJob;
    generated: SagaGeneratedPrivateMedia;
    uploaded: UploadedStudioBlob;
    now: Date;
  }) => Promise<{ status: "attached" | "already_attached" | "draft_revised" | "lease_lost"; mediaId?: string }>;
  completeJob: (input: {
    claim: ClaimedSagaAutomationMediaJob;
    mediaId: string;
    generated?: SagaGeneratedPrivateMedia;
    now: Date;
  }) => Promise<boolean>;
  failJob: (input: {
    claim: ClaimedSagaAutomationMediaJob;
    code: string;
    detail: string;
    retry: boolean;
    retryAfterMs: number;
    now: Date;
  }) => Promise<"retry_scheduled" | "failed" | "lease_lost">;
  generate: (input: SagaPrivateMediaGenerationInput) => Promise<SagaGeneratedPrivateMedia>;
};

const defaultDependencies: SagaAutomationMediaWorkerDependencies = {
  claimDueJobs: claimDueSagaAutomationMediaJobs,
  findAttachedMedia: findAttachedSagaAutomationMedia,
  resolveUploadedBlob: ({ workspaceId, draftId, generated }) => getPrivateStudioBlobMetadata({
    scope: { workspaceId, draftId },
    pathname: generated.storage.pathname,
  }),
  attachGeneratedMedia: attachGeneratedSagaAutomationMedia,
  completeJob: completeSagaAutomationMediaJob,
  failJob: failSagaAutomationMediaJob,
  generate: generateSagaPrivateMedia,
};

class SagaAutomationMediaJobInputError extends Error {
  constructor() {
    super("SAGA:s beständiga bildkvitto saknar ett giltigt privat bildunderlag.");
    this.name = "SagaAutomationMediaJobInputError";
  }
}

/**
 * Writes at most a few media receipts. It performs no image, Blob, social,
 * newsletter, or publishing call and is safe to run inside `/api/cron/tick`.
 */
export async function materializeSagaAutomationMediaGenerationJobs(
  options: { now?: Date; limit?: number } = {},
  sql: NeonSql = createNeonSql(),
): Promise<SagaAutomationMediaMaterializationResult> {
  const now = options.now ?? new Date();
  const limit = boundedInteger(options.limit, MAX_MATERIALIZATION_BATCH, 1, MAX_MATERIALIZATION_BATCH);
  const candidates = await sql.query(
    `select
       draft.id::text as draft_id,
       draft.workspace_id::text,
       draft.author_user_id::text,
       source.automation_id::text as source_automation_id,
       draft.revision,
       draft.title,
       draft.body,
       draft.publication_channels,
       draft.metadata
     from studio_drafts as draft
     inner join studio_jobs as source
       on source.workspace_id = draft.workspace_id
      and source.id = draft.automation_job_id
     where source.kind = 'draft_generation'
       and source.status = 'completed'
       and source.draft_id = draft.id
       and draft.automation_job_id is not null
       -- The current quality receipt applies exactly to its first immutable
       -- automation revision. A later editor change needs an explicit new
       -- quality/media run; it must not inherit a stale image automatically.
       and draft.revision = 1
       and draft.status in ('draft', 'in_review')
       and saga_daily_knowledge_brand_is_eligible(draft.workspace_id, draft.brand_profile_id)
       and draft.metadata -> 'sagaProductionQuality' ->> 'version' = 'saga-production-quality/v1'
       and coalesce(draft.metadata -> 'sagaProductionQuality' ->> 'canCreatePrivateDraft', 'false') = 'true'
       and char_length(trim(coalesce(draft.metadata ->> 'imagePrompt', ''))) >= 2
       and not exists (
         select 1
         from studio_jobs as media_job
         where media_job.workspace_id = draft.workspace_id
           and media_job.draft_id = draft.id
           and media_job.kind = 'media_generation'
       )
     order by draft.created_at asc
     limit $1::int`,
    [limit],
  ) as unknown as CandidateRow[];

  let jobsCreated = 0;
  for (const candidate of candidates) {
    const payload = buildSagaAutomationMediaPayload(candidate);
    const rows = await sql.query(
      `insert into studio_jobs (
         workspace_id, automation_id, draft_id, kind, status,
         idempotency_key, run_after, max_attempts, payload
       ) values (
         $1::uuid, $2::uuid, $3::uuid, 'media_generation', 'queued',
         $4, $5::timestamptz, $6::int, $7::jsonb
       )
       on conflict do nothing
       returning id::text`,
      [
        candidate.workspace_id,
        candidate.source_automation_id,
        candidate.draft_id,
        sagaAutomationMediaIdempotencyKey(candidate.draft_id),
        now.toISOString(),
        MAX_MEDIA_JOB_ATTEMPTS,
        JSON.stringify(payload),
      ],
    ) as unknown as Array<{ id: string }>;
    jobsCreated += rows.length;
  }

  return { candidatesScanned: candidates.length, jobsCreated };
}

/**
 * Claims exactly one private media job at a time. It is cross-workspace only
 * because the Vercel cron caller has already passed cron authentication.
 */
export async function claimDueSagaAutomationMediaJobs(
  options: { now?: Date; limit?: number; leaseMs?: number; workerId?: string } = {},
  sql: NeonSql = createNeonSql(),
): Promise<ClaimedSagaAutomationMediaJob[]> {
  const now = options.now ?? new Date();
  const limit = boundedInteger(options.limit, MAX_MEDIA_JOBS_PER_RUN, 1, MAX_MEDIA_JOBS_PER_RUN);
  const nowIso = now.toISOString();
  const leaseMs = boundedInteger(options.leaseMs, DEFAULT_LEASE_MS, 30_000, 90_000);
  const workerId = options.workerId?.trim().slice(0, 160) || "vercel-saga-media";
  const claims: ClaimedSagaAutomationMediaJob[] = [];

  for (let index = 0; index < limit; index += 1) {
    const claimToken = randomUUID();
    const rows = await sql.query(
      `update studio_jobs as claimed
          set status = 'running',
              claim_token = $2::uuid,
              locked_by = $3,
              lease_expires_at = clock_timestamp() + $4::int * interval '1 millisecond',
              started_at = $1::timestamptz,
              attempts = claimed.attempts + 1,
              failure_code = null,
              failure_detail = null
        where claimed.id = (
          select job.id
          from studio_jobs as job
          inner join studio_drafts as draft
            on draft.workspace_id = job.workspace_id
           and draft.id = job.draft_id
          where job.kind = 'media_generation'
            and job.run_after <= $1::timestamptz
            and job.attempts < job.max_attempts
            and draft.revision = coalesce((job.payload ->> 'draftRevision')::int, -1)
            and draft.status in ('draft', 'in_review')
            and saga_daily_knowledge_brand_is_eligible(draft.workspace_id, draft.brand_profile_id)
            and (
              job.status = 'queued'
              or (job.status = 'running' and coalesce(job.lease_expires_at, '-infinity'::timestamptz) <= clock_timestamp())
            )
          order by job.run_after asc, job.created_at asc
          for update of job skip locked
          limit 1
        )
      returning
        claimed.id::text,
        claimed.workspace_id::text,
        claimed.draft_id::text,
        claimed.automation_id::text,
        claimed.claim_token::text,
        claimed.attempts,
        claimed.max_attempts,
        claimed.payload`,
      [nowIso, claimToken, workerId, leaseMs],
    ) as unknown as MediaJobRow[];
    const row = rows[0];
    if (!row || !row.claim_token) break;

    const payload = mediaJobPayloadSchema.safeParse(jsonObject(row.payload));
    if (!payload.success) {
      // This should be unreachable because the materializer writes the
      // payload itself. Return a claim nonetheless so the worker can record a
      // terminal, auditable invalid-receipt failure with the live lease.
      claims.push({
        id: row.id,
        workspaceId: row.workspace_id,
        draftId: row.draft_id,
        automationId: nullableString(row.automation_id),
        claimToken: row.claim_token,
        attempts: numberValue(row.attempts, 1),
        maxAttempts: numberValue(row.max_attempts, MAX_MEDIA_JOB_ATTEMPTS),
        payload: invalidPayload(),
        invalidPayload: true,
      });
      continue;
    }

    claims.push({
      id: row.id,
      workspaceId: row.workspace_id,
      draftId: row.draft_id,
      automationId: nullableString(row.automation_id),
      claimToken: row.claim_token,
      attempts: numberValue(row.attempts, 1),
      maxAttempts: numberValue(row.max_attempts, MAX_MEDIA_JOB_ATTEMPTS),
      payload: payload.data,
    });
  }
  return claims;
}

/** Runs at most one external image request under a dedicated cron endpoint. */
export async function runDueSagaAutomationMediaGenerationWorker(
  options: { now?: Date; maxJobs?: number; timeBudgetMs?: number; workerId?: string } = {},
  dependencies: SagaAutomationMediaWorkerDependencies = defaultDependencies,
): Promise<SagaAutomationMediaWorkerResult> {
  const now = options.now ?? new Date();
  const maxJobs = boundedInteger(options.maxJobs, MAX_MEDIA_JOBS_PER_RUN, 1, MAX_MEDIA_JOBS_PER_RUN);
  const timeBudgetMs = boundedInteger(options.timeBudgetMs, DEFAULT_TIME_BUDGET_MS, MIN_TIME_BUDGET_MS, MAX_TIME_BUDGET_MS);
  const workerId = options.workerId?.trim().slice(0, 160) || "vercel-saga-media";
  const startedAt = Date.now();
  const result: SagaAutomationMediaWorkerResult = {
    jobsClaimed: 0,
    mediaAttached: 0,
    retriesScheduled: 0,
    failuresRecorded: 0,
    draftsRevised: 0,
    leasesLost: 0,
    timeBudgetReached: false,
    jobs: [],
  };

  try {
    await withExecutionDeadline(startedAt + timeBudgetMs, async () => {
      for (let index = 0; index < maxJobs; index += 1) {
        if (executionTimeRemainingMs() <= COMPLETION_RESERVE_MS) {
          result.timeBudgetReached = true;
          break;
        }
        const [claim] = await withExecutionDeadline(Date.now() + 5_000, () => dependencies.claimDueJobs({
          now,
          limit: 1,
          leaseMs: DEFAULT_LEASE_MS,
          workerId,
        }));
        if (!claim) break;

        result.jobsClaimed += 1;
        const outcome = await processSagaAutomationMediaClaim(claim, { now, dependencies });
        result.jobs.push(outcome);
        if (outcome.code === "execution_deadline_reached") result.timeBudgetReached = true;
        if (outcome.status === "media_attached") result.mediaAttached += 1;
        else if (outcome.status === "retry_scheduled") result.retriesScheduled += 1;
        else if (outcome.status === "failed") result.failuresRecorded += 1;
        else if (outcome.status === "draft_revised") result.draftsRevised += 1;
        else result.leasesLost += 1;
      }
    });
  } catch {
    result.timeBudgetReached ||= Date.now() - startedAt >= timeBudgetMs;
    throw new SagaAutomationMediaWorkerError(result);
  }
  return result;
}

/** Processes one leased media receipt; public routes never invoke this directly. */
export async function processSagaAutomationMediaClaim(
  claim: ClaimedSagaAutomationMediaJob,
  input: { now?: Date; dependencies?: SagaAutomationMediaWorkerDependencies } = {},
): Promise<SagaAutomationMediaWorkerJobResult> {
  const now = input.now ?? new Date();
  const dependencies = input.dependencies ?? defaultDependencies;
  try {
    if (claim.invalidPayload) throw new SagaAutomationMediaJobInputError();
    // Child cancellation leaves the parent budget available to durably record
    // failure/completion. Adapters await real cancellation; no raced writes.
    const { attachment, generated } = await withExecutionReserve(COMPLETION_RESERVE_MS, async () => {
      const existingMediaId = await dependencies.findAttachedMedia(claim);
      if (existingMediaId) return { attachment: { status: "already_attached" as const, mediaId: existingMediaId }, generated: undefined };
      executionAbortSignal();
      const generated = await dependencies.generate({
        runId: claim.id,
        scope: { workspaceId: claim.workspaceId, draftId: claim.draftId },
        creativeBrief: claim.payload.creativeBrief,
        output: claim.payload.output,
      });
      executionAbortSignal();
      const uploaded = await dependencies.resolveUploadedBlob({
        workspaceId: claim.workspaceId,
        draftId: claim.draftId,
        generated,
      });
      executionAbortSignal();
      const attachment = await dependencies.attachGeneratedMedia({ claim, generated, uploaded, now });
      return { attachment, generated };
    });
    if (attachment.status === "draft_revised") return { jobId: claim.id, status: "draft_revised", code: "draft_revised" };
    if (attachment.status === "lease_lost" || !attachment.mediaId) return { jobId: claim.id, status: "lease_lost" };

    const completed = await dependencies.completeJob({ claim, mediaId: attachment.mediaId, generated, now });
    return completed
      ? { jobId: claim.id, status: "media_attached", mediaId: attachment.mediaId }
      : { jobId: claim.id, status: "lease_lost" };
  } catch (error) {
    const failure = mediaFailure(error);
    let recorded: "retry_scheduled" | "failed" | "lease_lost";
    try {
      recorded = await dependencies.failJob({
        claim,
        code: failure.code,
        detail: failure.detail,
        retry: failure.retry,
        retryAfterMs: RETRY_AFTER_MS,
        now,
      });
    } catch {
      // A failure that cannot be durably recorded must surface to the cron
      // route, rather than being reported as a safe completed invocation.
      throw new Error("SAGA:s mediekörning kunde inte spara sitt felkvittens säkert.");
    }
    return recorded === "lease_lost"
      ? { jobId: claim.id, status: "lease_lost" }
      : { jobId: claim.id, status: recorded, code: failure.code };
  }
}

/** Finds a previous successful attachment before any retry can call a model again. */
export async function findAttachedSagaAutomationMedia(
  claim: ClaimedSagaAutomationMediaJob,
  sql: NeonSql = createNeonSql(),
): Promise<string | null> {
  const rows = await sql.query(
    `select media.id::text
     from studio_media as media
     where media.workspace_id = $1::uuid
       and media.draft_id = $2::uuid
       and media.job_id = $3::uuid
       and media.kind = 'generated'
       and media.status = 'ready'
     limit 1`,
    [claim.workspaceId, claim.draftId, claim.id],
  ) as unknown as Array<{ id: string }>;
  return rows[0]?.id ?? null;
}

/**
 * Adds exact private Blob metadata only while the same live lease still owns
 * the unchanged quality-passed draft. A changed draft is cancelled instead of
 * receiving a visually stale generated image.
 */
export async function attachGeneratedSagaAutomationMedia(
  input: { claim: ClaimedSagaAutomationMediaJob; generated: SagaGeneratedPrivateMedia; uploaded: UploadedStudioBlob; now?: Date },
  sql: NeonSql = createNeonSql(),
): Promise<{ status: "attached" | "already_attached" | "draft_revised" | "lease_lost"; mediaId?: string }> {
  const now = input.now ?? new Date();
  const { claim, generated, uploaded } = input;
  assertTrustedStudioBlobPath({ workspaceId: claim.workspaceId, draftId: claim.draftId }, uploaded.pathname);
  if (
    generated.runId !== claim.id
    || uploaded.pathname !== generated.storage.pathname
    || uploaded.contentType !== "image/png"
    || uploaded.contentType !== generated.storage.contentType
    || uploaded.size !== generated.storage.byteSize
  ) {
    throw new SagaMediaGenerationError(
      "Det privata Blob-objektet matchar inte mediekörningens verifierade resultat.",
      { status: 502, code: "blob_upload_failed", retryable: false, stage: "blob" },
    );
  }
  const metadata = JSON.stringify({
    contentKind: "image",
    source: "generated",
    filename: `saga-${claim.payload.output.label}.png`,
    caption: null,
    processingStatus: "ready",
    adaptationPrompt: null,
    variants: {},
    sortOrder: 0,
    sagaMediaGeneration: {
      version: SAGA_AUTOMATION_MEDIA_JOB_PAYLOAD_VERSION,
      runId: generated.runId,
      source: generated.source,
      privateOnly: true,
      requiresEditorialReview: true,
      generation: generated.generation,
    },
  });
  const rows = await sql.query(
    `with current_lease as materialized (
       select job.id, job.workspace_id, job.draft_id, job.lease_expires_at
       from studio_jobs as job
       where job.id = $1::uuid
         and job.workspace_id = $2::uuid
         and job.status = 'running'
         and job.claim_token = $3::uuid
         and job.kind = 'media_generation'
       for update
     ), current_draft as materialized (
       select draft.* from studio_drafts as draft
       inner join current_lease as job
         on draft.workspace_id = job.workspace_id and draft.id = job.draft_id
       for update of draft
     )
     insert into studio_media (
       workspace_id, draft_id, job_id, created_by_user_id,
       blob_url, blob_pathname, content_type, byte_size,
       kind, status, alt_text, metadata
     )
     select
       job.workspace_id,
       draft.id,
       job.id,
       draft.author_user_id,
       $4,
       $5,
       $6,
       $7::bigint,
       'generated',
       'ready',
       $8,
       $9::jsonb
     from current_lease as job
     inner join current_draft as draft
       on draft.workspace_id = job.workspace_id
      and draft.id = job.draft_id
     inner join studio_jobs as source
       on source.workspace_id = draft.workspace_id
      and source.id = draft.automation_job_id
     where job.id = $1::uuid
       and job.workspace_id = $2::uuid
       -- This check runs after both row locks, using the database clock, not
       -- the invocation's stale start time. Reclaim/editor writes cannot race.
       and job.lease_expires_at > clock_timestamp()
       and source.kind = 'draft_generation'
       and source.status = 'completed'
       and source.draft_id = draft.id
       and draft.revision = $10::int
       and draft.status in ('draft', 'in_review')
       and saga_daily_knowledge_brand_is_eligible(draft.workspace_id, draft.brand_profile_id)
       and draft.metadata -> 'sagaProductionQuality' ->> 'version' = 'saga-production-quality/v1'
       and coalesce(draft.metadata -> 'sagaProductionQuality' ->> 'canCreatePrivateDraft', 'false') = 'true'
     on conflict do nothing
     returning id::text`,
    [
      claim.id,
      claim.workspaceId,
      claim.claimToken,
      // Blob URLs never leave this server-only worker or the protected media
      // asset route. The browser sees only the metadata row's same-origin URL.
      uploaded.url,
      uploaded.pathname,
      uploaded.contentType,
      uploaded.size,
      generated.altText,
      metadata,
      claim.payload.draftRevision,
    ],
  ) as unknown as Array<{ id: string }>;
  const attached = rows[0];
  if (attached) return { status: "attached", mediaId: attached.id };

  const existingMediaId = await findAttachedSagaAutomationMedia(claim, sql);
  if (existingMediaId) return { status: "already_attached", mediaId: existingMediaId };

  const cancelled = await sql.query(
    `update studio_jobs as job
        set status = 'cancelled',
            completed_at = $4::timestamptz,
            lease_expires_at = null,
            locked_by = null,
            claim_token = null,
            failure_code = 'draft_revised',
            failure_detail = 'Utkastet ändrades eller lämnade det privata granskningsläget innan bilden kunde bifogas.'
       from studio_drafts as draft
      where job.id = $1::uuid
        and job.workspace_id = $2::uuid
        and job.status = 'running'
        and job.claim_token = $3::uuid
        and job.kind = 'media_generation'
        and job.lease_expires_at > clock_timestamp()
        and job.draft_id = draft.id
        and draft.workspace_id = job.workspace_id
        and (draft.revision <> $5::int or draft.status not in ('draft', 'in_review'))
      returning job.id::text`,
    [claim.id, claim.workspaceId, claim.claimToken, now.toISOString(), claim.payload.draftRevision],
  ) as unknown as Array<{ id: string }>;
  return cancelled[0] ? { status: "draft_revised" } : { status: "lease_lost" };
}

/** Completes a media receipt without creating a publishing receipt or URL. */
export async function completeSagaAutomationMediaJob(
  input: { claim: ClaimedSagaAutomationMediaJob; mediaId: string; generated?: SagaGeneratedPrivateMedia; now?: Date },
  sql: NeonSql = createNeonSql(),
): Promise<boolean> {
  const now = input.now ?? new Date();
  const result = {
    mediaId: input.mediaId,
    privateOnly: true,
    ...(input.generated ? {
      source: input.generated.source,
      status: input.generated.status,
      generation: input.generated.generation,
    } : {}),
  };
  const rows = await sql.query(
    `update studio_jobs as job
        set status = 'completed',
            completed_at = $4::timestamptz,
            lease_expires_at = null,
            locked_by = null,
            claim_token = null,
            failure_code = null,
            failure_detail = null,
            result = result || $5::jsonb
      where id = $1::uuid
        and workspace_id = $2::uuid
        and status = 'running'
        and claim_token = $3::uuid
        and kind = 'media_generation'
        and lease_expires_at > clock_timestamp()
        and exists (
          select 1 from studio_media as media
          where media.id = $6::uuid and media.workspace_id = job.workspace_id
            and media.draft_id = job.draft_id and media.job_id = job.id
            and media.kind = 'generated' and media.status = 'ready'
        )
      returning id::text`,
    [input.claim.id, input.claim.workspaceId, input.claim.claimToken, now.toISOString(), JSON.stringify(result), input.mediaId],
  ) as unknown as Array<{ id: string }>;
  return Boolean(rows[0]);
}

/** Records one bounded retry or terminal failure under the lease that observed it. */
export async function failSagaAutomationMediaJob(
  input: {
    claim: ClaimedSagaAutomationMediaJob;
    code: string;
    detail: string;
    retry: boolean;
    retryAfterMs?: number;
    now?: Date;
  },
  sql: NeonSql = createNeonSql(),
): Promise<"retry_scheduled" | "failed" | "lease_lost"> {
  const now = input.now ?? new Date();
  const retryAfterMs = boundedInteger(input.retryAfterMs, RETRY_AFTER_MS, 60_000, 30 * 60 * 1_000);
  const retryAt = new Date(now.getTime() + retryAfterMs).toISOString();
  const rows = await sql.query(
    `update studio_jobs
        set status = case when $4::boolean and attempts < max_attempts then 'queued' else 'failed' end,
            run_after = case when $4::boolean and attempts < max_attempts then $5::timestamptz else run_after end,
            completed_at = case when $4::boolean and attempts < max_attempts then null else $6::timestamptz end,
            lease_expires_at = null,
            locked_by = null,
            claim_token = null,
            failure_code = $7,
            failure_detail = $8
      where id = $1::uuid
        and workspace_id = $2::uuid
        and status = 'running'
        and claim_token = $3::uuid
        and kind = 'media_generation'
        and lease_expires_at > clock_timestamp()
      returning status`,
    [
      input.claim.id,
      input.claim.workspaceId,
      input.claim.claimToken,
      input.retry,
      retryAt,
      now.toISOString(),
      input.code.slice(0, 120),
      input.detail.slice(0, 4_000),
    ],
  ) as unknown as Array<{ status: string }>;
  if (!rows[0]) return "lease_lost";
  return rows[0].status === "queued" ? "retry_scheduled" : "failed";
}

function buildSagaAutomationMediaPayload(candidate: CandidateRow): SagaAutomationMediaJobPayload {
  const metadata = jsonObject(candidate.metadata);
  const channels = stringArray(candidate.publication_channels);
  const title = boundedText(candidate.title, 1_200) || "SAGA-utkast";
  const body = boundedText(candidate.body, 1_200) || "Ett privat redaktionellt underlag.";
  const callToAction = boundedText(nullableString(metadata.cta), 1_200) || "Granska underlaget innan nästa steg.";
  const imagePrompt = boundedText(nullableString(metadata.imagePrompt), 1_500);
  const draftRevision = numberValue(candidate.revision, 1);
  const metaphor = visualMetaphorFor(candidate.draft_id);
  const payload: SagaAutomationMediaJobPayload = {
    version: SAGA_AUTOMATION_MEDIA_JOB_PAYLOAD_VERSION,
    draftRevision,
    creativeBrief: {
      format: channels.includes("instagram") || channels.includes("facebook_page") ? "paid_social" : "display",
      hook: title,
      value: body,
      // A generic Studio draft has no server-verified offer record. The media
      // service therefore cannot pass commercial copy to the image model.
      offer: {
        copy: "Ingen verifierad erbjudandetext finns i den här privata bildkörningen.",
        terms: "",
        verification: { status: "unverified", sourceReference: "" },
      },
      callToAction,
      visualMetaphor: metaphor,
      customVisualDirection: imagePrompt,
    },
    output: {
      aspectRatio: aspectRatioFor(channels),
      altText: boundedAltText(title),
      label: mediaLabel(title),
    },
  };
  return mediaJobPayloadSchema.parse(payload);
}

function mediaFailure(error: unknown): { code: string; detail: string; retry: boolean } {
  if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return { code: "execution_deadline_reached", detail: "Bildkörningen nådde sin tidsgräns. Ingen publicering har gjorts; kön får återuppta det privata jobbet.", retry: true };
  }
  if (error instanceof SagaMediaGenerationError) {
    return { code: error.code, detail: error.message, retry: error.retryable };
  }
  if (error instanceof ZodError) {
    return {
      code: "media_job_invalid",
      detail: "SAGA:s beständiga bildkvitto saknar ett giltigt privat bildunderlag.",
      retry: false,
    };
  }
  if (error instanceof SagaAutomationMediaJobInputError) {
    return {
      code: "media_job_invalid",
      detail: error.message,
      retry: false,
    };
  }
  return {
    code: "media_worker_unavailable",
    detail: "SAGA kunde inte slutföra den privata bildkörningen just nu.",
    retry: true,
  };
}

function invalidPayload(): SagaAutomationMediaJobPayload {
  // The job will be failed terminally by validation below. The fallback stays
  // syntactically safe so its live lease can be reported instead of thrown.
  return {
    version: SAGA_AUTOMATION_MEDIA_JOB_PAYLOAD_VERSION,
    draftRevision: 1,
    creativeBrief: {
      format: "display",
      hook: "Ogiltigt privat bildunderlag",
      value: "Körningen stoppas innan någon bildmodell anropas.",
      offer: { copy: "Ingen verifierad erbjudandetext.", terms: "", verification: { status: "unverified", sourceReference: "" } },
      callToAction: "Kontrollera automatiseringen.",
      visualMetaphor: "day_to_evening",
      customVisualDirection: "",
    },
    output: { aspectRatio: "square", altText: "Privat bildkörning som stoppades före generering.", label: "ogiltigt-underlag" },
  };
}

function sagaAutomationMediaIdempotencyKey(draftId: string): string {
  if (!UUID_PATTERN.test(draftId)) throw new Error("Automationsutkastet saknar ett giltigt id.");
  return `saga-media-generation:v1:${draftId.toLowerCase()}`;
}

function aspectRatioFor(channels: string[]): "square" | "portrait" | "landscape" {
  if (channels.includes("instagram")) return "portrait";
  if (channels.includes("newsletter") || channels.includes("linkedin")) return "landscape";
  return "square";
}

function visualMetaphorFor(draftId: string): SagaCreativeBrief["visualMetaphor"] {
  const options: SagaCreativeBrief["visualMetaphor"][] = ["calendar_turn", "day_to_evening", "tread_transition", "prepared_shelf"];
  const sum = [...draftId].reduce((total, character) => total + character.charCodeAt(0), 0);
  return options[sum % options.length] ?? "day_to_evening";
}

function boundedAltText(title: string): string {
  const reference = boundedText(title, 220) || "det privata utkastet";
  return `Illustrativ redaktionell bild för privat granskning: ${reference}. Alternativtexten ska kontrolleras av redaktionen före publicering.`.slice(0, 500);
}

function mediaLabel(title: string): string {
  const safe = title.normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("sv-SE")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 72);
  return safe ? `saga-${safe}` : "saga-editorial";
}

function boundedText(value: unknown, max: number): string {
  return (typeof value === "string" ? value : "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, max)
    .trim();
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function numberValue(value: unknown, fallback: number): number {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : fallback;
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(Math.floor(value as number), maximum));
}
