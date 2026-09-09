import { z } from "zod";

/**
 * Browser-safe contracts for SAGA's News Core.  These objects describe what
 * a workspace may observe and how it should be treated; they deliberately do
 * not carry provider keys, OAuth material, or arbitrary request headers.
 * Connectors resolve those values only from Vercel environment variables.
 */

const uuidSchema = z.string().uuid();
const timestampSchema = z.string().min(1);
const slugSchema = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,78}$/);
const boundedTextSchema = z.string().trim().min(1).max(240);
// Connectors normalize BCP47 values to lower case (for example `sv-se`).
// Accepting that canonical representation keeps provider metadata durable
// without teaching each connector about a UI-specific locale casing rule.
const languageSchema = z.string().trim().toLowerCase().regex(/^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/);
const countrySchema = z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/i);

const forbiddenJsonKeyNames = new Set([
  "apikey",
  "accesstoken",
  "refreshtoken",
  "clientsecret",
  "secret",
  "password",
  "authorization",
  "privatekey",
  "credential",
  "credentials",
  "bearertoken",
  "serviceaccount",
  "token",
  "idtoken",
  "authtoken",
  "sessiontoken",
  "webhooksecret",
]);

function normalizedKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9]+/g, "").toLowerCase();
}

function isForbiddenJsonKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return forbiddenJsonKeyNames.has(normalized)
    || normalized.endsWith("apikey")
    || normalized.endsWith("accesstoken")
    || normalized.endsWith("refreshtoken")
    || normalized.endsWith("clientsecret")
    || normalized.endsWith("privatekey")
    || normalized.endsWith("bearertoken")
    || normalized.endsWith("credential")
    || normalized.endsWith("token")
    || normalized.endsWith("idtoken")
    || normalized.endsWith("authtoken")
    || normalized.endsWith("sessiontoken")
    || normalized.endsWith("webhooksecret");
}

function hasUnsafeUrlQuery(value: string): boolean {
  try {
    const parsed = new URL(value);
    return [...parsed.searchParams.keys()].some((key) => isForbiddenJsonKey(key));
  } catch {
    return false;
  }
}

function validateSafeJson(value: unknown, context: z.RefinementCtx, path: Array<string | number> = [], depth = 0): void {
  if (depth > 8) {
    context.addIssue({ code: z.ZodIssueCode.custom, path, message: "Konfigurationen får vara högst åtta nivåer djup." });
    return;
  }
  if (typeof value === "string") {
    if (hasUnsafeUrlQuery(value)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path, message: "Konfigurationen får inte innehålla URL:er med API-nycklar eller tokens." });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateSafeJson(item, context, [...path, index], depth + 1));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (isForbiddenJsonKey(key)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, key],
        message: "API-nycklar, tokens och andra hemligheter får aldrig sparas i SAGA News Core.",
      });
    }
    validateSafeJson(nested, context, [...path, key], depth + 1);
  }
}

/** A bounded extensibility envelope for public source and provenance metadata. */
export const sagaNewsSafeJsonSchema = z.record(z.string(), z.unknown()).superRefine((value, context) => {
  let serialized = "";
  try {
    serialized = JSON.stringify(value);
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Konfigurationen måste kunna sparas som JSON." });
    return;
  }
  if (serialized.length > 50_000) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Konfigurationen får vara högst 50 000 tecken." });
  }
  validateSafeJson(value, context);
});

const domainSchema = z.string().trim().toLowerCase().regex(
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
  "Ange ett domännamn utan protokoll eller sökväg.",
);

function safeHttpsUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password && !hasUnsafeUrlQuery(value);
  } catch {
    return false;
  }
}

const httpsUrlSchema = z.string().trim().url().max(2_000).refine(
  safeHttpsUrl,
  "Adressen måste vara HTTPS och får inte innehålla inloggningsuppgifter, API-nycklar eller tokens.",
);

const failureCodeSchema = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9._:-]{0,119}$/);
const safeDiagnosticTextSchema = z.string().trim().min(1).max(1_000).refine((value) => {
  if (hasUnsafeUrlQuery(value)) return false;
  return !/(?:api[_\s-]?key|access[_\s-]?token|refresh[_\s-]?token|client[_\s-]?secret|bearer[_\s-]?token|auth[_\s-]?token|id[_\s-]?token|password|credential|token|secret)\s*[:=]/iu.test(value);
}, "Feldiagnostik får inte innehålla nycklar, tokens eller andra hemligheter.");

