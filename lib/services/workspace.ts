import type { SupabaseClient } from "@supabase/supabase-js";
import { mergeSourcePolicies, SOURCE_CATALOG, type SourceKind, type SourcePolicyRecord, type SourcePriority, type SourceRole } from "@/lib/domain/source-catalog";
import type { EventStatus } from "@/lib/domain/types";
import { profileContextSchema, type ProfileContextInput } from "@/lib/domain/workspace";

type DatabaseClient = SupabaseClient;
type RawRecord = Record<string, unknown>;

export type ProfileContextView = ProfileContextInput & { userId: string; updatedAt: string };

export type BriefDefinitionView = {
  id: string;
  name: string;
  kind: "main" | "company" | "economy" | "technology" | "regulation" | "creator" | "local" | "custom";
  instructions: string;
  cadence: "daily" | "weekly";
  localTime: string;
  weekday: number | null;
  timezone: string;
  maxItems: number;
  briefDepth: "short" | "deep";
  relevanceThreshold: number;
  alertThreshold: number;
  onlyWhenChanged: boolean;
  active: boolean;
  isPrimary: boolean;
};

export type WatchView = {
  id: string;
  eventId: string | null;
  kind: "event" | "topic";
  title: string;
  queryText: string | null;
  rationale: string;
  triggerStatuses: EventStatus[];
  onlyMaterialChange: boolean;
  state: "active" | "paused" | "completed";
  lastTriggeredAt: string | null;
  updatedAt: string;
  event: { title: string; status: EventStatus } | null;
};

export type ConversationBlock = { type: string; [key: string]: unknown };

export type ConversationBriefReference = {
  id: string;
  briefDate: string;
  assessment: string;
  noMaterialChanges: boolean;
  itemCount: number;
  definitionName: string;
};

export type ConversationMessageView = {
  id: string;
  role: "system" | "user" | "assistant";
  kind: "text" | "brief" | "action" | "watch_update" | "direct_alert";
  text: string;
  action: { type?: string; title?: string; detail?: string; href?: string } | null;
  blocks: ConversationBlock[];
  responseMetadata: Record<string, unknown>;
  briefId: string | null;
  brief: ConversationBriefReference | null;
  eventId: string | null;
  watchId: string | null;
  createdAt: string;
};

export type ConversationView = {
  id: string;
  title: string;
  messages: ConversationMessageView[];
};

export type SourcePolicyView = SourcePolicyRecord & {
  id: string | null;
  sourceId: string | null;
  isCustom: boolean;
};

export type BriefSourcePolicyOverrideView = {
  id: string;
  briefDefinitionId: string;
  domain: string;
  active: boolean | null;
  blocked: boolean | null;
  priority: SourcePriority | null;
  roles: SourceRole[] | null;
  topicFilter: string | null;
  verificationRequirement: SourcePolicyRecord["verificationRequirement"] | null;
  frequency: SourcePolicyRecord["frequency"] | null;
};

function databaseError(context: string, error: { message?: string } | null): Error {
  return new Error(`${context}${error?.message ? `: ${error.message}` : ""}`);
}

