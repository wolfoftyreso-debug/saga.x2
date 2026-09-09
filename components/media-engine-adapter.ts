/**
 * Client-facing view models for the Media Engine workspace.
 *
 * The server remains the source of truth. These helpers deliberately accept
 * a narrow, defensive subset of the API payload so the Studio can show a
 * clear setup state while a tenant, sources, or pipeline are still missing.
 */

export type MediaEngineConfiguration = {
  ready: boolean;
  missing: string[];
};

export type MediaTenantView = {
  id: string;
  slug: string;
  name: string;
  role: string;
  timezone: string;
  settings: Record<string, unknown>;
};

export type MediaSourceView = {
  id: string;
  kind: string;
  provider: string;
  displayName: string;
  baseUrl: string | null;
  configPublic: Record<string, unknown>;
  active: boolean;
  status: "active" | "paused" | "error";
  lastSyncedAt: string | null;
  lastError: string | null;
  metadata: Record<string, unknown>;
};

export type MediaRuleView = {
  id: string;
  name: string;
  query: string;
  domains: string[];
  excludeDomains: string[];
  sourceIds: string[];
  minUniqueDomains: number;
  minMentions: number;
  windowHours: number;
  contentType: string;
  channels: string[];
  frameworkKey: string;
  imageStyle: string;
  prompt: string;
  scheduleMode: string;
  cadence: string;
  cronExpression: string | null;
  approvalRequired: boolean;
  autoCreateHandoff: boolean;
  active: boolean;
  updatedAt: string | null;
  lastRunAt: string | null;
};

export type MediaEvidenceView = {
  id: string;
  sourceName: string;
  url: string;
  domain: string;
  sourceType: string;
  publishedAt: string | null;
  eventDate: string | null;
  supportsClaim: string;
  stance: "supports" | "conflicts" | "context" | "unknown";
};

export type MediaHandoffView = {
  id: string;
  clusterId: string | null;
  status: "queued" | "drafted" | "in_review" | "approved" | "scheduled" | "published" | "rejected" | "failed" | "unknown";
  contentType: string;
  frameworkKey: string;
  imageStyle: string;
  scheduleMode: string;
  approvalRequired: boolean;
  contentDraftId: string | null;
  scheduledAt: string | null;
};

export type MediaDossierView = {
  id: string;
  clusterId: string | null;
  status: "draft" | "ready" | "failed" | "unknown";
  whatWeKnow: string;
  whatWeDontKnow: string;
  whyItMatters: string;
  suggestedAngle: string;
  reflection: string;
  uncertainties: string[];
  conflicts: string[];
  evidence: MediaEvidenceView[];
  imageDirection: string;
  createdAt: string | null;
  updatedAt: string | null;
};

export type MediaClusterView = {
  id: string;
  title: string;
  status: "collecting" | "threshold_met" | "researching" | "ready" | "dismissed" | "pending" | "published" | "unknown";
  summary: string;
  reflection: string;
  mentionCount: number;
  uniqueDomainCount: number;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  dossier: MediaDossierView | null;
  handoff: MediaHandoffView | null;
};

export type MediaRunView = {
  id: string;
  status: "queued" | "running" | "completed" | "failed" | "unknown";
  startedAt: string | null;
  completedAt: string | null;
  ruleId: string | null;
  sourceCount: number | null;
  clusterCount: number | null;
  error: string | null;
};

export type MediaEngineSnapshot = {
  tenant: MediaTenantView | null;
  tenants: MediaTenantView[];
  configuration: MediaEngineConfiguration;
  sources: MediaSourceView[];
  rules: MediaRuleView[];
  clusters: MediaClusterView[];
  runs: MediaRunView[];
};

export const EMPTY_MEDIA_ENGINE: MediaEngineSnapshot = {
  tenant: null,
  tenants: [],
  configuration: { ready: false, missing: [] },
  sources: [],
  rules: [],
  clusters: [],
  runs: [],
};

