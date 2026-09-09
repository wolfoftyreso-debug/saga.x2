import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sagaDailyKnowledgePolicyInputSchema } from "@/lib/domain/saga-daily-knowledge";
import type { NeonSql } from "@/lib/neon/database";
import {
  cancelStaleSagaDailyKnowledgeJobs,
  claimDueSagaDailyKnowledgeJob,
  completeSagaDailyKnowledgeJob,
  getSagaDailyKnowledgePolicy,
  isCurrentSagaDailyKnowledgeClaim,
  listSagaDailyKnowledgeEntries,
  listSagaDailyKnowledgeEvidenceForClaim,
  listSagaDailyKnowledgeRuns,
  materializeSagaDailyKnowledgeJobs,
  persistSagaDailyKnowledgeEntries,
  saveSagaDailyKnowledgePolicy,
  type ClaimedSagaDailyKnowledgeJob,
  type SagaDailyKnowledgeEvidenceCandidate,
} from "@/lib/neon/saga-daily-knowledge-repository";
import { SagaNewsConflictError } from "@/lib/neon/saga-news-core-repository";
import { SagaBrandScopeError } from "@/lib/neon/saga-brand-api-eligibility";
import {
  buildSagaDailyKnowledgeEntries,
  candidateMatchesTopic,
  processClaimedSagaDailyKnowledgeJob,
  type SagaDailyKnowledgeWorkerDependencies,
} from "@/lib/neon/saga-daily-knowledge-worker";

const NOW = new Date("2026-08-26T08:00:00.000Z");
const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const POLICY_ID = "22222222-2222-4222-8222-222222222222";
const JOB_ID = "33333333-3333-4333-8333-333333333333";
const CLAIM_TOKEN = "44444444-4444-4444-8444-444444444444";
const SOURCE_A = "55555555-5555-4555-8555-555555555555";
const SOURCE_B = "66666666-6666-4666-8666-666666666666";
const BRAND_ID = "99999999-9999-4999-8999-999999999999";

const CLAIM: ClaimedSagaDailyKnowledgeJob = {
  id: JOB_ID,
  workspaceId: WORKSPACE_ID,
  policyId: POLICY_ID,
  policyRevision: 2,
  knowledgeDate: "2026-08-26",
  claimToken: CLAIM_TOKEN,
  attempts: 1,
  maxAttempts: 3,
  retentionExpiresAt: "2026-11-24T08:00:00.000Z",
  policy: {
    timezone: "Europe/Stockholm",
    dailyAt: "06:00",
    topics: ["kinesiska elbilar"],
    sourceIds: [SOURCE_A, SOURCE_B],
    minimumIndependentPublishers: 2,
    minimumEvidenceItems: 2,
    maximumEvidenceItems: 4,
    evidenceWindowHours: 72,
    retentionDays: 90,
  },
};

function evidence(overrides: Partial<SagaDailyKnowledgeEvidenceCandidate> = {}): SagaDailyKnowledgeEvidenceCandidate {
  return {
    itemId: "77777777-7777-4777-8777-777777777777",
    sourceId: SOURCE_A,
    sourceName: "Officiell källa A",
    connectorKey: "rss_atom",
    sourceTrustLevel: 4,
    canonicalUrl: "https://www.source-a.example/elbilar",
    title: "Kinesiska elbilar växer på den svenska marknaden",
    excerpt: "Ny statistik om kinesiska elbilar och konsumenternas val.",
    publisherName: "Source A",
    publisherDomain: "source-a.example",
    language: "sv",
    publishedAt: "2026-08-26T06:00:00.000Z",
    observedAt: "2026-08-26T06:00:00.000Z",
    ...overrides,
  };
}

function dependencies(overrides: Partial<SagaDailyKnowledgeWorkerDependencies> = {}): SagaDailyKnowledgeWorkerDependencies {
  return {
    materialize: async () => ({ policiesScanned: 0, jobsCreated: 0 }),
    cancelStale: async () => 0,
    expireLeases: async () => 0,
    pruneRetention: async () => 0,
    claim: async () => null,
    isCurrent: async () => true,
    listEvidence: async () => [],
    persist: async () => undefined,
    complete: async () => true,
    cancel: async () => true,
    fail: async () => "retry_scheduled",
    ...overrides,
  };
}

function policyInput(expectedRevision?: number) {
  return {
    enabled: false,
    timezone: "Europe/Stockholm",
    dailyAt: "06:00",
    topics: ["Kinesiska elbilar"],
    sourceIds: [SOURCE_A, SOURCE_B],
    minimumIndependentPublishers: 2,
    minimumEvidenceItems: 2,
    maximumEvidenceItems: 4,
    evidenceWindowHours: 72,
    retentionDays: 90,
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
  };
}

