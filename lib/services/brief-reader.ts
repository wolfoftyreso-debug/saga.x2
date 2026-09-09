import type { SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_PROFILE_SETTINGS, profileSettingsSchema, strategicRadarSchema, weeklyRecapSchema, worldPulseSchema, type ConfidenceLevel, type EventCategory, type EventStatus, type ProfileSettings, type Recommendation, type RelevanceFactors, type Source, type StrategicRadar, type StrategicRadarSection, type WeeklyRecap, type WorldPulse } from "@/lib/domain/types";
import { marketSnapshotSchema, type MarketSnapshot } from "@/lib/domain/market-snapshot";
import { filterSourcesByPolicy, type SourcePolicyRecord } from "@/lib/domain/source-catalog";
import { hasSufficientVerification } from "@/lib/domain/source-policy";
import { getEffectiveSourcePolicies, getExplicitSourcePolicies, userCanAccessEvent } from "@/lib/services/workspace";
import { createAdminClient } from "@/lib/supabase/admin";
import { localDateInTimezone } from "@/lib/utils/date";

type DatabaseClient = SupabaseClient;

type RawRecord = Record<string, unknown>;

export type Profile = {
  userId: string;
  displayName: string;
  settings: ProfileSettings;
};

export type RunHealth = {
  id: string;
  state: "running" | "complete" | "failed";
  phase: string;
  localBriefDate: string;
  triggeredBy: "cron" | "manual" | "retry" | "watch";
  startedAt: string;
  finishedAt: string | null;
  errorMessage: string | null;
  candidateCount: number;
  publishedCount: number;
};

export type BriefItemView = {
  id: string;
  createdAt: string;
  eventId: string;
  eventUpdateId: string | null;
  position: number;
  title: string;
  category: EventCategory;
  status: EventStatus;
  eventDate: string | null;
  whatChanged: string;
  relevanceScore: number;
  relevanceFactors: RelevanceFactors;
  whyRelevant: string;
  shortTermImpact: string;
  longTermImpact: string;
  recommendation: Recommendation;
  confidence: ConfidenceLevel;
  systemicOverride: boolean;
  directAlert: boolean;
  selectedFeedback: string[];
  sources: Source[];
};

export type BriefView = {
  id: string;
  briefDate: string;
  timezone: string;
  assessment: string;
  noMaterialChanges: boolean;
  worldPulse: WorldPulse | null;
  weeklyRecap: WeeklyRecap | null;
  marketSnapshot: MarketSnapshot | null;
  strategicRadar: StrategicRadar | null;
  watchlist: Array<{ question: string; expectedBy: string | null; whyItMatters: string }>;
  createdAt: string;
  items: BriefItemView[];
};

type ProfileRow = {
  user_id: string;
  display_name: string;
  economy_weight: number;
  technology_weight: number;
  regulation_weight: number;
  geopolitics_weight: number;
  sweden_eu_weight: number;
  usa_weight: number;
  gulf_weight: number;
  max_items: number;
  brief_depth: "short" | "deep";
  relevance_threshold: number;
  alert_threshold: number;
  base_region: string;
  daily_brief_time: string;
  timezone: string;
};

type BriefRow = {
  id: string;
  user_id: string;
  brief_date: string;
  timezone: string;
  assessment: string | null;
  no_material_changes: boolean;
  world_pulse?: unknown;
  weekly_recap?: unknown;
  market_snapshot?: unknown;
  strategic_radar?: unknown;
  watchlist: BriefView["watchlist"];
  created_at: string;
  item_count: number;
  brief_definition_id?: string | null;
  brief_definitions?: { name?: string; kind?: string } | null;
};