const sourceStatusValues = new Set<MediaSourceView["status"]>(["active", "paused", "error"]);
const clusterStatusValues = new Set<MediaClusterView["status"]>(["collecting", "threshold_met", "researching", "ready", "dismissed", "pending", "published"]);
const dossierStatusValues = new Set<MediaDossierView["status"]>(["draft", "ready", "failed"]);
const handoffStatusValues = new Set<Exclude<MediaHandoffView["status"], "unknown">>(["queued", "drafted", "in_review", "approved", "scheduled", "published", "rejected", "failed"]);
const runStatusValues = new Set<Exclude<MediaRunView["status"], "unknown">>(["queued", "running", "completed", "failed"]);

export function mediaEngineFromPayload(payload: unknown): MediaEngineSnapshot {
  const record = isRecord(payload) ? payload : {};
  const dossiers = asArray(record.dossiers).map(dossierFromPayload).filter((item): item is MediaDossierView => item !== null);
  const dossierByCluster = new Map(dossiers.flatMap((item) => item.clusterId ? [[item.clusterId, item] as const] : []));
  const handoffs = asArray(record.handoffs).map(handoffFromPayload).filter((item): item is MediaHandoffView => item !== null);
  const handoffByCluster = new Map(handoffs.flatMap((item) => item.clusterId ? [[item.clusterId, item] as const] : []));
  const tenants = tenantListFromPayload(record.tenants);
  const tenant = tenantFromPayload(record.tenant) ?? tenants[0] ?? null;
  return {
    tenant,
    tenants,
    configuration: configurationFromPayload(record.configuration),
    sources: asArray(record.sources).map(sourceFromPayload).filter((item): item is MediaSourceView => item !== null),
    rules: asArray(record.rules).map(ruleFromPayload).filter((item): item is MediaRuleView => item !== null),
    clusters: asArray(record.clusters).map((item) => clusterFromPayload(item, dossierByCluster, handoffByCluster)).filter((item): item is MediaClusterView => item !== null),
    runs: asArray(record.runs).map(runFromPayload).filter((item): item is MediaRunView => item !== null),
  };
}

export function tenantListFromPayload(payload: unknown): MediaTenantView[] {
  const record = isRecord(payload) ? payload : {};
  const values = Array.isArray(payload) ? payload : asArray(record.tenants);
  return values.map(tenantFromPayload).filter((item): item is MediaTenantView => item !== null);
}

export function sourceFromPayload(payload: unknown): MediaSourceView | null {
  if (!isRecord(payload)) return null;
  const id = stringValue(payload.id);
  if (!id) return null;
  const active = boolValue(payload.active, payload.status !== "paused");
  const rawStatus = stringValue(payload.status);
  return {
    id,
    kind: stringValue(payload.kind, "rss"),
    provider: stringValue(payload.provider, "Egen källa"),
    displayName: stringValue(payload.displayName ?? payload.name, "Namnlös källa"),
    baseUrl: nullableString(payload.baseUrl ?? payload.url),
    configPublic: recordValue(payload.configPublic),
    active,
    status: sourceStatusValues.has(rawStatus as MediaSourceView["status"]) ? rawStatus as MediaSourceView["status"] : active ? "active" : "paused",
    lastSyncedAt: nullableString(payload.lastSyncedAt),
    lastError: nullableString(payload.lastError),
    metadata: recordValue(payload.metadata),
  };
}

