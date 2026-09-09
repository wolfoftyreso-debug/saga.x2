import { z } from "zod";
import { isSupportedFiveFieldCron } from "@/lib/domain/media-engine-cron";
import {
  mediaContentHandoffStateSchema,
  mediaResearchClusterStatusSchema,
  mediaResearchDossierStatusSchema,
  mediaResearchRunStateSchema,
} from "@/lib/domain/media-engine-pipeline";

/** The role order is used by server routes as well as by UI capability hints. */
export const MEDIA_TENANT_ROLES = ["owner", "admin", "editor", "viewer"] as const;
export const mediaTenantRoleSchema = z.enum(MEDIA_TENANT_ROLES);
export type MediaTenantRole = z.infer<typeof mediaTenantRoleSchema>;

export const mediaTenantIdSchema = z.string().uuid("Ogiltigt arbetsyte-id.");
export const mediaEntityIdSchema = z.string().uuid("Ogiltigt id.");

const slugSchema = z.string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Adressen får bara innehålla små bokstäver, siffror och bindestreck.")
  .min(3)
  .max(80);
/**
 * Schedules are evaluated server-side. Reject a typo here instead of saving a
 * workspace that cannot be dispatched by cron later. `Intl` is available in
 * both the browser and the Node runtimes we support, and uses the IANA zone
 * database for this validation.
 */
const timezoneSchema = z.string().trim().min(3).max(80).superRefine((value, context) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
  } catch {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Ange en giltig IANA-tidszon, exempelvis Europe/Stockholm.",
    });
  }
});
const domainSchema = z.string()
  .trim()
  .min(1)
  .max(320)
  .transform((value) => value
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.+$/, ""))
  .pipe(z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i, "Ange en giltig domän.").max(255));

const secretUrlParameterNames = new Set([
  "key", "apikey", "accesskey", "privatekey", "token", "accesstoken", "authtoken",
  "secret", "clientsecret", "password", "authorization", "credential", "auth", "signature", "sig",
]);

function isSecretUrlParameterKey(value: string): boolean {
  return secretUrlParameterNames.has(value.toLowerCase().replace(/[^a-z0-9]/g, ""));
}

/**
 * Public connector JSON is returned to every viewer in the workspace. Keep
 * this predicate deliberately conservative: V1 has no use for credentials in
 * either public configuration or metadata.
 */
function isSecretConnectorFieldName(value: string): boolean {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]/g, "");
  return isSecretUrlParameterKey(normalized)
    || /(secret|token|password|authorization|credential|privatekey|apikey|accesskey)/.test(normalized);
}

/**
 * A source URL is displayed back to tenant viewers, so it is public
 * configuration just like `configPublic`.  Reject credentials before any
 * source row is written rather than relying on the worker to refuse it later.
 */
export function publicUrlIssue(value: string, requireHttp = false): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return requireHttp ? "Ange en giltig HTTPS- eller HTTP-adress." : null;
  }
  if (requireHttp && url.protocol !== "https:" && url.protocol !== "http:") {
    return "Ange en giltig HTTPS- eller HTTP-adress.";
  }
  if (url.username || url.password) return "Källans URL får inte innehålla inloggningsuppgifter.";
  if ([...url.searchParams.keys()].some(isSecretUrlParameterKey)) {
    return "Källans URL får inte innehålla token, nyckel eller annan hemlig query-parameter.";
  }
  return null;
}

/**
 * Legacy rows can predate V1's input checks. Never echo a possibly secret URL
 * back to a viewer just because a cleanup migration has not yet run, or an
 * older value used an encoding the SQL cleanup cannot recognize.
 */
export function publicMediaSourceUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.length) return null;
  return publicUrlIssue(value, true) ? null : value;
}

type SanitizedPublicValue = string | number | boolean | null | SanitizedPublicValue[] | { [key: string]: SanitizedPublicValue };

