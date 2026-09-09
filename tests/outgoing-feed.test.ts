import { describe, expect, it } from "vitest";
import {
  decodeFeedCursor,
  encodeFeedCursor,
  formatSseEvent,
  formatSseHeartbeat,
  parseFeedLimit,
  serializeRssFeed,
} from "@/lib/domain/outgoing-feed";
import { toOutgoingFeedItem } from "@/lib/services/outgoing-feed";
import type { BriefItemView, BriefView } from "@/lib/services/brief-reader";

const ITEM_ID = "11111111-1111-4111-8111-111111111111";
const BRIEF_ID = "22222222-2222-4222-8222-222222222222";

const brief: BriefView = {
  id: BRIEF_ID,
  briefDate: "2026-08-22",
  timezone: "Europe/Stockholm",
  assessment: "En verifierad förändring behöver följas upp.",
  noMaterialChanges: false,
  worldPulse: null,
  weeklyRecap: null,
  marketSnapshot: null,
  strategicRadar: null,
  watchlist: [],
  createdAt: "2026-08-22T05:00:00.000Z",
  items: [],
};

const item: BriefItemView = {
  id: ITEM_ID,
  createdAt: "2026-08-22T05:01:00.000Z",
  eventId: "33333333-3333-4333-8333-333333333333",
  eventUpdateId: "44444444-4444-4444-8444-444444444444",
  position: 1,
  title: "Nya <dataregler> & avtal",
  category: "regulation",
  status: "adopted",
  eventDate: "2026-08-22",
  whatChanged: "Regeln är antagen och omfattar fler databehandlingsflöden.",
  relevanceScore: 88,
  relevanceFactors: { personalExposure: 90, materiality: 90, actionability: 85, confirmation: 95, timeCriticality: 75 },
  whyRelevant: "Ert avtal och era dataflöden kan behöva ses över.",
  shortTermImpact: "Kontrollera berörda databehandlare före nästa förnyelse.",
  longTermImpact: "Kravet påverkar framtida produkt- och leverantörsval.",
  recommendation: "act",
  confidence: "high",
  systemicOverride: false,
  directAlert: true,
  selectedFeedback: [],
  sources: [{
    sourceName: "Myndighet & partners",
    url: "https://example.com/a?x=1&y=2",
    sourceType: "primary",
    publishedAt: "2026-08-22",
    eventDate: "2026-08-22",
    supportsClaim: "Officiellt beslut.",
  }],
};

describe("utgående integrationsflöde", () => {
  it("ger varje levererad briefpost en stabil, ogenomskinlig cursor", () => {
    const cursor = encodeFeedCursor({ kind: "item", id: ITEM_ID, publishedAt: item.createdAt });
    expect(decodeFeedCursor(cursor)).toEqual({ kind: "item", id: ITEM_ID, publishedAt: item.createdAt });
    const briefCursor = encodeFeedCursor({ kind: "brief", id: BRIEF_ID, publishedAt: brief.createdAt });
    expect(decodeFeedCursor(briefCursor)?.kind).toBe("brief");
    expect(decodeFeedCursor("inte-en-cursor")).toBeNull();
  });

  it("begränsar sidstorleken till 1–100", () => {
    expect(parseFeedLimit(null)).toBe(25);
    expect(parseFeedLimit("1")).toBe(1);
    expect(parseFeedLimit("100")).toBe(100);
    expect(parseFeedLimit("0")).toBeNull();
    expect(parseFeedLimit("101")).toBeNull();
  });

  it("bygger RSS utan att rå markup eller tokenvägar läcker in", () => {
    const feedItem = toOutgoingFeedItem(brief, item, item.createdAt);
    const xml = serializeRssFeed({
      items: [feedItem],
      channelTitle: "Eriks signaler",
      channelDescription: "Endast publicerade beslutssignaler.",
      channelUrl: "https://brief.example.com",
      selfUrl: "https://brief.example.com/api/v1/rss",
      generatedAt: "2026-08-22T05:02:00.000Z",
      itemUrl: (entry) => `https://brief.example.com/briefs/${entry.brief.id}`,
    });

    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain("Nya &lt;dataregler&gt; &amp; avtal");
    expect(xml).toContain("https://example.com/a?x=1&amp;y=2");
    expect(xml).toContain('href="https://brief.example.com/api/v1/rss"');
    expect(xml).not.toContain("token=");
    expect(xml).toContain(`<guid isPermaLink="false">${ITEM_ID}</guid>`);
  });

  it("formaterar återupptagbara SSE-poster och separata heartbeats", () => {
    const payload = { id: ITEM_ID, title: "Verifierad post" };
    expect(formatSseEvent("brief_item", payload, "cursor-123")).toBe(
      `id: cursor-123\nevent: brief_item\ndata: ${JSON.stringify(payload)}\n\n`,
    );
    expect(formatSseHeartbeat()).toBe(": heartbeat\n\n");
  });
});
