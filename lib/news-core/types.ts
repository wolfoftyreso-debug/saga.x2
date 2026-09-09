import "server-only";

import { createHash } from "node:crypto";

/**
 * This is deliberately a connector boundary, not a database row. A future
 * Neon repository can accept this shape without teaching a connector about
 * workspace tables, source leases, or publication state.
 */
export const SAGA_NEWS_PROVIDERS = ["rss_atom", "gdelt_doc_2", "guardian_open_platform"] as const;

export type SagaNewsProvider = (typeof SAGA_NEWS_PROVIDERS)[number];

/** Stable keys a source repository can persist alongside a source record. */
export const SAGA_NEWS_CONNECTOR_KEY: Record<SagaNewsProvider, SagaNewsProvider> = {
  rss_atom: "rss_atom",
  gdelt_doc_2: "gdelt_doc_2",
  guardian_open_platform: "guardian_open_platform",
};

export type SagaNewsSourceKind = "rss" | "api";

export function sagaNewsSourceKindForProvider(provider: SagaNewsProvider): SagaNewsSourceKind {
  return provider === "rss_atom" ? "rss" : "api";
}

export type SagaNewsScalar = string | number | boolean | null;

/**
 * Small, serialisable provider facts only. It must never contain a fetched
 * document body, API key, signed URL, request URL, or arbitrary nested JSON.
 */
export type SagaNewsRawMetadata = Readonly<Record<string, SagaNewsScalar>>;

export type SagaNewsCandidate = Readonly<{
  /** Server-owned source configuration identity; never a workspace id. */
  sourceId: string;
  provider: SagaNewsProvider;
  /** Query-free public article URL, suitable as an evidence link. */
  canonicalUrl: string;
  title: string;
  /** Short, text-normalised feed excerpt. Full article bodies are never returned. */
  summary: string | null;
  publishedAt: string | null;
  language: string | null;
  sourceDomain: string;
  contentHash: string;
  raw: SagaNewsRawMetadata;
  fetchedAt: string;
}>;

export type SagaNewsConnectorResult = Readonly<{
  sourceId: string;
  provider: SagaNewsProvider;
  /** Safe provider endpoint without search parameters or credentials. */
  providerEndpoint: string;
  fetchedAt: string;
  candidates: readonly SagaNewsCandidate[];
}>;

/**
 * Exact hand-off type for the future News Core repository. It mirrors the
 * durable facts a schema adapter needs, while keeping connector code free of
 * Neon, tenancy and persistence concerns.
 */
export type SagaNewsPersistenceInput = Pick<
  SagaNewsCandidate,
  | "sourceId"
  | "provider"
  | "canonicalUrl"
  | "title"
  | "summary"
  | "publishedAt"
  | "language"
  | "sourceDomain"
  | "contentHash"
  | "raw"
  | "fetchedAt"
>;

export type SagaNewsIngestionBatch = Readonly<{
  /** UUID/opaque source record id owned by the source repository. */
  sourceId: string;
  connectorKey: SagaNewsProvider;
  sourceKind: SagaNewsSourceKind;
  fetchedAt: string;
  candidates: readonly SagaNewsPersistenceInput[];
}>;

export function toSagaNewsPersistenceInput(candidate: SagaNewsCandidate): SagaNewsPersistenceInput {
  return {
    sourceId: candidate.sourceId,
    provider: candidate.provider,
    canonicalUrl: candidate.canonicalUrl,
    title: candidate.title,
    summary: candidate.summary,
    publishedAt: candidate.publishedAt,
    language: candidate.language,
    sourceDomain: candidate.sourceDomain,
    contentHash: candidate.contentHash,
    raw: candidate.raw,
    fetchedAt: candidate.fetchedAt,
  };
}

/** Exact adapter input for `ingestSagaNewsBatch(...)` in the future Neon layer. */
export function toSagaNewsIngestionBatch(result: SagaNewsConnectorResult): SagaNewsIngestionBatch {
  return {
    sourceId: result.sourceId,
    connectorKey: SAGA_NEWS_CONNECTOR_KEY[result.provider],
    sourceKind: sagaNewsSourceKindForProvider(result.provider),
    fetchedAt: result.fetchedAt,
    candidates: result.candidates.map(toSagaNewsPersistenceInput),
  };
}

export type SagaNewsCandidateSeed = Readonly<{
  sourceId: string;
  provider: SagaNewsProvider;
  canonicalUrl: string;
  title: string;
  summary?: string | null;
  publishedAt?: string | null;
  language?: string | null;
  sourceDomain: string;
  raw?: SagaNewsRawMetadata;
  fetchedAt: string;
}>;

export function candidateContentHash(seed: Pick<SagaNewsCandidateSeed, "provider" | "canonicalUrl" | "title" | "summary" | "publishedAt">): string {
  return createHash("sha256")
    .update([seed.provider, seed.canonicalUrl, seed.title, seed.summary ?? "", seed.publishedAt ?? ""].join("\n"), "utf8")
    .digest("hex");
}

export function createSagaNewsCandidate(seed: SagaNewsCandidateSeed): SagaNewsCandidate {
  const candidate: SagaNewsCandidate = {
    sourceId: seed.sourceId,
    provider: seed.provider,
    canonicalUrl: seed.canonicalUrl,
    title: seed.title,
    summary: seed.summary ?? null,
    publishedAt: seed.publishedAt ?? null,
    language: seed.language ?? null,
    sourceDomain: seed.sourceDomain,
    contentHash: candidateContentHash(seed),
    raw: seed.raw ?? {},
    fetchedAt: seed.fetchedAt,
  };
  return candidate;
}
