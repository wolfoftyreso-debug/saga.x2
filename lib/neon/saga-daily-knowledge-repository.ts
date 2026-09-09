import "server-only";

import { createHash, randomUUID } from "node:crypto";
import {
  normalizedSagaDailyKnowledgeTopic,
  sagaDailyKnowledgeEntrySchema,
  sagaDailyKnowledgeEvidenceSchema,
  sagaDailyKnowledgePolicyInputSchema,
  sagaDailyKnowledgePolicySchema,
  sagaDailyKnowledgeRunSchema,
  type SagaDailyKnowledgeEntry,
  type SagaDailyKnowledgeEvidence,
  type SagaDailyKnowledgePolicy,
  type SagaDailyKnowledgePolicyInput,
  type SagaDailyKnowledgePolicySnapshot,
  type SagaDailyKnowledgeRun,
} from "@/lib/domain/saga-daily-knowledge";
import type { AppActor } from "@/lib/neon/auth-repository";
import { createNeonSql, type NeonSql } from "@/lib/neon/database";
import { SagaBrandScopeError } from "@/lib/neon/saga-brand-api-eligibility";
import {
  SagaNewsAccessError,
  SagaNewsConflictError,
  SagaNewsPolicyError,
} from "@/lib/neon/saga-news-core-repository";

const DEFAULT_LEASE_MS = 2 * 60 * 1_000;
const MAX_MATERIALIZATION_POLICIES = 12;
const MAX_EVIDENCE_SCAN = 400;

type JsonObject = Record<string, unknown>;

type PolicyRow = {
  id: string;
  workspace_id: string;
  brand_profile_id: string;
  enabled: boolean;
  timezone: string;
  daily_at: string;
  topics: unknown;
  source_ids: unknown;
  minimum_independent_publishers: number | string;
  minimum_evidence_items: number | string;
  maximum_evidence_items: number | string;
  evidence_window_hours: number | string;
  retention_days: number | string;
  last_materialized_for_date: string | Date | null;
  revision: number | string;
  created_at: string | Date;
  updated_at: string | Date;
};

type JobRow = {
  id: string;
  policy_id: string;
  policy_revision: number | string;
  knowledge_date: string | Date;
  state: string;
  evidence_entries_created: number | string;
  attempts: number | string;
  max_attempts: number | string;
  failure_code: string | null;
  failure_detail: string | null;
  created_at: string | Date;
  completed_at: string | Date | null;
  retention_expires_at: string | Date;
};

type EntryRow = {
  id: string;
  policy_id: string;
  job_id: string;
  policy_revision: number | string;
  knowledge_date: string | Date;
  topic: string;
  topic_key: string;
  headline: string;
  summary: string;
  evidence_count: number | string;
  independent_publisher_count: number | string;
  evidence: unknown;
  created_at: string | Date;
  retention_expires_at: string | Date;
};

type ClaimRow = {
  id: string;
  workspace_id: string;
  policy_id: string;
  policy_revision: number | string;
  knowledge_date: string | Date;
  policy_snapshot: unknown;
  claim_token: string;
  attempts: number | string;
  max_attempts: number | string;
  retention_expires_at: string | Date;
};

type EvidenceRow = {
  item_id: string;
  source_id: string;
  source_name: string;
  connector_key: string;
  source_trust_level: number | string;
  canonical_url: string;
  title: string;
  summary: string;
  publisher_name: string;
  publisher_domain: string;
  language: string | null;
  published_at: string | Date | null;
  observed_at: string | Date;
};

export type SagaDailyKnowledgeMaterialization = {
  policiesScanned: number;
  jobsCreated: number;
};

/** Server-only lease. It contains no source body and is never sent to the browser. */
export type ClaimedSagaDailyKnowledgeJob = {
  id: string;
  workspaceId: string;
  policyId: string;
  policyRevision: number;
  knowledgeDate: string;
  claimToken: string;
  attempts: number;
  maxAttempts: number;
  retentionExpiresAt: string;
  policy: SagaDailyKnowledgePolicySnapshot;
};

export type SagaDailyKnowledgeEvidenceCandidate = SagaDailyKnowledgeEvidence;

export type SagaDailyKnowledgeEntryWrite = Omit<SagaDailyKnowledgeEntry, "id" | "createdAt" | "retentionExpiresAt">;

