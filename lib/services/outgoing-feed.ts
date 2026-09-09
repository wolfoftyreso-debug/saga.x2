import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  encodeFeedCursor,
  type FeedCursor,
  type OutgoingFeedItem,
  type OutgoingFeedPage,
} from "@/lib/domain/outgoing-feed";
import { getBriefForUser, type BriefItemView, type BriefView } from "@/lib/services/brief-reader";
import { createAdminClient } from "@/lib/supabase/admin";

type DatabaseClient = SupabaseClient;
type RawRecord = Record<string, unknown>;

type FeedIndexRow = {
  id: string;
  brief_id: string;
  created_at: string;
};

export type ReadOutgoingFeedInput = {
  userId: string;
  after: FeedCursor | null;
  limit: number;
  /** A fresh client gets the current window. A cursor always means forward-only delivery. */
  initialWindow?: boolean;
  /** SSE polls do not need a second query for the current high-water mark. */
  includeLatestCursor?: boolean;
  database?: DatabaseClient;
  now?: Date;
};

export type OutgoingFeedRead = OutgoingFeedPage & {
  latestCursor: string | null;
};

export type OutgoingBrief = {
  id: string;
  cursor: string;
  publishedAt: string;
  briefDate: string;
  timezone: string;
  assessment: string;
  noMaterialChanges: boolean;
  watchlist: BriefView["watchlist"];
  worldPulse: BriefView["worldPulse"];
  weeklyRecap: BriefView["weeklyRecap"];
  marketSnapshot: BriefView["marketSnapshot"];
  strategicRadar: BriefView["strategicRadar"];
  items: OutgoingFeedItem[];
};

export type OutgoingBriefRead = {
  version: "v1";
  generatedAt: string;
  briefs: OutgoingBrief[];
  nextCursor: string | null;
  hasMore: boolean;
};

/**
 * Read only items that already passed the normal editor and were published in
 * a completed brief for this user. It deliberately cannot list registry events,
 * discovery candidates, pending alerts, or sources outside the UI policy.
 */
export async function readOutgoingFeed(input: ReadOutgoingFeedInput): Promise<OutgoingFeedRead> {
  if (input.after?.kind === "brief") throw new Error("En brief-cursor kan inte användas för poster.");
  const database = input.database ?? createAdminClient();
  const fetchLimit = input.after ? input.limit + 1 : input.limit;
  const indexRows = await readFeedIndex({
    database,
    userId: input.userId,
    after: input.after,
    limit: fetchLimit,
    ascending: Boolean(input.after),
  });
  const hasMore = Boolean(input.after && indexRows.length > input.limit);
  const pageRows = hasMore ? indexRows.slice(0, input.limit) : indexRows;
  const chronologicalRows = input.after || !input.initialWindow
    ? pageRows
    : pageRows.slice().reverse();
  const items = await hydrateFeedItems(database, input.userId, chronologicalRows);
  const lastRow = chronologicalRows.at(-1);
  const nextCursor = lastRow
    ? encodeFeedCursor({ kind: "item", id: lastRow.id, publishedAt: lastRow.created_at })
    : (input.after ? encodeFeedCursor(input.after) : null);
  const latestCursor = input.includeLatestCursor === false
    ? null
    : await getLatestOutgoingFeedCursor({ database, userId: input.userId });

  return {
    version: "v1",
    generatedAt: (input.now ?? new Date()).toISOString(),
    items,
    nextCursor,
    hasMore,
    latestCursor,
  };
}

/** Cursor used by a newly connected SSE client to avoid replaying old brief items. */
export async function getLatestOutgoingFeedCursor(input: { userId: string; database?: DatabaseClient }): Promise<string | null> {
  const database = input.database ?? createAdminClient();
  const rows = await readFeedIndex({
    database,
    userId: input.userId,
    after: null,
    limit: 1,
    ascending: false,
  });
  const row = rows[0];
  return row ? encodeFeedCursor({ kind: "item", id: row.id, publishedAt: row.created_at }) : null;
}

/**
 * A complete, policy-filtered brief archive for API consumers. The endpoint
 * remains separate from the flat feed: a caller explicitly asks for whole
 * issued briefs instead of being handed the global registry.
 */
export async function readOutgoingBriefs(input: ReadOutgoingFeedInput): Promise<OutgoingBriefRead> {
  if (input.after?.kind === "item") throw new Error("En post-cursor kan inte användas för briefar.");
  const database = input.database ?? createAdminClient();
  const fetchLimit = input.after ? input.limit + 1 : input.limit;
  const indexRows = await readBriefIndex({
    database,
    userId: input.userId,
    after: input.after,
    limit: fetchLimit,
    ascending: Boolean(input.after),
  });
  const hasMore = Boolean(input.after && indexRows.length > input.limit);
  const pageRows = hasMore ? indexRows.slice(0, input.limit) : indexRows;
  const chronologicalRows = input.after || !input.initialWindow
    ? pageRows
    : pageRows.slice().reverse();
  const briefs = await Promise.all(chronologicalRows.map(async (row) => {
    const brief = await getBriefForUser(database, input.userId, row.id);
    return brief ? toOutgoingBrief(brief, row.created_at) : null;
  }));
  const safeBriefs = briefs.filter((brief): brief is OutgoingBrief => Boolean(brief));
  const lastRow = chronologicalRows.at(-1);
  const nextCursor = lastRow
    ? encodeFeedCursor({ kind: "brief", id: lastRow.id, publishedAt: lastRow.created_at })
    : (input.after ? encodeFeedCursor(input.after) : null);

  return {
    version: "v1",
    generatedAt: (input.now ?? new Date()).toISOString(),
    briefs: safeBriefs,
    nextCursor,
    hasMore,
  };
}