function sanitizePublicValue(value: unknown, depth = 0): SanitizedPublicValue | undefined {
  // Input validation has its own detailed error messages. This is a defensive
  // response projection, so dropping an unsafe/deep legacy value is preferable
  // to returning a value that might contain a credential.
  if (depth > 12 || value === undefined || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") return undefined;
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return publicUrlIssue(value) ? undefined : value;
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((entry) => sanitizePublicValue(entry, depth + 1) ?? null);
  }
  if (!value || typeof value !== "object") return undefined;
  const sanitized: { [key: string]: SanitizedPublicValue } = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
    if (isSecretConnectorFieldName(key)) continue;
    const safe = sanitizePublicValue(entry, depth + 1);
    if (safe !== undefined) sanitized[key] = safe;
  }
  return sanitized;
}

/** A safe projection for source config/metadata read from a durable legacy row. */
export function sanitizePublicConnectorConfig(value: unknown): Record<string, unknown> {
  const sanitized = sanitizePublicValue(value);
  return sanitized && !Array.isArray(sanitized) && typeof sanitized === "object" ? sanitized : {};
}

const publicSourceUrlSchema = z.string()
  .url("Ange en giltig HTTPS- eller HTTP-adress.")
  .max(2_000)
  .superRefine((value, context) => {
    const issue = publicUrlIssue(value, true);
    if (issue) context.addIssue({ code: z.ZodIssueCode.custom, message: issue });
  });

function checkPublicObject(value: unknown, path: string[], context: z.RefinementCtx): void {
  if (value === null || typeof value === "number" || typeof value === "boolean") return;
  if (typeof value === "string") {
    const issue = publicUrlIssue(value);
    if (issue) context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${issue} Ta bort den ur publik konfiguration (${path.join(".") || "värde"}).`,
    });
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 100) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "En publik konfigurationslista får innehålla högst 100 värden." });
      return;
    }
    value.forEach((entry, index) => checkPublicObject(entry, [...path, String(index)], context));
    return;
  }
  if (!value || typeof value !== "object") {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Konfigurationen måste kunna serialiseras som JSON." });
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (isSecretConnectorFieldName(key)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Hemliga uppgifter får inte läggas i publik konfiguration (${[...path, key].join(".")}). Ta bort värdet och använd endast en publik källa i V1.`,
      });
      continue;
    }
    checkPublicObject(entry, [...path, key], context);
  }
}

/**
 * This schema is intentionally hostile to accidental key/token persistence.
 * Media Engine V1 accepts public RSS and API sources only. Authenticated
 * providers need a future server-owned credential broker that binds a tenant,
 * provider and approved origin together; a tenant must never choose an env
 * secret name for an arbitrary endpoint.
 */
export const publicConnectorConfigSchema = z.record(z.unknown()).superRefine((value, context) => {
  checkPublicObject(value, [], context);
});

export const mediaTenantCreateSchema = z.object({
  name: z.string().trim().min(2, "Ange ett namn.").max(160),
  slug: slugSchema.optional(),
  timezone: timezoneSchema.default("Europe/Stockholm"),
  settings: publicConnectorConfigSchema.default({}),
}).strict();
export const mediaTenantUpdateSchema = z.object({
  name: z.string().trim().min(2).max(160).optional(),
  timezone: timezoneSchema.optional(),
  settings: publicConnectorConfigSchema.optional(),
}).strict().refine((value) => Object.keys(value).length > 0, {
  message: "Ange minst en ändring.",
});
export type MediaTenantCreateInput = z.input<typeof mediaTenantCreateSchema>;
export type MediaTenantUpdateInput = z.input<typeof mediaTenantUpdateSchema>;

export const mediaTenantMemberUpsertSchema = z.object({
  userId: z.string().uuid("Ogiltigt användar-id."),
  role: z.enum(["admin", "editor", "viewer"]),
}).strict();
export type MediaTenantMemberUpsertInput = z.input<typeof mediaTenantMemberUpsertSchema>;

/** V1 only exposes connectors the runner can actually ingest. */
export const MEDIA_SOURCE_KINDS = ["rss", "api", "web_search"] as const;
export const mediaSourceKindSchema = z.enum(MEDIA_SOURCE_KINDS);
export type MediaSourceKind = z.infer<typeof mediaSourceKindSchema>;

