import "server-only";

import { createHash } from "node:crypto";
import {
  canonicalizeSagaNewsUrl,
  normalizedSagaNewsText,
  sagaNewsIngestionBatchInputSchema,
  sagaNewsIngestionFailureInputSchema,
  sagaNewsIngestionRunSchema,
  sagaNewsIngestionStartInputSchema,
  sagaNewsSignalCandidateInputSchema,
  sagaNewsSignalCandidateSchema,
  sagaNewsSourceInputSchema,
  sagaNewsSourceItemInputSchema,
  sagaNewsSourceSchema,
  type SagaNewsIngestionBatchInput,
  type SagaNewsIngestionBatchResult,
  type SagaNewsIngestionReceipt,
  type SagaNewsIngestionRun,
  type SagaNewsIngestionStartInput,
  type SagaNewsIngestionFailureInput,
  type SagaNewsRunReference,
  type SagaNewsSignalCandidate,
  type SagaNewsSignalCandidateInput,
  type SagaNewsSource,
  type SagaNewsSourceClaim,
  type SagaNewsSourceInput,
  type SagaNewsSourceItem,
  type SagaNewsSourceItemInput,
} from "@/lib/domain/saga-news-core";
import type { SagaNewsIngestionBatch, SagaNewsPersistenceInput } from "@/lib/news-core/types";
import type { AppActor } from "@/lib/neon/auth-repository";
import { createNeonSql, type NeonSql } from "@/lib/neon/database";

type JsonObject = Record<string, unknown>;

type SourceRow = {
  id: string;
  created_by_user_id: string;
  updated_by_user_id: string;
  slug: string;
  name: string;
  source_kind: string;
  connector_key: string;
  endpoint_url: string;
  publisher_allowlist: unknown;
  publisher_blocklist: unknown;
  allowlist_mode: string;
  topics: unknown;
  languages: unknown;
  countries: unknown;
  trust_level: number | string;
  source_weight: number | string;
  minimum_interval_minutes: number | string;
  max_items_per_run: number | string;
  max_item_text_chars: number | string;
  source_policy: unknown;
  is_allowed: boolean;
  active: boolean;
  last_ingestion_at: string | Date | null;
  last_successful_ingestion_at: string | Date | null;
  last_failure_at: string | Date | null;
  last_failure_code: string | null;
  next_ingestion_at: string | Date;
  lease_token: string | null;
  lease_expires_at: string | Date | null;
  leased_by: string | null;
  created_at: string | Date;
  updated_at: string | Date;
};

type IngestionRunRow = {
  id: string;
  source_id: string;
  requested_by_user_id: string;
  connector_key: string;
  idempotency_key: string;
  request_fingerprint: string;
  worker_id: string;
  status: string;
  items_received: number | string;
  items_inserted: number | string;
  items_duplicate: number | string;
  items_rejected: number | string;
  failure_code: string | null;
  failure_summary: string | null;
  started_at: string | Date;
  completed_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
};

type SignalCandidateRow = {
  id: string;
  created_by_user_id: string;
  updated_by_user_id: string;
  signal_key: string;
  topic: string;
  headline: string;
  summary: string;
  editorial_angle: string;
  content_fingerprint: string;
  source_credibility_score: number | string;
  topical_relevance_score: number | string;
  mission_alignment_score: number | string;
  trend_momentum_score: number | string;
  channel_suitability_score: number | string;
  evidence_item_ids: unknown;
  evidence_count: number | string;
  independent_source_count: number | string;
  distinct_publisher_count: number | string;
  policy_snapshot: unknown;
  state: string;
  requires_human_review: boolean;
  active: boolean;
  first_seen_at: string | Date;
  last_seen_at: string | Date;
  created_at: string | Date;
  updated_at: string | Date;
};

type IngestionBatchRow = {
  received_count: number | string;
  inserted_count: number | string;
  duplicate_count: number | string;
};

type SourceItemRow = {
  id: string;
  source_id: string;
  first_ingestion_run_id: string;
  last_ingestion_run_id: string;
  canonical_url: string;
  title: string;
  summary: string;
  publisher_name: string;
  publisher_domain: string;
  authors: unknown;
  language: string | null;
  published_at: string | Date | null;
  discovered_at: string | Date;
  first_seen_at: string | Date;
  last_seen_at: string | Date;
  provenance: unknown;
  content_fingerprint: string;
  story_fingerprint: string;
  created_at: string | Date;
  updated_at: string | Date;
};

type ClaimedSourceRow = SourceRow & { workspace_id: string };

export class SagaNewsAccessError extends Error {
  constructor() {
    super("Du har bara läsrättighet i den här arbetsytan.");
    this.name = "SagaNewsAccessError";
  }
}

export class SagaNewsNotFoundError extends Error {
  constructor(message = "Nyhetsresursen hittades inte i den här arbetsytan.") {
    super(message);
    this.name = "SagaNewsNotFoundError";
  }
}

export class SagaNewsPolicyError extends Error {
  constructor(message = "Källans policy tillåter inte denna hämtning eller dessa underlag.") {
    super(message);
    this.name = "SagaNewsPolicyError";
  }
}

export class SagaNewsConflictError extends Error {
  constructor(message = "SAGA News Core kunde inte spara ändringen eftersom ett beroende ändrades samtidigt.") {
    super(message);
    this.name = "SagaNewsConflictError";
  }
}

function assertCanWrite(actor: AppActor): void {
  if (actor.role === "viewer") throw new SagaNewsAccessError();
}

function assertUuid(value: string, message = "Nyhetsresursen hittades inte i den här arbetsytan."): string {
  const normalized = value.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) {
    throw new SagaNewsNotFoundError(message);
  }
  return normalized;
}