export function ruleFromPayload(payload: unknown): MediaRuleView | null {
  if (!isRecord(payload)) return null;
  const id = stringValue(payload.id);
  if (!id) return null;
  return {
    id,
    name: stringValue(payload.name, "Namnlös regel"),
    query: stringValue(payload.query),
    domains: stringArray(payload.domains ?? payload.includeDomains),
    excludeDomains: stringArray(payload.excludeDomains),
    sourceIds: stringArray(payload.sourceIds),
    minUniqueDomains: numberValue(payload.minUniqueDomains, 2),
    minMentions: numberValue(payload.minMentions, 3),
    windowHours: numberValue(payload.windowHours, 24),
    contentType: stringValue(payload.contentType, "social_post"),
    channels: stringArray(payload.channels),
    frameworkKey: stringValue(payload.frameworkKey, "insikt"),
    imageStyle: stringValue(payload.imageStyle, "editorial"),
    prompt: stringValue(payload.prompt),
    scheduleMode: stringValue(payload.scheduleMode, "threshold"),
    cadence: stringValue(payload.cadence, "hourly"),
    cronExpression: nullableString(payload.cronExpression),
    approvalRequired: boolValue(payload.approvalRequired, true),
    autoCreateHandoff: boolValue(payload.autoCreateHandoff, true),
    active: boolValue(payload.active, true),
    updatedAt: nullableString(payload.updatedAt),
    lastRunAt: nullableString(payload.lastRunAt),
  };
}

function clusterFromPayload(payload: unknown, dossierByCluster: Map<string, MediaDossierView>, handoffByCluster: Map<string, MediaHandoffView>): MediaClusterView | null {
  if (!isRecord(payload)) return null;
  const id = stringValue(payload.id);
  if (!id) return null;
  const rawStatus = stringValue(payload.status);
  const inlineDossier = dossierFromPayload(payload.dossier);
  return {
    id,
    title: stringValue(payload.title ?? payload.label, "Ny ämnesgrupp"),
    status: clusterStatusValues.has(rawStatus as MediaClusterView["status"]) ? rawStatus as MediaClusterView["status"] : "unknown",
    summary: stringValue(payload.summary ?? payload.whatChanged),
    reflection: stringValue(payload.reflection),
    mentionCount: numberValue(payload.mentionCount ?? payload.mentionsCount ?? payload.count, 0),
    uniqueDomainCount: numberValue(payload.uniqueDomainCount ?? payload.domainCount, 0),
    firstSeenAt: nullableString(payload.firstSeenAt),
    lastSeenAt: nullableString(payload.lastSeenAt ?? payload.updatedAt),
    dossier: inlineDossier ?? dossierByCluster.get(id) ?? null,
    handoff: handoffFromPayload(payload.handoff) ?? handoffByCluster.get(id) ?? null,
  };
}

function dossierFromPayload(payload: unknown): MediaDossierView | null {
  if (!isRecord(payload)) return null;
  const id = stringValue(payload.id);
  if (!id) return null;
  const rawStatus = stringValue(payload.status);
  const reflection = recordValue(payload.reflection);
  return {
    id,
    clusterId: nullableString(payload.clusterId),
    status: dossierStatusValues.has(rawStatus as MediaDossierView["status"]) ? rawStatus as MediaDossierView["status"] : "unknown",
    whatWeKnow: textFromUnknown(reflection.whatWeKnow ?? payload.whatWeKnow),
    whatWeDontKnow: textFromUnknown(reflection.whatWeDontKnow ?? payload.whatWeDontKnow),
    whyItMatters: stringValue(reflection.whyItMatters ?? payload.whyItMatters),
    suggestedAngle: stringValue(reflection.suggestedAngle ?? payload.suggestedAngle),
    reflection: stringValue(reflection.reflection ?? payload.transparentReflection),
    uncertainties: stringArray(reflection.uncertainties ?? payload.uncertainties),
    conflicts: stringArray(reflection.conflicts ?? payload.conflicts),
    evidence: asArray(payload.evidence).map(evidenceFromPayload).filter((item): item is MediaEvidenceView => item !== null),
    imageDirection: stringValue(payload.imageDirection ?? payload.imageStyle),
    createdAt: nullableString(payload.createdAt),
    updatedAt: nullableString(payload.updatedAt),
  };
}