/** A policy changed after a worker took its lease; writes must be cancelled, not retried. */
export class SagaDailyKnowledgePolicyGuardError extends Error {
  constructor() {
    super("Kunskapspolicyn ändrades innan dagens underlag kunde sparas.");
    this.name = "SagaDailyKnowledgePolicyGuardError";
  }
}

function assertCanWrite(actor: AppActor): void {
  if (actor.role === "viewer") throw new SagaNewsAccessError();
}

function requiredBrandProfileId(actor: AppActor): string {
  if (!actor.brandProfileId) throw new SagaBrandScopeError("brand_selection_required", "Välj vilket varumärke kunskapspolicyn tillhör.");
  return actor.brandProfileId;
}

function timestamp(value: unknown): string {
  return value instanceof Date ? value.toISOString() : typeof value === "string" ? value : "";
}

function dateValue(value: unknown): string {
  const raw = value instanceof Date ? value.toISOString().slice(0, 10) : typeof value === "string" ? value : "";
  return raw.slice(0, 10);
}

function numberValue(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function jsonObject(value: unknown): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as JsonObject;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonObject : {};
  } catch {
    return {};
  }
}

function jsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function strings(value: unknown): string[] {
  return jsonArray(value).flatMap((entry) => typeof entry === "string" ? [entry] : []);
}

function formatDailyAt(value: string): string {
  const matched = /^(\d{2}:\d{2})/.exec(value.trim());
  return matched?.[1] ?? "06:00";
}

function policySnapshot(value: unknown): SagaDailyKnowledgePolicySnapshot {
  const raw = jsonObject(value);
  const parsed = sagaDailyKnowledgePolicyInputSchema.safeParse({ ...raw, enabled: false });
  if (!parsed.success) throw new SagaDailyKnowledgePolicyGuardError();
  const {
    timezone,
    dailyAt,
    topics,
    sourceIds,
    minimumIndependentPublishers,
    minimumEvidenceItems,
    maximumEvidenceItems,
    evidenceWindowHours,
    retentionDays,
  } = parsed.data;
  return {
    timezone,
    dailyAt,
    topics,
    sourceIds,
    minimumIndependentPublishers,
    minimumEvidenceItems,
    maximumEvidenceItems,
    evidenceWindowHours,
    retentionDays,
  };
}

function mapPolicy(row: PolicyRow): SagaDailyKnowledgePolicy {
  return sagaDailyKnowledgePolicySchema.parse({
    workspaceId: row.workspace_id,
    brandProfileId: row.brand_profile_id,
    enabled: row.enabled,
    timezone: row.timezone,
    dailyAt: formatDailyAt(row.daily_at),
    topics: strings(row.topics),
    sourceIds: strings(row.source_ids),
    minimumIndependentPublishers: numberValue(row.minimum_independent_publishers),
    minimumEvidenceItems: numberValue(row.minimum_evidence_items),
    maximumEvidenceItems: numberValue(row.maximum_evidence_items),
    evidenceWindowHours: numberValue(row.evidence_window_hours),
    retentionDays: numberValue(row.retention_days),
    lastMaterializedForDate: row.last_materialized_for_date ? dateValue(row.last_materialized_for_date) : null,
    revision: numberValue(row.revision),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  });
}

function mapRun(row: JobRow): SagaDailyKnowledgeRun {
  return sagaDailyKnowledgeRunSchema.parse({
    id: row.id,
    policyId: row.policy_id,
    policyRevision: numberValue(row.policy_revision),
    knowledgeDate: dateValue(row.knowledge_date),
    state: row.state,
    evidenceEntriesCreated: numberValue(row.evidence_entries_created),
    attempts: numberValue(row.attempts),
    maxAttempts: numberValue(row.max_attempts),
    failureCode: row.failure_code,
    failureDetail: row.failure_detail,
    createdAt: timestamp(row.created_at),
    completedAt: row.completed_at ? timestamp(row.completed_at) : null,
    retentionExpiresAt: timestamp(row.retention_expires_at),
  });
}

function mapEntry(row: EntryRow): SagaDailyKnowledgeEntry {
  const evidence = zodEvidenceArray(jsonArray(row.evidence));
  return sagaDailyKnowledgeEntrySchema.parse({
    id: row.id,
    policyId: row.policy_id,
    jobId: row.job_id,
    policyRevision: numberValue(row.policy_revision),
    knowledgeDate: dateValue(row.knowledge_date),
    topic: row.topic,
    topicKey: row.topic_key,
    headline: row.headline,
    summary: row.summary,
    evidenceCount: numberValue(row.evidence_count),
    independentPublisherCount: numberValue(row.independent_publisher_count),
    evidence,
    createdAt: timestamp(row.created_at),
    retentionExpiresAt: timestamp(row.retention_expires_at),
  });
}