function numberValue(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function timestamp(value: unknown): string {
  return value instanceof Date ? value.toISOString() : typeof value === "string" ? value : "";
}

function timestampOrNull(value: unknown): string | null {
  const parsed = timestamp(value);
  return parsed || null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
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

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : value.slice(0, maximum);
}

function publisherDomainFromUrl(value: string): string {
  return new URL(value).hostname.toLowerCase();
}

function domainMatches(domain: string, rule: string): boolean {
  return domain === rule || domain.endsWith(`.${rule}`);
}

function isPublisherAllowed(source: SagaNewsSource, domain: string): boolean {
  if (source.publisherBlocklist.some((blocked) => domainMatches(domain, blocked))) return false;
  if (source.allowlistMode !== "strict") return true;
  return source.publisherAllowlist.some((allowed) => domainMatches(domain, allowed));
}

function mapSource(row: SourceRow): SagaNewsSource {
  return sagaNewsSourceSchema.parse({
    id: row.id,
    createdByUserId: row.created_by_user_id,
    updatedByUserId: row.updated_by_user_id,
    slug: row.slug,
    name: row.name,
    sourceKind: row.source_kind,
    connectorKey: row.connector_key,
    endpointUrl: row.endpoint_url,
    publisherAllowlist: strings(row.publisher_allowlist),
    publisherBlocklist: strings(row.publisher_blocklist),
    allowlistMode: row.allowlist_mode,
    topics: strings(row.topics),
    languages: strings(row.languages),
    countries: strings(row.countries),
    trustLevel: numberValue(row.trust_level, 3),
    sourceWeight: numberValue(row.source_weight, 50),
    minimumIntervalMinutes: numberValue(row.minimum_interval_minutes, 60),
    maxItemsPerRun: numberValue(row.max_items_per_run, 100),
    maxItemTextChars: numberValue(row.max_item_text_chars, 30_000),
    sourcePolicy: jsonObject(row.source_policy),
    isAllowed: row.is_allowed !== false,
    active: row.active !== false,
    lastIngestionAt: timestampOrNull(row.last_ingestion_at),
    lastSuccessfulIngestionAt: timestampOrNull(row.last_successful_ingestion_at),
    lastFailureAt: timestampOrNull(row.last_failure_at),
    lastFailureCode: stringOrNull(row.last_failure_code),
    nextIngestionAt: timestamp(row.next_ingestion_at),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  });
}

function mapIngestionRun(row: IngestionRunRow): SagaNewsIngestionRun {
  return sagaNewsIngestionRunSchema.parse({
    id: row.id,
    sourceId: row.source_id,
    requestedByUserId: row.requested_by_user_id,
    connectorKey: row.connector_key,
    idempotencyKey: row.idempotency_key,
    requestFingerprint: row.request_fingerprint,
    workerId: row.worker_id,
    status: row.status,
    itemsReceived: numberValue(row.items_received),
    itemsInserted: numberValue(row.items_inserted),
    itemsDuplicate: numberValue(row.items_duplicate),
    itemsRejected: numberValue(row.items_rejected),
    failureCode: stringOrNull(row.failure_code),
    failureSummary: stringOrNull(row.failure_summary),
    startedAt: timestamp(row.started_at),
    completedAt: timestampOrNull(row.completed_at),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  });
}

function mapSignalCandidate(row: SignalCandidateRow): SagaNewsSignalCandidate {
  return sagaNewsSignalCandidateSchema.parse({
    id: row.id,
    createdByUserId: row.created_by_user_id,
    updatedByUserId: row.updated_by_user_id,
    signalKey: row.signal_key,
    topic: row.topic,
    headline: row.headline,
    summary: row.summary,
    editorialAngle: row.editorial_angle,
    evidenceItemIds: strings(row.evidence_item_ids),
    scores: {
      sourceCredibility: numberValue(row.source_credibility_score),
      topicalRelevance: numberValue(row.topical_relevance_score),
      missionAlignment: numberValue(row.mission_alignment_score),
      trendMomentum: numberValue(row.trend_momentum_score),
      channelSuitability: numberValue(row.channel_suitability_score),
    },
    contentFingerprint: row.content_fingerprint,
    evidenceCount: numberValue(row.evidence_count),
    independentSourceCount: numberValue(row.independent_source_count),
    distinctPublisherCount: numberValue(row.distinct_publisher_count),
    policySnapshot: jsonObject(row.policy_snapshot),
    state: row.state,
    requiresHumanReview: row.requires_human_review !== false,
    active: row.active !== false,
    firstSeenAt: timestamp(row.first_seen_at),
    lastSeenAt: timestamp(row.last_seen_at),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  });
}

function mapSourceItem(row: SourceItemRow): SagaNewsSourceItem {
  return {
    id: row.id,
    sourceId: row.source_id,
    firstIngestionRunId: row.first_ingestion_run_id,
    lastIngestionRunId: row.last_ingestion_run_id,
    canonicalUrl: row.canonical_url,
    title: row.title,
    summary: row.summary,
    publisherName: row.publisher_name,
    publisherDomain: row.publisher_domain,
    authors: strings(row.authors),
    language: stringOrNull(row.language),
    publishedAt: timestampOrNull(row.published_at),
    discoveredAt: timestamp(row.discovered_at),
    firstSeenAt: timestamp(row.first_seen_at),
    lastSeenAt: timestamp(row.last_seen_at),
    provenance: jsonObject(row.provenance),
    contentFingerprint: row.content_fingerprint,
    storyFingerprint: row.story_fingerprint,
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  };
}

const sourceFields = `id::text, created_by_user_id::text, updated_by_user_id::text,
  slug, name, source_kind, connector_key, endpoint_url, publisher_allowlist,
  publisher_blocklist, allowlist_mode, topics, languages, countries, trust_level,
  source_weight, minimum_interval_minutes, max_items_per_run, max_item_text_chars,
  source_policy, is_allowed, active, last_ingestion_at::text,
  last_successful_ingestion_at::text, last_failure_at::text, last_failure_code,
  next_ingestion_at::text, lease_token::text, lease_expires_at::text, leased_by,
  created_at::text, updated_at::text`;

const ingestionRunFields = `id::text, source_id::text, requested_by_user_id::text,
  connector_key, idempotency_key::text, request_fingerprint, worker_id, status,
  items_received, items_inserted, items_duplicate, items_rejected, failure_code,
  failure_summary, started_at::text, completed_at::text, created_at::text, updated_at::text`;

const sourceItemFields = `id::text, source_id::text, first_ingestion_run_id::text,
  last_ingestion_run_id::text, canonical_url, title, summary, publisher_name,
  publisher_domain, authors, language, published_at::text, discovered_at::text,
  first_seen_at::text, last_seen_at::text, provenance, content_fingerprint,
  story_fingerprint, created_at::text, updated_at::text`;

const signalCandidateSelect = `select
  candidate.id::text,
  candidate.created_by_user_id::text,
  candidate.updated_by_user_id::text,
  candidate.signal_key,
  candidate.topic,
  candidate.headline,
  candidate.summary,
  candidate.editorial_angle,
  candidate.content_fingerprint,
  candidate.source_credibility_score,
  candidate.topical_relevance_score,
  candidate.mission_alignment_score,
  candidate.trend_momentum_score,
  candidate.channel_suitability_score,
  coalesce(
    jsonb_agg(evidence.source_item_id::text order by evidence.added_at)
      filter (where evidence.source_item_id is not null),
    '[]'::jsonb
  ) as evidence_item_ids,
  candidate.evidence_count,
  candidate.independent_source_count,
  candidate.distinct_publisher_count,
  candidate.policy_snapshot,
  candidate.state,
  candidate.requires_human_review,
  candidate.active,
  candidate.first_seen_at::text,
  candidate.last_seen_at::text,
  candidate.created_at::text,
  candidate.updated_at::text
from saga_news_signal_candidates candidate
left join saga_news_signal_evidence evidence
  on evidence.workspace_id = candidate.workspace_id and evidence.candidate_id = candidate.id`;

function signalCandidateGroupBy(alias = "candidate"): string {
  return `group by ${alias}.id, ${alias}.created_by_user_id, ${alias}.updated_by_user_id,
    ${alias}.signal_key, ${alias}.topic, ${alias}.headline, ${alias}.summary,
    ${alias}.editorial_angle, ${alias}.content_fingerprint,
    ${alias}.source_credibility_score, ${alias}.topical_relevance_score,
    ${alias}.mission_alignment_score, ${alias}.trend_momentum_score,
    ${alias}.channel_suitability_score, ${alias}.evidence_count,
    ${alias}.independent_source_count, ${alias}.distinct_publisher_count,
    ${alias}.policy_snapshot, ${alias}.state, ${alias}.requires_human_review,
    ${alias}.active, ${alias}.first_seen_at, ${alias}.last_seen_at,
    ${alias}.created_at, ${alias}.updated_at`;
}

/** Viewer-safe source listing. The workspace comes only from the signed actor. */
export async function listSagaNewsSources(
  actor: AppActor,
  sql: NeonSql = createNeonSql(),
): Promise<SagaNewsSource[]> {
  const rows = await sql.query(
    `select ${sourceFields}
       from saga_news_sources
      where workspace_id = $1::uuid
      order by active desc, is_allowed desc, name asc`,
    [actor.workspaceId],
  ) as unknown as SourceRow[];
  return rows.map(mapSource);
}

/** Reads one source inside the actor workspace; callers can never choose a tenant. */
export async function getSagaNewsSource(
  actor: AppActor,
  sourceId: string,
  sql: NeonSql = createNeonSql(),
): Promise<SagaNewsSource | null> {
  const id = assertUuid(sourceId);
  const rows = await sql.query(
    `select ${sourceFields}
       from saga_news_sources
      where workspace_id = $1::uuid and id = $2::uuid
      limit 1`,
    [actor.workspaceId, id],
  ) as unknown as SourceRow[];
  return rows[0] ? mapSource(rows[0]) : null;
}

/**
 * Claims only due, public sources for a trusted Vercel Cron worker. This is a
 * server-only cross-workspace operation: it accepts no workspace id and must
 * be called only after the route has authenticated CRON_SECRET.
 */
export async function claimDueSagaNewsSources(
  options: { now?: Date; limit?: number; workerId: string; leaseSeconds?: number },
  sql: NeonSql = createNeonSql(),
): Promise<SagaNewsSourceClaim[]> {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const limit = Math.min(20, Math.max(1, Math.trunc(options.limit ?? 2)));
  const leaseSeconds = Math.min(900, Math.max(30, Math.trunc(options.leaseSeconds ?? 120)));
  const workerId = options.workerId.trim();
  if (workerId.length < 2 || workerId.length > 120) throw new SagaNewsPolicyError("Cron-arbetaren saknar ett giltigt worker-id.");
  const rows = await sql.query(
    `with due as (
      select source.id
        from saga_news_sources source
       where source.active = true
         and source.is_allowed = true
         and source.next_ingestion_at <= $1::timestamptz
         and (source.lease_expires_at is null or source.lease_expires_at <= $1::timestamptz)
       order by source.next_ingestion_at asc, source.id
       limit $2
       for update skip locked
    ), claimed as (
      update saga_news_sources source
         set lease_token = gen_random_uuid(),
             lease_expires_at = $1::timestamptz + ($4::integer * interval '1 second'),
             leased_by = $3
        from due
       where source.id = due.id
       returning source.*
    )
    select claimed.workspace_id::text as workspace_id, ${sourceFields}
      from claimed`,
    [nowIso, limit, workerId, leaseSeconds],
  ) as unknown as ClaimedSourceRow[];
  return rows.map((row) => {
    const source = mapSource(row);
    const leaseToken = stringOrNull(row.lease_token);
    const leaseExpiresAt = timestampOrNull(row.lease_expires_at);
    if (!leaseToken || !leaseExpiresAt) throw new SagaNewsConflictError("Cron-källan saknar ett giltigt lease-kvitto.");
    return {
      workspaceId: row.workspace_id,
      source,
      claimToken: leaseToken,
      leaseExpiresAt,
    };
  });
}

async function getActiveSourceClaim(
  claim: Pick<SagaNewsSourceClaim, "workspaceId" | "source" | "claimToken">,
  sql: NeonSql,
): Promise<SagaNewsSource> {
  const rows = await sql.query(
    `select ${sourceFields}
       from saga_news_sources
      where workspace_id = $1::uuid
        and id = $2::uuid
        and lease_token = $3::uuid
        and lease_expires_at > now()
        and active = true
        and is_allowed = true
      limit 1`,
    [claim.workspaceId, claim.source.id, claim.claimToken],
  ) as unknown as SourceRow[];
  if (!rows[0]) throw new SagaNewsPolicyError("Cron-källans lease har löpt ut eller överlåtits.");
  return mapSource(rows[0]);
}

/** Editors can configure public source policies, never credential fields. */
export async function saveSagaNewsSource(
  actor: AppActor,
  input: SagaNewsSourceInput,
  sql: NeonSql = createNeonSql(),
): Promise<SagaNewsSource> {
  assertCanWrite(actor);
  const value = sagaNewsSourceInputSchema.parse(input);
  try {
    const rows = await sql.query(
      `insert into saga_news_sources (
        workspace_id, created_by_user_id, updated_by_user_id, slug, name,
        source_kind, connector_key, endpoint_url, publisher_allowlist,
        publisher_blocklist, allowlist_mode, topics, languages, countries,
        trust_level, source_weight, minimum_interval_minutes, max_items_per_run,
        max_item_text_chars, source_policy, is_allowed, active
      ) values (
        $1::uuid, $2::uuid, $2::uuid, $3, $4,
        $5, $6, $7, $8::text[],
        $9::text[], $10, $11::text[], $12::text[], $13::text[],
        $14, $15, $16, $17,
        $18, $19::jsonb, $20, $21
      )
      on conflict (workspace_id, slug) do update set
        updated_by_user_id = excluded.updated_by_user_id,
        name = excluded.name,
        source_kind = excluded.source_kind,
        connector_key = excluded.connector_key,
        endpoint_url = excluded.endpoint_url,
        publisher_allowlist = excluded.publisher_allowlist,
        publisher_blocklist = excluded.publisher_blocklist,
        allowlist_mode = excluded.allowlist_mode,
        topics = excluded.topics,
        languages = excluded.languages,
        countries = excluded.countries,
        trust_level = excluded.trust_level,
        source_weight = excluded.source_weight,
        minimum_interval_minutes = excluded.minimum_interval_minutes,
        max_items_per_run = excluded.max_items_per_run,
        max_item_text_chars = excluded.max_item_text_chars,
        source_policy = excluded.source_policy,
        is_allowed = excluded.is_allowed,
        active = excluded.active
      returning ${sourceFields}`,
      [
        actor.workspaceId,
        actor.userId,
        value.slug,
        value.name,
        value.sourceKind,
        value.connectorKey,
        value.endpointUrl,
        value.publisherAllowlist,
        value.publisherBlocklist,
        value.allowlistMode,
        value.topics,
        value.languages,
        value.countries,
        value.trustLevel,
        value.sourceWeight,
        value.minimumIntervalMinutes,
        value.maxItemsPerRun,
        value.maxItemTextChars,
        JSON.stringify(value.sourcePolicy),
        value.isAllowed,
        value.active,
      ],
    ) as unknown as SourceRow[];
    if (!rows[0]) throw new SagaNewsConflictError();
    return mapSource(rows[0]);
  } catch (error) {
    normalizeDatabaseError(error);
  }
}

/**
 * Explicit pause/resume control for a real source. Pausing clears an active
 * Cron lease so an editor never sees a source as "busy" after it is disabled.
 */
export async function setSagaNewsSourceActive(
  actor: AppActor,
  sourceId: string,
  active: boolean,
  sql: NeonSql = createNeonSql(),
): Promise<SagaNewsSource> {
  assertCanWrite(actor);
  const id = assertUuid(sourceId, "Nyhetskällan hittades inte i den här arbetsytan.");
  const rows = await sql.query(
    `update saga_news_sources
        set active = $3,
            lease_token = case when $3 then lease_token else null end,
            lease_expires_at = case when $3 then lease_expires_at else null end,
            leased_by = case when $3 then leased_by else null end,
            next_ingestion_at = case when $3 then least(next_ingestion_at, now()) else next_ingestion_at end,
            updated_by_user_id = $2::uuid
      where workspace_id = $1::uuid and id = $4::uuid
      returning ${sourceFields}`,
    [actor.workspaceId, actor.userId, active, id],
  ) as unknown as SourceRow[];
  if (!rows[0]) throw new SagaNewsNotFoundError("Nyhetskällan hittades inte i den här arbetsytan.");
  return mapSource(rows[0]);
}

/**
 * A source with collected evidence cannot be silently deleted. Editors must
 * pause it instead, preserving editorial provenance and run audit history.
 */
export async function deleteSagaNewsSource(
  actor: AppActor,
  sourceId: string,
  sql: NeonSql = createNeonSql(),
): Promise<boolean> {
  assertCanWrite(actor);
  const id = assertUuid(sourceId, "Nyhetskällan hittades inte i den här arbetsytan.");
  const references = await sql.query(
    `select
      exists(select 1 from saga_news_ingestion_runs where workspace_id = $1::uuid and source_id = $2::uuid) as has_runs,
      exists(select 1 from saga_news_source_items where workspace_id = $1::uuid and source_id = $2::uuid) as has_items`,
    [actor.workspaceId, id],
  ) as unknown as Array<{ has_runs: boolean; has_items: boolean }>;
  if (references[0]?.has_runs || references[0]?.has_items) {
    throw new SagaNewsPolicyError("Källan har hämtnings- eller evidenshistorik och kan inte raderas. Pausa den i stället.");
  }
  try {
    const rows = await sql.query(
      `delete from saga_news_sources
        where workspace_id = $1::uuid and id = $2::uuid
        returning id::text`,
      [actor.workspaceId, id],
    ) as unknown as Array<{ id: string }>;
    return Boolean(rows[0]);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "23503") {
      throw new SagaNewsPolicyError("Källan fick historik medan den raderades. Pausa den i stället.");
    }
    throw error;
  }
}