function list(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function roleList(value: unknown): SourceRole[] {
  const allowed = new Set<SourceRole>(["discovery", "analysis", "verification", "citation", "direct_monitoring"]);
  return list(value).filter((role): role is SourceRole => allowed.has(role as SourceRole));
}

function statusList(value: unknown): EventStatus[] {
  const allowed = new Set<EventStatus>(["rumor", "reported", "proposed", "negotiating", "announced", "signed", "adopted", "effective", "implemented", "changed", "reversed"]);
  return list(value).filter((status): status is EventStatus => allowed.has(status as EventStatus));
}

export async function getProfileContext(client: DatabaseClient, userId: string): Promise<ProfileContextView | null> {
  const { data, error } = await client.from("profile_context").select("*").eq("user_id", userId).maybeSingle();
  if (error) throw databaseError("Kunde inte läsa profilbilden", error);
  if (!data) return null;
  const row = data as RawRecord;
  const parsed = profileContextSchema.parse({
    workSummary: String(row.work_summary ?? ""),
    roleTitle: String(row.role_title ?? ""),
    organizations: list(row.organizations),
    sectors: list(row.sectors),
    markets: list(row.markets),
    dependencies: list(row.dependencies),
    decisions: list(row.decisions),
    risks: list(row.risks),
    opportunities: list(row.opportunities),
    interests: list(row.interests),
    exclusions: list(row.exclusions),
    languages: list(row.languages),
    onboardingComplete: Boolean(row.onboarding_complete),
  });
  return { userId, ...parsed, updatedAt: String(row.updated_at) };
}

export async function getBriefDefinitions(client: DatabaseClient, userId: string): Promise<BriefDefinitionView[]> {
  const { data, error } = await client
    .from("brief_definitions")
    .select("*")
    .eq("user_id", userId)
    .order("is_primary", { ascending: false })
    .order("created_at", { ascending: true });
  if (error) throw databaseError("Kunde inte läsa briefdefinitionerna", error);
  return (data ?? []).map((raw: RawRecord) => ({
    id: String(raw.id),
    name: String(raw.name),
    kind: raw.kind as BriefDefinitionView["kind"],
    instructions: String(raw.instructions ?? ""),
    cadence: raw.cadence as BriefDefinitionView["cadence"],
    localTime: String(raw.local_time).slice(0, 5),
    weekday: typeof raw.weekday === "number" ? raw.weekday : null,
    timezone: String(raw.timezone),
    maxItems: Number(raw.max_items),
    briefDepth: raw.brief_depth as BriefDefinitionView["briefDepth"],
    relevanceThreshold: Number(raw.relevance_threshold),
    alertThreshold: Number(raw.alert_threshold),
    onlyWhenChanged: Boolean(raw.only_when_changed),
    active: Boolean(raw.active),
    isPrimary: Boolean(raw.is_primary),
  }));
}

export async function getWatches(client: DatabaseClient, userId: string): Promise<WatchView[]> {
  const { data, error } = await client
    .from("watches")
    .select("*, events(title, status)")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false });
  if (error) throw databaseError("Kunde inte läsa bevakningarna", error);
  return (data ?? []).map((raw: RawRecord) => {
    const eventData = raw.events;
    const event = eventData && !Array.isArray(eventData) && typeof eventData === "object"
      ? { title: String((eventData as RawRecord).title), status: (eventData as RawRecord).status as EventStatus }
      : null;
    return {
      id: String(raw.id),
      eventId: typeof raw.event_id === "string" ? raw.event_id : null,
      kind: raw.kind === "topic" ? "topic" : "event",
      title: String(raw.title),
      queryText: typeof raw.query_text === "string" ? raw.query_text : null,
      rationale: String(raw.rationale ?? ""),
      triggerStatuses: statusList(raw.trigger_statuses),
      onlyMaterialChange: Boolean(raw.only_material_change),
      state: raw.state as WatchView["state"],
      lastTriggeredAt: typeof raw.last_triggered_at === "string" ? raw.last_triggered_at : null,
      updatedAt: String(raw.updated_at),
      event,
    };
  });
}

export async function getMainConversation(client: DatabaseClient, userId: string): Promise<ConversationView | null> {
  const { data: conversation, error } = await client
    .from("conversations")
    .select("id, title")
    .eq("user_id", userId)
    .eq("kind", "main")
    .maybeSingle();
  if (error) throw databaseError("Kunde inte läsa konversationen", error);
  if (!conversation) return null;
  return getConversationMessages(client, userId, conversation);
}

/**
 * Event threads are intentionally separate from the main brief conversation.
 * A user can therefore keep the reasoning and follow-up questions for one
 * event together without turning the daily brief into a long-running feed.
 */
export async function getEventConversation(client: DatabaseClient, userId: string, eventId: string): Promise<ConversationView | null> {
  const { data: conversation, error } = await client
    .from("conversations")
    .select("id, title")
    .eq("user_id", userId)
    .eq("kind", "event")
    .eq("event_id", eventId)
    .maybeSingle();
  if (error) throw databaseError("Kunde inte läsa händelsetråden", error);
  if (!conversation) return null;
  return getConversationMessages(client, userId, conversation);
}

