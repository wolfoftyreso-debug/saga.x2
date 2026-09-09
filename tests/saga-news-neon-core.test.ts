import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  sagaNewsIngestionFailureInputSchema,
  sagaNewsSourceInputSchema,
  sagaNewsSourceItemInputSchema,
} from "@/lib/domain/saga-news-core";
import type { AppActor } from "@/lib/neon/auth-repository";
import type { NeonSql } from "@/lib/neon/database";
import {
  beginClaimedSagaNewsIngestionRun,
  beginSagaNewsIngestionRun,
  claimDueSagaNewsSources,
  completeClaimedSagaNewsIngestionRun,
  listSagaNewsSourceItems,
  persistSagaNewsCandidates,
  SagaNewsAccessError,
  sagaNewsPersistenceInputToSourceItemInput,
  saveSagaNewsSource,
  setSagaNewsSourceActive,
  upsertSagaNewsSignalCandidate,
} from "@/lib/neon/saga-news-core-repository";

const actor: AppActor = {
  userId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  role: "owner",
  email: "owner@example.com",
  displayName: "Owner",
};
const sourceId = "33333333-3333-4333-8333-333333333333";
const runId = "44444444-4444-4444-8444-444444444444";
const itemId = "55555555-5555-4555-8555-555555555555";
const candidateId = "66666666-6666-4666-8666-666666666666";
const claimToken = "77777777-7777-4777-8777-777777777777";
const idempotencyKey = "88888888-8888-4888-8888-888888888888";
const now = "2026-08-24T09:00:00.000Z";
const hash = "a".repeat(64);

function sqlWith(...results: unknown[]) {
  const query = vi.fn();
  for (const result of results) query.mockResolvedValueOnce(result);
  return { sql: { query } as unknown as NeonSql, query };
}

const sourceRow = {
  id: sourceId,
  created_by_user_id: actor.userId,
  updated_by_user_id: actor.userId,
  slug: "elbil-nytt",
  name: "Elbilnytt",
  source_kind: "rss",
  connector_key: "rss_atom",
  endpoint_url: "https://example.test/feed.xml",
  publisher_allowlist: ["example.test"],
  publisher_blocklist: [],
  allowlist_mode: "strict",
  topics: ["elbil"],
  languages: ["sv"],
  countries: ["SE"],
  trust_level: 4,
  source_weight: 80,
  minimum_interval_minutes: 60,
  max_items_per_run: 100,
  max_item_text_chars: 30000,
  source_policy: { retainFullText: false },
  is_allowed: true,
  active: true,
  last_ingestion_at: null,
  last_successful_ingestion_at: null,
  last_failure_at: null,
  last_failure_code: null,
  next_ingestion_at: now,
  lease_token: null,
  lease_expires_at: null,
  leased_by: null,
  created_at: now,
  updated_at: now,
};

const runRow = {
  id: runId,
  source_id: sourceId,
  requested_by_user_id: actor.userId,
  connector_key: "rss_atom",
  idempotency_key: idempotencyKey,
  request_fingerprint: hash,
  worker_id: "saga-cron",
  status: "running",
  items_received: 0,
  items_inserted: 0,
  items_duplicate: 0,
  items_rejected: 0,
  failure_code: null,
  failure_summary: null,
  started_at: now,
  completed_at: null,
  created_at: now,
  updated_at: now,
};

const sourceItemRow = {
  id: itemId,
  source_id: sourceId,
  first_ingestion_run_id: runId,
  last_ingestion_run_id: runId,
  canonical_url: "https://example.test/elbilar",
  title: "Elbilar växer",
  summary: "En kort, verifierbar sammanfattning.",
  publisher_name: "Example News",
  publisher_domain: "example.test",
  authors: ["Redaktionen"],
  language: "sv-se",
  published_at: now,
  discovered_at: now,
  first_seen_at: now,
  last_seen_at: now,
  provenance: { provider: "rss_atom", contentHash: hash, fetchedAt: now },
  content_fingerprint: hash,
  story_fingerprint: "b".repeat(64),
  created_at: now,
  updated_at: now,
};