function zodEvidenceArray(value: unknown[]): SagaDailyKnowledgeEvidence[] {
  const parsed = sagaDailyKnowledgeEvidenceSchema.array().safeParse(value);
  return parsed.success ? parsed.data : [];
}

function hashTopic(value: string): string {
  return createHash("sha256").update(normalizedSagaDailyKnowledgeTopic(value)).digest("hex");
}

function bounded(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(Math.floor(value as number), maximum));
}

export async function getSagaDailyKnowledgePolicy(
  actor: AppActor,
  sql: NeonSql = createNeonSql(),
): Promise<SagaDailyKnowledgePolicy | null> {
  const brandProfileId = requiredBrandProfileId(actor);
  const rows = await sql.query(
    `select id::text, workspace_id::text, brand_profile_id::text, enabled, timezone, daily_at::text, topics, source_ids,
            minimum_independent_publishers, minimum_evidence_items, maximum_evidence_items,
            evidence_window_hours, retention_days, last_materialized_for_date::text,
            revision, created_at::text, updated_at::text
       from saga_daily_knowledge_policies
      where workspace_id = $1::uuid
        and brand_profile_id = $2::uuid
        and saga_daily_knowledge_brand_is_eligible(workspace_id, brand_profile_id)
      limit 1`,
    [actor.workspaceId, brandProfileId],
  ) as unknown as PolicyRow[];
  return rows[0] ? mapPolicy(rows[0]) : null;
}

/**
 * Persists a strict, opt-in workspace policy. All chosen sources must already
 * be active and allowed in that workspace; passing another tenant's UUID is
 * therefore indistinguishable from passing an unknown source.
 */
export async function saveSagaDailyKnowledgePolicy(
  actor: AppActor,
  input: SagaDailyKnowledgePolicyInput,
  sql: NeonSql = createNeonSql(),
): Promise<SagaDailyKnowledgePolicy> {
  assertCanWrite(actor);
  const brandProfileId = requiredBrandProfileId(actor);
  const parsed = sagaDailyKnowledgePolicyInputSchema.parse(input);
  const existingSources = await sql.query(
    `select id::text
       from saga_news_sources
      where workspace_id = $1::uuid
        and id = any($2::uuid[])
        and active = true
        and is_allowed = true`,
    [actor.workspaceId, parsed.sourceIds],
  ) as unknown as Array<{ id: string }>;
  if (existingSources.length !== parsed.sourceIds.length) {
    throw new SagaNewsPolicyError("Välj bara aktiva och tillåtna SAGA-källor i den här arbetsytan.");
  }

  const rows = await sql.query(
    `insert into saga_daily_knowledge_policies (
       workspace_id, created_by_user_id, updated_by_user_id, enabled, timezone, daily_at,
       topics, source_ids, minimum_independent_publishers, minimum_evidence_items,
       maximum_evidence_items, evidence_window_hours, retention_days, brand_profile_id
     ) select
       $1::uuid, $2::uuid, $2::uuid, $3, $4, $5::time,
       $6::text[], $7::uuid[], $8::smallint, $9::smallint, $10::smallint, $11::smallint, $12::smallint, $14::uuid
     where saga_daily_knowledge_brand_is_eligible($1::uuid, $14::uuid)
     on conflict (workspace_id, brand_profile_id) do update
       set updated_by_user_id = excluded.updated_by_user_id,
           enabled = excluded.enabled,
           timezone = excluded.timezone,
           daily_at = excluded.daily_at,
           topics = excluded.topics,
           source_ids = excluded.source_ids,
           minimum_independent_publishers = excluded.minimum_independent_publishers,
           minimum_evidence_items = excluded.minimum_evidence_items,
           maximum_evidence_items = excluded.maximum_evidence_items,
           evidence_window_hours = excluded.evidence_window_hours,
           retention_days = excluded.retention_days,
           revision = saga_daily_knowledge_policies.revision + 1
       where $13::integer is not null
         and saga_daily_knowledge_policies.revision = $13::integer
     returning id::text, workspace_id::text, brand_profile_id::text, enabled, timezone, daily_at::text, topics, source_ids,
               minimum_independent_publishers, minimum_evidence_items, maximum_evidence_items,
               evidence_window_hours, retention_days, last_materialized_for_date::text,
               revision, created_at::text, updated_at::text`,
    [
      actor.workspaceId,
      actor.userId,
      parsed.enabled,
      parsed.timezone,
      parsed.dailyAt,
      parsed.topics,
      parsed.sourceIds,
      parsed.minimumIndependentPublishers,
      parsed.minimumEvidenceItems,
      parsed.maximumEvidenceItems,
      parsed.evidenceWindowHours,
      parsed.retentionDays,
      parsed.expectedRevision ?? null,
      brandProfileId,
    ],
  ) as unknown as PolicyRow[];
  const row = rows[0];
  if (!row) {
    throw new SagaNewsConflictError(
      "Kunskapspolicyn har ändrats av någon annan. Läs in den senaste versionen innan du sparar igen.",
    );
  }
  // A changed revision cancels a queued or leased run immediately. A worker
  // that has already returned from Neon sees a lost lease and cannot write.
  await cancelStaleSagaDailyKnowledgeJobs(new Date(), sql);
  return mapPolicy(row);
}

