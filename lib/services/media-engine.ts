import "server-only";

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { MediaEngineCronError, nextMediaEngineRunAt } from "@/lib/domain/media-engine-cron";
import {
  mediaContentHandoffUpdateSchema,
  mediaEntityIdSchema,
  mediaResearchClusterUpdateSchema,
  mediaResearchRuleCreateSchema,
  mediaResearchRuleUpdateSchema,
  mediaSourceConnectionCreateSchema,
  mediaSourceConnectionUpdateSchema,
  mediaTenantCreateSchema,
  mediaTenantMemberUpsertSchema,
  mediaTenantRoleAllows,
  mediaTenantUpdateSchema,
  publicMediaSourceUrl,
  sanitizePublicConnectorConfig,
  type MediaContentHandoffUpdateInput,
  type MediaContentHandoffView,
  type MediaResearchClusterUpdateInput,
  type MediaResearchClusterView,
  type MediaResearchDossierView,
  type MediaResearchEvidenceView,
  type MediaResearchRuleCreateInput,
  type MediaResearchRuleUpdateInput,
  type MediaResearchRuleView,
  type MediaSourceConnectionCreateInput,
  type MediaSourceConnectionUpdateInput,
  type MediaSourceConnectionView,
  type MediaTenantCreateInput,
  type MediaTenantMemberUpsertInput,
  type MediaTenantMemberView,
  type MediaTenantRole,
  type MediaTenantUpdateInput,
  type MediaTenantView,
} from "@/lib/domain/media-engine";

type DatabaseClient = SupabaseClient;
type RawRecord = Record<string, unknown>;

export class MediaEngineServiceError extends Error {
  constructor(message: string, readonly status = 500, readonly code: "forbidden" | "not_found" | "validation" | "database" = "database") {
    super(message);
    this.name = "MediaEngineServiceError";
  }
}

function databaseError(context: string, error: { message?: string; code?: string } | null): MediaEngineServiceError {
  const missingMigration = error?.code === "42P01" || /relation .*does not exist|schema cache/i.test(error?.message ?? "");
  if (missingMigration) {
    return new MediaEngineServiceError("Researchmotorns databas saknar den senaste migrationen. Kör Supabase-migrationen först.", 503, "database");
  }
  return new MediaEngineServiceError(`${context}${error?.message ? `: ${error.message}` : ""}`, 500, "database");
}

function asRecord(value: unknown): RawRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RawRecord : {};
}