export const SAGA_NEWS_SOURCE_KINDS = ["rss", "news_api", "public_api", "website", "manual"] as const;
export const SAGA_NEWS_ALLOWLIST_MODES = ["strict", "prefer", "open"] as const;
export const SAGA_NEWS_INGESTION_STATUSES = ["running", "completed", "failed", "cancelled"] as const;
export const SAGA_NEWS_SIGNAL_STATES = ["candidate", "qualified", "in_review", "dismissed"] as const;

export type SagaNewsSourceKind = (typeof SAGA_NEWS_SOURCE_KINDS)[number];
export type SagaNewsAllowlistMode = (typeof SAGA_NEWS_ALLOWLIST_MODES)[number];
export type SagaNewsIngestionStatus = (typeof SAGA_NEWS_INGESTION_STATUSES)[number];
export type SagaNewsSignalState = (typeof SAGA_NEWS_SIGNAL_STATES)[number];

export const sagaNewsSourceKindSchema = z.enum(SAGA_NEWS_SOURCE_KINDS);
export const sagaNewsAllowlistModeSchema = z.enum(SAGA_NEWS_ALLOWLIST_MODES);
export const sagaNewsIngestionStatusSchema = z.enum(SAGA_NEWS_INGESTION_STATUSES);
export const sagaNewsSignalStateSchema = z.enum(SAGA_NEWS_SIGNAL_STATES);

export const sagaNewsSourcePolicySchema = z.object({
  requireCanonicalUrl: z.boolean().default(true),
  requirePublishedAt: z.boolean().default(false),
  minimumPublisherCredibility: z.number().int().min(1).max(5).default(3),
  retainFullText: z.boolean().default(false),
  additionalRules: sagaNewsSafeJsonSchema.default({}),
}).strict().default({});
export type SagaNewsSourcePolicy = z.infer<typeof sagaNewsSourcePolicySchema>;

const sourceInputBaseSchema = z.object({
  slug: slugSchema,
  name: z.string().trim().min(2).max(240),
  sourceKind: sagaNewsSourceKindSchema,
  /** Identifies a server-owned adapter, never an API credential. */
  connectorKey: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9._-]{1,80}$/),
  endpointUrl: httpsUrlSchema,
  publisherAllowlist: z.array(domainSchema).max(120).default([]),
  publisherBlocklist: z.array(domainSchema).max(120).default([]),
  allowlistMode: sagaNewsAllowlistModeSchema.default("strict"),
  topics: z.array(boundedTextSchema).max(40).default([]),
  languages: z.array(languageSchema).max(20).default(["sv"]),
  countries: z.array(countrySchema).max(20).default([]),
  trustLevel: z.number().int().min(1).max(5).default(3),
  sourceWeight: z.number().int().min(1).max(100).default(50),
  minimumIntervalMinutes: z.number().int().min(5).max(43_200).default(60),
  maxItemsPerRun: z.number().int().min(1).max(250).default(100),
  maxItemTextChars: z.number().int().min(500).max(120_000).default(30_000),
  sourcePolicy: sagaNewsSourcePolicySchema,
  isAllowed: z.boolean().default(true),
  active: z.boolean().default(true),
});

function noDuplicates(values: string[]): boolean {
  return new Set(values.map((value) => value.toLocaleLowerCase("sv-SE"))).size === values.length;
}

function domainMatches(domain: string, rule: string): boolean {
  return domain === rule || domain.endsWith(`.${rule}`);
}

export const sagaNewsSourceInputSchema = sourceInputBaseSchema.superRefine((value, context) => {
  for (const field of ["publisherAllowlist", "publisherBlocklist", "topics", "languages", "countries"] as const) {
    if (!noDuplicates(value[field])) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: "Samma värde får bara anges en gång." });
    }
  }
  if (value.publisherAllowlist.some((domain) => value.publisherBlocklist.some((blocked) => domainMatches(domain, blocked) || domainMatches(blocked, domain)))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["publisherBlocklist"], message: "En domän kan inte samtidigt tillåtas och blockeras." });
  }
  if (value.allowlistMode === "strict" && value.sourceKind !== "manual" && value.publisherAllowlist.length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["publisherAllowlist"], message: "Strikt källpolicy kräver minst en tillåten publicistdomän." });
  }
  if (value.trustLevel < value.sourcePolicy.minimumPublisherCredibility) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["trustLevel"],
      message: "Källans trovärdighetsnivå måste uppfylla den sparade källpolicyn.",
    });
  }
});
export type SagaNewsSourceInput = z.input<typeof sagaNewsSourceInputSchema>;