/**
 * One job per workspace-policy-local-date. The local date/time is calculated
 * by Postgres from the policy's validated IANA timezone, so Vercel Cron's UTC
 * schedule does not alter the editor's intended daily window.
 */
export async function materializeSagaDailyKnowledgeJobs(
  options: { now?: Date; limit?: number } = {},
  sql: NeonSql = createNeonSql(),
): Promise<SagaDailyKnowledgeMaterialization> {
  const now = options.now ?? new Date();
  const limit = bounded(options.limit, MAX_MATERIALIZATION_POLICIES, 1, MAX_MATERIALIZATION_POLICIES);
  const rows = await sql.query(
    `with due as (
       select policy.id, policy.workspace_id, policy.revision,
              (( $1::timestamptz at time zone policy.timezone)::date) as knowledge_date,
              jsonb_build_object(
                'timezone', policy.timezone,
                'dailyAt', to_char(policy.daily_at, 'HH24:MI'),
                'topics', to_jsonb(policy.topics),
                'sourceIds', to_jsonb(policy.source_ids),
                'minimumIndependentPublishers', policy.minimum_independent_publishers,
                'minimumEvidenceItems', policy.minimum_evidence_items,
                'maximumEvidenceItems', policy.maximum_evidence_items,
                'evidenceWindowHours', policy.evidence_window_hours,
                'retentionDays', policy.retention_days
              ) as policy_snapshot,
              policy.retention_days
         from saga_daily_knowledge_policies policy
        where policy.enabled = true
          and saga_daily_knowledge_brand_is_eligible(policy.workspace_id, policy.brand_profile_id)
          and ($1::timestamptz at time zone policy.timezone)::time >= policy.daily_at
          and (policy.last_materialized_for_date is null
               or policy.last_materialized_for_date < (($1::timestamptz at time zone policy.timezone)::date))
        order by policy.updated_at asc, policy.id asc
        for update skip locked
        limit $2::int
     ), inserted as (
       insert into saga_daily_knowledge_jobs (
         workspace_id, policy_id, policy_revision, knowledge_date, idempotency_key,
         policy_snapshot, state, run_after, retention_expires_at
       ) select
         due.workspace_id,
         due.id,
         due.revision,
         due.knowledge_date,
         concat('saga-daily-knowledge:', due.id::text, ':', due.knowledge_date::text),
         due.policy_snapshot,
         'queued',
         $1::timestamptz,
         $1::timestamptz + make_interval(days => due.retention_days::integer)
       from due
       on conflict (workspace_id, policy_id, knowledge_date) do nothing
       returning policy_id::text
     ), advanced as (
       update saga_daily_knowledge_policies policy
          set last_materialized_for_date = due.knowledge_date
         from due
        where policy.id = due.id
       returning policy.id::text
     )
     select (select count(*)::int from due) as scanned,
            (select count(*)::int from inserted) as inserted`,
    [now.toISOString(), limit],
  ) as unknown as Array<{ scanned: number | string; inserted: number | string }>;
  const result = rows[0];
  return {
    policiesScanned: numberValue(result?.scanned),
    jobsCreated: numberValue(result?.inserted),
  };
}