function record(value: unknown): Record<string, unknown> {
  return asRecord(value);
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length ? value : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function roleValue(value: unknown): MediaTenantRole {
  return value === "owner" || value === "admin" || value === "editor" ? value : "viewer";
}

function sourceKindValue(value: unknown): MediaSourceConnectionView["kind"] {
  return value === "api" || value === "web_search" ? value : "rss";
}

function channelList(value: unknown): MediaResearchRuleView["channels"] {
  return stringList(value).filter((channel): channel is MediaResearchRuleView["channels"][number] => (
    channel === "facebook_page" || channel === "instagram" || channel === "linkedin" || channel === "newsletter"
  ));
}

function clusterStatusValue(value: unknown): MediaResearchClusterView["status"] {
  return value === "researching" || value === "ready" || value === "dismissed" || value === "published" ? value : "pending";
}

function handoffStateValue(value: unknown): MediaContentHandoffView["state"] {
  return value === "drafted" || value === "in_review" || value === "approved" || value === "scheduled"
    || value === "published" || value === "rejected" || value === "failed" ? value : "queued";
}

function dossierStatusValue(value: unknown): MediaResearchDossierView["status"] {
  return value === "ready" || value === "failed" ? value : "draft";
}

function evidenceStanceValue(value: unknown): MediaResearchEvidenceView["stance"] {
  return value === "conflicts" || value === "context" ? value : "supports";
}

function evidenceSourceTypeValue(value: unknown): MediaResearchEvidenceView["sourceType"] {
  return value === "primary" || value === "secondary" || value === "rss" || value === "api" ? value : "web_search";
}

function arrayText(value: unknown): string[] {
  return stringList(value).filter((entry) => entry.length > 0);
}

function tenantFromRow(row: RawRecord, role: MediaTenantRole): MediaTenantView {
  return {
    id: stringValue(row.id),
    slug: stringValue(row.slug),
    name: stringValue(row.name),
    timezone: stringValue(row.timezone, "Europe/Stockholm"),
    isDefault: Boolean(row.is_default),
    settings: record(row.settings),
    role,
    createdAt: stringValue(row.created_at),
    updatedAt: stringValue(row.updated_at),
  };
}

/** This projection is intentionally the only source connection shape returned by config APIs. */
export function toMediaSourceConnectionView(row: RawRecord): MediaSourceConnectionView {
  return {
    id: stringValue(row.id),
    tenantId: stringValue(row.tenant_id),
    kind: sourceKindValue(row.kind),
    provider: stringValue(row.provider),
    displayName: stringValue(row.display_name),
    baseUrl: publicMediaSourceUrl(row.base_url),
    configPublic: sanitizePublicConnectorConfig(row.config_public),
    active: row.active !== false,
    lastSyncedAt: nullableString(row.last_synced_at),
    lastError: nullableString(row.last_error),
    metadata: sanitizePublicConnectorConfig(row.metadata),
    createdAt: stringValue(row.created_at),
    updatedAt: stringValue(row.updated_at),
  };
}

function toMediaResearchRuleView(row: RawRecord, sourceIds: string[]): MediaResearchRuleView {
  const contentType = row.content_type === "newsletter" || row.content_type === "article" ? row.content_type : "social_post";
  return {
    id: stringValue(row.id),
    tenantId: stringValue(row.tenant_id),
    name: stringValue(row.name),
    active: row.active !== false,
    query: stringValue(row.query),
    includeDomains: arrayText(row.include_domains),
    excludeDomains: arrayText(row.exclude_domains),
    sourceIds,
    minMentions: Number.isInteger(row.min_mentions) ? Number(row.min_mentions) : 3,
    minUniqueDomains: Number.isInteger(row.min_unique_domains) ? Number(row.min_unique_domains) : 2,
    windowHours: Number.isInteger(row.window_hours) ? Number(row.window_hours) : 72,
    contentType,
    channels: channelList(row.channels),
    frameworkKey: stringValue(row.framework_key, "transparent-analysis"),
    imageStyle: stringValue(row.image_style, "editorial"),
    prompt: stringValue(row.prompt),
    scheduleMode: row.schedule_mode === "cron" ? "cron" : "threshold",
    cadence: row.cadence === "continuous" || row.cadence === "daily" || row.cadence === "weekly" || row.cadence === "cron" ? row.cadence : "hourly",
    cronExpression: nullableString(row.cron_expression),
    nextRunAt: nullableString(row.next_run_at),
    lastRunAt: nullableString(row.last_run_at),
    lastCheckedAt: nullableString(row.last_checked_at),
    approvalRequired: row.approval_required !== false,
    autoCreateHandoff: row.auto_create_handoff !== false,
    createdAt: stringValue(row.created_at),
    updatedAt: stringValue(row.updated_at),
  };
}

function toMediaResearchDossierView(row: RawRecord): MediaResearchDossierView {
  return {
    id: stringValue(row.id),
    clusterId: stringValue(row.cluster_id),
    status: dossierStatusValue(row.status),
    whatWeKnow: arrayText(row.what_we_know),
    whatWeDontKnow: arrayText(row.what_we_dont_know),
    whyItMatters: stringValue(row.why_it_matters),
    suggestedAngle: stringValue(row.suggested_angle),
    transparentReflection: stringValue(row.transparent_reflection),
    uncertainties: arrayText(row.uncertainties),
    conflicts: arrayText(row.conflicts),
    sourceSynthesis: stringValue(row.source_synthesis),
    structuredData: record(row.structured_data),
    evidenceCount: Number.isInteger(row.evidence_count) ? Number(row.evidence_count) : 0,
    modelName: nullableString(row.model_name),
    modelMetadata: record(row.model_metadata),
    generatedAt: nullableString(row.generated_at),
    updatedAt: stringValue(row.updated_at),
  };
}

function toMediaContentHandoffView(row: RawRecord): MediaContentHandoffView {
  return {
    id: stringValue(row.id),
    tenantId: stringValue(row.tenant_id),
    clusterId: stringValue(row.cluster_id),
    runId: nullableString(row.run_id),
    contentDraftId: nullableString(row.content_draft_id),
    state: handoffStateValue(row.state),
    draftSnapshot: record(row.draft_snapshot),
    scheduledFor: nullableString(row.scheduled_for),
    createdBy: nullableString(row.created_by),
    approvedBy: nullableString(row.approved_by),
    approvedAt: nullableString(row.approved_at),
    failureReason: nullableString(row.failure_reason),
    createdAt: stringValue(row.created_at),
    updatedAt: stringValue(row.updated_at),
  };
}

function toMediaResearchEvidenceView(row: RawRecord): MediaResearchEvidenceView {
  return {
    id: stringValue(row.id),
    clusterId: stringValue(row.cluster_id),
    itemId: nullableString(row.item_id),
    sourceName: stringValue(row.source_name),
    sourceUrl: stringValue(row.source_url),
    sourceDomain: stringValue(row.source_domain),
    sourceType: evidenceSourceTypeValue(row.source_type),
    publishedAt: nullableString(row.published_at),
    eventDate: nullableString(row.event_date),
    claim: stringValue(row.claim),
    stance: evidenceStanceValue(row.stance),
    quote: nullableString(row.quote),
    confidence: Number.isInteger(row.confidence) ? Number(row.confidence) : 50,
    createdAt: stringValue(row.created_at),
  };
}

function toMediaResearchClusterView(row: RawRecord, dossier: MediaResearchDossierView | null, handoff: MediaContentHandoffView | null): MediaResearchClusterView {
  return {
    id: stringValue(row.id),
    tenantId: stringValue(row.tenant_id),
    canonicalKey: stringValue(row.canonical_key),
    title: stringValue(row.title),
    status: clusterStatusValue(row.status),
    mentionCount: Number.isInteger(row.mention_count) ? Number(row.mention_count) : 0,
    uniqueDomainCount: Number.isInteger(row.unique_domain_count) ? Number(row.unique_domain_count) : 0,
    significanceScore: typeof row.significance_score === "number" ? row.significance_score : null,
    firstSeenAt: stringValue(row.first_seen_at),
    lastSeenAt: stringValue(row.last_seen_at),
    summary: nullableString(row.summary),
    frameworkKey: nullableString(row.framework_key),
    imageBrief: nullableString(row.image_brief),
    dossier,
    handoff,
    createdAt: stringValue(row.created_at),
    updatedAt: stringValue(row.updated_at),
  };
}

async function getTenantMembership(client: DatabaseClient, userId: string, tenantId: string): Promise<MediaTenantView | null> {
  const { data: membership, error: membershipError } = await client
    .from("media_tenant_members")
    .select("tenant_id, role")
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .maybeSingle();
  if (membershipError) throw databaseError("Kunde inte kontrollera medlemskapet", membershipError);
  if (!membership) return null;
  const { data: tenant, error: tenantError } = await client
    .from("media_tenants")
    .select("*")
    .eq("id", tenantId)
    .maybeSingle();
  if (tenantError) throw databaseError("Kunde inte läsa arbetsytan", tenantError);
  if (!tenant) return null;
  return tenantFromRow(asRecord(tenant), roleValue(asRecord(membership).role));
}

async function requireTenantRole(client: DatabaseClient, userId: string, tenantId: string, required: MediaTenantRole): Promise<MediaTenantView> {
  const tenant = await getTenantMembership(client, userId, tenantId);
  if (!tenant) throw new MediaEngineServiceError("Arbetsytan hittades inte eller är inte tillgänglig för dig.", 404, "not_found");
  if (!mediaTenantRoleAllows(tenant.role, required)) {
    throw new MediaEngineServiceError("Du har inte behörighet att ändra den här arbetsytan.", 403, "forbidden");
  }
  return tenant;
}

/** Creates the deterministic default workspace through the SQL bootstrap function. */
export async function ensureDefaultMediaTenant(client: DatabaseClient, userId: string): Promise<MediaTenantView> {
  const { data, error } = await client.rpc("ensure_default_media_tenant", { p_user_id: userId });
  if (error) throw databaseError("Kunde inte skapa eller läsa standardarbetsytan", error);
  const tenantId = typeof data === "string" ? data : "";
  if (!tenantId) throw new MediaEngineServiceError("Standardarbetsytan kunde inte skapas.", 500, "database");
  const tenant = await getTenantMembership(client, userId, tenantId);
  if (!tenant) throw new MediaEngineServiceError("Standardarbetsytan saknar ett giltigt medlemskap.", 500, "database");
  return tenant;
}

export async function listMediaTenants(client: DatabaseClient, userId: string): Promise<MediaTenantView[]> {
  await ensureDefaultMediaTenant(client, userId);
  const { data: memberships, error } = await client
    .from("media_tenant_members")
    .select("tenant_id, role")
    .eq("user_id", userId);
  if (error) throw databaseError("Kunde inte läsa dina arbetsytor", error);
  const rows = (memberships ?? []).map((entry) => asRecord(entry));
  const ids = rows.map((entry) => stringValue(entry.tenant_id)).filter(Boolean);
  if (!ids.length) return [];
  const { data: tenants, error: tenantError } = await client
    .from("media_tenants")
    .select("*")
    .in("id", ids);
  if (tenantError) throw databaseError("Kunde inte läsa arbetsytorna", tenantError);
  const roles = new Map(rows.map((entry) => [stringValue(entry.tenant_id), roleValue(entry.role)]));
  return (tenants ?? [])
    .map((entry) => tenantFromRow(asRecord(entry), roles.get(stringValue(asRecord(entry).id)) ?? "viewer"))
    .sort((left, right) => Number(right.isDefault) - Number(left.isDefault) || left.name.localeCompare(right.name, "sv"));
}

export async function getMediaTenantForUser(client: DatabaseClient, userId: string, tenantId: string): Promise<MediaTenantView | null> {
  mediaEntityIdSchema.parse(tenantId);
  return getTenantMembership(client, userId, tenantId);
}

function slugForTenant(value: string): string {
  const normalized = value.normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 66)
    .replace(/-+$/g, "");
  return normalized || "arbetsyta";
}