export const sagaNewsSourceSchema = sourceInputBaseSchema.extend({
  id: uuidSchema,
  createdByUserId: uuidSchema,
  updatedByUserId: uuidSchema,
  lastIngestionAt: timestampSchema.nullable(),
  lastSuccessfulIngestionAt: timestampSchema.nullable(),
  lastFailureAt: timestampSchema.nullable(),
  lastFailureCode: z.string().max(120).nullable(),
  nextIngestionAt: timestampSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type SagaNewsSource = z.infer<typeof sagaNewsSourceSchema>;

const sourceItemInputBaseSchema = z.object({
  externalId: z.string().trim().max(512).nullable().default(null),
  canonicalUrl: httpsUrlSchema,
  title: z.string().trim().min(1).max(1_000),
  summary: z.string().trim().max(12_000).default(""),
  bodyText: z.string().trim().max(120_000).default(""),
  publisherName: z.string().trim().max(320).default(""),
  publisherDomain: domainSchema.nullable().default(null),
  authors: z.array(z.string().trim().min(1).max(240)).max(20).default([]),
  language: languageSchema.nullable().default(null),
  publishedAt: timestampSchema.nullable().default(null),
  provenance: sagaNewsSafeJsonSchema.default({}),
});

export const sagaNewsSourceItemInputSchema = sourceItemInputBaseSchema.superRefine((value, context) => {
  if (!noDuplicates(value.authors)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["authors"], message: "Samma upphovsperson får bara anges en gång." });
  }
});
export type SagaNewsSourceItemInput = z.input<typeof sagaNewsSourceItemInputSchema>;

export const sagaNewsIngestionStartInputSchema = z.object({
  sourceId: uuidSchema,
  /** A server-generated UUID makes retries safe without accepting arbitrary receipt keys. */
  idempotencyKey: uuidSchema,
  workerId: z.string().trim().min(2).max(120).default("saga-news-worker"),
}).strict();
export type SagaNewsIngestionStartInput = z.infer<typeof sagaNewsIngestionStartInputSchema>;

export const sagaNewsRunReferenceSchema = z.object({
  sourceId: uuidSchema,
  runId: uuidSchema,
}).strict();
export type SagaNewsRunReference = z.infer<typeof sagaNewsRunReferenceSchema>;

export const sagaNewsIngestionFailureInputSchema = sagaNewsRunReferenceSchema.extend({
  failureCode: failureCodeSchema,
  failureSummary: safeDiagnosticTextSchema,
}).strict();
export type SagaNewsIngestionFailureInput = z.infer<typeof sagaNewsIngestionFailureInputSchema>;

export const sagaNewsIngestionBatchInputSchema = z.object({
  sourceId: uuidSchema,
  runId: uuidSchema,
  items: z.array(sagaNewsSourceItemInputSchema).min(1).max(100),
}).strict().superRefine((value, context) => {
  const identities = new Set<string>();
  for (const [index, item] of value.items.entries()) {
    // A provider may rotate its item id while retaining the same article URL.
    // The canonical source URL is therefore the retry identity for a feed.
    const key = `url:${canonicalizeSagaNewsUrl(item.canonicalUrl)}`;
    if (identities.has(key)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["items", index], message: "Samma item får bara förekomma en gång per batch." });
    }
    identities.add(key);
  }
});
export type SagaNewsIngestionBatchInput = z.input<typeof sagaNewsIngestionBatchInputSchema>;

export const sagaNewsSignalScoresSchema = z.object({
  sourceCredibility: z.number().int().min(0).max(100),
  topicalRelevance: z.number().int().min(0).max(100),
  missionAlignment: z.number().int().min(0).max(100),
  trendMomentum: z.number().int().min(0).max(100),
  channelSuitability: z.number().int().min(0).max(100),
}).strict();
export type SagaNewsSignalScores = z.infer<typeof sagaNewsSignalScoresSchema>;