/** Revision/pause cancellation is an expected control-plane outcome, never a retry. */
export async function cancelStaleSagaDailyKnowledgeJobs(
  now: Date,
  sql: NeonSql = createNeonSql(),
): Promise<number> {
  const rows = await sql.query(
    `update saga_daily_knowledge_jobs job
        set state = 'cancelled', completed_at = $1::timestamptz,
            claim_token = null, claimed_by = null, lease_expires_at = null,
            failure_code = 'daily_knowledge_policy_changed',
            failure_detail = 'Kunskapspolicyn ändrades eller pausades innan dagens underlag kunde sparas.'
      where job.state in ('queued', 'running')
        and not exists (
          select 1
            from saga_daily_knowledge_policies policy
           where policy.id = job.policy_id
             and policy.workspace_id = job.workspace_id
             and policy.enabled = true
             and saga_daily_knowledge_brand_is_eligible(policy.workspace_id, policy.brand_profile_id)
             and policy.revision = job.policy_revision
        )
      returning id::text`,
    [now.toISOString()],
  ) as unknown as Array<{ id: string }>;
  return rows.length;
}

/** Expired leases only become terminal after their bounded retry budget is spent. */
export async function expireExhaustedSagaDailyKnowledgeLeases(
  now: Date,
  sql: NeonSql = createNeonSql(),
): Promise<number> {
  const rows = await sql.query(
    `update saga_daily_knowledge_jobs
        set state = 'failed', completed_at = $1::timestamptz,
            claim_token = null, claimed_by = null, lease_expires_at = null,
            failure_code = 'daily_knowledge_lease_exhausted',
            failure_detail = 'En tidigare kunskapskörning avslutades inte innan lease-tiden gick ut.'
      where state = 'running'
        and coalesce(lease_expires_at, '-infinity'::timestamptz) < $1::timestamptz
        and attempts >= max_attempts
      returning id::text`,
    [now.toISOString()],
  ) as unknown as Array<{ id: string }>;
  return rows.length;
}

/** Retention deletes only terminal receipts and their cascading metadata entries. */
export async function pruneSagaDailyKnowledgeRetention(
  now: Date,
  sql: NeonSql = createNeonSql(),
): Promise<number> {
  await sql.query(
    `update saga_daily_knowledge_jobs
        set state = 'cancelled', completed_at = $1::timestamptz,
            claim_token = null, claimed_by = null, lease_expires_at = null,
            failure_code = 'daily_knowledge_retention_expired',
            failure_detail = 'Kunskapsunderlaget passerade sin sparade gallringstid.'
      where state in ('queued', 'running')
        and retention_expires_at <= $1::timestamptz`,
    [now.toISOString()],
  );
  const rows = await sql.query(
    `delete from saga_daily_knowledge_jobs
      where state in ('completed', 'failed', 'cancelled')
        and retention_expires_at <= $1::timestamptz
      returning id::text`,
    [now.toISOString()],
  ) as unknown as Array<{ id: string }>;
  return rows.length;
}