function requestFingerprint(source: SagaNewsSource): string {
  // This is an audit hash of public connector configuration, not a request URL
  // or environment secret. It makes changed source policy visible across runs.
  return hash(JSON.stringify({
    connectorKey: source.connectorKey,
    endpointUrl: canonicalizeSagaNewsUrl(source.endpointUrl),
    publisherAllowlist: source.publisherAllowlist,
    publisherBlocklist: source.publisherBlocklist,
    allowlistMode: source.allowlistMode,
    topics: source.topics,
    languages: source.languages,
    countries: source.countries,
    sourcePolicy: source.sourcePolicy,
  }));
}

/**
 * Creates one actor-scoped run receipt. Retrying the same UUID returns the
 * original receipt rather than starting a second connector call.
 */
export async function beginSagaNewsIngestionRun(
  actor: AppActor,
  input: SagaNewsIngestionStartInput,
  sql: NeonSql = createNeonSql(),
): Promise<SagaNewsIngestionReceipt> {
  assertCanWrite(actor);
  const value = sagaNewsIngestionStartInputSchema.parse(input);
  const source = await getSagaNewsSource(actor, value.sourceId, sql);
  if (!source) throw new SagaNewsNotFoundError("Nyhetskällan hittades inte i den här arbetsytan.");
  if (!source.active || !source.isAllowed) throw new SagaNewsPolicyError("Nyhetskällan är pausad eller inte tillåten.");

  const fingerprint = requestFingerprint(source);
  try {
    const created = await sql.query(
      `insert into saga_news_ingestion_runs (
        workspace_id, source_id, requested_by_user_id, connector_key,
        idempotency_key, request_fingerprint, worker_id
      )
      select $1::uuid, source.id, $2::uuid, source.connector_key,
        $3::uuid, $4, $5
      from saga_news_sources source
      where source.workspace_id = $1::uuid
        and source.id = $6::uuid
        and source.active = true
        and source.is_allowed = true
      on conflict (workspace_id, source_id, idempotency_key) do nothing
      returning ${ingestionRunFields}`,
      [actor.workspaceId, actor.userId, value.idempotencyKey, fingerprint, value.workerId, source.id],
    ) as unknown as IngestionRunRow[];
    if (created[0]) return { run: mapIngestionRun(created[0]), reused: false };

    const existing = await sql.query(
      `select ${ingestionRunFields}
         from saga_news_ingestion_runs
        where workspace_id = $1::uuid and source_id = $2::uuid and idempotency_key = $3::uuid
        limit 1`,
      [actor.workspaceId, source.id, value.idempotencyKey],
    ) as unknown as IngestionRunRow[];
    if (existing[0]) return { run: mapIngestionRun(existing[0]), reused: true };
    throw new SagaNewsPolicyError("Nyhetskällan ändrades eller pausades innan hämtningen kunde starta.");
  } catch (error) {
    normalizeDatabaseError(error);
  }
}