const signalCandidateInputBaseSchema = z.object({
  /** A deterministic server/worker key; unique inside a workspace and safe to retry. */
  signalKey: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9._:-]{2,158}$/),
  topic: z.string().trim().min(2).max(240),
  headline: z.string().trim().min(2).max(500),
  summary: z.string().trim().max(6_000).default(""),
  editorialAngle: z.string().trim().max(3_000).default(""),
  evidenceItemIds: z.array(uuidSchema).min(1).max(50),
  scores: sagaNewsSignalScoresSchema,
  policySnapshot: sagaNewsSafeJsonSchema.default({}),
  state: sagaNewsSignalStateSchema.default("candidate"),
  requiresHumanReview: z.boolean().default(true),
  active: z.boolean().default(true),
});

export const sagaNewsSignalCandidateInputSchema = signalCandidateInputBaseSchema.superRefine((value, context) => {
  if (new Set(value.evidenceItemIds).size !== value.evidenceItemIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["evidenceItemIds"], message: "Samma källitem får bara anges en gång som belägg." });
  }
});
export type SagaNewsSignalCandidateInput = z.input<typeof sagaNewsSignalCandidateInputSchema>;

export const sagaNewsSignalCandidateSchema = signalCandidateInputBaseSchema.extend({
  id: uuidSchema,
  createdByUserId: uuidSchema,
  updatedByUserId: uuidSchema,
  contentFingerprint: sha256Schema,
  evidenceCount: z.number().int().min(0),
  independentSourceCount: z.number().int().min(0),
  distinctPublisherCount: z.number().int().min(0),
  firstSeenAt: timestampSchema,
  lastSeenAt: timestampSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type SagaNewsSignalCandidate = z.infer<typeof sagaNewsSignalCandidateSchema>;

export const sagaNewsIngestionRunSchema = z.object({
  id: uuidSchema,
  sourceId: uuidSchema,
  requestedByUserId: uuidSchema,
  connectorKey: z.string().min(2).max(81),
  idempotencyKey: uuidSchema,
  requestFingerprint: sha256Schema,
  workerId: z.string().min(2).max(120),
  status: sagaNewsIngestionStatusSchema,
  itemsReceived: z.number().int().min(0),
  itemsInserted: z.number().int().min(0),
  itemsDuplicate: z.number().int().min(0),
  itemsRejected: z.number().int().min(0),
  failureCode: z.string().max(120).nullable(),
  failureSummary: z.string().max(1_000).nullable(),
  startedAt: timestampSchema,
  completedAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type SagaNewsIngestionRun = z.infer<typeof sagaNewsIngestionRunSchema>;

export type SagaNewsIngestionReceipt = {
  run: SagaNewsIngestionRun;
  reused: boolean;
};

export type SagaNewsIngestionBatchResult = {
  receivedCount: number;
  insertedCount: number;
  duplicateCount: number;
};

/** A short-lived server-only Cron claim. It must never be serialized to a browser. */
export type SagaNewsSourceClaim = {
  /** Server-only tenant identity supplied by the database claim, never a request field. */
  workspaceId: string;
  source: SagaNewsSource;
  claimToken: string;
  leaseExpiresAt: string;
};

export type SagaNewsSourceItem = {
  id: string;
  sourceId: string;
  firstIngestionRunId: string;
  lastIngestionRunId: string;
  canonicalUrl: string;
  title: string;
  summary: string;
  publisherName: string;
  publisherDomain: string;
  authors: string[];
  language: string | null;
  publishedAt: string | null;
  discoveredAt: string;
  firstSeenAt: string;
  lastSeenAt: string;
  provenance: Record<string, unknown>;
  contentFingerprint: string;
  storyFingerprint: string;
  createdAt: string;
  updatedAt: string;
};

/**
 * Canonical URLs remove tracking fragments but retain meaningful query
 * parameters.  This lets each source retry safely without collapsing distinct
 * publisher provenance into a single global row.
 */
export function canonicalizeSagaNewsUrl(value: string): string {
  const parsed = new URL(value.trim());
  parsed.protocol = "https:";
  parsed.username = "";
  parsed.password = "";
  parsed.hostname = parsed.hostname.toLowerCase();
  if (parsed.port === "443") parsed.port = "";
  parsed.hash = "";
  const trackingKeys = new Set(["fbclid", "gclid", "mc_cid", "mc_eid"]);
  const retained = [...parsed.searchParams.entries()]
    .filter(([key]) => !key.toLowerCase().startsWith("utm_") && !trackingKeys.has(key.toLowerCase()))
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue));
  parsed.search = "";
  for (const [key, itemValue] of retained) parsed.searchParams.append(key, itemValue);
  return parsed.toString();
}

export function normalizedSagaNewsText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("sv-SE").replace(/\s+/g, " ").trim();
}