type BriefItemRow = {
  id: string;
  created_at: string;
  event_id: string;
  event_update_id: string | null;
  position: number;
  title_snapshot: string;
  category_snapshot: EventCategory;
  status_snapshot: EventStatus;
  event_date_snapshot: string | null;
  what_changed: string;
  relevance_score: number;
  relevance_factors: RelevanceFactors;
  why_relevant: string;
  short_term_impact: string;
  long_term_impact: string;
  recommendation: Recommendation;
  confidence: ConfidenceLevel;
  systemic_override: boolean;
  direct_alert: boolean;
};

type EventRow = {
  id: string;
  title: string;
  category: EventCategory;
  status: EventStatus;
  event_date: string | null;
  effective_date: string | null;
  latest_terms_summary: string | null;
  confidence: ConfidenceLevel;
};

type EventUpdateRow = {
  id: string;
  previous_status: EventStatus | null;
  new_status: EventStatus;
  kind: string;
  change_summary: string;
  event_date: string | null;
  effective_date: string | null;
  occurred_at: string;
  confidence: ConfidenceLevel;
};

type EventSourceRow = {
  event_id: string;
  event_update_id: string | null;
  source_name: string;
  url: string;
  source_type: Source["sourceType"];
  published_at: string | null;
  event_date: string | null;
  supports_claim: string;
};

type OwnedBriefItemRow = Pick<BriefItemRow, "event_id" | "relevance_score" | "why_relevant"> & { brief_id: string };
type BriefDateRow = Pick<BriefRow, "id" | "brief_date">;
type FeedbackRow = { type: string };
type FeedbackEventRow = FeedbackRow & { event_id: string };
type RunRow = {
  id: string;
  state: RunHealth["state"];
  phase: string;
  local_brief_date: string;
  triggered_by: RunHealth["triggeredBy"];
  started_at: string;
  finished_at: string | null;
  error_message: string | null;
  candidate_count: number;
  published_count: number;
};

export type DashboardData = {
  profile: Profile;
  today: string;
  brief: BriefView | null;
  isCurrentBrief: boolean;
  latestRun: RunHealth | null;
};

function databaseError(context: string, error: { message?: string } | null): Error {
  return new Error(`${context}${error?.message ? `: ${error.message}` : ""}`);
}

export async function getProfile(client: DatabaseClient, userId: string): Promise<Profile | null> {
  const { data, error } = await client.from("profiles").select("*").eq("user_id", userId).maybeSingle();
  if (error) throw databaseError("Kunde inte läsa profilen", error);
  if (!data) return null;
  return mapProfile(data);
}

export function mapProfile(data: RawRecord): Profile {
  const profile = data as ProfileRow;
  const settings = profileSettingsSchema.parse({
    economyWeight: profile.economy_weight,
    technologyWeight: profile.technology_weight,
    regulationWeight: profile.regulation_weight,
    geopoliticsWeight: profile.geopolitics_weight,
    swedenEuWeight: profile.sweden_eu_weight,
    usaWeight: profile.usa_weight,
    gulfWeight: profile.gulf_weight,
    maxItems: profile.max_items,
    briefDepth: profile.brief_depth,
    relevanceThreshold: profile.relevance_threshold,
    alertThreshold: profile.alert_threshold,
    baseRegion: profile.base_region,
    dailyBriefTime: String(profile.daily_brief_time).slice(0, 5),
    timezone: profile.timezone,
  });
  return { userId: profile.user_id, displayName: profile.display_name, settings };
}

