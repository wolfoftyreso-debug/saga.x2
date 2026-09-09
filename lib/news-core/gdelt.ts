import "server-only";

import { SagaNewsCoreError } from "@/lib/news-core/errors";
import {
  normalizeGdeltPublishedAt,
  normalizedCandidate,
  normalizedSourceId,
} from "@/lib/news-core/normalization";
import {
  fetchSagaNewsText,
  type SagaNewsTextFetcher,
  type SagaNewsTextResponse,
} from "@/lib/news-core/safe-outbound";
import type { SagaNewsConnectorResult } from "@/lib/news-core/types";

const GDELT_DOC_ENDPOINT = "https://api.gdeltproject.org/api/v2/doc/doc";
const GDELT_HOSTS = ["api.gdeltproject.org"] as const;
const GDELT_MIN_REQUEST_INTERVAL_MS = 5_000;
const GDELT_MAX_RECORDS = 75;
const GDELT_TIMESPANS = ["15min", "1h", "6h", "24h", "3d", "1week", "1month", "3months"] as const;

export type SagaGdeltTimespan = (typeof GDELT_TIMESPANS)[number];

export type SagaGdeltDocQuery = Readonly<{
  sourceId: string;
  query: string;
  timespan?: SagaGdeltTimespan;
  maxRecords?: number;
}>;

export type SagaGdeltPacer = Readonly<{
  claim: (now: number) => void;
}>;

export type SagaGdeltConnectorDependencies = Readonly<{
  fetchText?: SagaNewsTextFetcher;
  now?: () => Date;
  pacer?: SagaGdeltPacer;
}>;

/**
 * A local safety valve for the official GDELT DOC endpoint. Production needs
 * a persisted lease/queue as well because Vercel can run more than one
 * instance; this connector fails closed instead of silently creating a burst.
 */
export function createSagaGdeltPacer(minimumIntervalMs = GDELT_MIN_REQUEST_INTERVAL_MS): SagaGdeltPacer {
  let previousClaimAt: number | null = null;
  return {
    claim(now) {
      if (previousClaimAt !== null && now - previousClaimAt < minimumIntervalMs) {
        const retryAfterMs = minimumIntervalMs - (now - previousClaimAt);
        throw new SagaNewsCoreError("rate_limited", `GDELT behöver pausas innan nästa förfrågan (${Math.ceil(retryAfterMs / 1_000)} s).`, 429);
      }
      previousClaimAt = now;
    },
  };
}

const sharedGdeltPacer = createSagaGdeltPacer();

/**
 * Fetches a bounded ArticleList JSON result from GDELT DOC 2.0. The only
 * configurable input is the search query; endpoint, mode, format, order and
 * response limit remain hard-coded. Article body text is not requested.
 */
export async function fetchSagaGdeltDocCandidates(
  input: SagaGdeltDocQuery,
  dependencies: SagaGdeltConnectorDependencies = {},
): Promise<SagaNewsConnectorResult> {
  const query = prepareSagaGdeltQuery(input);
  const now = dependencies.now?.() ?? new Date();
  (dependencies.pacer ?? sharedGdeltPacer).claim(now.getTime());

  const url = new URL(GDELT_DOC_ENDPOINT);
  url.searchParams.set("query", query.query);
  url.searchParams.set("mode", "artlist");
  url.searchParams.set("format", "json");
  url.searchParams.set("sort", "datedesc");
  url.searchParams.set("maxrecords", String(query.maxRecords));
  url.searchParams.set("timespan", query.timespan);

  const fetchText = dependencies.fetchText ?? fetchSagaNewsText;
  const response = await fetchText({
    url,
    policy: {
      allowedHosts: GDELT_HOSTS,
      allowQuery: true,
      acceptedContentTypes: ["application/json"],
      maxBytes: 1_000_000,
      timeoutMs: 15_000,
    },
  });
  assertGdeltJsonResponse(response);
  const payload = parseGdeltPayload(response.text);
  const fetchedAt = now.toISOString();
  const candidates = payload.articles.slice(0, query.maxRecords).flatMap((article) => {
    const candidate = normalizedCandidate({
      sourceId: query.sourceId,
      provider: "gdelt_doc_2",
      canonicalUrl: article.url,
      title: article.title,
      summary: null,
      publishedAt: normalizeGdeltPublishedAt(article.seendate),
      language: article.language,
      fetchedAt,
      raw: {
        provider_name: "GDELT DOC 2.0",
        publisher_domain: article.domain ?? null,
        source_country: article.sourcecountry ?? null,
      },
    });
    return candidate ? [candidate] : [];
  });
  return {
    sourceId: query.sourceId,
    provider: "gdelt_doc_2",
    providerEndpoint: GDELT_DOC_ENDPOINT,
    fetchedAt,
    candidates,
  };
}

export function prepareSagaGdeltQuery(input: SagaGdeltDocQuery): {
  sourceId: string;
  query: string;
  timespan: SagaGdeltTimespan;
  maxRecords: number;
} {
  const sourceId = normalizedSourceId(input.sourceId);
  const query = input.query.replace(/[\u0000-\u001F\u007F]/gu, " ").replace(/\s+/gu, " ").trim();
  if (query.length < 2 || query.length > 500) {
    throw new SagaNewsCoreError("configuration", "En GDELT-sökfråga måste vara mellan 2 och 500 tecken.", 422);
  }
  const timespan = input.timespan ?? "1week";
  if (!GDELT_TIMESPANS.includes(timespan)) {
    throw new SagaNewsCoreError("configuration", "GDELT-tidsfönstret är inte tillåtet.", 422);
  }
  const maxRecords = input.maxRecords ?? 30;
  if (!Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > GDELT_MAX_RECORDS) {
    throw new SagaNewsCoreError("configuration", `GDELT maxrecords måste vara 1–${GDELT_MAX_RECORDS}.`, 422);
  }
  return { sourceId, query, timespan, maxRecords };
}

function assertGdeltJsonResponse(response: SagaNewsTextResponse): void {
  if (response.contentType.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw new SagaNewsCoreError("provider_response", "GDELT returnerade inte JSON.", 502);
  }
}

type GdeltArticle = Readonly<{
  url: string;
  title: string;
  seendate: string | null;
  domain: string | null;
  language: string | null;
  sourcecountry: string | null;
}>;

function parseGdeltPayload(text: string): { articles: GdeltArticle[] } {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new SagaNewsCoreError("provider_response", "GDELT returnerade inte giltig JSON.", 502);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new SagaNewsCoreError("provider_response", "GDELT-svaret saknar ett giltigt artikelunderlag.", 502);
  }
  const articles = Array.isArray((payload as { articles?: unknown }).articles) ? (payload as { articles: unknown[] }).articles : [];
  return { articles: articles.flatMap(parseGdeltArticle) };
}

function parseGdeltArticle(value: unknown): GdeltArticle[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  const url = string(record.url);
  const title = string(record.title);
  if (!url || !title) return [];
  return [{
    url,
    title,
    seendate: nullableString(record.seendate),
    domain: nullableString(record.domain),
    language: nullableString(record.language),
    sourcecountry: nullableString(record.sourcecountry),
  }];
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableString(value: unknown): string | null {
  const result = string(value).trim();
  return result || null;
}