function policyRow() {
  return {
    id: POLICY_ID,
    workspace_id: WORKSPACE_ID,
    brand_profile_id: BRAND_ID,
    enabled: false,
    timezone: "Europe/Stockholm",
    daily_at: "06:00:00",
    topics: ["Kinesiska elbilar"],
    source_ids: [SOURCE_A, SOURCE_B],
    minimum_independent_publishers: 2,
    minimum_evidence_items: 2,
    maximum_evidence_items: 4,
    evidence_window_hours: 72,
    retention_days: 90,
    last_materialized_for_date: null,
    revision: 1,
    created_at: "2026-08-26T08:00:00.000Z",
    updated_at: "2026-08-26T08:00:00.000Z",
  };
}

describe("SAGA Daily Knowledge policy", () => {
  it("is opt-in and rejects duplicate topics, duplicate source ids and an invalid evidence range", () => {
    const base = policyInput();
    expect(sagaDailyKnowledgePolicyInputSchema.parse(base).enabled).toBe(false);
    expect(sagaDailyKnowledgePolicyInputSchema.parse(policyInput(1)).expectedRevision).toBe(1);
    expect(sagaDailyKnowledgePolicyInputSchema.safeParse({
      ...base,
      topics: ["Kinesiska elbilar", " kinesiska elbilar "],
      sourceIds: [SOURCE_A, SOURCE_A],
      minimumEvidenceItems: 5,
      maximumEvidenceItems: 4,
    }).success).toBe(false);
  });

  it("allows a first save without a revision but atomically rejects an existing stale/missing revision", async () => {
    const calls: Array<{ query: string; values: unknown[] | undefined }> = [];
    const sql = {
      query: async (query: string, values?: unknown[]) => {
        calls.push({ query, values });
        if (query.includes("from saga_news_sources")) return [{ id: SOURCE_A }, { id: SOURCE_B }];
        if (query.includes("insert into saga_daily_knowledge_policies")) return [policyRow()];
        return [];
      },
    } as unknown as NeonSql;
    await expect(saveSagaDailyKnowledgePolicy({
      userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      workspaceId: WORKSPACE_ID,
      brandProfileId: BRAND_ID,
      role: "owner",
      email: null,
      displayName: null,
    }, policyInput(), sql)).resolves.toMatchObject({ revision: 1 });
    const upsert = calls.find((call) => call.query.includes("insert into saga_daily_knowledge_policies"));
    expect(upsert?.query).toMatch(/where \$13::integer is not null/i);
    expect(upsert?.values?.[12]).toBeNull();

    const staleSql = {
      query: async (query: string) => {
        if (query.includes("from saga_news_sources")) return [{ id: SOURCE_A }, { id: SOURCE_B }];
        if (query.includes("insert into saga_daily_knowledge_policies")) return [];
        return [];
      },
    } as unknown as NeonSql;
    await expect(saveSagaDailyKnowledgePolicy({
      userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      workspaceId: WORKSPACE_ID,
      brandProfileId: BRAND_ID,
      role: "owner",
      email: null,
      displayName: null,
    }, policyInput(1), staleSql)).rejects.toBeInstanceOf(SagaNewsConflictError);
  });
});