/** Atomically claims exactly one due knowledge receipt, including an expired retryable lease. */
export async function claimDueSagaDailyKnowledgeJob(
  now: Date,
  workerId: string,
  sql: NeonSql = createNeonSql(),
): Promise<ClaimedSagaDailyKnowledgeJob | null> {
  const claimToken = randomUUID();
  const leaseUntil = new Date(now.getTime() + DEFAULT_LEASE_MS).toISOString();
  const rows = await sql.query(
    `update saga_daily_knowledge_jobs claimed
        set state = 'running', claim_token = $2::uuid, claimed_by = $3,
            lease_expires_at = $4::timestamptz, attempts = claimed.attempts + 1,
            failure_code = null, failure_detail = null
      where claimed.id = (
        select job.id
          from saga_daily_knowledge_jobs job
          join saga_daily_knowledge_policies policy
            on policy.id = job.policy_id and policy.workspace_id = job.workspace_id
         where (job.state = 'queued' or (
                  job.state = 'running'
              and coalesce(job.lease_expires_at, '-infinity'::timestamptz) < $1::timestamptz
              and job.attempts < job.max_attempts
            ))
           and job.run_after <= $1::timestamptz
           and job.retention_expires_at > $1::timestamptz
           and policy.enabled = true
           and saga_daily_knowledge_brand_is_eligible(policy.workspace_id, policy.brand_profile_id)
           and policy.revision = job.policy_revision
         order by job.created_at asc, job.id asc
         for update of job skip locked
         limit 1
      )
      returning id::text, workspace_id::text, policy_id::text, policy_revision,
                knowledge_date::text, policy_snapshot, claim_token::text,
                attempts, max_attempts, retention_expires_at::text`,
    [now.toISOString(), claimToken, workerId.slice(0, 160), leaseUntil],
  ) as unknown as ClaimRow[];
  const row = rows[0];
  if (!row) return null;
  try {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      policyId: row.policy_id,
      policyRevision: numberValue(row.policy_revision),
      knowledgeDate: dateValue(row.knowledge_date),
      claimToken: row.claim_token,
      attempts: numberValue(row.attempts),
      maxAttempts: numberValue(row.max_attempts),
      retentionExpiresAt: timestamp(row.retention_expires_at),
      policy: policySnapshot(row.policy_snapshot),
    };
  } catch (error) {
    await cancelClaimedSagaDailyKnowledgeJob({
      id: row.id,
      workspaceId: row.workspace_id,
      policyId: row.policy_id,
      policyRevision: numberValue(row.policy_revision),
      knowledgeDate: dateValue(row.knowledge_date),
      claimToken: row.claim_token,
      attempts: numberValue(row.attempts),
      maxAttempts: numberValue(row.max_attempts),
      retentionExpiresAt: timestamp(row.retention_expires_at),
      policy: {
        timezone: "Europe/Stockholm",
        dailyAt: "06:00",
        topics: ["ogiltigt underlag"],
        sourceIds: ["00000000-0000-4000-8000-000000000000"],
        minimumIndependentPublishers: 2,
        minimumEvidenceItems: 2,
        maximumEvidenceItems: 2,
        evidenceWindowHours: 12,
        retentionDays: 7,
      },
    }, now, sql);
    throw error;
  }
}

/**
 * Reads only title, bounded summary and provenance-safe source metadata. The
 * query purposefully does not mention `saga_news_source_items.body_text`.
 */
export async function listSagaDailyKnowledgeEvidenceForClaim(
  claim: ClaimedSagaDailyKnowledgeJob,
  now: Date,
  sql: NeonSql = createNeonSql(),
): Promise<SagaDailyKnowledgeEvidenceCandidate[]> {
  const windowStart = new Date(now.getTime() - claim.policy.evidenceWindowHours * 60 * 60 * 1_000).toISOString();
  const rows = await sql.query(
    `select item.id::text as item_id, source.id::text as source_id, source.name as source_name,
            source.connector_key, source.trust_level as source_trust_level,
            item.canonical_url, item.title, item.summary, item.publisher_name,
            item.publisher_domain, item.language, item.published_at::text,
            coalesce(item.published_at, item.discovered_at)::text as observed_at
       from saga_news_source_items item
       join saga_news_sources source
         on source.workspace_id = item.workspace_id and source.id = item.source_id
      where item.workspace_id = $1::uuid
        and source.id = any($2::uuid[])
        -- Recheck this at evidence-read time; a source can be disabled after
        -- the policy was saved and must then contribute no new material.
        and source.active = true
        and source.is_allowed = true
        and coalesce(item.published_at, item.discovered_at) >= $3::timestamptz
      order by coalesce(item.published_at, item.discovered_at) desc, item.id asc
      limit $4::int`,
    [claim.workspaceId, claim.policy.sourceIds, windowStart, MAX_EVIDENCE_SCAN],
  ) as unknown as EvidenceRow[];
  return rows.flatMap((row) => {
    const parsed = sagaDailyKnowledgeEvidenceSchema.safeParse({
      itemId: row.item_id,
      sourceId: row.source_id,
      sourceName: row.source_name,
      connectorKey: row.connector_key,
      sourceTrustLevel: numberValue(row.source_trust_level),
      canonicalUrl: row.canonical_url,
      title: row.title,
      excerpt: row.summary.slice(0, 1_400),
      publisherName: row.publisher_name,
      publisherDomain: row.publisher_domain,
      language: row.language,
      publishedAt: row.published_at ? timestamp(row.published_at) : null,
      observedAt: timestamp(row.observed_at),
    });
    return parsed.success ? [parsed.data] : [];
  });
}

