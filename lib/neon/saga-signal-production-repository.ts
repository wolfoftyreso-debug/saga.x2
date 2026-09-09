import "server-only";

import { randomUUID } from "node:crypto";
import {
  sagaSignalProductionPolicyInputSchema,
  sagaSignalProductionPolicySchema,
  type SagaSignalProductionJob,
  type SagaSignalProductionPolicy,
  type SagaSignalProductionPolicyInput,
} from "@/lib/domain/saga-signal-production";
import type { AppActor } from "@/lib/neon/auth-repository";
import { StudioContentAccessError } from "@/lib/neon/studio-content-repository";
import { createNeonSql, type NeonSql } from "@/lib/neon/database";
import type { SagaProductionQualityAssessment } from "@/lib/services/saga-production-quality";
import { localDateTimeInTimezone } from "@/lib/utils/date";

const MAX_MATERIALIZATION_CANDIDATES = 20;
const DEFAULT_LEASE_MS = 2 * 60 * 1_000;

type PolicyRow = {
  workspace_id: string;
  enabled: boolean;
  calendar_enabled: boolean;
  calendar_delay_minutes: number | string;
  timezone: string;
  max_drafts_per_tick: number | string;
  revision: number | string;
  created_at: string;
  updated_at: string;
};

type JobRow = {
  id: string;
  signal_candidate_id: string;
  state: string;
  policy_revision: number | string;
  calendar_scheduled_at: string | null;
  calendar_timezone: string;
  calendar_withheld: boolean;
  draft_id: string | null;
  attempts: number | string;
  max_attempts: number | string;
  failure_code: string | null;
  failure_detail: string | null;
  created_at: string;
  updated_at: string;
};

export type SagaSignalProductionMaterialization = {
  qualifiedSignalsScanned: number;
  jobsCreated: number;
};

export type ClaimedSagaSignalProductionJob = {
  id: string;
  workspaceId: string;
  authorUserId: string;
  signalCandidateId: string;
  claimToken: string;
  policyRevision: number;
  calendarEnabled: boolean;
  calendarScheduledAt: string | null;
  calendarTimezone: string;
  attempts: number;
  maxAttempts: number;
  signal: {
    signalKey: string;
    topic: string;
    headline: string;
    summary: string;
    editorialAngle: string;
    evidenceCount: number;
    independentSourceCount: number;
    distinctPublisherCount: number;
    lastSeenAt: string;
  };
};

export type SagaSignalProductionDraftInput = {
  title: string;
  headline: string;
  body: string;
  excerpt: string;
  cta: string;
  imagePrompt: string;
  quality: SagaProductionQualityAssessment;
};

export type SagaSignalProductionDraftResult = {
  id: string;
  calendarWithheld: boolean;
  scheduledAt: string | null;
};

/** The policy/signal changed after the lease was claimed and before final write. */
export class SagaSignalProductionDraftGuardError extends Error {
  constructor() {
    super("Produktionspolicyn eller signalen ändrades innan det privata granskningsutkastet kunde skapas.");
    this.name = "SagaSignalProductionDraftGuardError";
  }
}

function assertCanWrite(actor: AppActor): void {
  if (actor.role === "viewer") throw new StudioContentAccessError();
}