function evidenceFromPayload(payload: unknown): MediaEvidenceView | null {
  if (!isRecord(payload)) return null;
  const url = stringValue(payload.url ?? payload.sourceUrl);
  const id = stringValue(payload.id, url);
  if (!id || !url) return null;
  return {
    id,
    sourceName: stringValue(payload.sourceName ?? payload.publisher, domainFromUrl(url)),
    url,
    domain: stringValue(payload.domain ?? payload.sourceDomain, domainFromUrl(url)),
    sourceType: stringValue(payload.sourceType, "secondary"),
    publishedAt: nullableString(payload.publishedAt),
    eventDate: nullableString(payload.eventDate),
    supportsClaim: stringValue(payload.supportsClaim ?? payload.claim),
    stance: payload.stance === "supports" || payload.stance === "conflicts" || payload.stance === "context" ? payload.stance : "unknown",
  };
}

function handoffFromPayload(payload: unknown): MediaHandoffView | null {
  if (!isRecord(payload)) return null;
  const id = stringValue(payload.id);
  if (!id) return null;
  const rawStatus = stringValue(payload.status ?? payload.state);
  const snapshot = recordValue(payload.draftSnapshot ?? payload.draft_snapshot);
  return {
    id,
    clusterId: nullableString(payload.clusterId ?? payload.cluster_id),
    status: handoffStatusValues.has(rawStatus as Exclude<MediaHandoffView["status"], "unknown">) ? rawStatus as MediaHandoffView["status"] : "unknown",
    contentType: stringValue(payload.contentType ?? snapshot.contentType, "social_post"),
    frameworkKey: stringValue(payload.frameworkKey ?? snapshot.frameworkKey, "insikt"),
    imageStyle: stringValue(payload.imageStyle ?? payload.imageBrief ?? snapshot.imageStyle ?? snapshot.imageBrief, "editorial"),
    scheduleMode: stringValue(payload.scheduleMode ?? snapshot.scheduleMode, "approval_required"),
    approvalRequired: boolValue(payload.approvalRequired ?? snapshot.approvalRequired, true),
    contentDraftId: nullableString(payload.contentDraftId ?? payload.content_draft_id),
    scheduledAt: nullableString(payload.scheduledAt ?? payload.scheduledFor ?? payload.scheduled_for),
  };
}

function runFromPayload(payload: unknown): MediaRunView | null {
  if (!isRecord(payload)) return null;
  const id = stringValue(payload.id);
  if (!id) return null;
  const rawStatus = stringValue(payload.status ?? payload.state);
  const stats = recordValue(payload.stats);
  return {
    id,
    status: runStatusValues.has(rawStatus as Exclude<MediaRunView["status"], "unknown">) ? rawStatus as MediaRunView["status"] : "unknown",
    startedAt: nullableString(payload.startedAt ?? payload.createdAt),
    completedAt: nullableString(payload.completedAt ?? payload.finishedAt),
    ruleId: nullableString(payload.ruleId),
    sourceCount: nullableNumber(payload.sourceCount ?? stats.sourceCount ?? stats.sourcesProcessed),
    clusterCount: nullableNumber(payload.clusterCount ?? stats.clusterCount ?? stats.clustersCreated),
    error: nullableString(payload.error),
  };
}

function tenantFromPayload(payload: unknown): MediaTenantView | null {
  if (!isRecord(payload)) return null;
  const id = stringValue(payload.id);
  if (!id) return null;
  return {
    id,
    slug: stringValue(payload.slug, id.slice(0, 8)),
    name: stringValue(payload.name, "Namnlös arbetsyta"),
    role: stringValue(payload.role, "owner"),
    timezone: stringValue(payload.timezone, "Europe/Stockholm"),
    settings: recordValue(payload.settings),
  };
}

function configurationFromPayload(payload: unknown): MediaEngineConfiguration {
  if (!isRecord(payload)) return { ready: false, missing: [] };
  return { ready: boolValue(payload.ready, false), missing: stringArray(payload.missing) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() || fallback : fallback;
}

function nullableString(value: unknown): string | null {
  const result = stringValue(value);
  return result || null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean) : [];
}

function textFromUnknown(value: unknown): string {
  return Array.isArray(value) ? stringArray(value).join(" ") : stringValue(value);
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function boolValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function recordValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function domainFromUrl(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return "Okänd källa"; }
}