const sourceFieldsSchema = z.object({
  kind: mediaSourceKindSchema,
  provider: z.string().trim().min(2).max(120),
  displayName: z.string().trim().min(2).max(160),
  baseUrl: publicSourceUrlSchema.nullable().optional(),
  configPublic: publicConnectorConfigSchema.default({}),
  active: z.boolean().default(true),
  metadata: publicConnectorConfigSchema.default({}),
}).strict();

/**
 * A web-search connector is intentionally URL-less. RSS needs a stored public
 * feed URL; an API may use either that URL or its explicit public `endpoint`
 * setting. Accepting neither would create an "active" connector which can
 * only fail later in the scheduled worker. Keep that error at the API boundary.
 */
function validateCompleteSourceFields(
  value: z.output<typeof sourceFieldsSchema>,
  context: z.RefinementCtx,
): void {
  const configuredApiEndpoint = value.configPublic.endpoint;
  const apiHasPublicEndpoint = typeof configuredApiEndpoint === "string" && !publicUrlIssue(configuredApiEndpoint, true);
  if (value.kind === "rss" && !value.baseUrl) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["baseUrl"],
      message: "RSS-källor behöver en publik feed-URL innan de kan aktiveras.",
    });
  }
  if (value.kind === "api" && !value.baseUrl && !apiHasPublicEndpoint) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["baseUrl"],
      message: "API-källor behöver en publik URL eller endpoint innan de kan aktiveras.",
    });
  }
}

export const mediaSourceConnectionCreateSchema = sourceFieldsSchema.extend({ tenantId: mediaTenantIdSchema }).strict().superRefine((value, context) => {
  validateCompleteSourceFields(value, context);
});
export const mediaSourceConnectionUpdateSchema = sourceFieldsSchema.partial().strict();
export type MediaSourceConnectionCreateInput = z.input<typeof mediaSourceConnectionCreateSchema>;
export type MediaSourceConnectionUpdateInput = z.input<typeof mediaSourceConnectionUpdateSchema>;

export const MEDIA_CONTENT_TYPES = ["social_post", "newsletter", "article"] as const;
export const MEDIA_CHANNELS = ["facebook_page", "instagram", "linkedin", "newsletter"] as const;
export const mediaContentTypeSchema = z.enum(MEDIA_CONTENT_TYPES);
export const mediaChannelSchema = z.enum(MEDIA_CHANNELS);
const channelListSchema = z.array(mediaChannelSchema).min(1).max(4).superRefine((channels, context) => {
  if (new Set(channels).size !== channels.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "En kanal får bara väljas en gång." });
  }
});

export const MEDIA_RULE_SCHEDULE_MODES = ["threshold", "cron"] as const;
export const MEDIA_RULE_CADENCES = ["continuous", "hourly", "daily", "weekly", "cron"] as const;
export const mediaResearchRuleScheduleModeSchema = z.enum(MEDIA_RULE_SCHEDULE_MODES);
export const mediaResearchRuleCadenceSchema = z.enum(MEDIA_RULE_CADENCES);

const ruleFieldsObject = z.object({
  name: z.string().trim().min(2).max(160),
  active: z.boolean().default(true),
  query: z.string().trim().min(2).max(4000),
  includeDomains: z.array(domainSchema).max(100).default([]),
  excludeDomains: z.array(domainSchema).max(100).default([]),
  // Keep a single rule bounded enough for an interactive/serverless run. The
  // worker applies the same cap when a legacy rule has no explicit selection.
  sourceIds: z.array(mediaEntityIdSchema).max(12).default([]),
  minMentions: z.number().int().min(1).max(100).default(3),
  minUniqueDomains: z.number().int().min(1).max(50).default(2),
  windowHours: z.number().int().min(1).max(8760).default(72),
  contentType: mediaContentTypeSchema.default("social_post"),
  channels: channelListSchema.default(["linkedin"]),
  frameworkKey: z.string().trim().min(2).max(120).default("transparent-analysis"),
  imageStyle: z.string().trim().min(2).max(240).default("editorial"),
  prompt: z.string().max(12_000).default(""),
  scheduleMode: mediaResearchRuleScheduleModeSchema.default("threshold"),
  cadence: mediaResearchRuleCadenceSchema.default("hourly"),
  cronExpression: z.string().trim().min(9).max(160).nullable().optional(),
  nextRunAt: z.string().datetime({ offset: true }).nullable().optional(),
  approvalRequired: z.boolean().default(true),
  autoCreateHandoff: z.boolean().default(true),
}).strict();