export async function getDashboardData(client: DatabaseClient, userId: string): Promise<DashboardData | null> {
  const profile = await getProfile(client, userId);
  if (!profile) return null;

  const today = localDateInTimezone(profile.settings.timezone);
  const { data: primaryDefinition, error: primaryDefinitionError } = await client
    .from("brief_definitions")
    .select("id")
    .eq("user_id", userId)
    .eq("is_primary", true)
    .maybeSingle();
  if (primaryDefinitionError) throw databaseError("Kunde inte läsa huvudbriefen", primaryDefinitionError);
  let todayBriefQuery = client.from("briefs").select("*").eq("user_id", userId).eq("brief_date", today).eq("state", "complete");
  let latestBriefQuery = client.from("briefs").select("*").eq("user_id", userId).eq("state", "complete").order("brief_date", { ascending: false }).limit(1);
  let latestRunQuery = client.from("processing_runs").select("*").eq("user_id", userId).order("started_at", { ascending: false }).limit(1);
  if (primaryDefinition?.id) {
    todayBriefQuery = todayBriefQuery.eq("brief_definition_id", primaryDefinition.id);
    latestBriefQuery = latestBriefQuery.eq("brief_definition_id", primaryDefinition.id);
    latestRunQuery = latestRunQuery.eq("brief_definition_id", primaryDefinition.id);
  }
  const [todayBriefResult, latestBriefResult, latestRunResult] = await Promise.all([
    todayBriefQuery.maybeSingle(),
    latestBriefQuery.maybeSingle(),
    latestRunQuery.maybeSingle(),
  ]);
  if (todayBriefResult.error) throw databaseError("Kunde inte läsa dagens brief", todayBriefResult.error);
  if (latestBriefResult.error) throw databaseError("Kunde inte läsa senaste kompletta brief", latestBriefResult.error);
  if (latestRunResult.error) throw databaseError("Kunde inte läsa körstatus", latestRunResult.error);

  const rawBrief = todayBriefResult.data ?? latestBriefResult.data;
  return {
    profile,
    today,
    brief: rawBrief ? await hydrateBrief(client, rawBrief) : null,
    isCurrentBrief: Boolean(todayBriefResult.data),
    latestRun: latestRunResult.data ? mapRun(latestRunResult.data) : null,
  };
}

export async function getBrief(client: DatabaseClient, briefId: string): Promise<BriefView | null> {
  const { data, error } = await client.from("briefs").select("*").eq("id", briefId).eq("state", "complete").maybeSingle();
  if (error) throw databaseError("Kunde inte läsa briefen", error);
  return data ? hydrateBrief(client, data) : null;
}

/**
 * Service-role integrations must restore the owner constraint explicitly.
 * Keep this separate from getBrief(), which is used with an RLS-bound client
 * by server-rendered pages.
 */
export async function getBriefForUser(client: DatabaseClient, userId: string, briefId: string): Promise<BriefView | null> {
  const { data, error } = await client
    .from("briefs")
    .select("*")
    .eq("id", briefId)
    .eq("user_id", userId)
    .eq("state", "complete")
    .maybeSingle();
  if (error) throw databaseError("Kunde inte läsa den användarägda briefen", error);
  return data ? hydrateBrief(client, data) : null;
}

export async function getHistory(client: DatabaseClient, userId: string): Promise<Array<Omit<BriefView, "items"> & { itemCount: number; definitionName: string; definitionKind: string }>> {
  const { data, error } = await client
    .from("briefs")
    .select("*, brief_definitions(name, kind)")
    .eq("user_id", userId)
    .eq("state", "complete")
    // A calm sourced layer is an intentionally useful daily record even when
    // it has zero event cards. Flow controls can turn the world pulse off
    // while leaving another independent layer on, so no enabled module may be
    // hidden behind the legacy event-only history filter.
    .or("no_material_changes.eq.false,world_pulse.not.is.null,weekly_recap.not.is.null,market_snapshot.not.is.null,strategic_radar.not.is.null")
    .order("brief_date", { ascending: false })
    .limit(30);
  if (error) throw databaseError("Kunde inte läsa historiken", error);

  return Promise.all((data ?? []).map(async (brief: RawRecord) => {
    const row = brief as BriefRow;
    const sourcePolicies = await getEffectiveSourcePolicies(client, userId, row.brief_definition_id ?? undefined);
    return {
      id: row.id,
      briefDate: row.brief_date,
      timezone: row.timezone,
      assessment: row.assessment ?? "",
      noMaterialChanges: row.no_material_changes,
      worldPulse: filterWorldPulseByPolicy(parseWorldPulse(row.world_pulse), sourcePolicies),
      weeklyRecap: filterWeeklyRecapByPolicy(parseWeeklyRecap(row.weekly_recap), sourcePolicies),
      marketSnapshot: parseMarketSnapshot(row.market_snapshot),
      strategicRadar: filterStrategicRadarByPolicy(parseStrategicRadar(row.strategic_radar), sourcePolicies),
      watchlist: Array.isArray(row.watchlist) ? row.watchlist : [],
      createdAt: row.created_at,
      itemCount: row.item_count,
      definitionName: row.brief_definitions?.name ?? "Brief",
      definitionKind: row.brief_definitions?.kind ?? "custom",
    };
  }));
}

