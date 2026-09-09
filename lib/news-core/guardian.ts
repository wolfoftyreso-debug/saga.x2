import "server-only";

import { SagaNewsCoreError } from "@/lib/news-core/errors";
import { normalizePublishedAt, normalizedCandidate, normalizedSourceId } from "@/lib/news-core/normalization";
import { fetchSagaNewsText, type SagaNewsTextFetcher, type SagaNewsTextResponse } from "@/lib/news-core/safe-outbound";
import type { SagaNewsConnectorResult } from "@/lib/news-core/types";

const GUARDIAN_SEARCH_ENDPOINT = "https://content.guardianapis.com/search";
const GUARDIAN_HOSTS = ["content.guardianapis.com"] as const;
const GUARDIAN_MAX_PAGE_SIZE = 50;

export type SagaGuardianOpenPlatformQuery = Readonly<{
  sourceId: string;
  query: string;
  section?: string;
  fromDate?: string;
  toDate?: string;
  pageSize?: number;
}>;

export type SagaGuardianConnectorDependencies = Readonly<{
  /** Server-only override for tests. Production reads GUARDIAN_OPEN_PLATFORM_API_KEY. */
  apiKey?: string | null;
  fetchText?: SagaNewsTextFetcher;
  now?: () => Date;
}>;

/**
 * Uses Guardian's search endpoint as metadata-only discovery. The connector
 * requests no article body, trail text, image or other fields and never hands
 * Guardian text to an AI model. Commercial/AI rights must be established by
 * the deployment owner before this source is enabled in a production recipe.
 */
export async function fetchSagaGuardianOpenPlatformCandidates(
  input: SagaGuardianOpenPlatformQuery,
  dependencies: SagaGuardianConnectorDependencies = {},
): Promise<SagaNewsConnectorResult> {
  const query = prepareSagaGuardianQuery(input);
  const apiKey = guardianApiKey(dependencies.apiKey);
  const url = new URL(GUARDIAN_SEARCH_ENDPOINT);
  url.searchParams.set("q", query.query);
  url.searchParams.set("order-by", "newest");
  url.searchParams.set("page-size", String(query.pageSize));
  url.searchParams.set("format", "json");
  if (query.section) url.searchParams.set("section", query.section);
  if (query.fromDate) url.searchParams.set("from-date", query.fromDate);
  if (query.toDate) url.searchParams.set("to-date", query.toDate);
  // Guardian documents api-key as a query parameter. It is added only inside
  // this server-only function, never accepted from source config, returned,
  // persisted, logged, or copied into candidate metadata.
  url.searchParams.set("api-key", apiKey);

  const now = dependencies.now?.() ?? new Date();
  const fetchText = dependencies.fetchText ?? fetchSagaNewsText;
  const response = await fetchText({
    url,
    policy: {
      allowedHosts: GUARDIAN_HOSTS,
      allowQuery: true,
      acceptedContentTypes: ["application/json"],
      maxBytes: 1_000_000,
      timeoutMs: 15_000,
    },
  });
  assertGuardianJsonResponse(response);
  const payload = parseGuardianPayload(response.text);
  const fetchedAt = now.toISOString();
  const candidates = payload.results.slice(0, query.pageSize).flatMap((result) => {
    const candidate = normalizedCandidate({
      sourceId: query.sourceId,
      provider: "guardian_open_platform",
      canonicalUrl: result.webUrl,
      title: result.webTitle,
      summary: null,
      publishedAt: normalizePublishedAt(result.webPublicationDate),
      language: null,
      fetchedAt,
      raw: {
        provider_name: "Guardian Open Platform",
        guardian_id: result.id,
        section_id: result.sectionId,
        section_name: result.sectionName,
        content_type: result.type,
      },
    });
    return candidate ? [candidate] : [];
  });
  return {
    sourceId: query.sourceId,
    provider: "guardian_open_platform",
    providerEndpoint: GUARDIAN_SEARCH_ENDPOINT,
    fetchedAt,
    candidates,
  };
}