async function getConversationMessages(
  client: DatabaseClient,
  userId: string,
  conversation: { id: string; title: string },
): Promise<ConversationView> {
  const { data: rawMessages, error: messagesError } = await client
    .from("conversation_messages")
    .select("*, briefs(id, brief_date, assessment, no_material_changes, item_count, brief_definitions(name))")
    .eq("conversation_id", conversation.id)
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(80);
  if (messagesError) throw databaseError("Kunde inte läsa konversationsmeddelanden", messagesError);
  return {
    id: String(conversation.id),
    title: String(conversation.title),
    // Fetch newest first so the limit is a recent-window limit, then restore
    // chronological display order for the thread.
    messages: (rawMessages ?? []).reverse().map((raw: RawRecord) => mapConversationMessage(raw)),
  };
}

function mapConversationMessage(raw: RawRecord): ConversationMessageView {
  const nestedBrief = raw.briefs;
  const briefRecord = nestedBrief && typeof nestedBrief === "object" && !Array.isArray(nestedBrief) ? nestedBrief as RawRecord : null;
  const nestedDefinition = briefRecord?.brief_definitions;
  const definitionRecord = nestedDefinition && typeof nestedDefinition === "object" && !Array.isArray(nestedDefinition) ? nestedDefinition as RawRecord : null;
  return {
    id: String(raw.id),
    role: raw.role as ConversationMessageView["role"],
    kind: raw.kind as ConversationMessageView["kind"],
    text: String(raw.text ?? ""),
    action: raw.action && typeof raw.action === "object" && !Array.isArray(raw.action) ? raw.action as ConversationMessageView["action"] : null,
    blocks: Array.isArray(raw.blocks)
      ? raw.blocks.filter((block): block is ConversationBlock => Boolean(block) && typeof block === "object" && !Array.isArray(block) && typeof (block as RawRecord).type === "string")
      : [],
    responseMetadata: raw.response_metadata && typeof raw.response_metadata === "object" && !Array.isArray(raw.response_metadata)
      ? raw.response_metadata as Record<string, unknown>
      : {},
    briefId: typeof raw.brief_id === "string" ? raw.brief_id : null,
    brief: briefRecord && typeof briefRecord.id === "string"
      ? {
        id: briefRecord.id,
        briefDate: String(briefRecord.brief_date ?? ""),
        assessment: String(briefRecord.assessment ?? ""),
        noMaterialChanges: Boolean(briefRecord.no_material_changes),
        itemCount: Number(briefRecord.item_count ?? 0),
        definitionName: typeof definitionRecord?.name === "string" ? definitionRecord.name : "Brief",
      }
      : null,
    eventId: typeof raw.event_id === "string" ? raw.event_id : null,
    watchId: typeof raw.watch_id === "string" ? raw.watch_id : null,
    createdAt: String(raw.created_at),
  };
}

export async function getSourcePolicies(client: DatabaseClient, userId: string): Promise<SourcePolicyView[]> {
  const { data, error } = await client
    .from("user_source_policies")
    .select("*")
    .eq("user_id", userId)
    .order("source_name", { ascending: true });
  if (error) throw databaseError("Kunde inte läsa källreglerna", error);
  const explicit = new Map((data ?? []).map((raw: RawRecord) => [String(raw.domain).toLowerCase(), raw]));
  const defaultEntries: SourcePolicyView[] = SOURCE_CATALOG.map((entry) => {
    const raw = explicit.get(entry.domain);
    if (raw) return mapSourcePolicy(raw, false);
    return {
      id: null,
      sourceId: null,
      domain: entry.domain,
      sourceName: entry.name,
      sourceKind: entry.kind,
      active: true,
      blocked: false,
      priority: "normal",
      roles: entry.defaultRoles,
      topicFilter: "",
      verificationRequirement: "verify_material",
      frequency: "material",
      isCustom: false,
    };
  });
  const custom = (data ?? [])
    .filter((raw: RawRecord) => !SOURCE_CATALOG.some((entry) => entry.domain === String(raw.domain).toLowerCase()))
    .map((raw: RawRecord) => mapSourcePolicy(raw, true));
  return [...defaultEntries, ...custom].sort((left, right) => left.sourceName.localeCompare(right.sourceName, "sv"));
}

