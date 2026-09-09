import "server-only";

import { SagaNewsCoreError } from "@/lib/news-core/errors";
import {
  canonicalPublicArticleUrl,
  normalizeNewsText,
  normalizePublishedAt,
  normalizedCandidate,
  normalizedSourceId,
} from "@/lib/news-core/normalization";
import {
  fetchSagaNewsText,
  validateSagaNewsOutboundUrl,
  type SagaNewsTextFetcher,
  type SagaNewsTextResponse,
} from "@/lib/news-core/safe-outbound";
import type { SagaNewsCandidate, SagaNewsConnectorResult } from "@/lib/news-core/types";

const RSS_ATOM_CONTENT_TYPES = [
  "application/atom+xml",
  "application/rss+xml",
  "application/xml",
  "text/xml",
] as const;

const MAX_RSS_ATOM_ITEMS = 75;

export type SagaRssAtomSourceConfig = Readonly<{
  sourceId: string;
  name: string;
  /** Final, public HTTPS feed URL. Query parameters and redirectors are rejected. */
  feedUrl: string;
  /** Server-owned exact domain or parent domain allowlist. */
  allowedHosts: readonly string[];
  language?: string | null;
  kind?: "official" | "editorial";
  maxItems?: number;
}>;

export type SagaRssAtomConnectorDependencies = Readonly<{
  fetchText?: SagaNewsTextFetcher;
  now?: () => Date;
}>;

/**
 * Reads RSS 2.0/RDF or Atom using only a public configured feed. It extracts
 * title, link, date and a bounded description/summary — never content:encoded
 * or an article body — then returns persistence-independent candidates.
 */
export async function fetchSagaRssAtomCandidates(
  config: SagaRssAtomSourceConfig,
  dependencies: SagaRssAtomConnectorDependencies = {},
): Promise<SagaNewsConnectorResult> {
  const prepared = prepareSagaRssAtomSource(config);
  const fetchedAt = (dependencies.now?.() ?? new Date()).toISOString();
  const fetchText = dependencies.fetchText ?? fetchSagaNewsText;
  const response = await fetchText({
    url: prepared.feedUrl,
    policy: {
      allowedHosts: prepared.allowedHosts,
      acceptedContentTypes: RSS_ATOM_CONTENT_TYPES,
      maxBytes: 1_000_000,
      timeoutMs: 15_000,
    },
  });
  assertXmlResponse(response);
  const candidates = parseSagaRssAtomFeed(response.text, {
    sourceId: prepared.sourceId,
    language: prepared.language,
    kind: prepared.kind,
    sourceName: prepared.name,
    maxItems: prepared.maxItems,
    fetchedAt,
  });
  return {
    sourceId: prepared.sourceId,
    provider: "rss_atom",
    providerEndpoint: publicEndpoint(prepared.feedUrl),
    fetchedAt,
    candidates,
  };
}

export function prepareSagaRssAtomSource(config: SagaRssAtomSourceConfig): {
  sourceId: string;
  name: string;
  feedUrl: URL;
  allowedHosts: string[];
  language: string | null;
  kind: "official" | "editorial";
  maxItems: number;
} {
  const sourceId = normalizedSourceId(config.sourceId);
  const name = normalizeNewsText(config.name, 240);
  if (!name) throw new SagaNewsCoreError("configuration", "En RSS- eller Atom-källa behöver ett namn.", 422);
  let feedUrl: URL;
  try {
    feedUrl = new URL(config.feedUrl.trim());
  } catch {
    throw new SagaNewsCoreError("configuration", "RSS- eller Atom-adressen är ogiltig.", 422);
  }
  if (feedUrl.search || feedUrl.hash || feedUrl.username || feedUrl.password) {
    throw new SagaNewsCoreError("configuration", "RSS- och Atom-adresser får inte innehålla query-parametrar, ankare eller inloggningsuppgifter.", 422);
  }
  const allowedHosts = config.allowedHosts.map((host) => host.trim().toLowerCase()).filter(Boolean);
  if (!allowedHosts.length) throw new SagaNewsCoreError("configuration", "RSS- och Atom-källor behöver en serverägd godkänd värdlista.", 422);
  const validatedFeedUrl = validateSagaNewsOutboundUrl(feedUrl, {
    allowedHosts,
    acceptedContentTypes: RSS_ATOM_CONTENT_TYPES,
  });
  const language = config.language?.trim().toLowerCase() || null;
  if (language && !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/u.test(language)) {
    throw new SagaNewsCoreError("configuration", "Källans språk måste vara en kort språk-tag, till exempel sv eller en-gb.", 422);
  }
  return {
    sourceId,
    name,
    feedUrl: validatedFeedUrl,
    allowedHosts,
    language,
    kind: config.kind === "editorial" ? "editorial" : "official",
    maxItems: boundedItemLimit(config.maxItems),
  };
}