export async function createMediaTenant(client: DatabaseClient, userId: string, input: MediaTenantCreateInput): Promise<MediaTenantView> {
  const payload = mediaTenantCreateSchema.parse(input);
  const base = payload.slug ?? slugForTenant(payload.name);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const slug = attempt === 0 ? base : `${base.slice(0, 66)}-${randomUUID().slice(0, 8)}`;
    const { data, error } = await client.rpc("create_media_tenant", {
      p_owner_user_id: userId,
      p_name: payload.name,
      p_slug: slug,
      p_timezone: payload.timezone,
      p_is_default: false,
    });
    if (!error && typeof data === "string") {
      const tenant = await getTenantMembership(client, userId, data);
      if (tenant) {
        if (Object.keys(payload.settings).length) await updateMediaTenant(client, userId, data, { settings: payload.settings });
        return (await getTenantMembership(client, userId, data)) ?? tenant;
      }
    }
    if (error?.code !== "23505") throw databaseError("Kunde inte skapa arbetsytan", error);
  }
  throw new MediaEngineServiceError("Kunde inte skapa en unik arbetsyteadress. Försök igen.", 409, "validation");
}

export async function updateMediaTenant(client: DatabaseClient, userId: string, tenantId: string, input: MediaTenantUpdateInput): Promise<MediaTenantView | null> {
  const payload = mediaTenantUpdateSchema.parse(input);
  const tenant = await requireTenantRole(client, userId, tenantId, "admin");
  const values: RawRecord = {};
  if (payload.name !== undefined) values.name = payload.name;
  if (payload.timezone !== undefined) values.timezone = payload.timezone;
  if (payload.settings !== undefined) values.settings = payload.settings;
  const { data, error } = await client
    .from("media_tenants")
    .update(values)
    .eq("id", tenantId)
    .select("*")
    .maybeSingle();
  if (error) throw databaseError("Kunde inte uppdatera arbetsytan", error);
  return data ? tenantFromRow(asRecord(data), tenant.role) : null;
}

