import { z } from "zod";
import type { ConfidenceLevel, EventCategory, EventStatus, Recommendation, Source } from "@/lib/domain/types";

/**
 * The public integration surface deliberately represents a delivered brief
 * item, not a row from the global event register. This preserves the same
 * editorial and per-user access boundary as the product UI.
 */
export type OutgoingFeedItem = {
  id: string;
  cursor: string;
  publishedAt: string;
  brief: {
    id: string;
    date: string;
    timezone: string;
    assessment: string;
    noMaterialChanges: boolean;
  };
  event: {
    id: string;
    title: string;
    category: EventCategory;
    status: EventStatus;
    eventDate: string | null;
  };
  whatChanged: string;
  whyRelevant: string;
  shortTermImpact: string;
  longTermImpact: string;
  recommendation: Recommendation;
  relevanceScore: number;
  confidence: ConfidenceLevel;
  systemicOverride: boolean;
  directAlert: boolean;
  sources: Source[];
};

export type OutgoingFeedPage = {
  version: "v1";
  generatedAt: string;
  items: OutgoingFeedItem[];
  nextCursor: string | null;
  hasMore: boolean;
};

export type FeedCursor = {
  kind: "item" | "brief";
  publishedAt: string;
  id: string;
};

const feedCursorSchema = z.object({
  kind: z.enum(["item", "brief"]),
  publishedAt: z.string().datetime({ offset: true }),
  id: z.string().uuid(),
});

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function encodeFeedCursor(cursor: FeedCursor): string {
  const normalized = feedCursorSchema.parse({
    id: cursor.id,
    kind: cursor.kind,
    publishedAt: new Date(cursor.publishedAt).toISOString(),
  });
  return Buffer.from(JSON.stringify(normalized), "utf8").toString("base64url");
}

export function decodeFeedCursor(value: string | null | undefined): FeedCursor | null {
  if (!value) return null;
  if (value.length > 512) return null;

  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    const parsed = feedCursorSchema.safeParse(JSON.parse(decoded));
    if (!parsed.success || Number.isNaN(new Date(parsed.data.publishedAt).getTime())) return null;
    return {
      id: parsed.data.id.toLowerCase(),
      kind: parsed.data.kind,
      publishedAt: new Date(parsed.data.publishedAt).toISOString(),
    };
  } catch {
    return null;
  }
}

export function isFeedCursor(value: string | null | undefined): boolean {
  return decodeFeedCursor(value) !== null;
}

export function parseFeedLimit(value: string | null | undefined, fallback = 25): number | null {
  if (value === null || value === undefined || value === "") return fallback;
  if (!/^(?:[1-9]|[1-9][0-9]|100)$/.test(value)) return null;
  return Number(value);
}

export function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function recommendationLabel(value: Recommendation): string {
  if (value === "act") return "Agera";
  if (value === "monitor") return "Bevaka";
  return "Ingen åtgärd";
}

/** Build a standards-compatible RSS 2.0 document without leaking the feed token in its self link. */
export function serializeRssFeed(input: {
  items: OutgoingFeedItem[];
  channelTitle: string;
  channelDescription: string;
  channelUrl: string;
  selfUrl: string;
  generatedAt: string;
  itemUrl: (item: OutgoingFeedItem) => string;
}): string {
  const buildDate = input.items.at(-1)?.publishedAt ?? input.generatedAt;
  const rssItems = input.items
    .slice()
    .reverse()
    .map((item) => {
      const description = [
        item.whatChanged,
        `Påverkar dig: ${item.whyRelevant}`,
        `Gör: ${recommendationLabel(item.recommendation)}.`,
      ].join("\n\n");
      const sourceLines = item.sources
        .map((source) => `<source url="${escapeXml(source.url)}">${escapeXml(source.sourceName)}</source>`)
        .join("");
      return [
        "<item>",
        `<title>${escapeXml(item.event.title)}</title>`,
        `<guid isPermaLink="false">${escapeXml(item.id)}</guid>`,
        `<link>${escapeXml(input.itemUrl(item))}</link>`,
        `<pubDate>${escapeXml(toRfc822(item.publishedAt))}</pubDate>`,
        `<category>${escapeXml(item.event.category)}</category>`,
        `<description>${escapeXml(description)}</description>`,
        sourceLines,
        "</item>",
      ].join("");
    })
    .join("");

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    "<channel>",
    `<title>${escapeXml(input.channelTitle)}</title>`,
    `<description>${escapeXml(input.channelDescription)}</description>`,
    `<link>${escapeXml(input.channelUrl)}</link>`,
    '<language>sv-SE</language>',
    `<lastBuildDate>${escapeXml(toRfc822(buildDate))}</lastBuildDate>`,
    `<atom:link href="${escapeXml(input.selfUrl)}" rel="self" type="application/rss+xml" />`,
    rssItems,
    "</channel>",
    "</rss>",
  ].join("");
}

export function formatSseEvent(event: string, data: unknown, id?: string): string {
  const lines = (JSON.stringify(data) ?? "null").split("\n");
  return [
    id ? `id: ${id}` : "",
    `event: ${event}`,
    ...lines.map((line) => `data: ${line}`),
    "",
    "",
  ].filter((line, index) => line !== "" || index >= 2).join("\n");
}

export function formatSseHeartbeat(): string {
  return ": heartbeat\n\n";
}

function toRfc822(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date(0).toUTCString() : date.toUTCString();
}

export function isValidFeedItemId(value: string): boolean {
  return UUID_PATTERN.test(value);
}