/**
 * Starts a receipt for a source that this Vercel Cron invocation already
 * claimed. It intentionally has no `AppActor` argument: the database derives
 * the audit user from the persisted source and validates the live lease.
 */
export async function beginClaimedSagaNewsIngestionRun(
  claim: SagaNewsSourceClaim,
  options: { idempotencyKey: string; workerId: string },
  sql: NeonSql = createNeonSql(),
): Promise<SagaNewsIngestionReceipt> {
  const source = await getActiveSourceClaim(claim, sql);
  const idempotencyKey = assertUuid(options.idempotencyKey, "Cron-kvittot har ett ogiltigt idempotency-id.");
  const workerId = options.workerId.trim();
  if (workerId.length < 2 || workerId.length > 120) throw new SagaNewsPolicyError("Cron-arbetaren saknar ett giltigt worker-id.");
  const fingerprint = requestFingerprint(source);
  try {
    const created = await sql.query(
      `insert into saga_news_ingestion_runs (
        workspace_id, source_id, requested_by_user_id, connector_key,
        idempotency_key, request_fingerprint, worker_id
      )
      select source.workspace_id, source.id, source.updated_by_user_id, source.connector_key,
        $1::uuid, $2, $3
      from saga_news_sources source
      where source.workspace_id = $4::uuid
        and source.id = $5::uuid
        and source.lease_token = $6::uuid
        and source.lease_expires_at > now()
        and source.active = true
        and source.is_allowed = true
      on conflict (workspace_id, source_id, idempotency_key) do nothing
      returning ${ingestionRunFields}`,
      [idempotencyKey, fingerprint, workerId, claim.workspaceId, source.id, claim.claimToken],
    ) as unknown as IngestionRunRow[];
    if (created[0]) return { run: mapIngestionRun(created[0]), reused: false };

    const existing = await sql.query(
      `select ${ingestionRunFields}
         from saga_news_ingestion_runs
        where workspace_id = $1::uuid and source_id = $2::uuid and idempotency_key = $3::uuid
        limit 1`,
      [claim.workspaceId, source.id, idempotencyKey],
    ) as unknown as IngestionRunRow[];
    if (existing[0]) return { run: mapIngestionRun(existing[0]), reused: true };
    throw new SagaNewsPolicyError("Cron-källans lease ändrades innan hämtningskvittot kunde skapas.");
  } catch (error) {
    normalizeDatabaseError(error);
  }
}