export async function deleteMediaTenant(client: DatabaseClient, userId: string, tenantId: string): Promise<boolean> {
  await requireTenantRole(client, userId, tenantId, "owner");
  const { data, error } = await client
    .from("media_tenants")
    .delete()
    .eq("id", tenantId)
    .eq("owner_user_id", userId)
    .select("id")
    .maybeSingle();
  if (error) throw databaseError("Kunde inte ta bort arbetsytan", error);
  return Boolean(data);
}

export async function listMediaTenantMembers(client: DatabaseClient, userId: string, tenantId: string): Promise<MediaTenantMemberView[]> {
  await requireTenantRole(client, userId, tenantId, "viewer");
  const { data, error } = await client
    .from("media_tenant_members")
    .select("tenant_id, user_id, role, created_at, updated_at")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: true });
  if (error) throw databaseError("Kunde inte läsa arbetsytans medlemmar", error);
  return (data ?? []).map((entry) => {
    const row = asRecord(entry);
    return {
      tenantId: stringValue(row.tenant_id),
      userId: stringValue(row.user_id),
      role: roleValue(row.role),
      createdAt: stringValue(row.created_at),
      updatedAt: stringValue(row.updated_at),
    };
  });
}

export async function upsertMediaTenantMember(client: DatabaseClient, userId: string, tenantId: string, input: MediaTenantMemberUpsertInput): Promise<MediaTenantMemberView> {
  mediaTenantMemberUpsertSchema.parse(input);
  await requireTenantRole(client, userId, tenantId, "admin");
  const payload = mediaTenantMemberUpsertSchema.parse(input);
  const { data: profile, error: profileError } = await client.from("profiles").select("user_id").eq("user_id", payload.userId).maybeSingle();
  if (profileError) throw databaseError("Kunde inte kontrollera användaren", profileError);
  if (!profile) throw new MediaEngineServiceError("Användaren har ingen Brief-profil ännu.", 422, "validation");
  const { data, error } = await client
    .from("media_tenant_members")
    .upsert({ tenant_id: tenantId, user_id: payload.userId, role: payload.role }, { onConflict: "tenant_id,user_id" })
    .select("tenant_id, user_id, role, created_at, updated_at")
    .single();
  if (error) throw databaseError("Kunde inte spara medlemskapet", error);
  const row = asRecord(data);
  return { tenantId: stringValue(row.tenant_id), userId: stringValue(row.user_id), role: roleValue(row.role), createdAt: stringValue(row.created_at), updatedAt: stringValue(row.updated_at) };
}

export async function removeMediaTenantMember(client: DatabaseClient, userId: string, tenantId: string, memberUserId: string): Promise<boolean> {
  await requireTenantRole(client, userId, tenantId, "admin");
  const { data: member, error: memberError } = await client
    .from("media_tenant_members")
    .select("role")
    .eq("tenant_id", tenantId)
    .eq("user_id", memberUserId)
    .maybeSingle();
  if (memberError) throw databaseError("Kunde inte läsa medlemskapet", memberError);
  if (!member) return false;
  if (asRecord(member).role === "owner") {
    throw new MediaEngineServiceError("Ägaren kan inte tas bort från arbetsytan i V1.", 422, "validation");
  }
  const { data, error } = await client
    .from("media_tenant_members")
    .delete()
    .eq("tenant_id", tenantId)
    .eq("user_id", memberUserId)
    .select("user_id")
    .maybeSingle();
  if (error) throw databaseError("Kunde inte ta bort medlemmen", error);
  return Boolean(data);
}

export async function listMediaSourceConnections(client: DatabaseClient, userId: string, tenantId: string): Promise<MediaSourceConnectionView[]> {
  await requireTenantRole(client, userId, tenantId, "viewer");
  const { data, error } = await client
    .from("media_source_connections")
    .select("*")
    .eq("tenant_id", tenantId)
    .order("display_name", { ascending: true });
  if (error) throw databaseError("Kunde inte läsa källkopplingarna", error);
  return (data ?? []).map((entry) => toMediaSourceConnectionView(asRecord(entry)));
}

export async function getMediaSourceConnectionForUser(client: DatabaseClient, userId: string, tenantId: string, sourceId: string): Promise<MediaSourceConnectionView | null> {
  await requireTenantRole(client, userId, tenantId, "viewer");
  const { data, error } = await client
    .from("media_source_connections")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("id", sourceId)
    .maybeSingle();
  if (error) throw databaseError("Kunde inte läsa källkopplingen", error);
  return data ? toMediaSourceConnectionView(asRecord(data)) : null;
}