/** The worker uses this guard before and during metadata-only persistence. */
export async function isCurrentSagaDailyKnowledgeClaim(
  claim: ClaimedSagaDailyKnowledgeJob,
  sql: NeonSql = createNeonSql(),
): Promise<boolean> {
  const rows = await sql.query(
    `select 1
       from saga_daily_knowledge_jobs job
       join saga_daily_knowledge_policies policy
         on policy.id = job.policy_id and policy.workspace_id = job.workspace_id
      where job.id = $1::uuid and job.workspace_id = $2::uuid
        and job.state = 'running' and job.claim_token = $3::uuid
        and policy.enabled = true and policy.revision = job.policy_revision
        and saga_daily_knowledge_brand_is_eligible(policy.workspace_id, policy.brand_profile_id)
      limit 1`,
    [claim.id, claim.workspaceId, claim.claimToken],
  ) as unknown as Array<{ "?column?": number }>;
  return Boolean(rows[0]);
}

/**
 * Idempotently stores a small factual bundle per topic. The input is already
 * typed to metadata-only evidence, and the SQL guard prevents an old revision
 * from writing after a policy edit.
 */
export async function persistSagaDailyKnowledgeEntries(
  claim: ClaimedSagaDailyKnowledgeJob,
  entries: SagaDailyKnowledgeEntryWrite[],
  now: Date,
  sql: NeonSql = createNeonSql(),
): Promise<void> {
  if (!(await isCurrentSagaDailyKnowledgeClaim(claim, sql))) throw new SagaDailyKnowledgePolicyGuardError();
  for (const entry of entries) {
    const checkedEvidence = sagaDailyKnowledgeEvidenceSchema.array().max(30).parse(entry.evidence);
    await sql.query(
      `insert into saga_daily_knowledge_entries (
         workspace_id, policy_id, job_id, policy_revision, knowledge_date, topic, topic_key,
         headline, summary, evidence_count, independent_publisher_count, evidence, retention_expires_at
       ) select
         $1::uuid, $2::uuid, $3::uuid, $4::integer, $5::date, $6, $7,
         $8, $9, $10::integer, $11::integer, $12::jsonb, $13::timestamptz
       where exists (
         select 1
           from saga_daily_knowledge_jobs job
           join saga_daily_knowledge_policies policy
             on policy.id = job.policy_id and policy.workspace_id = job.workspace_id
          where job.id = $3::uuid and job.workspace_id = $1::uuid
            and job.state = 'running' and job.claim_token = $14::uuid
            and policy.enabled = true and policy.revision = job.policy_revision
            and saga_daily_knowledge_brand_is_eligible(policy.workspace_id, policy.brand_profile_id)
       )
       on conflict (workspace_id, policy_id, knowledge_date, topic_key) do nothing`,
      [
        claim.workspaceId,
        claim.policyId,
        claim.id,
        claim.policyRevision,
        claim.knowledgeDate,
        entry.topic,
        entry.topicKey,
        entry.headline,
        entry.summary,
        entry.evidenceCount,
        entry.independentPublisherCount,
        JSON.stringify(checkedEvidence),
        claim.retentionExpiresAt,
        claim.claimToken,
      ],
    );
  }
  if (!(await isCurrentSagaDailyKnowledgeClaim(claim, sql))) throw new SagaDailyKnowledgePolicyGuardError();
  void now;
}

export async function completeSagaDailyKnowledgeJob(
  claim: ClaimedSagaDailyKnowledgeJob,
  entryCount: number,
  now: Date,
  sql: NeonSql = createNeonSql(),
): Promise<boolean> {
  const rows = await sql.query(
    `update saga_daily_knowledge_jobs job
        set state = 'completed', evidence_entries_created = $3::integer,
            completed_at = $4::timestamptz,
            claim_token = null, claimed_by = null, lease_expires_at = null
      where job.id = $1::uuid and job.workspace_id = $5::uuid
        and job.state = 'running' and job.claim_token = $2::uuid
        and exists (
          select 1 from saga_daily_knowledge_policies policy
           where policy.id = job.policy_id and policy.workspace_id = job.workspace_id
             and policy.enabled = true and policy.revision = job.policy_revision
             and saga_daily_knowledge_brand_is_eligible(policy.workspace_id, policy.brand_profile_id)
        )
      returning id::text`,
    [claim.id, claim.claimToken, Math.max(0, Math.min(entryCount, 12)), now.toISOString(), claim.workspaceId],
  ) as unknown as Array<{ id: string }>;
  return Boolean(rows[0]);
}