export type EventDetail = {
  event: {
    id: string;
    title: string;
    category: EventCategory;
    status: EventStatus;
    eventDate: string | null;
    effectiveDate: string | null;
    termsSummary: string | null;
    confidence: ConfidenceLevel;
  };
  updates: Array<{
    id: string;
    previousStatus: EventStatus | null;
    newStatus: EventStatus;
    kind: string;
    changeSummary: string;
    eventDate: string | null;
    effectiveDate: string | null;
    occurredAt: string;
    confidence: ConfidenceLevel;
  }>;
  sources: Source[];
  relatedBriefs: Array<{ id: string; briefDate: string; relevanceScore: number; whyRelevant: string }>;
  selectedFeedback: string[];
};

export async function getEventDetail(client: DatabaseClient, userId: string, eventId: string): Promise<EventDetail | null> {
  const { data: ownedItems, error: ownedItemsError } = await client
    .from("brief_items")
    .select("brief_id, relevance_score, why_relevant")
    .eq("event_id", eventId);
  if (ownedItemsError) throw databaseError("Kunde inte kontrollera åtkomst till händelsen", ownedItemsError);
  // A delivered watch may grant an event that has not (yet) appeared in a
  // brief. A watch row alone never grants access; userCanAccessEvent checks the
  // durable server-created access grant instead.
  if (!ownedItems?.length && !(await userCanAccessEvent(client, userId, eventId))) return null;

  const briefIds = ownedItems.map((item: RawRecord) => (item as OwnedBriefItemRow).brief_id);
  const relatedBriefsQuery = briefIds.length
    ? client.from("briefs").select("id, brief_date").eq("user_id", userId).in("id", briefIds)
    : Promise.resolve({ data: [] as RawRecord[], error: null });
  const [eventResult, updatesResult, sourcesResult, briefsResult, feedbackResult, sourcePolicies] = await Promise.all([
    client.from("events").select("*").eq("id", eventId).maybeSingle(),
    client.from("event_updates").select("*").eq("event_id", eventId).order("occurred_at", { ascending: false }),
    // Event sources are global records. Query them server-side only after the
    // user-owned brief relation above has established access, then apply the
    // user's source policy below. This keeps a blocked source unavailable to
    // direct authenticated Supabase reads as well as to the UI.
    createAdminClient().from("event_sources").select("*").eq("event_id", eventId).order("published_at", { ascending: false }),
    relatedBriefsQuery,
    client.from("feedback").select("type").eq("user_id", userId).eq("event_id", eventId),
    getExplicitSourcePolicies(client, userId),
  ]);
  if (eventResult.error) throw databaseError("Kunde inte läsa händelsen", eventResult.error);
  if (updatesResult.error) throw databaseError("Kunde inte läsa händelseuppdateringar", updatesResult.error);
  if (sourcesResult.error) throw databaseError("Kunde inte läsa källor", sourcesResult.error);
  if (briefsResult.error) throw databaseError("Kunde inte läsa relaterade briefs", briefsResult.error);
  if (feedbackResult.error) throw databaseError("Kunde inte läsa återkoppling", feedbackResult.error);
  if (!eventResult.data) return null;

  const eventRow = eventResult.data as EventRow;
  const briefDateById = new Map((briefsResult.data ?? []).map((brief: RawRecord) => {
    const row = brief as BriefDateRow;
    return [row.id, row.brief_date] as const;
  }));
  return {
    event: {
      id: eventRow.id,
      title: eventRow.title,
      category: eventRow.category,
      status: eventRow.status,
      eventDate: eventRow.event_date,
      effectiveDate: eventRow.effective_date,
      termsSummary: eventRow.latest_terms_summary,
      confidence: eventRow.confidence,
    },
    updates: (updatesResult.data ?? []).map((update: RawRecord) => {
      const row = update as EventUpdateRow;
      return {
        id: row.id,
        previousStatus: row.previous_status,
        newStatus: row.new_status,
        kind: row.kind,
        changeSummary: row.change_summary,
        eventDate: row.event_date,
        effectiveDate: row.effective_date,
        occurredAt: row.occurred_at,
        confidence: row.confidence,
      };
    }),
    sources: filterSourcesByPolicy((sourcesResult.data ?? []).map(mapSource), sourcePolicies),
    relatedBriefs: ownedItems
      .map((item: RawRecord) => {
        const row = item as OwnedBriefItemRow;
        return {
          id: row.brief_id,
          briefDate: briefDateById.get(row.brief_id),
          relevanceScore: row.relevance_score,
          whyRelevant: row.why_relevant,
        };
      })
      .filter((item): item is { id: string; briefDate: string; relevanceScore: number; whyRelevant: string } => Boolean(item.briefDate)),
    selectedFeedback: (feedbackResult.data ?? []).map((feedback: RawRecord) => (feedback as FeedbackRow).type),
  };
}