function mapPolicy(row: PolicyRow): SagaSignalProductionPolicy {
  return sagaSignalProductionPolicySchema.parse({
    workspaceId: row.workspace_id,
    enabled: row.enabled,
    calendarEnabled: row.calendar_enabled,
    calendarDelayMinutes: Number(row.calendar_delay_minutes),
    timezone: row.timezone,
    maxDraftsPerTick: Number(row.max_drafts_per_tick),
    revision: Number(row.revision),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function mapJob(row: JobRow): SagaSignalProductionJob {
  return {
    id: row.id,
    signalCandidateId: row.signal_candidate_id,
    state: row.state === "running" || row.state === "completed" || row.state === "blocked" || row.state === "failed" || row.state === "cancelled"
      ? row.state
      : "queued",
    policyRevision: Number(row.policy_revision),
    calendarScheduledAt: row.calendar_scheduled_at,
    calendarTimezone: row.calendar_timezone,
    calendarWithheld: row.calendar_withheld,
    draftId: row.draft_id,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    failureCode: row.failure_code,
    failureDetail: row.failure_detail,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getSagaSignalProductionPolicy(
  actor: AppActor,
  sql: NeonSql = createNeonSql(),
): Promise<SagaSignalProductionPolicy | null> {
  const rows = await sql.query(
    `select workspace_id::text, enabled, calendar_enabled, calendar_delay_minutes,
            timezone, max_drafts_per_tick, revision, created_at::text, updated_at::text
       from saga_signal_production_policies
      where workspace_id = $1::uuid
      limit 1`,
    [actor.workspaceId],
  ) as unknown as PolicyRow[];
  return rows[0] ? mapPolicy(rows[0]) : null;
}

/**
 * Saving a policy is the explicit opt-in.  It is tenant scoped through the
 * signed actor, and no caller can choose a different workspace id.
 */
export async function saveSagaSignalProductionPolicy(
  actor: AppActor,
  input: SagaSignalProductionPolicyInput,
  sql: NeonSql = createNeonSql(),
): Promise<SagaSignalProductionPolicy> {
  assertCanWrite(actor);
  const parsed = sagaSignalProductionPolicyInputSchema.parse(input);
  const rows = await sql.query(
    `insert into saga_signal_production_policies (
       workspace_id, created_by_user_id, updated_by_user_id,
       enabled, calendar_enabled, calendar_delay_minutes, timezone, max_drafts_per_tick
     ) values ($1::uuid, $2::uuid, $2::uuid, $3, $4, $5::integer, $6, $7::smallint)
     on conflict (workspace_id) do update
       set updated_by_user_id = excluded.updated_by_user_id,
           enabled = excluded.enabled,
           calendar_enabled = excluded.calendar_enabled,
           calendar_delay_minutes = excluded.calendar_delay_minutes,
           timezone = excluded.timezone,
           max_drafts_per_tick = excluded.max_drafts_per_tick,
           revision = saga_signal_production_policies.revision + 1
     returning workspace_id::text, enabled, calendar_enabled, calendar_delay_minutes,
               timezone, max_drafts_per_tick, revision, created_at::text, updated_at::text`,
    [
      actor.workspaceId,
      actor.userId,
      parsed.enabled,
      parsed.calendarEnabled,
      parsed.calendarDelayMinutes,
      parsed.timezone,
      parsed.maxDraftsPerTick,
    ],
  ) as unknown as PolicyRow[];
  const row = rows[0];
  if (!row) throw new Error("Produktionspolicyn kunde inte sparas.");
  return mapPolicy(row);
}

/**
 * Creates at most one durable receipt per qualified signal.  No policy row
 * means no work.  The policy snapshot is frozen on the receipt, and a policy
 * edit/pause will cancel it before a draft write can occur.
 */
export async function materializeSagaSignalProductionJobs(
  options: { now?: Date; limit?: number } = {},
  sql: NeonSql = createNeonSql(),
): Promise<SagaSignalProductionMaterialization> {
  const now = options.now ?? new Date();
  const limit = bounded(options.limit, MAX_MATERIALIZATION_CANDIDATES, 1, MAX_MATERIALIZATION_CANDIDATES);
  const rows = await sql.query(
    `with eligible as (
       select candidate.workspace_id,
              candidate.id as signal_candidate_id,
              candidate.updated_by_user_id as author_user_id,
              policy.revision as policy_revision,
              policy.calendar_enabled,
              policy.timezone,
              policy.calendar_delay_minutes,
              policy.max_drafts_per_tick,
              candidate.last_seen_at,
              candidate.created_at,
              row_number() over (
                partition by candidate.workspace_id
                order by candidate.last_seen_at asc, candidate.created_at asc, candidate.id asc
              ) as workspace_rank
         from saga_news_signal_candidates candidate
         join saga_signal_production_policies policy
           on policy.workspace_id = candidate.workspace_id
        where policy.enabled = true
          and candidate.active = true
          and candidate.state = 'qualified'
     ), selected as (
       select *
         from eligible
        where workspace_rank <= max_drafts_per_tick
        order by last_seen_at asc, workspace_id asc, signal_candidate_id asc
        limit $2::int
     ), inserted as (
       insert into saga_signal_production_jobs (
         workspace_id, signal_candidate_id, author_user_id, policy_revision,
         calendar_enabled, calendar_scheduled_at, calendar_timezone, state
       ) select
         workspace_id,
         signal_candidate_id,
         author_user_id,
         policy_revision,
         calendar_enabled,
         case when calendar_enabled
           then $1::timestamptz + make_interval(mins => calendar_delay_minutes)
           else null
         end,
         timezone,
         'queued'
       from selected
       on conflict (workspace_id, signal_candidate_id) do nothing
       returning id::text
     )
     select (select count(*)::int from selected) as scanned,
            (select count(*)::int from inserted) as inserted`,
    [now.toISOString(), limit],
  ) as unknown as Array<{ scanned: number | string; inserted: number | string }>;
  const result = rows[0];
  return {
    qualifiedSignalsScanned: Number(result?.scanned ?? 0),
    jobsCreated: Number(result?.inserted ?? 0),
  };
}

/** Cancels stale queued/leased work before a policy or signal state can leak into production. */
export async function cancelStaleSagaSignalProductionJobs(
  now: Date,
  sql: NeonSql = createNeonSql(),
): Promise<number> {
  const rows = await sql.query(
    `update saga_signal_production_jobs job
        set state = 'cancelled',
            completed_at = $1::timestamptz,
            claim_token = null,
            claimed_by = null,
            lease_expires_at = null,
            failure_code = 'production_policy_changed',
            failure_detail = 'Produktionspolicyn eller signalens granskningsstatus ändrades innan utkastet skapades.'
       where job.state in ('queued', 'running')
         and not exists (
           select 1
             from saga_signal_production_policies policy
             join saga_news_signal_candidates signal
               on signal.workspace_id = policy.workspace_id
              and signal.id = job.signal_candidate_id
            where policy.workspace_id = job.workspace_id
              and policy.enabled = true
              and policy.revision = job.policy_revision
              and signal.active = true
              and signal.state = 'qualified'
         )
       returning id::text`,
    [now.toISOString()],
  ) as unknown as Array<{ id: string }>;
  return rows.length;
}

/** Terminally records only leases that used their entire retry budget. */
export async function expireExhaustedSagaSignalProductionLeases(
  now: Date,
  sql: NeonSql = createNeonSql(),
): Promise<number> {
  const rows = await sql.query(
    `update saga_signal_production_jobs
        set state = 'failed',
            completed_at = $1::timestamptz,
            claim_token = null,
            claimed_by = null,
            lease_expires_at = null,
            failure_code = 'lease_exhausted',
            failure_detail = 'En tidigare produktionskörning avslutades inte innan lease-tiden gick ut.'
      where state = 'running'
        and coalesce(lease_expires_at, '-infinity'::timestamptz) < $1::timestamptz
        and attempts >= max_attempts
      returning id::text`,
    [now.toISOString()],
  ) as unknown as Array<{ id: string }>;
  return rows.length;
}

/** Atomically leases one current policy/signal receipt. */
export async function claimDueSagaSignalProductionJob(
  now: Date,
  workerId: string,
  sql: NeonSql = createNeonSql(),
): Promise<ClaimedSagaSignalProductionJob | null> {
  const claimToken = randomUUID();
  const leaseUntil = new Date(now.getTime() + DEFAULT_LEASE_MS).toISOString();
  const rows = await sql.query(
    `update saga_signal_production_jobs claimed
        set state = 'running',
            claim_token = $2::uuid,
            claimed_by = $3,
            lease_expires_at = $4::timestamptz,
            attempts = claimed.attempts + 1,
            failure_code = null,
            failure_detail = null
      where claimed.id = (
        select job.id
          from saga_signal_production_jobs job
          join saga_signal_production_policies policy
            on policy.workspace_id = job.workspace_id
          join saga_news_signal_candidates signal
            on signal.workspace_id = job.workspace_id
           and signal.id = job.signal_candidate_id
         where (job.state = 'queued' or (
                  job.state = 'running'
              and coalesce(job.lease_expires_at, '-infinity'::timestamptz) < $1::timestamptz
              and job.attempts < job.max_attempts
            ))
           and job.run_after <= $1::timestamptz
           and policy.enabled = true
           and policy.revision = job.policy_revision
           and signal.active = true
           and signal.state = 'qualified'
         order by job.created_at asc, job.id asc
         for update of job skip locked
         limit 1
      )
      returning id::text, workspace_id::text, author_user_id::text, signal_candidate_id::text,
                policy_revision, calendar_enabled, calendar_scheduled_at::text, calendar_timezone,
                attempts, max_attempts, claim_token::text`,
    [now.toISOString(), claimToken, workerId.slice(0, 160), leaseUntil],
  ) as unknown as Array<{
    id: string;
    workspace_id: string;
    author_user_id: string;
    signal_candidate_id: string;
    policy_revision: number | string;
    calendar_enabled: boolean;
    calendar_scheduled_at: string | null;
    calendar_timezone: string;
    attempts: number | string;
    max_attempts: number | string;
    claim_token: string;
  }>;
  const row = rows[0];
  if (!row) return null;
  const signalRows = await sql.query(
    `select signal_key, topic, headline, summary, editorial_angle,
            evidence_count, independent_source_count, distinct_publisher_count,
            last_seen_at::text
       from saga_news_signal_candidates
      where workspace_id = $1::uuid
        and id = $2::uuid
        and active = true
        and state = 'qualified'
      limit 1`,
    [row.workspace_id, row.signal_candidate_id],
  ) as unknown as Array<ClaimedSagaSignalProductionJob["signal"]>;
  const signal = signalRows[0];
  if (!signal) {
    await cancelStaleSagaSignalProductionJobs(now, sql);
    return null;
  }
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    authorUserId: row.author_user_id,
    signalCandidateId: row.signal_candidate_id,
    claimToken: row.claim_token,
    policyRevision: Number(row.policy_revision),
    calendarEnabled: row.calendar_enabled,
    calendarScheduledAt: row.calendar_scheduled_at,
    calendarTimezone: row.calendar_timezone,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    signal,
  };
}

/**
 * Saves an evidence-carrying review document.  This function never invokes a
 * model or a media provider.  `calendarWithheld` is true when an opt-in
 * calendar policy existed but the independent quality gate required review.
 */
export async function createPrivateSagaSignalProductionDraft(
  claim: ClaimedSagaSignalProductionJob,
  input: SagaSignalProductionDraftInput,
  now: Date,
  sql: NeonSql = createNeonSql(),
): Promise<SagaSignalProductionDraftResult> {
  const existing = await findSagaSignalProductionDraft(claim.workspaceId, claim.id, sql);
  if (existing) return existing;

  const qualityAllowsCalendar = input.quality.canEnterCalendar;
  const scheduledAt = claim.calendarEnabled && qualityAllowsCalendar
    ? claim.calendarScheduledAt
    : null;
  const calendarWithheld = claim.calendarEnabled && !qualityAllowsCalendar;
  const local = scheduledAt ? localDateTimeInTimezone(scheduledAt, claim.calendarTimezone) : null;
  if (scheduledAt && !local) throw new Error("Kunde inte beräkna kalenderns lokala tid.");

  const metadata = JSON.stringify({
    headline: input.headline,
    subject: null,
    cta: input.cta,
    hashtags: [],
    generationPrompt: "Kvalificerad SAGA News-signal. Ingen AI-text eller extern leverans har körts.",
    imagePrompt: input.imagePrompt,
    language: "sv",
    timezone: claim.calendarTimezone,
    scheduledLocalDate: local?.date ?? null,
    scheduledLocalTime: local?.time ?? null,
    approvalRequired: true,
    sagaSignalProductionJobId: claim.id,
    sagaSignalProduction: {
      origin: "qualified_news_signal",
      signalCandidateId: claim.signalCandidateId,
      signalKey: claim.signal.signalKey,
      evidenceCount: claim.signal.evidenceCount,
      independentSourceCount: claim.signal.independentSourceCount,
      distinctPublisherCount: claim.signal.distinctPublisherCount,
      policyRevision: claim.policyRevision,
      calendarOptIn: claim.calendarEnabled,
      calendarWithheld,
      delivery: "unavailable",
    },
    sagaProductionQuality: input.quality,
  });
  const sourceContext = JSON.stringify([{
    kind: "saga_news_signal",
    signalCandidateId: claim.signalCandidateId,
    signalKey: claim.signal.signalKey,
    evidenceCount: claim.signal.evidenceCount,
    independentSourceCount: claim.signal.independentSourceCount,
    distinctPublisherCount: claim.signal.distinctPublisherCount,
  }]);
  const rows = await sql.query(
    `insert into studio_drafts (
       workspace_id, author_user_id, content_type, status, title, body, excerpt,
       publication_channels, source_context, metadata, scheduled_at
     ) select
       $1::uuid, $2::uuid, 'article', 'in_review', $3, $4, $5,
       '[]'::jsonb, $6::jsonb, $7::jsonb, $8::timestamptz
     from saga_signal_production_jobs job
     join saga_signal_production_policies policy
       on policy.workspace_id = job.workspace_id
     join saga_news_signal_candidates signal
       on signal.workspace_id = job.workspace_id
      and signal.id = job.signal_candidate_id
     where job.id = $9::uuid
       and job.workspace_id = $1::uuid
       and job.state = 'running'
       and job.claim_token = $10::uuid
       and policy.enabled = true
       and policy.revision = job.policy_revision
       and signal.active = true
       and signal.state = 'qualified'
     on conflict do nothing
     returning id::text, scheduled_at::text`,
    [
      claim.workspaceId,
      claim.authorUserId,
      input.title.slice(0, 240),
      input.body.slice(0, 60_000),
      input.excerpt.slice(0, 320),
      sourceContext,
      metadata,
      scheduledAt,
      claim.id,
      claim.claimToken,
    ],
  ) as unknown as Array<{ id: string; scheduled_at: string | null }>;
  const created = rows[0];
  if (created) return { id: created.id, calendarWithheld, scheduledAt: created.scheduled_at };
  const afterConflict = await findSagaSignalProductionDraft(claim.workspaceId, claim.id, sql);
  if (afterConflict) return afterConflict;
  const current = await isCurrentSagaSignalProductionClaim(claim, sql);
  if (!current) throw new SagaSignalProductionDraftGuardError();
  throw new Error("Det privata signalutkastet kunde inte sparas.");
}

async function findSagaSignalProductionDraft(
  workspaceId: string,
  jobId: string,
  sql: NeonSql,
): Promise<SagaSignalProductionDraftResult | null> {
  const rows = await sql.query(
    `select id::text, scheduled_at::text,
            coalesce((metadata -> 'sagaSignalProduction' ->> 'calendarWithheld')::boolean, false) as calendar_withheld
       from studio_drafts
      where workspace_id = $1::uuid
        and metadata ->> 'sagaSignalProductionJobId' = $2
      limit 1`,
    [workspaceId, jobId],
  ) as unknown as Array<{ id: string; scheduled_at: string | null; calendar_withheld: boolean }>;
  const row = rows[0];
  return row ? { id: row.id, scheduledAt: row.scheduled_at, calendarWithheld: row.calendar_withheld } : null;
}

async function isCurrentSagaSignalProductionClaim(
  claim: ClaimedSagaSignalProductionJob,
  sql: NeonSql,
): Promise<boolean> {
  const rows = await sql.query(
    `select 1
       from saga_signal_production_jobs job
       join saga_signal_production_policies policy
         on policy.workspace_id = job.workspace_id
       join saga_news_signal_candidates signal
         on signal.workspace_id = job.workspace_id
        and signal.id = job.signal_candidate_id
      where job.id = $1::uuid
        and job.workspace_id = $2::uuid
        and job.state = 'running'
        and job.claim_token = $3::uuid
        and policy.enabled = true
        and policy.revision = job.policy_revision
        and signal.active = true
        and signal.state = 'qualified'
      limit 1`,
    [claim.id, claim.workspaceId, claim.claimToken],
  ) as unknown as Array<{ "?column?": number }>;
  return Boolean(rows[0]);
}

export async function completeSagaSignalProductionJob(
  claim: ClaimedSagaSignalProductionJob,
  draft: SagaSignalProductionDraftResult,
  quality: SagaProductionQualityAssessment,
  now: Date,
  sql: NeonSql = createNeonSql(),
): Promise<boolean> {
  const rows = await sql.query(
    `update saga_signal_production_jobs
        set state = 'completed',
            draft_id = $3::uuid,
            quality = $4::jsonb,
            calendar_withheld = $5::boolean,
            completed_at = $6::timestamptz,
            claim_token = null,
            claimed_by = null,
            lease_expires_at = null
      where id = $1::uuid and workspace_id = $7::uuid
        and state = 'running' and claim_token = $2::uuid
        and exists (
          select 1
            from saga_signal_production_policies policy
            join saga_news_signal_candidates signal
              on signal.workspace_id = policy.workspace_id
             and signal.id = saga_signal_production_jobs.signal_candidate_id
           where policy.workspace_id = saga_signal_production_jobs.workspace_id
             and policy.enabled = true
             and policy.revision = saga_signal_production_jobs.policy_revision
             and signal.active = true
             and signal.state = 'qualified'
        )
      returning signal_candidate_id::text`,
    [claim.id, claim.claimToken, draft.id, JSON.stringify(quality), draft.calendarWithheld, now.toISOString(), claim.workspaceId],
  ) as unknown as Array<{ signal_candidate_id: string }>;
  const row = rows[0];
  if (!row) return false;
  await sql.query(
    `update saga_news_signal_candidates
        set state = 'in_review'
      where workspace_id = $1::uuid
        and id = $2::uuid
        and state = 'qualified'`,
    [claim.workspaceId, row.signal_candidate_id],
  );
  return true;
}

/** A quality rejection is terminal and deliberately creates no draft. */
export async function blockSagaSignalProductionJob(
  claim: ClaimedSagaSignalProductionJob,
  quality: SagaProductionQualityAssessment,
  now: Date,
  sql: NeonSql = createNeonSql(),
): Promise<boolean> {
  const message = quality.findings.find((finding) => finding.severity === "blocker")?.message
    ?? "Signalunderlaget klarade inte SAGA:s produktionskvalitet.";
  const rows = await sql.query(
    `update saga_signal_production_jobs
        set state = 'blocked', quality = $3::jsonb, completed_at = $4::timestamptz,
            claim_token = null, claimed_by = null, lease_expires_at = null,
            failure_code = 'production_quality_rejected', failure_detail = $5
      where id = $1::uuid and workspace_id = $6::uuid
        and state = 'running' and claim_token = $2::uuid
      returning id::text`,
    [claim.id, claim.claimToken, JSON.stringify(quality), now.toISOString(), message.slice(0, 1_000), claim.workspaceId],
  ) as unknown as Array<{ id: string }>;
  return Boolean(rows[0]);
}

/** A policy pause/revision must cancel the live lease, not reclassify it as a worker outage. */
export async function cancelClaimedSagaSignalProductionJob(
  claim: ClaimedSagaSignalProductionJob,
  now: Date,
  sql: NeonSql = createNeonSql(),
): Promise<boolean> {
  const rows = await sql.query(
    `update saga_signal_production_jobs
        set state = 'cancelled', completed_at = $3::timestamptz,
            claim_token = null, claimed_by = null, lease_expires_at = null,
            failure_code = 'production_policy_changed',
            failure_detail = 'Produktionspolicyn eller signalens granskningsstatus ändrades innan utkastet skapades.'
      where id = $1::uuid and workspace_id = $4::uuid
        and state = 'running' and claim_token = $2::uuid
      returning id::text`,
    [claim.id, claim.claimToken, now.toISOString(), claim.workspaceId],
  ) as unknown as Array<{ id: string }>;
  return Boolean(rows[0]);
}

/** Records a bounded retry without leaking raw database/provider diagnostics. */
export async function failSagaSignalProductionJob(
  claim: ClaimedSagaSignalProductionJob,
  input: { code: string; detail: string; retry: boolean; retryAfterMs?: number },
  now: Date,
  sql: NeonSql = createNeonSql(),
): Promise<"retry_scheduled" | "failed" | "lease_lost"> {
  const retryAfterMs = bounded(input.retryAfterMs, 2 * 60 * 1_000, 30_000, 30 * 60 * 1_000);
  const retryAt = new Date(now.getTime() + retryAfterMs).toISOString();
  const rows = await sql.query(
    `update saga_signal_production_jobs
        set state = case when $3::boolean and attempts < max_attempts then 'queued' else 'failed' end,
            claim_token = null,
            claimed_by = null,
            lease_expires_at = null,
            completed_at = case when $3::boolean and attempts < max_attempts then null else $4::timestamptz end,
            run_after = case when $3::boolean and attempts < max_attempts then $5::timestamptz else run_after end,
            failure_code = $6,
            failure_detail = $7
      where id = $1::uuid and workspace_id = $8::uuid
        and state = 'running' and claim_token = $2::uuid
      returning state`,
    [
      claim.id,
      claim.claimToken,
      input.retry,
      now.toISOString(),
      retryAt,
      input.code.slice(0, 120),
      input.detail.slice(0, 1_000),
      claim.workspaceId,
    ],
  ) as unknown as Array<{ state: string }>;
  if (!rows[0]) return "lease_lost";
  return rows[0].state === "queued" ? "retry_scheduled" : "failed";
}

export async function getSagaSignalProductionJob(
  actor: AppActor,
  jobId: string,
  sql: NeonSql = createNeonSql(),
): Promise<SagaSignalProductionJob | null> {
  const rows = await sql.query(
    `select id::text, signal_candidate_id::text, state, policy_revision,
            calendar_scheduled_at::text, calendar_timezone, calendar_withheld,
            draft_id::text, attempts, max_attempts, failure_code, failure_detail,
            created_at::text, updated_at::text
       from saga_signal_production_jobs
      where workspace_id = $1::uuid and id = $2::uuid
      limit 1`,
    [actor.workspaceId, jobId],
  ) as unknown as JobRow[];
  return rows[0] ? mapJob(rows[0]) : null;
}

function bounded(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(Math.floor(value as number), maximum));
}