export async function cancelClaimedSagaDailyKnowledgeJob(
  claim: ClaimedSagaDailyKnowledgeJob,
  now: Date,
  sql: NeonSql = createNeonSql(),
): Promise<boolean> {
  const rows = await sql.query(
    `update saga_daily_knowledge_jobs
        set state = 'cancelled', completed_at = $3::timestamptz,
            claim_token = null, claimed_by = null, lease_expires_at = null,
            failure_code = 'daily_knowledge_policy_changed',
            failure_detail = 'Kunskapspolicyn ändrades eller pausades innan dagens underlag kunde sparas.'
      where id = $1::uuid and workspace_id = $4::uuid
        and state = 'running' and claim_token = $2::uuid
      returning id::text`,
    [claim.id, claim.claimToken, now.toISOString(), claim.workspaceId],
  ) as unknown as Array<{ id: string }>;
  return Boolean(rows[0]);
}

/** Stores a bounded, generic diagnostic; raw database and source errors never reach Neon/UI. */
export async function failSagaDailyKnowledgeJob(
  claim: ClaimedSagaDailyKnowledgeJob,
  input: { code: string; detail: string; retry: boolean; retryAfterMs?: number },
  now: Date,
  sql: NeonSql = createNeonSql(),
): Promise<"retry_scheduled" | "failed" | "lease_lost"> {
  const retryAfterMs = bounded(input.retryAfterMs, 2 * 60 * 1_000, 30_000, 30 * 60 * 1_000);
  const retryAt = new Date(now.getTime() + retryAfterMs).toISOString();
  const rows = await sql.query(
    `update saga_daily_knowledge_jobs
        set state = case when $3::boolean and attempts < max_attempts then 'queued' else 'failed' end,
            claim_token = null, claimed_by = null, lease_expires_at = null,
            completed_at = case when $3::boolean and attempts < max_attempts then null else $4::timestamptz end,
            run_after = case when $3::boolean and attempts < max_attempts then $5::timestamptz else run_after end,
            failure_code = $6, failure_detail = $7
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

export async function listSagaDailyKnowledgeEntries(
  actor: AppActor,
  options: { date?: string; limit?: number } = {},
  sql: NeonSql = createNeonSql(),
): Promise<SagaDailyKnowledgeEntry[]> {
  const brandProfileId = requiredBrandProfileId(actor);
  const limit = bounded(options.limit, 20, 1, 60);
  const rows = await sql.query(
    `select id::text, policy_id::text, job_id::text, policy_revision, knowledge_date::text,
            topic, topic_key, headline, summary, evidence_count, independent_publisher_count,
            evidence, created_at::text, retention_expires_at::text
       from saga_daily_knowledge_entries entry
      where workspace_id = $1::uuid
        and exists (
          select 1 from saga_daily_knowledge_policies policy
          where policy.id = entry.policy_id and policy.workspace_id = entry.workspace_id
            and policy.brand_profile_id = $4::uuid
            and saga_daily_knowledge_brand_is_eligible(policy.workspace_id, policy.brand_profile_id)
        )
        and ($2::date is null or knowledge_date = $2::date)
      order by knowledge_date desc, created_at desc, id desc
      limit $3::int`,
    [actor.workspaceId, options.date ?? null, limit, brandProfileId],
  ) as unknown as EntryRow[];
  return rows.map(mapEntry);
}

export async function listSagaDailyKnowledgeRuns(
  actor: AppActor,
  options: { limit?: number } = {},
  sql: NeonSql = createNeonSql(),
): Promise<SagaDailyKnowledgeRun[]> {
  const brandProfileId = requiredBrandProfileId(actor);
  const limit = bounded(options.limit, 20, 1, 60);
  const rows = await sql.query(
    `select id::text, policy_id::text, policy_revision, knowledge_date::text, state,
            evidence_entries_created, attempts, max_attempts, failure_code, failure_detail,
            created_at::text, completed_at::text, retention_expires_at::text
       from saga_daily_knowledge_jobs job
      where workspace_id = $1::uuid
        and exists (
          select 1 from saga_daily_knowledge_policies policy
          where policy.id = job.policy_id and policy.workspace_id = job.workspace_id
            and policy.brand_profile_id = $3::uuid
            and saga_daily_knowledge_brand_is_eligible(policy.workspace_id, policy.brand_profile_id)
        )
      order by knowledge_date desc, created_at desc, id desc
      limit $2::int`,
    [actor.workspaceId, limit, brandProfileId],
  ) as unknown as JobRow[];
  return rows.map(mapRun);
}

export function sagaDailyKnowledgeTopicKey(topic: string): string {
  return hashTopic(topic);
}