function sourceRow(payload: ReturnType<typeof mediaSourceConnectionCreateSchema.parse>): RawRecord {
  return {
    tenant_id: payload.tenantId,
    kind: payload.kind,
    provider: payload.provider,
    display_name: payload.displayName,
    base_url: payload.baseUrl ?? null,
    config_public: payload.configPublic,
    active: payload.active,
    metadata: payload.metadata,
  };
}

export async function createMediaSourceConnection(client: DatabaseClient, userId: string, input: MediaSourceConnectionCreateInput): Promise<MediaSourceConnectionView> {
  const payload = mediaSourceConnectionCreateSchema.parse(input);
  await requireTenantRole(client, userId, payload.tenantId, "editor");
  const { data, error } = await client.from("media_source_connections").insert(sourceRow(payload)).select("*").single();
  if (error) throw databaseError("Kunde inte skapa källkopplingen", error);
  return toMediaSourceConnectionView(asRecord(data));
}

export async function updateMediaSourceConnection(client: DatabaseClient, userId: string, tenantId: string, sourceId: string, input: MediaSourceConnectionUpdateInput): Promise<MediaSourceConnectionView | null> {
  const payload = mediaSourceConnectionUpdateSchema.parse(input);
  await requireTenantRole(client, userId, tenantId, "editor");
  // PATCH is intentionally partial, but a source can become runnable only
  // when its *merged* state is valid. Without this check an API client could
  // turn a URL-less web-search source into RSS/API (or clear its executable
  // URL/endpoint) and leave an active connector that fails on every later
  // cron run. Pausing a legacy invalid source remains possible so operators
  // can safely contain it.
  const current = await getMediaSourceConnectionForUser(client, userId, tenantId, sourceId);
  if (!current) return null;
  const merged = {
    tenantId,
    kind: payload.kind ?? current.kind,
    provider: payload.provider ?? current.provider,
    displayName: payload.displayName ?? current.displayName,
    baseUrl: payload.baseUrl !== undefined ? payload.baseUrl : current.baseUrl,
    configPublic: payload.configPublic ?? current.configPublic,
    active: payload.active ?? current.active,
    metadata: payload.metadata ?? current.metadata,
  };
  if (merged.active) mediaSourceConnectionCreateSchema.parse(merged);
  const values: RawRecord = {};
  if (payload.kind !== undefined) values.kind = payload.kind;
  if (payload.provider !== undefined) values.provider = payload.provider;
  if (payload.displayName !== undefined) values.display_name = payload.displayName;
  if (payload.baseUrl !== undefined) values.base_url = payload.baseUrl;
  if (payload.configPublic !== undefined) values.config_public = payload.configPublic;
  if (payload.active !== undefined) values.active = payload.active;
  if (payload.metadata !== undefined) values.metadata = payload.metadata;
  const { data, error } = await client
    .from("media_source_connections")
    .update(values)
    .eq("tenant_id", tenantId)
    .eq("id", sourceId)
    .select("*")
    .maybeSingle();
  if (error) throw databaseError("Kunde inte uppdatera källkopplingen", error);
  return data ? toMediaSourceConnectionView(asRecord(data)) : null;
}

export async function deleteMediaSourceConnection(client: DatabaseClient, userId: string, tenantId: string, sourceId: string): Promise<boolean> {
  await requireTenantRole(client, userId, tenantId, "editor");
  const { data, error } = await client
    .from("media_source_connections")
    .delete()
    .eq("tenant_id", tenantId)
    .eq("id", sourceId)
    .select("id")
    .maybeSingle();
  if (error) throw databaseError("Kunde inte ta bort källkopplingen", error);
  return Boolean(data);
}

async function validateRuleSources(client: DatabaseClient, tenantId: string, sourceIds: string[]): Promise<void> {
  if (!sourceIds.length) return;
  const { data, error } = await client
    .from("media_source_connections")
    .select("id")
    .eq("tenant_id", tenantId)
    .in("id", sourceIds);
  if (error) throw databaseError("Kunde inte kontrollera regelns källor", error);
  if ((data ?? []).length !== sourceIds.length) {
    throw new MediaEngineServiceError("En eller flera valda källor tillhör inte arbetsytan.", 422, "validation");
  }
}

function ruleRow(payload: ReturnType<typeof mediaResearchRuleCreateSchema.parse>): RawRecord {
  return {
    tenant_id: payload.tenantId,
    name: payload.name,
    active: payload.active,
    query: payload.query,
    include_domains: payload.includeDomains,
    exclude_domains: payload.excludeDomains,
    min_mentions: payload.minMentions,
    min_unique_domains: payload.minUniqueDomains,
    window_hours: payload.windowHours,
    content_type: payload.contentType,
    channels: payload.channels,
    framework_key: payload.frameworkKey,
    image_style: payload.imageStyle,
    prompt: payload.prompt,
    schedule_mode: payload.scheduleMode,
    cadence: payload.cadence,
    cron_expression: payload.cronExpression ?? null,
    next_run_at: payload.nextRunAt ?? null,
    approval_required: payload.approvalRequired,
    auto_create_handoff: payload.autoCreateHandoff,
  };
}