type NormalizedIncomingItem = {
  identity_fingerprint: string;
  content_fingerprint: string;
  story_fingerprint: string;
  external_id: string | null;
  canonical_url: string;
  title: string;
  summary: string;
  body_text: string;
  publisher_name: string;
  publisher_domain: string;
  authors: string[];
  language: string | null;
  published_at: string | null;
  discovered_at: string;
  provenance: JsonObject;
};

/**
 * The connector layer emits a deliberately small, provider-neutral candidate.
 * This adapter keeps it equally small in Neon: no article body, no provider
 * request URL, and no secret-bearing connector configuration.
 */
export function sagaNewsPersistenceInputToSourceItemInput(candidate: SagaNewsPersistenceInput): SagaNewsSourceItemInput {
  return {
    externalId: null,
    canonicalUrl: candidate.canonicalUrl,
    title: candidate.title,
    summary: candidate.summary ?? "",
    bodyText: "",
    publisherName: candidate.sourceDomain,
    publisherDomain: candidate.sourceDomain,
    authors: [],
    language: candidate.language?.trim().toLowerCase() || null,
    publishedAt: candidate.publishedAt,
    provenance: {
      provider: candidate.provider,
      contentHash: candidate.contentHash,
      raw: candidate.raw,
      fetchedAt: candidate.fetchedAt,
    },
  };
}

function normalizeIncomingItem(source: SagaNewsSource, input: SagaNewsSourceItemInput, discoveredAt: string): NormalizedIncomingItem {
  const value = sagaNewsSourceItemInputSchema.parse(input);
  if (source.sourcePolicy.requirePublishedAt && !value.publishedAt) {
    throw new SagaNewsPolicyError("Källans policy kräver publiceringstid för varje item.");
  }
  const canonicalUrl = canonicalizeSagaNewsUrl(value.canonicalUrl);
  const publisherDomain = (value.publisherDomain ?? publisherDomainFromUrl(canonicalUrl)).toLowerCase();
  if (!isPublisherAllowed(source, publisherDomain)) {
    throw new SagaNewsPolicyError(`Publicisten ${publisherDomain} tillåts inte av den här källpolicyn.`);
  }

  const summaryBudget = Math.min(12_000, Math.max(0, Math.floor(source.maxItemTextChars / 3)));
  const summary = truncate(value.summary, summaryBudget);
  const remainingBodyBudget = Math.max(0, source.maxItemTextChars - summary.length);
  const bodyText = source.sourcePolicy.retainFullText ? truncate(value.bodyText, remainingBodyBudget) : "";
  // Provider item IDs can change between a feed refresh. The source-scoped
  // canonical URL remains the durable identity; the external ID is retained
  // only as provenance and never controls duplicate insertion.
  const identityMaterial = `source:${source.id}\nurl:${canonicalUrl}`;
  const contentMaterial = [canonicalUrl, value.title, summary, value.publishedAt ?? ""].map(normalizedSagaNewsText).join("\n");
  // Story fingerprints intentionally omit source/publisher identity. They are
  // a clustering aid only; evidence always retains each original source row.
  const storyMaterial = [value.title, summary.slice(0, 2_000), value.publishedAt?.slice(0, 10) ?? ""]
    .map(normalizedSagaNewsText)
    .join("\n");

  return {
    identity_fingerprint: hash(identityMaterial),
    content_fingerprint: hash(contentMaterial),
    story_fingerprint: hash(storyMaterial),
    external_id: value.externalId,
    canonical_url: canonicalUrl,
    title: value.title,
    summary,
    body_text: bodyText,
    publisher_name: value.publisherName,
    publisher_domain: publisherDomain,
    authors: value.authors,
    language: value.language,
    published_at: value.publishedAt,
    discovered_at: discoveredAt,
    provenance: {
      ...value.provenance,
      connector: source.connectorKey,
      sourceEndpointHost: new URL(source.endpointUrl).hostname.toLowerCase(),
    },
  };
}

/**
 * Stores at most 100 normalized public items per batch. The database locks the
 * receipt and enforces its per-source total cap, deduplication, provenance,
 * and publisher policy again so retries cannot widen scope.
 */