async function hydrateBrief(client: DatabaseClient, rawBrief: RawRecord): Promise<BriefView> {
  const brief = rawBrief as BriefRow;
  const { data: rawItems, error: itemsError } = await client
    .from("brief_items")
    .select("*")
    .eq("brief_id", brief.id)
    .order("position", { ascending: true });
  if (itemsError) throw databaseError("Kunde inte läsa briefposter", itemsError);

  const items = (rawItems ?? []) as BriefItemRow[];
  const eventIds = items.map((item) => item.event_id);
  const updateIds = items.map((item) => item.event_update_id).filter((id): id is string => Boolean(id));
  let rawSources: EventSourceRow[] = [];
  let feedbackByEventId = new Map<string, string[]>();
  // A definition can tighten or relax an individual source role. Render the
  // exact policy that governed this brief, rather than a later global default.
  const sourcePolicies = await getEffectiveSourcePolicies(client, brief.user_id, brief.brief_definition_id ?? undefined);
  if (eventIds.length) {
    // See getEventDetail: source records are retrieved with service role only
    // after ownership of this brief has already been established by RLS.
    const sourceQuery = createAdminClient().from("event_sources").select("*").in("event_id", eventIds);
    const { data, error } = updateIds.length ? await sourceQuery.in("event_update_id", updateIds) : await sourceQuery;
    if (error) throw databaseError("Kunde inte läsa briefkällor", error);
    rawSources = (data ?? []) as EventSourceRow[];

    const { data: feedback, error: feedbackError } = await client
      .from("feedback")
      .select("event_id, type")
      .eq("user_id", brief.user_id)
      .in("event_id", eventIds);
    if (feedbackError) throw databaseError("Kunde inte läsa återkoppling för briefen", feedbackError);
    feedbackByEventId = new Map<string, string[]>();
    for (const entry of feedback ?? []) {
      const row = entry as FeedbackEventRow;
      const current = feedbackByEventId.get(row.event_id) ?? [];
      current.push(row.type);
      feedbackByEventId.set(row.event_id, current);
    }
  }

  return {
    id: brief.id,
    briefDate: brief.brief_date,
    timezone: brief.timezone,
    assessment: brief.assessment ?? "",
    noMaterialChanges: brief.no_material_changes,
    worldPulse: filterWorldPulseByPolicy(parseWorldPulse(brief.world_pulse), sourcePolicies),
    weeklyRecap: filterWeeklyRecapByPolicy(parseWeeklyRecap(brief.weekly_recap), sourcePolicies),
    marketSnapshot: parseMarketSnapshot(brief.market_snapshot),
    strategicRadar: filterStrategicRadarByPolicy(parseStrategicRadar(brief.strategic_radar), sourcePolicies),
    watchlist: Array.isArray(brief.watchlist) ? brief.watchlist : [],
    createdAt: brief.created_at,
    items: items.map((item) => ({
      id: item.id,
      createdAt: item.created_at,
      eventId: item.event_id,
      eventUpdateId: item.event_update_id,
      position: item.position,
      title: item.title_snapshot,
      category: item.category_snapshot,
      status: item.status_snapshot,
      eventDate: item.event_date_snapshot,
      whatChanged: item.what_changed,
      relevanceScore: item.relevance_score,
      relevanceFactors: item.relevance_factors,
      whyRelevant: item.why_relevant,
      shortTermImpact: item.short_term_impact,
      longTermImpact: item.long_term_impact,
      recommendation: item.recommendation,
      confidence: item.confidence,
      systemicOverride: item.systemic_override,
      directAlert: item.direct_alert,
      selectedFeedback: feedbackByEventId.get(item.event_id) ?? [],
      sources: rawSources
        .filter((source) => source.event_id === item.event_id && (!item.event_update_id || source.event_update_id === item.event_update_id))
        .map(mapSource)
        .filter((source) => filterSourcesByPolicy([source], sourcePolicies).length > 0),
    })),
  };
}