function scheduledRulePayload(
  payload: ReturnType<typeof mediaResearchRuleCreateSchema.parse>,
  timezone: string,
  options: { recompute?: boolean } = {},
): ReturnType<typeof mediaResearchRuleCreateSchema.parse> {
  if (!payload.active) return { ...payload, nextRunAt: null };
  if (!options.recompute && payload.nextRunAt) return payload;
  try {
    return {
      ...payload,
      nextRunAt: nextMediaEngineRunAt({
        active: payload.active,
        scheduleMode: payload.scheduleMode,
        cadence: payload.cadence,
        cronExpression: payload.cronExpression ?? null,
      }, new Date(), timezone),
    };
  } catch (error) {
    if (error instanceof MediaEngineCronError) throw new MediaEngineServiceError(error.message, 422, "validation");
    throw error;
  }
}

async function sourceIdsByRule(client: DatabaseClient, tenantId: string, ruleIds: string[]): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>(ruleIds.map((id) => [id, [] as string[]]));
  if (!ruleIds.length) return result;
  const { data, error } = await client
    .from("media_research_rule_sources")
    .select("rule_id, source_connection_id")
    .eq("tenant_id", tenantId)
    .in("rule_id", ruleIds);
  if (error) throw databaseError("Kunde inte läsa regelns källor", error);
  for (const entry of data ?? []) {
    const row = asRecord(entry);
    const ruleId = stringValue(row.rule_id);
    const sourceId = stringValue(row.source_connection_id);
    if (ruleId && sourceId) result.get(ruleId)?.push(sourceId);
  }
  return result;
}

export async function listMediaResearchRules(client: DatabaseClient, userId: string, tenantId: string): Promise<MediaResearchRuleView[]> {
  await requireTenantRole(client, userId, tenantId, "viewer");
  const { data, error } = await client
    .from("media_research_rules")
    .select("*")
    .eq("tenant_id", tenantId)
    .order("updated_at", { ascending: false });
  if (error) throw databaseError("Kunde inte läsa researchreglerna", error);
  const rows = (data ?? []).map((entry) => asRecord(entry));
  const sourceIds = await sourceIdsByRule(client, tenantId, rows.map((row) => stringValue(row.id)).filter(Boolean));
  return rows.map((row) => toMediaResearchRuleView(row, sourceIds.get(stringValue(row.id)) ?? []));
}

export async function getMediaResearchRuleForUser(client: DatabaseClient, userId: string, tenantId: string, ruleId: string): Promise<MediaResearchRuleView | null> {
  await requireTenantRole(client, userId, tenantId, "viewer");
  const { data, error } = await client
    .from("media_research_rules")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("id", ruleId)
    .maybeSingle();
  if (error) throw databaseError("Kunde inte läsa researchregeln", error);
  if (!data) return null;
  const row = asRecord(data);
  const sourceIds = await sourceIdsByRule(client, tenantId, [stringValue(row.id)]);
  return toMediaResearchRuleView(row, sourceIds.get(stringValue(row.id)) ?? []);
}

export async function createMediaResearchRule(client: DatabaseClient, userId: string, input: MediaResearchRuleCreateInput): Promise<MediaResearchRuleView> {
  const payload = mediaResearchRuleCreateSchema.parse(input);
  const tenant = await requireTenantRole(client, userId, payload.tenantId, "editor");
  const scheduled = scheduledRulePayload(payload, tenant.timezone);
  await validateRuleSources(client, scheduled.tenantId, scheduled.sourceIds);
  const { data, error } = await client.from("media_research_rules").insert(ruleRow(scheduled)).select("*").single();
  if (error) throw databaseError("Kunde inte skapa researchregeln", error);
  const rule = asRecord(data);
  if (scheduled.sourceIds.length) {
    const { error: linkError } = await client.from("media_research_rule_sources").insert(
      scheduled.sourceIds.map((sourceId) => ({ tenant_id: scheduled.tenantId, rule_id: rule.id, source_connection_id: sourceId })),
    );
    if (linkError) {
      await client.from("media_research_rules").delete().eq("id", rule.id).eq("tenant_id", scheduled.tenantId);
      throw databaseError("Kunde inte koppla regelns källor", linkError);
    }
  }
  return toMediaResearchRuleView(rule, scheduled.sourceIds);
}

function fullRuleInput(view: MediaResearchRuleView): MediaResearchRuleCreateInput {
  return {
    tenantId: view.tenantId,
    name: view.name,
    active: view.active,
    query: view.query,
    includeDomains: view.includeDomains,
    excludeDomains: view.excludeDomains,
    sourceIds: view.sourceIds,
    minMentions: view.minMentions,
    minUniqueDomains: view.minUniqueDomains,
    windowHours: view.windowHours,
    contentType: view.contentType,
    channels: view.channels,
    frameworkKey: view.frameworkKey,
    imageStyle: view.imageStyle,
    prompt: view.prompt,
    scheduleMode: view.scheduleMode,
    cadence: view.cadence,
    cronExpression: view.cronExpression,
    nextRunAt: view.nextRunAt,
    approvalRequired: view.approvalRequired,
    autoCreateHandoff: view.autoCreateHandoff,
  };
}