function validateCompleteRuleFields(value: z.output<typeof ruleFieldsObject>, context: z.RefinementCtx): void {
  if (new Set(value.includeDomains).size !== value.includeDomains.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["includeDomains"], message: "En domän får bara förekomma en gång." });
  }
  if (new Set(value.excludeDomains).size !== value.excludeDomains.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["excludeDomains"], message: "En domän får bara förekomma en gång." });
  }
  if (new Set(value.sourceIds).size !== value.sourceIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["sourceIds"], message: "En källa får bara förekomma en gång." });
  }
  // `schedule_mode` is also enforced by a durable SQL shape constraint. Keep
  // the two UI-facing fields in lockstep so a malformed raw API request is a
  // clear 400 validation error rather than a late database 500.
  const cronEnabled = value.scheduleMode === "cron";
  if (cronEnabled !== (value.cadence === "cron")) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["cadence"],
      message: "Cron-läge kräver frekvensen cron, och andra lägen får inte använda cron-frekvens.",
    });
  }
  if (cronEnabled && !value.cronExpression) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["cronExpression"], message: "Cron-läge kräver ett femfältsuttryck, exempelvis `0 9 * * 1-5`." });
  }
  if (!cronEnabled && value.cronExpression) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["cronExpression"], message: "Tröskelläget utan Cron-frekvens ska inte ha ett cron-uttryck." });
  }
  if (cronEnabled && value.cronExpression && !isSupportedFiveFieldCron(value.cronExpression)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["cronExpression"], message: "Cron måste ha fem fält och kan använda *, siffror, listor, intervall och steg. Exempel: `0 9 * * 1-5`." });
  }
  if (value.contentType === "newsletter" && (value.channels.length !== 1 || value.channels[0] !== "newsletter")) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["channels"], message: "Nyhetsbrev ska enbart använda nyhetsbrevskanalen." });
  }
  if (value.contentType !== "newsletter" && value.channels.includes("newsletter")) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["channels"], message: "Nyhetsbrevskanalen kräver innehållstypen nyhetsbrev." });
  }
}

export const mediaResearchRuleCreateSchema = ruleFieldsObject.extend({ tenantId: mediaTenantIdSchema }).strict().superRefine(validateCompleteRuleFields);
// PATCH validates each field; the service merges it with the saved rule and
// reparses through the full create contract before it writes anything.
export const mediaResearchRuleUpdateSchema = ruleFieldsObject.partial().strict();
export type MediaResearchRuleCreateInput = z.input<typeof mediaResearchRuleCreateSchema>;
export type MediaResearchRuleUpdateInput = z.input<typeof mediaResearchRuleUpdateSchema>;

export const mediaResearchClusterUpdateSchema = z.object({
  status: mediaResearchClusterStatusSchema,
}).strict();
export type MediaResearchClusterUpdateInput = z.input<typeof mediaResearchClusterUpdateSchema>;