function parseWorldPulse(value: unknown): WorldPulse | null {
  const parsed = worldPulseSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseWeeklyRecap(value: unknown): WeeklyRecap | null {
  const parsed = weeklyRecapSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseMarketSnapshot(value: unknown): MarketSnapshot | null {
  const parsed = marketSnapshotSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseStrategicRadar(value: unknown): StrategicRadar | null {
  const parsed = strategicRadarSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Source policies continue to apply when a user opens history. If a later
 * policy blocks a source, suppress the whole pulse rather than rendering a
 * previously source-backed claim with an empty or prohibited source chain.
 */
function filterWorldPulseByPolicy(pulse: WorldPulse | null, policies: SourcePolicyRecord[]): WorldPulse | null {
  if (!pulse) return null;
  const parsed = worldPulseSchema.safeParse({
    ...pulse,
    conflictSecurity: { ...pulse.conflictSecurity, sources: filterSourcesByPolicy(pulse.conflictSecurity.sources, policies) },
    economy: { ...pulse.economy, sources: filterSourcesByPolicy(pulse.economy.sources, policies) },
    personalExposure: { ...pulse.personalExposure, sources: filterSourcesByPolicy(pulse.personalExposure.sources, policies) },
  });
  return parsed.success ? parsed.data : null;
}

/**
 * A recap row is source-backed just like the pulse. If a later policy blocks
 * any proof chain, hide the full recap rather than display a shortened list
 * whose stored total would no longer be true.
 */
function filterWeeklyRecapByPolicy(recap: WeeklyRecap | null, policies: SourcePolicyRecord[]): WeeklyRecap | null {
  if (!recap) return null;
  const items = recap.items.map((item) => ({
    ...item,
    sources: filterSourcesByPolicy(
      item.sources,
      policies,
      "citation",
      `${item.title} ${item.whatChanged} ${item.whyItMatters}`,
    ),
  }));
  if (items.some((item) => !hasSufficientVerification(item.sources))) return null;
  const parsed = weeklyRecapSchema.safeParse({ ...recap, items });
  return parsed.success ? parsed.data : null;
}

/**
 * Source policy changes also apply to stored radar cards. Do not render an
 * old, now-blocked source as if it still backed an opportunity or event.
 */
function filterStrategicRadarByPolicy(radar: StrategicRadar | null, policies: SourcePolicyRecord[]): StrategicRadar | null {
  if (!radar) return null;
  const sections = ["aiRoadmap", "businessOpportunities", "contexts"] as const;
  const filtered = Object.fromEntries(sections.map((name) => {
    const section = radar[name];
    const items = section.items
      .map((item) => ({ ...item, sources: filterSourcesByPolicy(item.sources, policies) }))
      .filter((item) => item.sources.length > 0);
    const nextSection: StrategicRadarSection = section.status === "items_found" && items.length === 0
      ? {
        status: "unavailable",
        summary: "Källorna för den här sektionen är inte tillåtna i den aktiva källpolicyn.",
        items: [],
      }
      : { ...section, items };
    return [name, nextSection];
  })) as Pick<StrategicRadar, "aiRoadmap" | "businessOpportunities" | "contexts">;
  const sectionValues = sections.map((name) => filtered[name]);
  const unavailableCount = sectionValues.filter((section) => section.status === "unavailable").length;
  const coverage = unavailableCount === sectionValues.length
    ? "unavailable"
    : unavailableCount > 0
      ? "partial"
      : "complete";
  const parsed = strategicRadarSchema.safeParse({ ...radar, ...filtered, coverage });
  return parsed.success ? parsed.data : null;
}

function mapRun(data: RawRecord): RunHealth {
  const run = data as RunRow;
  return {
    id: run.id,
    state: run.state,
    phase: run.phase,
    localBriefDate: run.local_brief_date,
    triggeredBy: run.triggered_by,
    startedAt: run.started_at,
    finishedAt: run.finished_at,
    errorMessage: run.error_message,
    candidateCount: run.candidate_count,
    publishedCount: run.published_count,
  };
}

function mapSource(data: RawRecord): Source {
  const source = data as EventSourceRow;
  return {
    sourceName: source.source_name,
    url: source.url,
    sourceType: source.source_type,
    publishedAt: source.published_at,
    eventDate: source.event_date,
    supportsClaim: source.supports_claim,
  };
}

export async function updateProfileSettings(client: DatabaseClient, userId: string, settings: ProfileSettings): Promise<void> {
  const parsed = profileSettingsSchema.parse(settings);
  const { error } = await client
    .from("profiles")
    .update({
      economy_weight: parsed.economyWeight,
      technology_weight: parsed.technologyWeight,
      regulation_weight: parsed.regulationWeight,
      geopolitics_weight: parsed.geopoliticsWeight,
      sweden_eu_weight: parsed.swedenEuWeight,
      usa_weight: parsed.usaWeight,
      gulf_weight: parsed.gulfWeight,
      max_items: parsed.maxItems,
      brief_depth: parsed.briefDepth,
      relevance_threshold: parsed.relevanceThreshold,
      alert_threshold: parsed.alertThreshold,
      base_region: parsed.baseRegion,
      daily_brief_time: parsed.dailyBriefTime,
      timezone: parsed.timezone,
    })
    .eq("user_id", userId);
  if (error) throw databaseError("Kunde inte spara inställningarna", error);
  const { error: briefDefinitionError } = await client
    .from("brief_definitions")
    .update({
      timezone: parsed.timezone,
      local_time: parsed.dailyBriefTime,
      max_items: parsed.maxItems,
      brief_depth: parsed.briefDepth,
      relevance_threshold: parsed.relevanceThreshold,
      alert_threshold: parsed.alertThreshold,
    })
    .eq("user_id", userId)
    .eq("is_primary", true);
  if (briefDefinitionError) throw databaseError("Kunde inte synkronisera huvudbriefen", briefDefinitionError);
}

export const fallbackProfile: Profile = {
  userId: "",
  displayName: "Erik",
  settings: DEFAULT_PROFILE_SETTINGS,
};