const signalCandidateRow = {
  id: candidateId,
  created_by_user_id: actor.userId,
  updated_by_user_id: actor.userId,
  signal_key: "elbilar-2026-08-24",
  topic: "Elbilar",
  headline: "Elbilar växer i Sverige",
  summary: "Två bekräftade källor visar ett återkommande mönster.",
  editorial_angle: "Vad betyder detta för vardagsbilisten?",
  content_fingerprint: hash,
  source_credibility_score: 85,
  topical_relevance_score: 90,
  mission_alignment_score: 80,
  trend_momentum_score: 70,
  channel_suitability_score: 88,
  evidence_item_ids: [itemId],
  evidence_count: 1,
  independent_source_count: 1,
  distinct_publisher_count: 1,
  policy_snapshot: { minimumSources: 2 },
  state: "candidate",
  requires_human_review: true,
  active: true,
  first_seen_at: now,
  last_seen_at: now,
  created_at: now,
  updated_at: now,
};

const validSourceInput = {
  slug: "elbil-nytt",
  name: "Elbilnytt",
  sourceKind: "rss" as const,
  connectorKey: "rss_atom",
  endpointUrl: "https://example.test/feed.xml",
  publisherAllowlist: ["example.test"],
  publisherBlocklist: [],
  allowlistMode: "strict" as const,
  topics: ["elbil"],
  languages: ["sv"],
  countries: ["SE"],
  trustLevel: 4,
  sourceWeight: 80,
  minimumIntervalMinutes: 60,
  maxItemsPerRun: 100,
  maxItemTextChars: 30000,
  sourcePolicy: { retainFullText: false },
  isAllowed: true,
  active: true,
};