export const mediaContentHandoffUpdateSchema = z.object({
  state: mediaContentHandoffStateSchema.optional(),
  scheduledFor: z.string().datetime({ offset: true }).nullable().optional(),
  note: z.string().trim().max(2000).nullable().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "Ange minst en ändring.");
export type MediaContentHandoffUpdateInput = z.input<typeof mediaContentHandoffUpdateSchema>;

export type MediaTenantView = {
  id: string;
  slug: string;
  name: string;
  timezone: string;
  isDefault: boolean;
  settings: Record<string, unknown>;
  role: MediaTenantRole;
  createdAt: string;
  updatedAt: string;
};

export type MediaTenantMemberView = {
  tenantId: string;
  userId: string;
  role: MediaTenantRole;
  createdAt: string;
  updatedAt: string;
};

/** Safe projection: it has only public connector configuration. */
export type MediaSourceConnectionView = {
  id: string;
  tenantId: string;
  kind: MediaSourceKind;
  provider: string;
  displayName: string;
  baseUrl: string | null;
  configPublic: Record<string, unknown>;
  active: boolean;
  lastSyncedAt: string | null;
  lastError: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type MediaResearchRuleView = {
  id: string;
  tenantId: string;
  name: string;
  active: boolean;
  query: string;
  includeDomains: string[];
  excludeDomains: string[];
  sourceIds: string[];
  minMentions: number;
  minUniqueDomains: number;
  windowHours: number;
  contentType: z.infer<typeof mediaContentTypeSchema>;
  channels: z.infer<typeof mediaChannelSchema>[];
  frameworkKey: string;
  imageStyle: string;
  prompt: string;
  scheduleMode: z.infer<typeof mediaResearchRuleScheduleModeSchema>;
  cadence: z.infer<typeof mediaResearchRuleCadenceSchema>;
  cronExpression: string | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastCheckedAt: string | null;
  approvalRequired: boolean;
  autoCreateHandoff: boolean;
  createdAt: string;
  updatedAt: string;
};

export type MediaResearchEvidenceView = {
  id: string;
  clusterId: string;
  itemId: string | null;
  sourceName: string;
  sourceUrl: string;
  sourceDomain: string;
  sourceType: "primary" | "secondary" | "rss" | "api" | "web_search";
  publishedAt: string | null;
  eventDate: string | null;
  claim: string;
  stance: "supports" | "conflicts" | "context";
  quote: string | null;
  confidence: number;
  createdAt: string;
};

export type MediaResearchDossierView = {
  id: string;
  clusterId: string;
  status: z.infer<typeof mediaResearchDossierStatusSchema>;
  whatWeKnow: string[];
  whatWeDontKnow: string[];
  whyItMatters: string;
  suggestedAngle: string;
  transparentReflection: string;
  uncertainties: string[];
  conflicts: string[];
  sourceSynthesis: string;
  structuredData: Record<string, unknown>;
  evidenceCount: number;
  modelName: string | null;
  modelMetadata: Record<string, unknown>;
  generatedAt: string | null;
  updatedAt: string;
};

export type MediaContentHandoffView = {
  id: string;
  tenantId: string;
  clusterId: string;
  runId: string | null;
  contentDraftId: string | null;
  state: z.infer<typeof mediaContentHandoffStateSchema>;
  draftSnapshot: Record<string, unknown>;
  scheduledFor: string | null;
  createdBy: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MediaResearchClusterView = {
  id: string;
  tenantId: string;
  canonicalKey: string;
  title: string;
  status: z.infer<typeof mediaResearchClusterStatusSchema>;
  mentionCount: number;
  uniqueDomainCount: number;
  significanceScore: number | null;
  firstSeenAt: string;
  lastSeenAt: string;
  summary: string | null;
  frameworkKey: string | null;
  imageBrief: string | null;
  dossier: MediaResearchDossierView | null;
  handoff: MediaContentHandoffView | null;
  evidence?: MediaResearchEvidenceView[];
  createdAt: string;
  updatedAt: string;
};

export type MediaResearchRunView = {
  id: string;
  tenantId: string;
  ruleId: string;
  triggerKind: "manual" | "scheduled";
  state: z.infer<typeof mediaResearchRunStateSchema>;
  phase: "discovery" | "clustering" | "research" | "handoff" | "complete" | "failed";
  candidateCount: number;
  clusterCount: number;
  handoffCount: number;
  startedAt: string | null;
  finishedAt: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

const roleRank: Record<MediaTenantRole, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };
export function mediaTenantRoleAllows(actual: MediaTenantRole, required: MediaTenantRole): boolean {
  return roleRank[actual] >= roleRank[required];
}