describe("SAGA Daily Knowledge brand persistence boundary", () => {
  const actor = { userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", workspaceId: WORKSPACE_ID, role: "owner" as const, email: null, displayName: null };

  it("rejects unscoped repository reads and writes before issuing SQL", async () => {
    const query = vi.fn();
    const sql = { query } as unknown as NeonSql;
    for (const call of [
      () => getSagaDailyKnowledgePolicy(actor, sql),
      () => saveSagaDailyKnowledgePolicy(actor, policyInput(), sql),
      () => listSagaDailyKnowledgeEntries(actor, {}, sql),
      () => listSagaDailyKnowledgeRuns(actor, {}, sql),
    ]) await expect(call()).rejects.toBeInstanceOf(SagaBrandScopeError);
    expect(query).not.toHaveBeenCalled();
  });

  it("binds each read to the selected brand and signed tenant, including entry/run policy joins", async () => {
    const query = vi.fn(async () => []);
    const sql = { query } as unknown as NeonSql;
    const selected = { ...actor, brandProfileId: BRAND_ID };
    await getSagaDailyKnowledgePolicy(selected, sql);
    await listSagaDailyKnowledgeEntries(selected, {}, sql);
    await listSagaDailyKnowledgeRuns(selected, {}, sql);
    expect(query.mock.calls).toHaveLength(3);
    for (const call of query.mock.calls as unknown as Array<[string, unknown[]]>) {
      expect(call[0]).toContain("workspace_id = $1::uuid");
      expect(call[0]).toContain("brand_profile_id = $");
      expect(call[0]).toContain("saga_daily_knowledge_brand_is_eligible");
      expect(call[1][0]).toBe(WORKSPACE_ID);
      expect(call[1].at(-1)).toBe(BRAND_ID);
    }
    expect((query.mock.calls as unknown as Array<[string]>)[1]![0]).toContain("policy.id = entry.policy_id and policy.workspace_id = entry.workspace_id");
    expect((query.mock.calls as unknown as Array<[string]>)[2]![0]).toContain("policy.id = job.policy_id and policy.workspace_id = job.workspace_id");
  });

  it("isolates policy upsert/revision conflict to one immutable brand", async () => {
    const query = vi.fn(async (statement: string) => {
      if (statement.includes("from saga_news_sources")) return [{ id: SOURCE_A }, { id: SOURCE_B }];
      if (statement.includes("insert into saga_daily_knowledge_policies")) return [policyRow()];
      return [];
    });
    const sql = { query } as unknown as NeonSql;
    await saveSagaDailyKnowledgePolicy({ ...actor, brandProfileId: BRAND_ID }, policyInput(1), sql);
    const upsert = (query.mock.calls as unknown as Array<[string, unknown[]]>).find(([statement]) => statement.includes("insert into saga_daily_knowledge_policies"))!;
    expect(upsert[0]).toContain("on conflict (workspace_id, brand_profile_id)");
    expect(upsert[0]).toContain("saga_daily_knowledge_brand_is_eligible($1::uuid, $14::uuid)");
    expect(upsert[0]).not.toContain("brand_profile_id = excluded");
    expect(upsert[1][13]).toBe(BRAND_ID);
    expect(upsert[1][12]).toBe(1);
  });

  it("guards every cron materialization and persistence stage against inactive or unassigned brands", async () => {
    const statements: string[] = [];
    const sql = { query: async (statement: string) => {
      statements.push(statement);
      if (statement.includes("select 1\n       from saga_daily_knowledge_jobs")) return [{ "?column?": 1 }];
      return [];
    } } as unknown as NeonSql;
    await materializeSagaDailyKnowledgeJobs({ now: NOW }, sql);
    await cancelStaleSagaDailyKnowledgeJobs(NOW, sql);
    await claimDueSagaDailyKnowledgeJob(NOW, "test-worker", sql);
    await isCurrentSagaDailyKnowledgeClaim(CLAIM, sql);
    await persistSagaDailyKnowledgeEntries(CLAIM, [{
      policyId: POLICY_ID, jobId: JOB_ID, policyRevision: 2, knowledgeDate: "2026-08-26", topic: "AI och arbete",
      topicKey: "a".repeat(64), headline: "Dagens underlag", summary: "Ett verifierat underlag.", evidenceCount: 2,
      independentPublisherCount: 2, evidence: [evidence(), evidence({ publisherDomain: "source-b.example" })],
    }], NOW, sql);
    await completeSagaDailyKnowledgeJob(CLAIM, 1, NOW, sql);
    expect(statements).toHaveLength(8);
    for (const statement of statements) expect(statement).toContain("saga_daily_knowledge_brand_is_eligible(policy.workspace_id, policy.brand_profile_id)");
  });

  it("migrates without guessing an owner for ambiguous legacy policies", () => {
    const migration = readFileSync(resolve("db/migrations/202609080029_neon_saga_knowledge_brand_scope.sql"), "utf8");
    expect(migration).toContain("having count(*) = 1");
    expect(migration).toContain("where all_brands.workspace_id = brand.workspace_id) = 1");
    expect(migration).toContain("brand.active = true and onboarding.completion_state = 'completed'");
    expect(migration).toContain("foreign key (workspace_id, brand_profile_id)");
    expect(migration).toContain("on saga_daily_knowledge_policies(workspace_id, brand_profile_id)");
    expect(migration).toContain("new.brand_profile_id is distinct from old.brand_profile_id");
    expect(migration).toContain("new.workspace_id is distinct from old.workspace_id");
    expect(migration).toContain("where brand_profile_id is null and enabled = true");
    expect(migration).not.toContain("delete from saga_daily_knowledge");
  });
});

describe("SAGA Daily Knowledge generator", () => {
  it("requires independent publisher evidence and produces metadata-only source bundles", () => {
    const second = evidence({
      itemId: "88888888-8888-4888-8888-888888888888",
      sourceId: SOURCE_B,
      sourceName: "Officiell källa B",
      canonicalUrl: "https://www.source-b.example/elbilar",
      publisherName: "Source B",
      publisherDomain: "source-b.example",
    });
    const entries = buildSagaDailyKnowledgeEntries(CLAIM, [evidence(), second]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      policyId: POLICY_ID,
      jobId: JOB_ID,
      evidenceCount: 2,
      independentPublisherCount: 2,
      knowledgeDate: "2026-08-26",
    });
    expect(JSON.stringify(entries)).not.toContain("bodyText");
    expect(JSON.stringify(entries)).not.toContain("article body");
    expect(entries[0]?.summary).not.toContain("verifierade");
    expect(entries[0]?.summary).not.toContain("faktaunderlag");
    expect(entries[0]?.summary).toContain("valda källorna");
    expect(entries[0]?.summary).toContain("inte ett färdigt inlägg");

    const samePublisher = evidence({
      itemId: "99999999-9999-4999-8999-999999999999",
      canonicalUrl: "https://www.source-a.example/another-electric-car-story",
    });
    expect(buildSagaDailyKnowledgeEntries(CLAIM, [evidence(), samePublisher])).toEqual([]);
  });

  it("uses visible topic tokens rather than hidden semantic inference", () => {
    expect(candidateMatchesTopic(evidence(), "kinesiska elbilar")).toBe(true);
    expect(candidateMatchesTopic(evidence(), "ny laddinfrastruktur")).toBe(false);
  });

  it("completes a no-evidence run without creating content or scheduling a retry", async () => {
    const persist = vi.fn(async () => undefined);
    const complete = vi.fn(async () => true);
    const result = await processClaimedSagaDailyKnowledgeJob(CLAIM, {
      now: NOW,
      dependencies: dependencies({ persist, complete }),
    });
    expect(result).toEqual({ jobId: JOB_ID, status: "no_qualifying_evidence", entriesCreated: 0 });
    expect(persist).toHaveBeenCalledWith(CLAIM, [], NOW);
    expect(complete).toHaveBeenCalledWith(CLAIM, 0, NOW);
  });

  it("cancels instead of writing if the policy guard is no longer current", async () => {
    const persist = vi.fn(async () => undefined);
    const cancel = vi.fn(async () => true);
    const result = await processClaimedSagaDailyKnowledgeJob(CLAIM, {
      now: NOW,
      dependencies: dependencies({ isCurrent: async () => false, persist, cancel }),
    });
    expect(result).toMatchObject({ jobId: JOB_ID, status: "cancelled", code: "daily_knowledge_policy_changed" });
    expect(persist).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledWith(CLAIM, NOW);
  });
});