export async function getExplicitSourcePolicies(client: DatabaseClient, userId: string): Promise<SourcePolicyRecord[]> {
  const { data, error } = await client
    .from("user_source_policies")
    .select("*")
    .eq("user_id", userId);
  if (error) throw databaseError("Kunde inte läsa aktiva källregler", error);
  return (data ?? []).map((raw: RawRecord) => mapSourcePolicy(raw, !SOURCE_CATALOG.some((entry) => entry.domain === String(raw.domain).toLowerCase())));
}

/**
 * A brief may tighten or relax a user's global source policy without changing
 * the policy used by their other briefs. The database stores only nullable
 * deltas; this helper restores a complete policy set before a runner uses it.
 */
export async function getEffectiveSourcePolicies(
  client: DatabaseClient,
  userId: string,
  briefDefinitionId?: string,
): Promise<SourcePolicyRecord[]> {
  const basePolicies = await getExplicitSourcePolicies(client, userId);
  if (!briefDefinitionId) return mergeSourcePolicies(basePolicies, []);

  const { data, error } = await client
    .from("brief_source_policies")
    .select("*")
    .eq("user_id", userId)
    .eq("brief_definition_id", briefDefinitionId);
  if (error) throw databaseError("Kunde inte läsa briefens källregler", error);

  return mergeSourcePolicies(basePolicies, (data ?? []).map((raw: RawRecord) => mapSourcePolicyOverride(raw)));
}

export async function getBriefSourcePolicyOverrides(client: DatabaseClient, userId: string, briefDefinitionId: string): Promise<BriefSourcePolicyOverrideView[]> {
  const { data, error } = await client
    .from("brief_source_policies")
    .select("*")
    .eq("user_id", userId)
    .eq("brief_definition_id", briefDefinitionId);
  if (error) throw databaseError("Kunde inte läsa briefens källundantag", error);
  return (data ?? []).map((raw: RawRecord) => ({
    id: String(raw.id),
    briefDefinitionId: String(raw.brief_definition_id),
    domain: String(raw.domain).toLowerCase(),
    active: typeof raw.active === "boolean" ? raw.active : null,
    blocked: typeof raw.blocked === "boolean" ? raw.blocked : null,
    priority: raw.priority === "high" || raw.priority === "normal" || raw.priority === "low" ? raw.priority : null,
    roles: Array.isArray(raw.roles) ? roleList(raw.roles) : null,
    topicFilter: typeof raw.topic_filter === "string" ? raw.topic_filter : null,
    verificationRequirement: raw.verification_requirement === "none" || raw.verification_requirement === "verify_material" || raw.verification_requirement === "primary_only" || raw.verification_requirement === "two_independent" ? raw.verification_requirement : null,
    frequency: raw.frequency === "all_relevant" || raw.frequency === "daily" || raw.frequency === "weekly" || raw.frequency === "material" ? raw.frequency : null,
  }));
}

export async function getEffectiveSourcePolicyViews(client: DatabaseClient, userId: string, briefDefinitionId: string): Promise<SourcePolicyView[]> {
  const policies = await getEffectiveSourcePolicies(client, userId, briefDefinitionId);
  return policies.map((policy) => ({
    id: null,
    sourceId: null,
    domain: policy.domain,
    sourceName: policy.sourceName,
    sourceKind: policy.sourceKind,
    active: policy.active,
    blocked: policy.blocked,
    priority: policy.priority,
    roles: policy.roles,
    topicFilter: policy.topicFilter,
    verificationRequirement: policy.verificationRequirement,
    frequency: policy.frequency,
    isCustom: !SOURCE_CATALOG.some((entry) => entry.domain === policy.domain),
  }));
}

/**
 * Service-role endpoints must restore the same event boundary that RLS gives
 * page reads. A watch is deliberately not an access grant: otherwise a user
 * could guess an event UUID, create a watch and turn that row into a data
 * exfiltration primitive. Trusted publication and watch delivery create an
 * explicit grant in the database instead.
 */