export function prepareSagaGuardianQuery(input: SagaGuardianOpenPlatformQuery): {
  sourceId: string;
  query: string;
  section: string | null;
  fromDate: string | null;
  toDate: string | null;
  pageSize: number;
} {
  const sourceId = normalizedSourceId(input.sourceId);
  const query = input.query.replace(/[\u0000-\u001F\u007F]/gu, " ").replace(/\s+/gu, " ").trim();
  if (query.length < 2 || query.length > 300) {
    throw new SagaNewsCoreError("configuration", "En Guardian-sökfråga måste vara mellan 2 och 300 tecken.", 422);
  }
  const section = input.section?.trim().toLowerCase() || null;
  if (section && !/^[a-z0-9][a-z0-9_-]{0,79}$/u.test(section)) {
    throw new SagaNewsCoreError("configuration", "Guardian-sektionen är ogiltig.", 422);
  }
  const fromDate = boundedGuardianDate(input.fromDate);
  const toDate = boundedGuardianDate(input.toDate);
  if (fromDate && toDate && fromDate > toDate) {
    throw new SagaNewsCoreError("configuration", "Guardian från-datum får inte vara efter till-datum.", 422);
  }
  const pageSize = input.pageSize === undefined ? 20 : input.pageSize;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > GUARDIAN_MAX_PAGE_SIZE) {
    throw new SagaNewsCoreError("configuration", `Guardian sidstorlek måste vara 1–${GUARDIAN_MAX_PAGE_SIZE}.`, 422);
  }
  return { sourceId, query, section, fromDate, toDate, pageSize };
}

function guardianApiKey(override: string | null | undefined): string {
  const key = (override ?? process.env.GUARDIAN_OPEN_PLATFORM_API_KEY ?? "").trim();
  if (!key) {
    throw new SagaNewsCoreError("configuration", "GUARDIAN_OPEN_PLATFORM_API_KEY saknas. Guardian-källan är inte aktiverad.", 503);
  }
  if (key.length > 512 || /[\r\n\u0000]/u.test(key)) {
    throw new SagaNewsCoreError("configuration", "Guardian-nyckeln har ett ogiltigt format.", 503);
  }
  return key;
}

function boundedGuardianDate(value: string | undefined): string | null {
  if (!value) return null;
  const date = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date) || Number.isNaN(new Date(`${date}T00:00:00.000Z`).getTime())) {
    throw new SagaNewsCoreError("configuration", "Guardian-datum måste ha formatet ÅÅÅÅ-MM-DD.", 422);
  }
  return date;
}

function assertGuardianJsonResponse(response: SagaNewsTextResponse): void {
  if (response.contentType.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw new SagaNewsCoreError("provider_response", "Guardian returnerade inte JSON.", 502);
  }
}

type GuardianResult = Readonly<{
  id: string | null;
  type: string | null;
  sectionId: string | null;
  sectionName: string | null;
  webPublicationDate: string | null;
  webTitle: string;
  webUrl: string;
}>;

function parseGuardianPayload(text: string): { results: GuardianResult[] } {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new SagaNewsCoreError("provider_response", "Guardian returnerade inte giltig JSON.", 502);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new SagaNewsCoreError("provider_response", "Guardian-svaret saknar ett giltigt artikelunderlag.", 502);
  }
  const response = (payload as { response?: unknown }).response;
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new SagaNewsCoreError("provider_response", "Guardian-svaret saknar resultatdelen.", 502);
  }
  const results = Array.isArray((response as { results?: unknown }).results) ? (response as { results: unknown[] }).results : [];
  return { results: results.flatMap(parseGuardianResult) };
}

function parseGuardianResult(value: unknown): GuardianResult[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  const webTitle = string(record.webTitle);
  const webUrl = string(record.webUrl);
  if (!webTitle || !webUrl) return [];
  return [{
    id: nullableString(record.id),
    type: nullableString(record.type),
    sectionId: nullableString(record.sectionId),
    sectionName: nullableString(record.sectionName),
    webPublicationDate: nullableString(record.webPublicationDate),
    webTitle,
    webUrl,
  }];
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableString(value: unknown): string | null {
  const result = string(value).trim();
  return result || null;
}
