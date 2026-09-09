import "server-only";

import { isIP } from "node:net";
import { SagaNewsCoreError } from "@/lib/news-core/errors";
import { createSagaNewsCandidate, type SagaNewsCandidate, type SagaNewsCandidateSeed, type SagaNewsRawMetadata } from "@/lib/news-core/types";

const MAX_TITLE_LENGTH = 500;
const MAX_SUMMARY_LENGTH = 1_200;
const MAX_METADATA_ENTRIES = 20;
const MAX_METADATA_STRING_LENGTH = 500;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
};

export function normalizedSourceId(value: string): string {
  const sourceId = value.trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(sourceId)) {
    throw new SagaNewsCoreError("configuration", "sourceId måste vara ett serverägt, ogenomskinligt id med 1–80 säkra tecken.", 422);
  }
  return sourceId;
}

/** Feed and HTML text are converted to plain bounded text before leaving the connector. */
export function normalizeNewsText(value: string, maximumLength: number): string {
  const withoutCdata = value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/giu, "$1");
  const withoutDangerousBlocks = withoutCdata
    .replace(/<(?:script|style|noscript)\b[^>]*>[\s\S]*?<\/(?:script|style|noscript)\s*>/giu, " ")
    .replace(/<[^>]+>/gu, " ");
  const decoded = decodeXmlEntities(withoutDangerousBlocks)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return decoded.slice(0, maximumLength).trim();
}

export function normalizeNewsTitle(value: string): string {
  return normalizeNewsText(value, MAX_TITLE_LENGTH);
}

export function normalizeNewsSummary(value: string | null | undefined): string | null {
  if (!value) return null;
  const summary = normalizeNewsText(value, MAX_SUMMARY_LENGTH);
  return summary || null;
}

/**
 * A candidate link is evidence only. Removing every query parameter prevents
 * feed-supplied tracker or token values from reaching the browser, storage or
 * an AI prompt.
 */
export function canonicalPublicArticleUrl(value: string): string | null {
  try {
    const url = new URL(decodeXmlEntities(value.trim()));
    const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
    if (url.protocol !== "https:" || !hostname || url.username || url.password || isIP(hostname)) return null;
    if (hostname === "localhost" || hostname.endsWith(".localhost")) return null;
    url.protocol = "https:";
    url.hostname = hostname;
    url.port = "";
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function sourceDomainFromCanonicalUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname ? url.hostname.toLowerCase().replace(/^www\./u, "") : null;
  } catch {
    return null;
  }
}

export function normalizePublishedAt(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** GDELT commonly returns a compact UTC timestamp such as 20260824T103000Z. */
export function normalizeGdeltPublishedAt(value: string | null | undefined): string | null {
  if (!value) return null;
  const compact = value.trim().match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/u);
  if (compact) {
    const [, year, month, day, hour, minute, second] = compact;
    return normalizePublishedAt(`${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`);
  }
  return normalizePublishedAt(value);
}

export function boundedRawMetadata(value: Record<string, unknown>): SagaNewsRawMetadata {
  const result: Record<string, string | number | boolean | null> = {};
  for (const [key, candidate] of Object.entries(value)) {
    if (Object.keys(result).length >= MAX_METADATA_ENTRIES) break;
    if (!/^[a-z][a-z0-9_]{0,63}$/u.test(key)) continue;
    if (typeof candidate === "string") result[key] = normalizeNewsText(candidate, MAX_METADATA_STRING_LENGTH);
    else if (typeof candidate === "number" && Number.isFinite(candidate)) result[key] = candidate;
    else if (typeof candidate === "boolean" || candidate === null) result[key] = candidate;
  }
  return result;
}

export function normalizedCandidate(seed: Omit<SagaNewsCandidateSeed, "canonicalUrl" | "title" | "summary" | "sourceDomain" | "raw"> & {
  canonicalUrl: string;
  title: string;
  summary?: string | null;
  raw?: Record<string, unknown>;
}): SagaNewsCandidate | null {
  const sourceId = normalizedSourceId(seed.sourceId);
  const canonicalUrl = canonicalPublicArticleUrl(seed.canonicalUrl);
  const title = normalizeNewsTitle(seed.title);
  const sourceDomain = canonicalUrl ? sourceDomainFromCanonicalUrl(canonicalUrl) : null;
  if (!canonicalUrl || !sourceDomain || !title) return null;
  return createSagaNewsCandidate({
    sourceId,
    provider: seed.provider,
    canonicalUrl,
    title,
    summary: normalizeNewsSummary(seed.summary),
    publishedAt: normalizePublishedAt(seed.publishedAt),
    language: normalizedLanguage(seed.language),
    sourceDomain,
    raw: boundedRawMetadata(seed.raw ?? {}),
    fetchedAt: normalizePublishedAt(seed.fetchedAt) ?? new Date().toISOString(),
  });
}

function normalizedLanguage(value: string | null | undefined): string | null {
  if (!value) return null;
  const language = value.trim().toLowerCase();
  return /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/u.test(language) ? language : null;
}

function decodeXmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/giu, (entity, code: string) => {
    const lower = code.toLowerCase();
    if (lower in NAMED_ENTITIES) return NAMED_ENTITIES[lower];
    const numeric = lower.startsWith("#x") ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
    if (!Number.isInteger(numeric) || numeric <= 0 || numeric > 0x10ffff || (numeric >= 0xd800 && numeric <= 0xdfff)) return " ";
    return String.fromCodePoint(numeric);
  });
}