export async function ingestSagaNewsSourceItems(
  actor: AppActor,
  input: SagaNewsIngestionBatchInput,
  sql: NeonSql = createNeonSql(),
): Promise<SagaNewsIngestionBatchResult> {
  assertCanWrite(actor);
  const value = sagaNewsIngestionBatchInputSchema.parse(input);
  const source = await getSagaNewsSource(actor, value.sourceId, sql);
  if (!source) throw new SagaNewsNotFoundError("Nyhetskällan hittades inte i den här arbetsytan.");
  if (!source.active || !source.isAllowed) throw new SagaNewsPolicyError("Nyhetskällan är pausad eller inte tillåten.");
  const discoveredAt = new Date().toISOString();
  const items = value.items.map((item) => normalizeIncomingItem(source, item, discoveredAt));

  try {
    const rows = await sql.query(
      `select * from saga_news_ingest_source_items($1::uuid, $2::uuid, $3::uuid, $4::jsonb)`,
      [actor.workspaceId, source.id, value.runId, JSON.stringify(items)],
    ) as unknown as IngestionBatchRow[];
    const row = rows[0];
    if (!row) throw new SagaNewsConflictError("Hämtningskvittot kunde inte uppdateras.");
    return {
      receivedCount: numberValue(row.received_count),
      insertedCount: numberValue(row.inserted_count),
      duplicateCount: numberValue(row.duplicate_count),
    };
  } catch (error) {
    normalizeDatabaseError(error);
  }
}

/**
 * Direct connector hand-off. Every candidate must name the same server-owned
 * source as the active receipt; source ownership is then verified again in
 * `ingestSagaNewsSourceItems` and the database function.
 */
export async function persistSagaNewsCandidates(
  actor: AppActor,
  options: { sourceId: string; runId: string; candidates: readonly SagaNewsPersistenceInput[] },
  sql: NeonSql = createNeonSql(),
): Promise<SagaNewsIngestionBatchResult> {
  const sourceId = assertUuid(options.sourceId);
  const runId = assertUuid(options.runId);
  if (options.candidates.length < 1 || options.candidates.length > 100) {
    throw new SagaNewsPolicyError("En connectorbatch måste innehålla mellan 1 och 100 kandidater.");
  }
  if (options.candidates.some((candidate) => candidate.sourceId !== sourceId)) {
    throw new SagaNewsPolicyError("Connectorns kandidater hör inte alla till samma nyhetskälla.");
  }
  return ingestSagaNewsSourceItems(actor, {
    sourceId,
    runId,
    items: options.candidates.map(sagaNewsPersistenceInputToSourceItemInput),
  }, sql);
}

/** Convenience boundary for `toSagaNewsIngestionBatch(runSagaNewsConnector(...))`. */
export async function persistSagaNewsConnectorBatch(
  actor: AppActor,
  options: { runId: string; batch: SagaNewsIngestionBatch },
  sql: NeonSql = createNeonSql(),
): Promise<SagaNewsIngestionBatchResult> {
  const sourceId = assertUuid(options.batch.sourceId);
  const source = await getSagaNewsSource(actor, sourceId, sql);
  if (!source) throw new SagaNewsNotFoundError("Nyhetskällan hittades inte i den här arbetsytan.");
  if (source.connectorKey !== options.batch.connectorKey) {
    throw new SagaNewsPolicyError("Connectorbatchen matchar inte den sparade källans serverägda connector.");
  }
  return persistSagaNewsCandidates(actor, {
    sourceId,
    runId: options.runId,
    candidates: options.batch.candidates,
  }, sql);
}

/** Server-only connector persistence for an active Cron lease. */
export async function persistClaimedSagaNewsCandidates(
  claim: SagaNewsSourceClaim,
  options: { runId: string; candidates: readonly SagaNewsPersistenceInput[] },
  sql: NeonSql = createNeonSql(),
): Promise<SagaNewsIngestionBatchResult> {
  const source = await getActiveSourceClaim(claim, sql);
  const runId = assertUuid(options.runId, "Cron-hämtningskvittot har ett ogiltigt id.");
  if (options.candidates.length < 1 || options.candidates.length > 100) {
    throw new SagaNewsPolicyError("En connectorbatch måste innehålla mellan 1 och 100 kandidater.");
  }
  if (options.candidates.some((candidate) => candidate.sourceId !== source.id)) {
    throw new SagaNewsPolicyError("Connectorns kandidater hör inte alla till den claimade nyhetskällan.");
  }
  const discoveredAt = new Date().toISOString();
  const items = options.candidates.map((candidate) => normalizeIncomingItem(
    source,
    sagaNewsPersistenceInputToSourceItemInput(candidate),
    discoveredAt,
  ));
  try {
    const rows = await sql.query(
      `select * from saga_news_ingest_source_items($1::uuid, $2::uuid, $3::uuid, $4::jsonb, $5::uuid)`,
      [claim.workspaceId, source.id, runId, JSON.stringify(items), claim.claimToken],
    ) as unknown as IngestionBatchRow[];
    const row = rows[0];
    if (!row) throw new SagaNewsConflictError("Cron-hämtningskvittot kunde inte uppdateras.");
    return {
      receivedCount: numberValue(row.received_count),
      insertedCount: numberValue(row.inserted_count),
      duplicateCount: numberValue(row.duplicate_count),
    };
  } catch (error) {
    normalizeDatabaseError(error);
  }
}

/** Server-only batch convenience for a claim returned by `claimDueSagaNewsSources`. */
export async function persistClaimedSagaNewsConnectorBatch(
  claim: SagaNewsSourceClaim,
  options: { runId: string; batch: SagaNewsIngestionBatch },
  sql: NeonSql = createNeonSql(),
): Promise<SagaNewsIngestionBatchResult> {
  if (options.batch.sourceId !== claim.source.id || options.batch.connectorKey !== claim.source.connectorKey) {
    throw new SagaNewsPolicyError("Connectorbatchen matchar inte den claimade källan.");
  }
  return persistClaimedSagaNewsCandidates(claim, {
    runId: options.runId,
    candidates: options.batch.candidates,
  }, sql);
}

/** Finishes a live receipt. Completion never publishes or generates content. */
export async function completeSagaNewsIngestionRun(
  actor: AppActor,
  options: { sourceId: string; runId: string },
  sql: NeonSql = createNeonSql(),
): Promise<SagaNewsIngestionRun | null> {
  assertCanWrite(actor);
  const sourceId = assertUuid(options.sourceId);
  const runId = assertUuid(options.runId);
  const rows = await sql.query(
    `with completed as (
      update saga_news_ingestion_runs run
         set status = 'completed', completed_at = now(), failure_code = null, failure_summary = null
       where run.workspace_id = $1::uuid
         and run.source_id = $2::uuid
         and run.id = $3::uuid
         and run.status = 'running'
       returning run.*
    ), touched_source as (
      update saga_news_sources source
         set last_successful_ingestion_at = now(), last_failure_code = null
        from completed
       where source.workspace_id = completed.workspace_id and source.id = completed.source_id
       returning source.id
    )
    select ${ingestionRunFields} from completed`,
    [actor.workspaceId, sourceId, runId],
  ) as unknown as IngestionRunRow[];
  return rows[0] ? mapIngestionRun(rows[0]) : null;
}

