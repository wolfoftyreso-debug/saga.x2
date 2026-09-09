import { describe, expect, it, vi } from "vitest";
import { createSagaNewsCandidate } from "@/lib/news-core";
import type { SagaNewsIngestionRun, SagaNewsSource, SagaNewsSourceClaim } from "@/lib/domain/saga-news-core";

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  begin: vi.fn(),
  persist: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
  release: vi.fn(),
  getSource: vi.fn(),
  listItems: vi.fn(),
  listSources: vi.fn(),
  persistActor: vi.fn(),
  completeActor: vi.fn(),
  failActor: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock("@/lib/neon/saga-news-core-repository", () => ({
  claimDueSagaNewsSources: mocks.claim,
  beginClaimedSagaNewsIngestionRun: mocks.begin,
  persistClaimedSagaNewsConnectorBatch: mocks.persist,
  completeClaimedSagaNewsIngestionRun: mocks.complete,
  failClaimedSagaNewsIngestionRun: mocks.fail,
  releaseSagaNewsSourceClaim: mocks.release,
  getSagaNewsSource: mocks.getSource,
  listSagaNewsSourceItems: mocks.listItems,
  listSagaNewsSources: mocks.listSources,
  persistSagaNewsConnectorBatch: mocks.persistActor,
  completeSagaNewsIngestionRun: mocks.completeActor,
  failSagaNewsIngestionRun: mocks.failActor,
  upsertSagaNewsSignalCandidate: mocks.upsert,
}));

import { runDueSagaNewsSources } from "@/lib/services/saga-news-runner";

const NOW = new Date("2026-08-24T12:00:00.000Z");
const SOURCE_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKSPACE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const RUN_ID = "22222222-2222-4222-8222-222222222222";

function source(): SagaNewsSource {
  return {
    id: SOURCE_ID, createdByUserId: USER_ID, updatedByUserId: USER_ID,
    slug: "global-elbilar", name: "Global elbilsbevakning", sourceKind: "public_api", connectorKey: "gdelt_doc_2",
    endpointUrl: "https://api.gdeltproject.org/api/v2/doc/doc", publisherAllowlist: ["di.se", "svd.se"], publisherBlocklist: [], allowlistMode: "strict",
    topics: ["kinesiska elbilar"], languages: ["sv"], countries: ["SE"], trustLevel: 4, sourceWeight: 80,
    minimumIntervalMinutes: 60, maxItemsPerRun: 50, maxItemTextChars: 30_000,
    sourcePolicy: { requireCanonicalUrl: true, requirePublishedAt: false, minimumPublisherCredibility: 3, retainFullText: false, additionalRules: {} },
    isAllowed: true, active: true, lastIngestionAt: null, lastSuccessfulIngestionAt: null, lastFailureAt: null, lastFailureCode: null,
    nextIngestionAt: NOW.toISOString(), createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
  };
}

function run(): SagaNewsIngestionRun {
  return {
    id: RUN_ID, sourceId: SOURCE_ID, requestedByUserId: USER_ID, connectorKey: "gdelt_doc_2",
    idempotencyKey: "33333333-3333-4333-8333-333333333333", requestFingerprint: "a".repeat(64), workerId: "vercel-saga-news",
    status: "running", itemsReceived: 0, itemsInserted: 0, itemsDuplicate: 0, itemsRejected: 0, failureCode: null, failureSummary: null,
    startedAt: NOW.toISOString(), completedAt: null, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
  };
}

describe("SAGA News Cron source-to-signal chain", () => {
  it("reconciles a persisted claimed batch before releasing the source lease", async () => {
    const claimedSource = source();
    const claim: SagaNewsSourceClaim = { workspaceId: WORKSPACE_ID, source: claimedSource, claimToken: "44444444-4444-4444-8444-444444444444", leaseExpiresAt: "2026-08-24T12:02:00.000Z" };
    const receipt = run();
    const completed = { ...receipt, status: "completed" as const, completedAt: NOW.toISOString() };
    const reconcileSignals = vi.fn().mockResolvedValue([]);
    mocks.claim.mockResolvedValue([claim]);
    mocks.begin.mockResolvedValue({ run: receipt, reused: false });
    mocks.persist.mockResolvedValue({ receivedCount: 1, insertedCount: 1, duplicateCount: 0 });
    mocks.complete.mockResolvedValue(completed);

    const candidate = createSagaNewsCandidate({
      sourceId: SOURCE_ID, provider: "gdelt_doc_2", canonicalUrl: "https://di.se/motor/kinesiska-elbilar", title: "Kinesiska elbilar pressar priser",
      summary: "Kort metadata", publishedAt: NOW.toISOString(), language: "sv", sourceDomain: "di.se", fetchedAt: NOW.toISOString(),
    });
    const result = await runDueSagaNewsSources(
      { limit: 1, workerId: "vercel-saga-news", timeBudgetMs: 10_000 },
      { now: () => NOW, newId: () => "33333333-3333-4333-8333-333333333333", reconcileSignals, dispatch: async () => ({ sourceId: SOURCE_ID, provider: "gdelt_doc_2", providerEndpoint: "https://api.gdeltproject.org/api/v2/doc/doc", fetchedAt: NOW.toISOString(), candidates: [candidate] }) },
    );

    expect(result).toMatchObject({ claimed: 1, completed: 1, failed: 0 });
    expect(reconcileSignals).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID, workspaceId: WORKSPACE_ID, role: "owner" }),
      claimedSource,
      expect.any(Object),
    );
    expect(mocks.persist.mock.invocationCallOrder[0]).toBeLessThan(reconcileSignals.mock.invocationCallOrder[0]!);
    expect(reconcileSignals.mock.invocationCallOrder[0]).toBeLessThan(mocks.complete.mock.invocationCallOrder[0]!);
  });
});