async function readFeedIndex(input: {
  database: DatabaseClient;
  userId: string;
  after: FeedCursor | null;
  limit: number;
  ascending: boolean;
}): Promise<FeedIndexRow[]> {
  let query = input.database
    .from("brief_items")
    .select("id, brief_id, created_at, briefs!inner(user_id, state)")
    .eq("briefs.user_id", input.userId)
    .eq("briefs.state", "complete")
    .order("created_at", { ascending: input.ascending })
    .order("id", { ascending: input.ascending })
    .limit(input.limit);

  if (input.after) {
    // Both cursor properties are validated before this service is called. The
    // tuple comparison avoids duplicates when several rows share a timestamp.
    query = query.or(
      `created_at.gt.${input.after.publishedAt},and(created_at.eq.${input.after.publishedAt},id.gt.${input.after.id})`,
    );
  }

  const { data, error } = await query;
  if (error) throw new Error(`Kunde inte läsa publicerade briefposter för integrationsflödet: ${error.message}`);
  return (data ?? []).flatMap((row: RawRecord) => {
    const id = typeof row.id === "string" ? row.id : null;
    const briefId = typeof row.brief_id === "string" ? row.brief_id : null;
    const createdAt = typeof row.created_at === "string" ? row.created_at : null;
    return id && briefId && createdAt ? [{ id, brief_id: briefId, created_at: createdAt }] : [];
  });
}

async function readBriefIndex(input: {
  database: DatabaseClient;
  userId: string;
  after: FeedCursor | null;
  limit: number;
  ascending: boolean;
}): Promise<Array<{ id: string; created_at: string }>> {
  let query = input.database
    .from("briefs")
    .select("id, created_at")
    .eq("user_id", input.userId)
    .eq("state", "complete")
    .order("created_at", { ascending: input.ascending })
    .order("id", { ascending: input.ascending })
    .limit(input.limit);

  if (input.after) {
    query = query.or(
      `created_at.gt.${input.after.publishedAt},and(created_at.eq.${input.after.publishedAt},id.gt.${input.after.id})`,
    );
  }

  const { data, error } = await query;
  if (error) throw new Error(`Kunde inte läsa publicerade briefs för integrationsflödet: ${error.message}`);
  return (data ?? []).flatMap((row: RawRecord) => {
    const id = typeof row.id === "string" ? row.id : null;
    const createdAt = typeof row.created_at === "string" ? row.created_at : null;
    return id && createdAt ? [{ id, created_at: createdAt }] : [];
  });
}

async function hydrateFeedItems(database: DatabaseClient, userId: string, indexRows: FeedIndexRow[]): Promise<OutgoingFeedItem[]> {
  const briefIds = [...new Set(indexRows.map((row) => row.brief_id))];
  const briefs = await Promise.all(briefIds.map(async (briefId) => getBriefForUser(database, userId, briefId)));
  const briefById = new Map(briefs.flatMap((brief) => brief ? [[brief.id, brief] as const] : []));

  return indexRows.flatMap((row) => {
    const brief = briefById.get(row.brief_id);
    const item = brief?.items.find((candidate) => candidate.id === row.id);
    return brief && item ? [toOutgoingFeedItem(brief, item, row.created_at)] : [];
  });
}

export function toOutgoingFeedItem(brief: BriefView, item: BriefItemView, publishedAt: string): OutgoingFeedItem {
  return {
    id: item.id,
    cursor: encodeFeedCursor({ kind: "item", id: item.id, publishedAt }),
    publishedAt: new Date(publishedAt).toISOString(),
    brief: {
      id: brief.id,
      date: brief.briefDate,
      timezone: brief.timezone,
      assessment: brief.assessment,
      noMaterialChanges: brief.noMaterialChanges,
    },
    event: {
      id: item.eventId,
      title: item.title,
      category: item.category,
      status: item.status,
      eventDate: item.eventDate,
    },
    whatChanged: item.whatChanged,
    whyRelevant: item.whyRelevant,
    shortTermImpact: item.shortTermImpact,
    longTermImpact: item.longTermImpact,
    recommendation: item.recommendation,
    relevanceScore: item.relevanceScore,
    confidence: item.confidence,
    systemicOverride: item.systemicOverride,
    directAlert: item.directAlert,
    sources: item.sources,
  };
}

export function toOutgoingBrief(brief: BriefView, publishedAt: string): OutgoingBrief {
  return {
    id: brief.id,
    cursor: encodeFeedCursor({ kind: "brief", id: brief.id, publishedAt }),
    publishedAt: new Date(publishedAt).toISOString(),
    briefDate: brief.briefDate,
    timezone: brief.timezone,
    assessment: brief.assessment,
    noMaterialChanges: brief.noMaterialChanges,
    watchlist: brief.watchlist,
    worldPulse: brief.worldPulse,
    weeklyRecap: brief.weeklyRecap,
    marketSnapshot: brief.marketSnapshot,
    strategicRadar: brief.strategicRadar,
    items: brief.items.map((item) => toOutgoingFeedItem(brief, item, item.createdAt)),
  };
}