/** Completes a receipt and advances only the matching live Cron lease. */
export async function completeClaimedSagaNewsIngestionRun(
  claim: SagaNewsSourceClaim,
  options: Pick<SagaNewsRunReference, "runId">,
  sql: NeonSql = createNeonSql(),
): Promise<SagaNewsIngestionRun | null> {
  const runId = assertUuid(options.runId, "Cron-hämtningskvittot har ett ogiltigt id.");
  const rows = await sql.query(
    `with completed as (
      update saga_news_ingestion_runs run
         set status = 'completed', completed_at = now(), failure_code = null, failure_summary = null
        from saga_news_sources source
       where run.workspace_id = $1::uuid
         and run.source_id = $2::uuid
         and run.id = $3::uuid
         and run.status = 'running'
         and source.workspace_id = run.workspace_id
         and source.id = run.source_id
         and source.lease_token = $4::uuid
         and source.lease_expires_at > now()
       returning run.*
    ), touched_source as (
      update saga_news_sources source
         set last_successful_ingestion_at = now(),
             last_failure_code = null,
             next_ingestion_at = now() + (source.minimum_interval_minutes * interval '1 minute'),
             lease_token = null,
             lease_expires_at = null,
             leased_by = null
        from completed
       where source.workspace_id = completed.workspace_id
         and source.id = completed.source_id
         and source.lease_token = $4::uuid
       returning source.id
    )
    select ${ingestionRunFields} from completed`,
    [claim.workspaceId, claim.source.id, runId, claim.claimToken],
  ) as unknown as IngestionRunRow[];
  return rows[0] ? mapIngestionRun(rows[0]) : null;
}

/** Stores an intentionally short, non-secret failure reason on the receipt. */
export async function failSagaNewsIngestionRun(
  actor: AppActor,
  options: { sourceId: string; runId: string; failureCode: string; failureSummary: string },
  sql: NeonSql = createNeonSql(),
): Promise<SagaNewsIngestionRun | null> {
  assertCanWrite(actor);
  const value = sagaNewsIngestionFailureInputSchema.parse(options);
  const sourceId = value.sourceId;
  const runId = value.runId;
  const failureCode = value.failureCode;
  const failureSummary = value.failureSummary;
  const rows = await sql.query(
    `with failed as (
      update saga_news_ingestion_runs run
         set status = 'failed', completed_at = now(), failure_code = $4, failure_summary = $5
       where run.workspace_id = $1::uuid
         and run.source_id = $2::uuid
         and run.id = $3::uuid
         and run.status = 'running'
       returning run.*
    ), touched_source as (
      update saga_news_sources source
         set last_failure_at = now(), last_failure_code = $4
        from failed
       where source.workspace_id = failed.workspace_id and source.id = failed.source_id
       returning source.id
    )
    select ${ingestionRunFields} from failed`,
    [actor.workspaceId, sourceId, runId, failureCode, failureSummary],
  ) as unknown as IngestionRunRow[];
  return rows[0] ? mapIngestionRun(rows[0]) : null;
}

/** Fails a receipt and safely releases only the matching current Cron lease. */
export async function failClaimedSagaNewsIngestionRun(
  claim: SagaNewsSourceClaim,
  options: Pick<SagaNewsIngestionFailureInput, "runId" | "failureCode" | "failureSummary">,
  sql: NeonSql = createNeonSql(),
): Promise<SagaNewsIngestionRun | null> {
  const value = sagaNewsIngestionFailureInputSchema.parse({
    sourceId: claim.source.id,
    runId: options.runId,
    failureCode: options.failureCode,
    failureSummary: options.failureSummary,
  });
  const runId = value.runId;
  const failureCode = value.failureCode;
  const failureSummary = value.failureSummary;
  const rows = await sql.query(
    `with failed as (
      update saga_news_ingestion_runs run
         set status = 'failed', completed_at = now(), failure_code = $5, failure_summary = $6
        from saga_news_sources source
       where run.workspace_id = $1::uuid
         and run.source_id = $2::uuid
         and run.id = $3::uuid
         and run.status = 'running'
         and source.workspace_id = run.workspace_id
         and source.id = run.source_id
         and source.lease_token = $4::uuid
         and source.lease_expires_at > now()
       returning run.*
    ), touched_source as (
      update saga_news_sources source
         set last_failure_at = now(),
             last_failure_code = $5,
             next_ingestion_at = now() + (source.minimum_interval_minutes * interval '1 minute'),
             lease_token = null,
             lease_expires_at = null,
             leased_by = null
        from failed
       where source.workspace_id = failed.workspace_id
         and source.id = failed.source_id
         and source.lease_token = $4::uuid
       returning source.id
    )
    select ${ingestionRunFields} from failed`,
    [claim.workspaceId, claim.source.id, runId, claim.claimToken, failureCode, failureSummary],
  ) as unknown as IngestionRunRow[];
  return rows[0] ? mapIngestionRun(rows[0]) : null;
}

/**
 * Releases a claim that failed before a run receipt existed. A stale token is
 * harmless and cannot release a newer worker's lease.
 */
export async function releaseSagaNewsSourceClaim(
  claim: SagaNewsSourceClaim,
  options: { nextIngestionAt?: string | Date } = {},
  sql: NeonSql = createNeonSql(),
): Promise<boolean> {
  let nextAt: string | null = null;
  if (options.nextIngestionAt) {
    const parsed = options.nextIngestionAt instanceof Date ? options.nextIngestionAt : new Date(options.nextIngestionAt);
    if (Number.isNaN(parsed.getTime())) throw new SagaNewsPolicyError("Nästa hämtningspunkt är ogiltig.");
    nextAt = parsed.toISOString();
  }
  const rows = await sql.query(
    `update saga_news_sources source
        set lease_token = null,
            lease_expires_at = null,
            leased_by = null,
            next_ingestion_at = coalesce(
              $4::timestamptz,
              now() + (source.minimum_interval_minutes * interval '1 minute')
            )
      where source.workspace_id = $1::uuid
        and source.id = $2::uuid
        and source.lease_token = $3::uuid
      returning source.id::text`,
    [claim.workspaceId, claim.source.id, claim.claimToken, nextAt],
  ) as unknown as Array<{ id: string }>;
  return Boolean(rows[0]);
}

/** Read-only run history for audit UI or a future Cron monitor. */
export async function listSagaNewsIngestionRuns(
  actor: AppActor,
  options: { sourceId?: string; limit?: number } = {},
  sql: NeonSql = createNeonSql(),
): Promise<SagaNewsIngestionRun[]> {
  const sourceId = options.sourceId ? assertUuid(options.sourceId) : null;
  const limit = Math.min(100, Math.max(1, Math.trunc(options.limit ?? 30)));
  const rows = await sql.query(
    `select ${ingestionRunFields}
       from saga_news_ingestion_runs
      where workspace_id = $1::uuid
        and ($2::uuid is null or source_id = $2::uuid)
      order by started_at desc
      limit $3`,
    [actor.workspaceId, sourceId, limit],
  ) as unknown as IngestionRunRow[];
  return rows.map(mapIngestionRun);
}