export async function updateMediaResearchRule(client: DatabaseClient, userId: string, tenantId: string, ruleId: string, input: MediaResearchRuleUpdateInput): Promise<MediaResearchRuleView | null> {
  const patch = mediaResearchRuleUpdateSchema.parse(input);
  const tenant = await requireTenantRole(client, userId, tenantId, "editor");
  const current = await getMediaResearchRuleForUser(client, userId, tenantId, ruleId);
  if (!current) return null;
  const merged = mediaResearchRuleCreateSchema.parse({ ...fullRuleInput(current), ...patch, tenantId });
  const scheduleChanged = patch.active !== undefined || patch.scheduleMode !== undefined || patch.cadence !== undefined || patch.cronExpression !== undefined;
  const scheduled = scheduledRulePayload(merged, tenant.timezone, { recompute: scheduleChanged || !merged.nextRunAt });
  await validateRuleSources(client, tenantId, scheduled.sourceIds);
  const { data, error } = await client
    .from("media_research_rules")
    .update(ruleRow(scheduled))
    .eq("tenant_id", tenantId)
    .eq("id", ruleId)
    .select("*")
    .maybeSingle();
  if (error) throw databaseError("Kunde inte uppdatera researchregeln", error);
  if (!data) return null;
  if (patch.sourceIds !== undefined) {
    const { error: clearError } = await client.from("media_research_rule_sources").delete().eq("tenant_id", tenantId).eq("rule_id", ruleId);
    if (clearError) throw databaseError("Kunde inte uppdatera regelns källor", clearError);
    if (scheduled.sourceIds.length) {
      const { error: linkError } = await client.from("media_research_rule_sources").insert(
        scheduled.sourceIds.map((sourceId) => ({ tenant_id: tenantId, rule_id: ruleId, source_connection_id: sourceId })),
      );
      if (linkError) throw databaseError("Kunde inte spara regelns källor", linkError);
    }
  }
  return toMediaResearchRuleView(asRecord(data), scheduled.sourceIds);
}

export async function deleteMediaResearchRule(client: DatabaseClient, userId: string, tenantId: string, ruleId: string): Promise<boolean> {
  await requireTenantRole(client, userId, tenantId, "editor");
  const { data, error } = await client
    .from("media_research_rules")
    .delete()
    .eq("tenant_id", tenantId)
    .eq("id", ruleId)
    .select("id")
    .maybeSingle();
  if (error) throw databaseError("Kunde inte ta bort researchregeln", error);
  return Boolean(data);
}

async function clusterExtras(client: DatabaseClient, tenantId: string, clusterIds: string[]) {
  const dossiers = new Map<string, MediaResearchDossierView>();
  const dossierLeaseTokens = new Map<string, string | null>();
  const handoffs = new Map<string, MediaContentHandoffView>();
  if (!clusterIds.length) return { dossiers, dossierLeaseTokens, handoffs };
  const [dossierResult, handoffResult] = await Promise.all([
    // A cluster can retain prior failed/ready revisions for audit. The normal
    // product view must never choose an arbitrary historical row just because
    // it happened to be returned last by the database.
    client.from("media_research_dossiers").select("*").eq("tenant_id", tenantId).eq("is_current", true).in("cluster_id", clusterIds),
    client.from("media_content_handoffs").select("*").eq("tenant_id", tenantId).in("cluster_id", clusterIds),
  ]);
  if (dossierResult.error) throw databaseError("Kunde inte läsa researchdossierer", dossierResult.error);
  if (handoffResult.error) throw databaseError("Kunde inte läsa innehållshandoffs", handoffResult.error);
  for (const entry of dossierResult.data ?? []) {
    const row = asRecord(entry);
    const dossier = toMediaResearchDossierView(row);
    dossiers.set(dossier.clusterId, dossier);
    dossierLeaseTokens.set(dossier.clusterId, nullableString(row.research_lease_token));
  }
  for (const entry of handoffResult.data ?? []) {
    const handoff = toMediaContentHandoffView(asRecord(entry));
    handoffs.set(handoff.clusterId, handoff);
  }
  return { dossiers, dossierLeaseTokens, handoffs };
}

export async function listMediaResearchClusters(client: DatabaseClient, userId: string, tenantId: string): Promise<MediaResearchClusterView[]> {
  await requireTenantRole(client, userId, tenantId, "viewer");
  const { data, error } = await client
    .from("media_research_clusters")
    .select("*")
    .eq("tenant_id", tenantId)
    .order("last_seen_at", { ascending: false })
    .limit(100);
  if (error) throw databaseError("Kunde inte läsa researchklustren", error);
  const rows = (data ?? []).map((entry) => asRecord(entry));
  const extras = await clusterExtras(client, tenantId, rows.map((row) => stringValue(row.id)).filter(Boolean));
  return rows.map((row) => toMediaResearchClusterView(
    row,
    extras.dossiers.get(stringValue(row.id)) ?? null,
    extras.handoffs.get(stringValue(row.id)) ?? null,
  ));
}

