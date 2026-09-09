import { z } from "zod";
import { isValidIanaTimezone } from "@/lib/utils/date";

/**
 * The Daily Knowledge loop is deliberately a research product, not a content
 * product. It turns selected, already-ingested source metadata into a bounded
 * daily evidence bundle. It has no fields for prompts, models, drafts,
 * channels, delivery or publication.
 */

const uuidSchema = z.string().uuid();
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Ange datum som YYYY-MM-DD.");
const timezoneSchema = z.string().trim().min(3).max(80).refine(
  isValidIanaTimezone,
  "Ange en giltig IANA-tidszon, till exempel Europe/Stockholm.",
);
const dailyTimeSchema = z.string().trim().regex(
  /^(?:[01]\d|2[0-3]):[0-5]\d$/,
  "Ange tid som HH:MM.",
);
const revisionSchema = z.number().int().min(1).max(2_147_483_647);
const topicSchema = z.string().trim().min(2).max(160);
const domainSchema = z.string().trim().toLowerCase().regex(
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
  "Källdomänen är inte giltig.",
);
const httpsUrlSchema = z.string().trim().url().max(2_000).refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}, "Källänken måste vara en säker HTTPS-adress.");

function hasDuplicates(values: string[]): boolean {
  return new Set(values.map((value) => value.trim().normalize("NFKC").toLocaleLowerCase("sv-SE"))).size !== values.length;
}

export const SAGA_DAILY_KNOWLEDGE_JOB_STATES = [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;

export type SagaDailyKnowledgeJobState = (typeof SAGA_DAILY_KNOWLEDGE_JOB_STATES)[number];

/**
 * Saving this policy does not turn it on: a workspace must explicitly set
 * `enabled: true`. Source ids are validated server-side against that same
 * workspace before the policy reaches Neon.
 */
const sagaDailyKnowledgePolicyInputBaseSchema = z.object({
  enabled: z.boolean().default(false),
  timezone: timezoneSchema.default("Europe/Stockholm"),
  dailyAt: dailyTimeSchema.default("06:00"),
  topics: z.array(topicSchema).min(1, "Välj minst ett bevakat ämne.").max(12),
  sourceIds: z.array(uuidSchema).min(1, "Välj minst en godkänd källa.").max(40),
  minimumIndependentPublishers: z.number().int().min(2).max(12).default(2),
  minimumEvidenceItems: z.number().int().min(2).max(30).default(2),
  maximumEvidenceItems: z.number().int().min(2).max(30).default(8),
  /** How far back a daily run may look in the verified News Core catalog. */
  evidenceWindowHours: z.number().int().min(12).max(168).default(72),
  retentionDays: z.number().int().min(7).max(365).default(90),
}).strict();

function refineDailyKnowledgePolicy(value: z.infer<typeof sagaDailyKnowledgePolicyInputBaseSchema>, context: z.RefinementCtx): void {
  if (hasDuplicates(value.topics)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["topics"], message: "Samma ämne får bara väljas en gång." });
  }
  if (new Set(value.sourceIds).size !== value.sourceIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["sourceIds"], message: "Samma källa får bara väljas en gång." });
  }
  if (value.minimumEvidenceItems > value.maximumEvidenceItems) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["maximumEvidenceItems"],
      message: "Maximalt antal underlag måste vara minst lika stort som minimiantalet.",
    });
  }
}

/**
 * `expectedRevision` is omitted only when the workspace has no policy yet.
 * The repository applies it atomically on conflict, so a stale browser cannot
 * overwrite another editor's source, schedule or retention controls.
 */
export const sagaDailyKnowledgePolicyInputSchema = sagaDailyKnowledgePolicyInputBaseSchema.extend({
  expectedRevision: revisionSchema.optional(),
}).superRefine(refineDailyKnowledgePolicy);

export type SagaDailyKnowledgePolicyInput = z.input<typeof sagaDailyKnowledgePolicyInputSchema>;

export const sagaDailyKnowledgePolicySchema = sagaDailyKnowledgePolicyInputBaseSchema.extend({
  workspaceId: uuidSchema,
  brandProfileId: uuidSchema,
  revision: revisionSchema,
  lastMaterializedForDate: dateSchema.nullable(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
}).superRefine(refineDailyKnowledgePolicy);
export type SagaDailyKnowledgePolicy = z.infer<typeof sagaDailyKnowledgePolicySchema>;

/** A source reference is intentionally metadata-only: no web body is stored or returned. */
export const sagaDailyKnowledgeEvidenceSchema = z.object({
  itemId: uuidSchema,
  sourceId: uuidSchema,
  sourceName: z.string().min(1).max(240),
  connectorKey: z.string().min(2).max(81),
  sourceTrustLevel: z.number().int().min(1).max(5),
  canonicalUrl: httpsUrlSchema,
  title: z.string().min(1).max(1_000),
  excerpt: z.string().max(1_400),
  publisherName: z.string().max(320),
  publisherDomain: domainSchema,
  language: z.string().max(32).nullable(),
  publishedAt: z.string().min(1).nullable(),
  observedAt: z.string().min(1),
}).strict();
export type SagaDailyKnowledgeEvidence = z.infer<typeof sagaDailyKnowledgeEvidenceSchema>;

export const sagaDailyKnowledgeEntrySchema = z.object({
  id: uuidSchema,
  policyId: uuidSchema,
  jobId: uuidSchema,
  policyRevision: z.number().int().min(1),
  knowledgeDate: dateSchema,
  topic: topicSchema,
  topicKey: z.string().regex(/^[a-f0-9]{64}$/),
  headline: z.string().min(1).max(320),
  summary: z.string().min(1).max(1_200),
  evidenceCount: z.number().int().min(0),
  independentPublisherCount: z.number().int().min(0),
  evidence: z.array(sagaDailyKnowledgeEvidenceSchema).max(30),
  createdAt: z.string().min(1),
  retentionExpiresAt: z.string().min(1),
});
export type SagaDailyKnowledgeEntry = z.infer<typeof sagaDailyKnowledgeEntrySchema>;

export const sagaDailyKnowledgeRunSchema = z.object({
  id: uuidSchema,
  policyId: uuidSchema,
  policyRevision: z.number().int().min(1),
  knowledgeDate: dateSchema,
  state: z.enum(SAGA_DAILY_KNOWLEDGE_JOB_STATES),
  evidenceEntriesCreated: z.number().int().min(0),
  attempts: z.number().int().min(0),
  maxAttempts: z.number().int().min(1).max(10),
  failureCode: z.string().max(120).nullable(),
  failureDetail: z.string().max(1_000).nullable(),
  createdAt: z.string().min(1),
  completedAt: z.string().min(1).nullable(),
  retentionExpiresAt: z.string().min(1),
});
export type SagaDailyKnowledgeRun = z.infer<typeof sagaDailyKnowledgeRunSchema>;

export type SagaDailyKnowledgePolicySnapshot = Pick<
  SagaDailyKnowledgePolicy,
  | "timezone"
  | "dailyAt"
  | "topics"
  | "sourceIds"
  | "minimumIndependentPublishers"
  | "minimumEvidenceItems"
  | "maximumEvidenceItems"
  | "evidenceWindowHours"
  | "retentionDays"
>;

export function normalizedSagaDailyKnowledgeTopic(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase("sv-SE");
}