/**
 * Safe material for an evidence/review UI. It deliberately does not select
 * `body_text`; connector feeds and models never need a stored article body to
 * explain why a signal qualified.
 */
export async function listSagaNewsSourceItems(
  actor: AppActor,
  options: { sourceId?: string; runId?: string; limit?: number; since?: string | Date } = {},
  sql: NeonSql = createNeonSql(),
): Promise<SagaNewsSourceItem[]> {
  const sourceId = options.sourceId ? assertUuid(options.sourceId) : null;
  const runId = options.runId ? assertUuid(options.runId) : null;
  const limit = Math.min(200, Math.max(1, Math.trunc(options.limit ?? 50)));
  let since: string | null = null;
  if (options.since) {
    const parsed = options.since instanceof Date ? options.since : new Date(options.since);
    if (Number.isNaN(parsed.getTime())) throw new SagaNewsPolicyError("Tidpunkten för item-läsning är ogiltig.");
    since = parsed.toISOString();
  }
  const rows = await sql.query(
    `select ${sourceItemFields}
       from saga_news_source_items item
      where item.workspace_id = $1::uuid
        and ($2::uuid is null or item.source_id = $2::uuid)
        and ($3::uuid is null or item.last_ingestion_run_id = $3::uuid)
        and ($4::timestamptz is null or item.last_seen_at >= $4::timestamptz)
      order by item.last_seen_at desc, item.id
      limit $5`,
    [actor.workspaceId, sourceId, runId, since, limit],
  ) as unknown as SourceItemRow[];
  return rows.map(mapSourceItem);
}

/**
 * Creates or updates a candidate from actor-scoped evidence. The database
 * validates each item/source and snapshots source credibility atomically.
 * A candidate is editorial material only: it has no publishing side effect.
 */
export async function upsertSagaNewsSignalCandidate(
  actor: AppActor,
  input: SagaNewsSignalCandidateInput,
  sql: NeonSql = createNeonSql(),
): Promise<SagaNewsSignalCandidate> {
  assertCanWrite(actor);
  const value = sagaNewsSignalCandidateInputSchema.parse(input);
  const contentFingerprint = hash([
    value.signalKey,
    value.topic,
    value.headline,
    value.summary,
    value.editorialAngle,
  ].map(normalizedSagaNewsText).join("\n"));
  try {
    const rows = await sql.query(
      `with persisted as (
        insert into saga_news_signal_candidates (
          workspace_id, created_by_user_id, updated_by_user_id, signal_key,
          topic, headline, summary, editorial_angle, content_fingerprint,
          source_credibility_score, topical_relevance_score,
          mission_alignment_score, trend_momentum_score, channel_suitability_score,
          policy_snapshot, state, requires_human_review, active
        ) values (
          $1::uuid, $2::uuid, $2::uuid, $3,
          $4, $5, $6, $7, $8,
          $9, $10, $11, $12, $13,
          $14::jsonb, $15, $16, $17
        )
        on conflict (workspace_id, signal_key) do update set
          updated_by_user_id = excluded.updated_by_user_id,
          topic = excluded.topic,
          headline = excluded.headline,
          summary = excluded.summary,
          editorial_angle = excluded.editorial_angle,
          content_fingerprint = excluded.content_fingerprint,
          source_credibility_score = excluded.source_credibility_score,
          topical_relevance_score = excluded.topical_relevance_score,
          mission_alignment_score = excluded.mission_alignment_score,
          trend_momentum_score = excluded.trend_momentum_score,
          channel_suitability_score = excluded.channel_suitability_score,
          policy_snapshot = excluded.policy_snapshot,
          state = excluded.state,
          requires_human_review = excluded.requires_human_review,
          active = excluded.active,
          last_seen_at = now()
        returning id, workspace_id
      ), evidence_replaced as (
        select saga_news_replace_signal_evidence(persisted.workspace_id, persisted.id, $18::jsonb)
        from persisted
      )
      ${signalCandidateSelect}
      join persisted on persisted.workspace_id = candidate.workspace_id and persisted.id = candidate.id
      cross join evidence_replaced
      ${signalCandidateGroupBy()}`,
      [
        actor.workspaceId,
        actor.userId,
        value.signalKey,
        value.topic,
        value.headline,
        value.summary,
        value.editorialAngle,
        contentFingerprint,
        value.scores.sourceCredibility,
        value.scores.topicalRelevance,
        value.scores.missionAlignment,
        value.scores.trendMomentum,
        value.scores.channelSuitability,
        JSON.stringify(value.policySnapshot),
        value.state,
        value.requiresHumanReview,
        value.active,
        JSON.stringify(value.evidenceItemIds),
      ],
    ) as unknown as SignalCandidateRow[];
    if (!rows[0]) throw new SagaNewsConflictError("Signalkandidaten kunde inte sparas.");
    return mapSignalCandidate(rows[0]);
  } catch (error) {
    normalizeDatabaseError(error);
  }
}

/** Viewer-safe candidates: their evidence remains scoped to the same workspace. */
export async function listSagaNewsSignalCandidates(
  actor: AppActor,
  options: { state?: "candidate" | "qualified" | "in_review" | "dismissed"; limit?: number } = {},
  sql: NeonSql = createNeonSql(),
): Promise<SagaNewsSignalCandidate[]> {
  const limit = Math.min(100, Math.max(1, Math.trunc(options.limit ?? 30)));
  const rows = await sql.query(
    `${signalCandidateSelect}
      where candidate.workspace_id = $1::uuid
        and ($2::text is null or candidate.state = $2::text)
      ${signalCandidateGroupBy()}
      order by candidate.last_seen_at desc
      limit $3`,
    [actor.workspaceId, options.state ?? null, limit],
  ) as unknown as SignalCandidateRow[];
  return rows.map(mapSignalCandidate);
}

function normalizeDatabaseError(error: unknown): never {
  if (error instanceof SagaNewsAccessError || error instanceof SagaNewsNotFoundError || error instanceof SagaNewsPolicyError || error instanceof SagaNewsConflictError) {
    throw error;
  }
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (code === "23503") throw new SagaNewsNotFoundError();
    if (code === "23505") throw new SagaNewsConflictError();
    // The migration uses explicit PostgreSQL checks when an item, source, or
    // receipt is stale / off-policy. Never reinterpret these as a free retry.
    if (code === "P0001") throw new SagaNewsPolicyError();
  }
  throw error;
}