export async function userCanAccessEvent(client: DatabaseClient, userId: string, eventId: string): Promise<boolean> {
  const { data: items, error: itemsError } = await client
    .from("brief_items")
    .select("brief_id")
    .eq("event_id", eventId);
  if (itemsError) throw databaseError("Kunde inte kontrollera händelseåtkomst", itemsError);
  const briefIds = (items ?? []).map((item: RawRecord) => String(item.brief_id));
  if (briefIds.length) {
    const { data: ownedBrief, error: briefsError } = await client
      .from("briefs")
      .select("id")
      .eq("user_id", userId)
      .in("id", briefIds)
      .limit(1)
      .maybeSingle();
    if (briefsError) throw databaseError("Kunde inte kontrollera briefåtkomst", briefsError);
    if (ownedBrief) return true;
  }

  const { data: grant, error: grantError } = await client
    .from("user_event_access_grants")
    .select("event_id")
    .eq("user_id", userId)
    .eq("event_id", eventId)
    .maybeSingle();
  if (grantError) throw databaseError("Kunde inte kontrollera beviljad händelseåtkomst", grantError);
  return Boolean(grant);
}

function mapSourcePolicy(raw: RawRecord, isCustom: boolean): SourcePolicyView {
  return {
    id: typeof raw.id === "string" ? raw.id : null,
    sourceId: typeof raw.source_id === "string" ? raw.source_id : null,
    domain: String(raw.domain).toLowerCase(),
    sourceName: String(raw.source_name),
    sourceKind: raw.source_kind as SourceKind,
    active: Boolean(raw.active),
    blocked: Boolean(raw.blocked),
    priority: raw.priority as SourcePriority,
    roles: roleList(raw.roles),
    topicFilter: String(raw.topic_filter ?? ""),
    verificationRequirement: raw.verification_requirement as SourcePolicyRecord["verificationRequirement"],
    frequency: raw.frequency as SourcePolicyRecord["frequency"],
    isCustom,
  };
}

function mapSourcePolicyOverride(raw: RawRecord): Partial<SourcePolicyRecord> & Pick<SourcePolicyRecord, "domain"> {
  const value: Partial<SourcePolicyRecord> & Pick<SourcePolicyRecord, "domain"> = {
    domain: String(raw.domain).toLowerCase(),
  };
  if (typeof raw.active === "boolean") value.active = raw.active;
  if (typeof raw.blocked === "boolean") value.blocked = raw.blocked;
  if (raw.priority === "high" || raw.priority === "normal" || raw.priority === "low") value.priority = raw.priority;
  const roles = roleList(raw.roles);
  if (Array.isArray(raw.roles)) value.roles = roles;
  if (typeof raw.topic_filter === "string") value.topicFilter = raw.topic_filter;
  if (raw.verification_requirement === "none" || raw.verification_requirement === "verify_material" || raw.verification_requirement === "primary_only" || raw.verification_requirement === "two_independent") {
    value.verificationRequirement = raw.verification_requirement;
  }
  if (raw.frequency === "all_relevant" || raw.frequency === "daily" || raw.frequency === "weekly" || raw.frequency === "material") {
    value.frequency = raw.frequency;
  }
  return value;
}

export function summarizeProfileContext(context: ProfileContextView | null): string {
  if (!context) return "Profilen är ännu inte ifylld.";
  const parts = [
    context.roleTitle,
    context.workSummary,
    context.organizations.length ? context.organizations.join(", ") : "",
    context.sectors.length ? context.sectors.join(", ") : "",
    context.markets.length ? context.markets.join(", ") : "",
    context.dependencies.length ? `Beroenden: ${context.dependencies.join(", ")}` : "",
    context.decisions.length ? `Beslut: ${context.decisions.join(", ")}` : "",
    context.risks.length ? `Risker: ${context.risks.join(", ")}` : "",
    context.opportunities.length ? `Affärslägen och sammanhang: ${context.opportunities.join(", ")}` : "",
    context.interests.length ? `Fokusbolag och ämnen: ${context.interests.join(", ")}` : "",
    context.exclusions.length ? `Undvik: ${context.exclusions.join(", ")}` : "",
  ].filter(Boolean);
  return parts.join(" · ") || "Profilen är ännu inte ifylld.";
}
