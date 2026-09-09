import { describe, expect, it } from "vitest";
import type { SagaNewsSource, SagaNewsSourceItem } from "@/lib/domain/saga-news-core";
import {
  candidateGroupsForSagaNewsItems,
  sagaNewsConnectorConfigForSource,
} from "@/lib/services/saga-news-runner";

const SOURCE_A = "11111111-1111-4111-8111-111111111111";
const SOURCE_B = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-08-24T12:00:00.000Z");

function source(overrides: Partial<SagaNewsSource> = {}): SagaNewsSource {
  return {
    id: SOURCE_A,
    createdByUserId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    updatedByUserId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    slug: "global-ev",
    name: "Global elbilsbevakning",
    sourceKind: "public_api",
    connectorKey: "gdelt_doc_2",
    endpointUrl: "https://api.gdeltproject.org/api/v2/doc/doc",
    publisherAllowlist: ["svd.se", "di.se"],
    publisherBlocklist: [],
    allowlistMode: "strict",
    topics: ["kinesiska elbilar", "elbil"],
    languages: ["sv"],
    countries: ["SE"],
    trustLevel: 4,
    sourceWeight: 80,
    minimumIntervalMinutes: 60,
    maxItemsPerRun: 60,
    maxItemTextChars: 30_000,
    sourcePolicy: { requireCanonicalUrl: true, requirePublishedAt: false, minimumPublisherCredibility: 3, retainFullText: false, additionalRules: {} },
    isAllowed: true,
    active: true,
    lastIngestionAt: null,
    lastSuccessfulIngestionAt: null,
    lastFailureAt: null,
    lastFailureCode: null,
    nextIngestionAt: NOW.toISOString(),
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

function item(overrides: Partial<SagaNewsSourceItem> = {}): SagaNewsSourceItem {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    sourceId: SOURCE_A,
    firstIngestionRunId: "44444444-4444-4444-8444-444444444444",
    lastIngestionRunId: "44444444-4444-4444-8444-444444444444",
    canonicalUrl: "https://svd.se/ekonomi/elbilar",
    title: "Kinesiska elbilar pressar svenska priser",
    summary: "",
    publisherName: "svd.se",
    publisherDomain: "svd.se",
    authors: [],
    language: "sv",
    publishedAt: "2026-08-24T10:00:00.000Z",
    discoveredAt: "2026-08-24T10:01:00.000Z",
    firstSeenAt: "2026-08-24T10:01:00.000Z",
    lastSeenAt: "2026-08-24T10:01:00.000Z",
    provenance: {},
    contentFingerprint: "a".repeat(64),
    storyFingerprint: "b".repeat(64),
    createdAt: "2026-08-24T10:01:00.000Z",
    updatedAt: "2026-08-24T10:01:00.000Z",
    ...overrides,
  };
}

describe("SAGA News runner", () => {
  it("maps GDELT to its server-owned endpoint and a bounded query", () => {
    const config = sagaNewsConnectorConfigForSource(source());
    expect(config).toMatchObject({
      connectorKey: "gdelt_doc_2",
      input: {
        sourceId: SOURCE_A,
        query: "kinesiska elbilar OR elbil",
        timespan: "1h",
        maxRecords: 60,
      },
    });
  });

  it("does not create a signal until two independent publishers overlap on substantive terms", () => {
    const onePublisher = candidateGroupsForSagaNewsItems([item()], SOURCE_A, NOW);
    expect(onePublisher).toEqual([]);

    const second = item({
      id: "55555555-5555-4555-8555-555555555555",
      sourceId: SOURCE_B,
      canonicalUrl: "https://di.se/motor/kinesiska-elbilar-priser",
      title: "Svenska priser pressas av kinesiska elbilar",
      publisherName: "di.se",
      publisherDomain: "di.se",
      contentFingerprint: "c".repeat(64),
      storyFingerprint: "d".repeat(64),
    });
    const groups = candidateGroupsForSagaNewsItems([item(), second], SOURCE_A, NOW);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ publisherDomain: "svd.se" }), expect.objectContaining({ publisherDomain: "di.se" })]) });
    expect(groups[0]?.tokens).toEqual(expect.arrayContaining(["kinesiska", "elbilar", "priser"]));
  });
});