describe("SAGA News Core: Neon foundation", () => {
  it("ships Vercel/Neon tables, bounded intake, provenance, evidence and no credential store", () => {
    const migration = readFileSync(resolve(process.cwd(), "db/migrations/202608240008_neon_saga_news_core.sql"), "utf8");
    for (const table of [
      "saga_news_sources",
      "saga_news_ingestion_runs",
      "saga_news_source_items",
      "saga_news_signal_candidates",
      "saga_news_signal_evidence",
    ]) expect(migration).toContain(`create table if not exists ${table}`);
    expect(migration).toContain("saga_news_ingest_source_items");
    expect(migration).toContain("saga_news_replace_signal_evidence");
    expect(migration).toContain("next_ingestion_at");
    expect(migration).toContain("identity_fingerprint");
    expect(migration).toContain("publisher_allowlist");
    expect(migration).toContain("lease_token");
    expect(migration).toContain("incoming items exceed source text or metadata policy");
    expect(migration).toContain("retainFullText");
    expect(migration.toLowerCase()).not.toContain("supabase");
  });

  it("rejects secret-bearing source config and credential URLs while accepting normalized BCP47 feed language", () => {
    expect(sagaNewsSourceInputSchema.safeParse({
      ...validSourceInput,
      sourcePolicy: { additionalRules: { apiKey: "never-store-me" } },
    }).success).toBe(false);
    expect(sagaNewsSourceInputSchema.safeParse({
      ...validSourceInput,
      endpointUrl: "https://example.test/feed.xml?access_token=nope",
    }).success).toBe(false);
    expect(sagaNewsSourceInputSchema.safeParse({
      ...validSourceInput,
      publisherAllowlist: [],
    }).success).toBe(false);
    expect(sagaNewsSourceItemInputSchema.parse({
      canonicalUrl: "https://example.test/story",
      title: "Test",
      publisherDomain: "example.test",
      language: "sv-se",
    }).language).toBe("sv-se");
    expect(sagaNewsIngestionFailureInputSchema.safeParse({
      sourceId,
      runId,
      failureCode: "connector_failed",
      failureSummary: "https://example.test/?token=never-store-this",
    }).success).toBe(false);
  });

  it("maps connector candidates to a bounded body-free persistence shape", () => {
    const item = sagaNewsPersistenceInputToSourceItemInput({
      sourceId,
      provider: "rss_atom",
      canonicalUrl: "https://example.test/elbilar",
      title: "Elbilar växer",
      summary: "Kort sammanfattning",
      publishedAt: now,
      language: "SV-se",
      sourceDomain: "example.test",
      contentHash: hash,
      raw: { feed_kind: "rss" },
      fetchedAt: now,
    });
    expect(item).toMatchObject({
      externalId: null,
      bodyText: "",
      publisherDomain: "example.test",
      language: "sv-se",
      provenance: { provider: "rss_atom", contentHash: hash, fetchedAt: now },
    });
  });

  it("writes a source solely under the signed actor workspace and rejects viewer writes", async () => {
    const { sql, query } = sqlWith([sourceRow]);
    const saved = await saveSagaNewsSource(actor, validSourceInput, sql);
    expect(saved).toMatchObject({ id: sourceId, publisherAllowlist: ["example.test"], nextIngestionAt: now });
    expect(saved).not.toHaveProperty("leaseToken");
    expect(query.mock.calls[0]?.[0]).toContain("on conflict (workspace_id, slug)");
    expect(query.mock.calls[0]?.[1]?.slice(0, 2)).toEqual([actor.workspaceId, actor.userId]);

    const blocked = sqlWith();
    await expect(saveSagaNewsSource({ ...actor, role: "viewer" }, validSourceInput, blocked.sql)).rejects.toBeInstanceOf(SagaNewsAccessError);
    expect(blocked.query).not.toHaveBeenCalled();
  });

  it("creates an idempotent manual receipt with actor-scoped active source lookup", async () => {
    const { sql, query } = sqlWith([sourceRow], [runRow]);
    const receipt = await beginSagaNewsIngestionRun(actor, { sourceId, idempotencyKey, workerId: "manual-run" }, sql);
    expect(receipt).toMatchObject({ reused: false, run: { id: runId, sourceId, status: "running" } });
    expect(query.mock.calls[0]?.[0]).toContain("workspace_id = $1::uuid and id = $2::uuid");
    expect(query.mock.calls[1]?.[0]).toContain("on conflict (workspace_id, source_id, idempotency_key) do nothing");
    expect(query.mock.calls[1]?.[1]?.[0]).toBe(actor.workspaceId);
  });

  it("persists connector facts with no body text and lets Neon enforce the live run/publisher policy", async () => {
    const { sql, query } = sqlWith([sourceRow], [{ received_count: 1, inserted_count: 1, duplicate_count: 0 }]);
    const result = await persistSagaNewsCandidates(actor, {
      sourceId,
      runId,
      candidates: [{
        sourceId,
        provider: "rss_atom",
        canonicalUrl: "https://example.test/elbilar?utm_source=rss",
        title: "Elbilar växer",
        summary: "Kort sammanfattning",
        publishedAt: now,
        language: "sv-se",
        sourceDomain: "example.test",
        contentHash: hash,
        raw: { feed_kind: "rss" },
        fetchedAt: now,
      }],
    }, sql);
    expect(result).toEqual({ receivedCount: 1, insertedCount: 1, duplicateCount: 0 });
    expect(query.mock.calls[1]?.[0]).toContain("saga_news_ingest_source_items");
    const persisted = JSON.parse(query.mock.calls[1]?.[1]?.[3] as string);
    expect(persisted[0]).toMatchObject({ external_id: null, body_text: "", publisher_domain: "example.test" });
    expect(persisted[0].canonical_url).toBe("https://example.test/elbilar");
    expect(persisted[0].provenance).toMatchObject({ provider: "rss_atom", contentHash: hash, fetchedAt: now });
  });

  it("lists source items under actor scope without selecting article body text", async () => {
    const { sql, query } = sqlWith([sourceItemRow]);
    const items = await listSagaNewsSourceItems(actor, { sourceId, runId, since: now, limit: 10 }, sql);
    expect(items).toEqual([expect.objectContaining({ id: itemId, title: "Elbilar växer" })]);
    expect(items[0]).not.toHaveProperty("bodyText");
    expect(query.mock.calls[0]?.[0]).toContain("item.workspace_id = $1::uuid");
    expect(query.mock.calls[0]?.[0]).not.toContain("body_text");
    expect(query.mock.calls[0]?.[1]).toEqual([actor.workspaceId, sourceId, runId, now, 10]);
  });

  it("upserts a signal through atomic workspace-scoped evidence replacement", async () => {
    const { sql, query } = sqlWith([signalCandidateRow]);
    const candidate = await upsertSagaNewsSignalCandidate(actor, {
      signalKey: "elbilar-2026-08-24",
      topic: "Elbilar",
      headline: "Elbilar växer i Sverige",
      summary: "Två bekräftade källor visar ett återkommande mönster.",
      editorialAngle: "Vad betyder detta för vardagsbilisten?",
      evidenceItemIds: [itemId],
      scores: { sourceCredibility: 85, topicalRelevance: 90, missionAlignment: 80, trendMomentum: 70, channelSuitability: 88 },
      policySnapshot: { minimumSources: 2 },
      state: "candidate",
      requiresHumanReview: true,
      active: true,
    }, sql);
    expect(candidate).toMatchObject({ id: candidateId, evidenceItemIds: [itemId], requiresHumanReview: true });
    expect(query.mock.calls[0]?.[0]).toContain("saga_news_replace_signal_evidence");
    expect(query.mock.calls[0]?.[0]).toContain("join persisted on persisted.workspace_id = candidate.workspace_id");
    expect(JSON.parse(query.mock.calls[0]?.[1]?.[17] as string)).toEqual([itemId]);
  });

  it("claims due sources with a lease and finalizes only the matching Cron receipt", async () => {
    const claimedRow = { ...sourceRow, workspace_id: actor.workspaceId, lease_token: claimToken, lease_expires_at: "2026-08-24T09:02:00.000Z", leased_by: "vercel-cron" };
    const claimSql = sqlWith([claimedRow]);
    const [claim] = await claimDueSagaNewsSources({ now: new Date(now), limit: 2, workerId: "vercel-cron", leaseSeconds: 120 }, claimSql.sql);
    expect(claim).toMatchObject({ workspaceId: actor.workspaceId, source: { id: sourceId }, claimToken });
    expect(claimSql.query.mock.calls[0]?.[0]).toContain("for update skip locked");
    expect(claimSql.query.mock.calls[0]?.[0]).toContain("lease_token = gen_random_uuid()");

    const finalizerSql = sqlWith([{ ...runRow, status: "completed", completed_at: now }]);
    const completed = await completeClaimedSagaNewsIngestionRun(claim!, { runId }, finalizerSql.sql);
    expect(completed).toMatchObject({ id: runId, status: "completed" });
    expect(finalizerSql.query.mock.calls[0]?.[0]).toContain("source.lease_token = $4::uuid");
    expect(finalizerSql.query.mock.calls[0]?.[0]).toContain("next_ingestion_at = now() + (source.minimum_interval_minutes * interval '1 minute')");
    expect(finalizerSql.query.mock.calls[0]?.[0]).toContain("lease_token = null");
  });

  it("starts a claimed receipt only after checking its live lease", async () => {
    const claimedSourceRow = { ...sourceRow, lease_token: claimToken, lease_expires_at: "2026-08-24T09:02:00.000Z", leased_by: "vercel-cron" };
    const claim = {
      workspaceId: actor.workspaceId,
      source: { ...sourceRow },
      claimToken,
      leaseExpiresAt: "2026-08-24T09:02:00.000Z",
    } as never;
    const { sql, query } = sqlWith([claimedSourceRow], [runRow]);
    const receipt = await beginClaimedSagaNewsIngestionRun(claim, { idempotencyKey, workerId: "vercel-cron" }, sql);
    expect(receipt).toMatchObject({ reused: false, run: { id: runId } });
    expect(query.mock.calls[0]?.[0]).toContain("lease_token = $3::uuid");
    expect(query.mock.calls[1]?.[0]).toContain("source.lease_token = $6::uuid");
  });

  it("pauses a real source under actor scope and clears a stale lease", async () => {
    const { sql, query } = sqlWith([{ ...sourceRow, active: false }]);
    const source = await setSagaNewsSourceActive(actor, sourceId, false, sql);
    expect(source.active).toBe(false);
    expect(query.mock.calls[0]?.[0]).toContain("lease_token = case when $3 then lease_token else null end");
    expect(query.mock.calls[0]?.[1]).toEqual([actor.workspaceId, actor.userId, false, sourceId]);
  });
});