export async function getMediaResearchClusterForUser(client: DatabaseClient, userId: string, tenantId: string, clusterId: string): Promise<MediaResearchClusterView | null> {
  await requireTenantRole(client, userId, tenantId, "viewer");
  const { data, error } = await client
    .from("media_research_clusters")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("id", clusterId)
    .maybeSingle();
  if (error) throw databaseError("Kunde inte läsa researchklustret", error);
  if (!data) return null;
  const row = asRecord(data);
  const extras = await clusterExtras(client, tenantId, [clusterId]);
  const cluster = toMediaResearchClusterView(row, extras.dossiers.get(clusterId) ?? null, extras.handoffs.get(clusterId) ?? null);
  // Evidence is revisioned with the research lease token. Return nothing for
  // a cluster without a current dossier, and only the exact chain that backs
  // the current dossier (including legacy rows whose token is null).
  let evidence: unknown[] = [];
  if (extras.dossiers.has(clusterId)) {
    let evidenceQuery = client
      .from("media_research_evidence")
      .select("*")
      .eq("tenant_id", tenantId)
      .eq("cluster_id", clusterId);
    const currentLeaseToken = extras.dossierLeaseTokens.get(clusterId) ?? null;
    evidenceQuery = currentLeaseToken
      ? evidenceQuery.eq("research_lease_token", currentLeaseToken)
      : evidenceQuery.is("research_lease_token", null);
    const { data: evidenceData, error: evidenceError } = await evidenceQuery.order("created_at", { ascending: false });
    if (evidenceError) throw databaseError("Kunde inte läsa klustrets källkedja", evidenceError);
    evidence = evidenceData ?? [];
  }
  return { ...cluster, evidence: evidence.map((entry) => toMediaResearchEvidenceView(asRecord(entry))) };
}

/** Only dismissal/restoration is exposed here; research and publication are separate controlled operations. */
export async function updateMediaResearchCluster(client: DatabaseClient, userId: string, tenantId: string, clusterId: string, input: MediaResearchClusterUpdateInput): Promise<MediaResearchClusterView | null> {
  const payload = mediaResearchClusterUpdateSchema.parse(input);
  if (payload.status !== "dismissed" && payload.status !== "pending") {
    throw new MediaEngineServiceError("Klusterstatus kan här bara återställas eller avfärdas. Research och publicering har egna steg.", 422, "validation");
  }
  await requireTenantRole(client, userId, tenantId, "editor");
  const { data, error } = await client
    .from("media_research_clusters")
    .update({ status: payload.status })
    .eq("tenant_id", tenantId)
    .eq("id", clusterId)
    .select("*")
    .maybeSingle();
  if (error) throw databaseError("Kunde inte ändra klustrets status", error);
  if (!data) return null;
  return getMediaResearchClusterForUser(client, userId, tenantId, clusterId);
}

export async function getMediaContentHandoffForUser(client: DatabaseClient, userId: string, tenantId: string, handoffId: string): Promise<MediaContentHandoffView | null> {
  await requireTenantRole(client, userId, tenantId, "viewer");
  const { data, error } = await client
    .from("media_content_handoffs")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("id", handoffId)
    .maybeSingle();
  if (error) throw databaseError("Kunde inte läsa innehållshandoff", error);
  return data ? toMediaContentHandoffView(asRecord(data)) : null;
}

/**
 * Editorial transitions are auditable.  A regular editor can prepare/reject a
 * draft, while approval and scheduling are held for tenant owner/admin.  This
 * function never sets `published`; provider workers remain the only path to it.
 */
export async function updateMediaContentHandoffState(
  client: DatabaseClient,
  userId: string,
  tenantId: string,
  handoffId: string,
  input: MediaContentHandoffUpdateInput,
): Promise<MediaContentHandoffView | null> {
  const payload = mediaContentHandoffUpdateSchema.parse(input);
  const existing = await getMediaContentHandoffForUser(client, userId, tenantId, handoffId);
  if (!existing) return null;
  const nextState = payload.state ?? existing.state;
  if (nextState === "published") {
    throw new MediaEngineServiceError("Publicering kan inte göras från researchpanelen.", 422, "validation");
  }
  const needsAdmin = nextState === "approved" || nextState === "scheduled";
  await requireTenantRole(client, userId, tenantId, needsAdmin ? "admin" : "editor");
  const scheduledFor = payload.scheduledFor === undefined
    ? existing.scheduledFor
    : payload.scheduledFor;
  if (nextState === "scheduled" && !scheduledFor) {
    throw new MediaEngineServiceError("En schemalagd handoff behöver en tidpunkt.", 422, "validation");
  }
  const now = new Date().toISOString();
  const row: RawRecord = {
    state: nextState,
    scheduled_for: nextState === "scheduled" ? scheduledFor : null,
  };
  if (needsAdmin) {
    row.approved_by = userId;
    row.approved_at = existing.approvedAt ?? now;
  }
  if (nextState === "failed" && payload.note) row.failure_reason = payload.note;
  const { data, error } = await client
    .from("media_content_handoffs")
    .update(row)
    .eq("tenant_id", tenantId)
    .eq("id", handoffId)
    .select("*")
    .maybeSingle();
  if (error) throw databaseError("Kunde inte uppdatera innehållshandoff", error);
  if (!data) return null;
  const { error: eventError } = await client.from("media_content_handoff_events").insert({
    tenant_id: tenantId,
    handoff_id: handoffId,
    actor_user_id: userId,
    from_state: existing.state,
    to_state: nextState,
    note: payload.note ?? null,
  });
  if (eventError) throw databaseError("Kunde inte spara handoffens granskningsspår", eventError);
  return toMediaContentHandoffView(asRecord(data));
}