export function parseSagaRssAtomFeed(
  xml: string,
  context: {
    sourceId: string;
    sourceName: string;
    language: string | null;
    kind: "official" | "editorial";
    maxItems: number;
    fetchedAt: string;
  },
): SagaNewsCandidate[] {
  const format = feedFormat(xml);
  if (!format) throw new SagaNewsCoreError("provider_response", "Källan returnerade inte ett giltigt RSS- eller Atom-flöde.", 502);
  const entryName = format === "atom" ? "entry" : "item";
  const entries = xmlBlocks(xml, entryName).slice(0, context.maxItems);
  return entries.flatMap((entry) => {
    const title = xmlFieldText(entry, "title") ?? "";
    const link = format === "atom" ? atomLink(entry) : rssLink(entry);
    const canonicalUrl = link ? canonicalPublicArticleUrl(link) : null;
    if (!title || !canonicalUrl) return [];
    // Feed summaries can be useful context. `content:encoded` is intentionally
    // never read, because News Core must not ingest full article bodies.
    const summary = xmlFieldText(entry, format === "atom" ? "summary" : "description");
    const publishedAt = normalizePublishedAt(
      xmlFieldText(entry, format === "atom" ? "published" : "pubDate")
      ?? xmlFieldText(entry, format === "atom" ? "updated" : "date"),
    );
    const candidate = normalizedCandidate({
      sourceId: context.sourceId,
      provider: "rss_atom",
      canonicalUrl,
      title,
      summary,
      publishedAt,
      language: context.language,
      fetchedAt: context.fetchedAt,
      raw: {
        source_name: context.sourceName,
        source_kind: context.kind,
        feed_format: format,
      },
    });
    return candidate ? [candidate] : [];
  });
}

function assertXmlResponse(response: SagaNewsTextResponse): void {
  if (!RSS_ATOM_CONTENT_TYPES.includes(response.contentType.split(";", 1)[0]?.trim().toLowerCase() as typeof RSS_ATOM_CONTENT_TYPES[number])) {
    throw new SagaNewsCoreError("provider_response", "RSS- eller Atom-källan returnerade inte XML.", 502);
  }
}

function feedFormat(xml: string): "rss" | "atom" | null {
  const start = xml.slice(0, 8_000);
  if (/<(?:[a-z][\w.-]*:)?feed\b/iu.test(start)) return "atom";
  if (/<(?:[a-z][\w.-]*:)?rss\b|<rdf:rdf\b/iu.test(start)) return "rss";
  return null;
}

function xmlBlocks(xml: string, tagName: string): string[] {
  const escaped = escapeRegExp(tagName);
  const expression = new RegExp(`<(?:(?:[a-z][\\w.-]*):)?${escaped}\\b[^>]*>([\\s\\S]*?)<\\/(?:(?:[a-z][\\w.-]*):)?${escaped}\\s*>`, "giu");
  return [...xml.matchAll(expression)].map((match) => match[1] ?? "");
}

function xmlFieldText(xml: string, tagName: string): string | null {
  const block = xmlBlocks(xml, tagName)[0];
  return block === undefined ? null : block;
}

function rssLink(entry: string): string | null {
  return xmlFieldText(entry, "link") ?? xmlFieldText(entry, "guid");
}

function atomLink(entry: string): string | null {
  const links = [...entry.matchAll(/<(?:[a-z][\w.-]*:)?link\b([^>]*?)(?:\/>|>[\s\S]*?<\/(?:[a-z][\w.-]*:)?link\s*>)/giu)];
  const candidates = links.map((match) => {
    const attributes = match[1] ?? "";
    return { href: xmlAttribute(attributes, "href"), rel: xmlAttribute(attributes, "rel") };
  }).filter((link): link is { href: string; rel: string | null } => Boolean(link.href));
  return candidates.find((link) => !link.rel || link.rel.toLowerCase() === "alternate")?.href ?? null;
}

function xmlAttribute(attributes: string, name: string): string | null {
  const expression = new RegExp(`\\b${escapeRegExp(name)}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "iu");
  const match = attributes.match(expression);
  return match?.[2] ?? null;
}

function boundedItemLimit(value: number | undefined): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_RSS_ATOM_ITEMS
    ? value
    : 30;
}

function publicEndpoint(url: URL): string {
  const copy = new URL(url.toString());
  copy.search = "";
  copy.hash = "";
  return copy.toString();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