describe("SAGA Daily Knowledge source boundary", () => {
  it("selects only bounded source metadata, never saga_news_source_items.body_text", async () => {
    const queries: string[] = [];
    const sql = {
      query: async (query: string) => {
        queries.push(query);
        return [
          {
            item_id: "77777777-7777-4777-8777-777777777777",
            source_id: SOURCE_A,
            source_name: "Officiell källa A",
            connector_key: "rss_atom",
            source_trust_level: 4,
            canonical_url: "https://www.source-a.example/elbilar",
            title: "Kinesiska elbilar växer",
            summary: "Kort kontrollerat källutdrag.",
            publisher_name: "Source A",
            publisher_domain: "source-a.example",
            language: "sv",
            published_at: "2026-08-26T06:00:00.000Z",
            observed_at: "2026-08-26T06:00:00.000Z",
          },
        ];
      },
    } as unknown as NeonSql;
    const result = await listSagaDailyKnowledgeEvidenceForClaim(CLAIM, NOW, sql);
    expect(result).toHaveLength(1);
    expect(queries[0]).not.toMatch(/body_text/i);
    expect(queries[0]).toMatch(/item\.title/i);
    expect(queries[0]).toMatch(/item\.summary/i);
    expect(queries[0]).toMatch(/source\.is_allowed = true/i);
  });

  it("keeps the Cron integration on the knowledge worker, never the authoring generator", () => {
    const cron = readFileSync(resolve(process.cwd(), "app/api/cron/tick/route.ts"), "utf8");
    const worker = readFileSync(resolve(process.cwd(), "lib/neon/saga-daily-knowledge-worker.ts"), "utf8");
    expect(cron).toContain("runDueSagaDailyKnowledgeWorker");
    expect(cron).not.toContain("saga-adobe-authoring");
    expect(cron).not.toContain("runSagaAdobeAuthoring");
    expect(worker).not.toContain("studio_drafts");
    expect(worker).not.toContain("createPrivateSagaSignalProductionDraft");
  });
});
