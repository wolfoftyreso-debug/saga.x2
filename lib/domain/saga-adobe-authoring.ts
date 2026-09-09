import { z } from "zod";
import {
  CONTENT_CHANNELS,
  CONTENT_TYPES,
  type ContentChannel,
  type ContentType,
} from "@/lib/domain/content-studio";
import { generatedContentSchema } from "@/lib/domain/content-generation";

/**
 * Adobe-simple authoring is a deliberate, private writing run.  It is not an
 * automation rule: browser input may choose saved records, but it can never
 * supply a reference body, research URL, workspace, model, delivery target or
 * schedule.
 */

const uuidSchema = z.string().uuid();
const revisionSchema = z.number().int().min(1).max(2_147_483_647);
const timestampSchema = z.string().min(1);
const objectiveSchema = z.string().trim().min(12).max(1_200);
const authorPromptSchema = z.string().trim().min(1).max(4_000);

export const SAGA_ADOBE_AUTHORING_RUN_STATES = [
  "queued",
  "generating",
  "ready_to_select",
  "selected",
  "failed",
  "stale",
] as const;
export type SagaAdobeAuthoringRunState = (typeof SAGA_ADOBE_AUTHORING_RUN_STATES)[number];

export const SAGA_ADOBE_AUTHORING_CANDIDATE_STATES = [
  "queued",
  "generating",
  "ready",
  "blocked",
  "failed",
  "selected",
  "not_selected",
] as const;
export type SagaAdobeAuthoringCandidateState = (typeof SAGA_ADOBE_AUTHORING_CANDIDATE_STATES)[number];

export const SAGA_ADOBE_AUTHORING_RECEIPT_STATES = ["running", "completed", "failed", "stale"] as const;
export type SagaAdobeAuthoringReceiptState = (typeof SAGA_ADOBE_AUTHORING_RECEIPT_STATES)[number];
export const SAGA_ADOBE_AUTHORING_COMMAND_STATES = ["running", "completed", "stale"] as const;
export type SagaAdobeAuthoringCommandState = (typeof SAGA_ADOBE_AUTHORING_COMMAND_STATES)[number];
export const SAGA_ADOBE_AUTHORING_PROMPT_POLICY_VERSION = "saga-adobe-authoring/v1" as const;

const qualityFindingSchema = z.object({
  code: z.string().min(1).max(120),
  severity: z.enum(["blocker", "warning"]),
  field: z.string().min(1).max(80),
  message: z.string().min(1).max(1_000),
}).strict();

/** Browser-safe audit projection; it contains no provider response or hidden prompt context. */
export const sagaAdobeAuthoringQualitySchema = z.object({
  version: z.string().min(1).max(120),
  decision: z.enum(["approved", "review_required", "blocked"]),
  score: z.number().int().min(0).max(100),
  findings: z.array(qualityFindingSchema).max(40),
  canCreatePrivateDraft: z.boolean(),
  canEnterCalendar: z.boolean(),
  canDeliver: z.literal(false),
}).strict();
export type SagaAdobeAuthoringQuality = z.infer<typeof sagaAdobeAuthoringQualitySchema>;

export const sagaAdobeAuthoringReferenceSnapshotSchema = z.object({
  sourceDraftId: uuidSchema,
  sourceDraftRevision: revisionSchema,
  contentType: z.enum(CONTENT_TYPES),
  channels: z.array(z.enum(CONTENT_CHANNELS)).min(1).max(CONTENT_CHANNELS.length),
  title: z.string().trim().min(1).max(240),
  body: z.string().trim().min(1).max(60_000),
  language: z.string().trim().min(2).max(16),
  timezone: z.string().trim().min(3).max(80),
  capturedAt: timestampSchema,
}).strict();
export type SagaAdobeAuthoringReferenceSnapshot = z.infer<typeof sagaAdobeAuthoringReferenceSnapshotSchema>;

/** A copied safe summary, intentionally without a URL or evidence payload. */
export const sagaAdobeAuthoringKnowledgeSnapshotSchema = z.object({
  entryId: uuidSchema,
  policyRevision: revisionSchema,
  knowledgeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  topic: z.string().trim().min(2).max(160),
  headline: z.string().trim().min(1).max(320),
  summary: z.string().trim().min(1).max(1_200),
  evidenceCount: z.number().int().min(0).max(30),
  independentPublisherCount: z.number().int().min(0).max(30),
  capturedAt: timestampSchema,
}).strict();
export type SagaAdobeAuthoringKnowledgeSnapshot = z.infer<typeof sagaAdobeAuthoringKnowledgeSnapshotSchema>;

export const sagaAdobeAuthoringRunCreateSchema = z.object({
  idempotencyKey: uuidSchema,
  /** A saved draft ID only. The server snapshots title/body/channels at the supplied revision. */
  referenceDraftId: uuidSchema,
  expectedReferenceDraftRevision: revisionSchema,
  objective: objectiveSchema,
  prompt: authorPromptSchema,
  includeAuthorName: z.boolean().default(false),
  /** Workspace-owned Daily Knowledge entries; the server resolves their safe summaries. */
  selectedKnowledgeEntryIds: z.array(uuidSchema).max(12).default([]),
  candidateCount: z.number().int().min(1).max(10),
}).strict().superRefine((value, context) => {
  if (new Set(value.selectedKnowledgeEntryIds).size !== value.selectedKnowledgeEntryIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["selectedKnowledgeEntryIds"],
      message: "Samma kunskapsunderlag får bara väljas en gång.",
    });
  }
});
export type SagaAdobeAuthoringRunCreateInput = z.infer<typeof sagaAdobeAuthoringRunCreateSchema>;

/**
 * A transient first-draft request. It deliberately reuses the supported copy
 * fields but receives opaque Daily Knowledge IDs instead of client-supplied
 * summaries, URLs or source bodies. It has no persistence action.
 */
export const sagaAdobeAuthoringPreviewSchema = z.object({
  contentType: z.enum(CONTENT_TYPES),
  channels: z.array(z.enum(CONTENT_CHANNELS)).min(1).max(CONTENT_CHANNELS.length),
  topic: z.string().trim().min(3).max(2_000),
  brief: z.string().trim().max(6_000).default(""),
  voice: z.string().trim().max(280).default("Rak, varm och konkret svenska."),
  targetLength: z.enum(["short", "medium", "long"]).default("medium"),
  templateInstructions: z.string().trim().max(2_000).default(""),
  desiredCallToAction: z.string().trim().max(300).default(""),
  avoid: z.string().trim().max(1_000).default(""),
  imageDirection: z.string().trim().max(1_000).default(""),
  language: z.literal("sv").default("sv"),
  selectedKnowledgeEntryIds: z.array(uuidSchema).max(12).default([]),
}).strict().superRefine((value, context) => {
  if (new Set(value.selectedKnowledgeEntryIds).size !== value.selectedKnowledgeEntryIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["selectedKnowledgeEntryIds"],
      message: "Samma kunskapsunderlag får bara väljas en gång.",
    });
  }
  if (new Set(value.channels).size !== value.channels.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["channels"], message: "En kanal får bara anges en gång." });
  }
  if (value.contentType === "newsletter" && (value.channels.length !== 1 || value.channels[0] !== "newsletter")) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["channels"], message: "Nyhetsbrev kräver kanalen newsletter." });
  }
  if (value.contentType !== "newsletter" && value.channels.includes("newsletter")) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["channels"], message: "Kanalen newsletter kräver innehållstypen newsletter." });
  }
});
export type SagaAdobeAuthoringPreviewInput = z.infer<typeof sagaAdobeAuthoringPreviewSchema>;

/** Starts or resumes one pre-existing private run. A fresh key can resume a queued run after a lost client response. */
export const sagaAdobeAuthoringRunGenerateSchema = z.object({
  idempotencyKey: uuidSchema,
  expectedRunRevision: revisionSchema,
  retryFailed: z.boolean().default(false),
}).strict();
export type SagaAdobeAuthoringRunGenerateInput = z.infer<typeof sagaAdobeAuthoringRunGenerateSchema>;

/** Exactly one selected candidate creates one editable private Studio draft. */
export const sagaAdobeAuthoringCandidateSelectSchema = z.object({
  idempotencyKey: uuidSchema,
  expectedRunRevision: revisionSchema,
  expectedCandidateRevision: revisionSchema,
}).strict();
export type SagaAdobeAuthoringCandidateSelectInput = z.infer<typeof sagaAdobeAuthoringCandidateSelectSchema>;

export const sagaAdobeAuthoringCandidateSchema = z.object({
  id: uuidSchema,
  ordinal: z.number().int().min(1).max(10),
  state: z.enum(SAGA_ADOBE_AUTHORING_CANDIDATE_STATES),
  revision: revisionSchema,
  content: generatedContentSchema.nullable(),
  quality: sagaAdobeAuthoringQualitySchema.nullable(),
  error: z.string().max(1_200).nullable(),
  selectedDraftId: uuidSchema.nullable(),
  selectedDraftHref: z.string().max(500).nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict();
export type SagaAdobeAuthoringCandidate = z.infer<typeof sagaAdobeAuthoringCandidateSchema>;

export const sagaAdobeAuthoringGenerationReceiptSchema = z.object({
  id: uuidSchema,
  state: z.enum(SAGA_ADOBE_AUTHORING_RECEIPT_STATES),
  runRevision: revisionSchema,
  jobCount: z.number().int().min(0).max(10),
  completedJobCount: z.number().int().min(0).max(10),
  failedJobCount: z.number().int().min(0).max(10),
  failureMessage: z.string().max(1_200).nullable(),
  reused: z.boolean(),
}).strict();
export type SagaAdobeAuthoringGenerationReceipt = z.infer<typeof sagaAdobeAuthoringGenerationReceiptSchema>;

/**
 * Server-only command lease. The browser never sees its claim token; a
 * duplicate HTTP request must not advance a different candidate.
 */
export type SagaAdobeAuthoringGenerationCommand = {
  id: string;
  claimToken: string | null;
  shouldProcess: boolean;
};

/**
 * Browser-safe, read-only accounting for an explicitly started receipt.  It
 * deliberately describes persisted candidates rather than implying that a
 * background worker will keep running after the response finishes.
 */
export const sagaAdobeAuthoringGenerationProgressSchema = z.object({
  total: z.number().int().min(1).max(10),
  pending: z.number().int().min(0).max(10),
  completed: z.number().int().min(0).max(10),
  queued: z.number().int().min(0).max(10),
  generating: z.number().int().min(0).max(10),
  ready: z.number().int().min(0).max(10),
  blocked: z.number().int().min(0).max(10),
  failed: z.number().int().min(0).max(10),
  selected: z.number().int().min(0).max(10),
  notSelected: z.number().int().min(0).max(10),
}).strict();
export type SagaAdobeAuthoringGenerationProgress = z.infer<typeof sagaAdobeAuthoringGenerationProgressSchema>;

export const sagaAdobeAuthoringRunSchema = z.object({
  id: uuidSchema,
  revision: revisionSchema,
  state: z.enum(SAGA_ADOBE_AUTHORING_RUN_STATES),
  objective: objectiveSchema,
  prompt: authorPromptSchema,
  includeAuthorName: z.boolean(),
  candidateCount: z.number().int().min(1).max(10),
  reference: sagaAdobeAuthoringReferenceSnapshotSchema,
  knowledge: z.array(sagaAdobeAuthoringKnowledgeSnapshotSchema).max(12),
  candidates: z.array(sagaAdobeAuthoringCandidateSchema).max(10),
  selectedCandidateId: uuidSchema.nullable(),
  selectedDraftId: uuidSchema.nullable(),
  selectedDraftHref: z.string().max(500).nullable(),
  failureMessage: z.string().max(1_200).nullable(),
  canGenerate: z.boolean(),
  canRetry: z.boolean(),
  canSelect: z.boolean(),
  /** True only while an explicitly started receipt still has unclaimed work. GET never advances it. */
  hasPendingWork: z.boolean(),
  /** Call the same explicit generate route again; Cron and polling never do this work. */
  canContinue: z.boolean(),
  generationProgress: sagaAdobeAuthoringGenerationProgressSchema,
  noPublication: z.literal(true),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict();
export type SagaAdobeAuthoringRun = z.infer<typeof sagaAdobeAuthoringRunSchema>;

/** Server-only claim; no raw actor selection, URL or client-generated copy exists here. */
export type SagaAdobeAuthoringGenerationClaim = {
  commandId: string;
  commandClaimToken: string;
  jobId: string;
  claimToken: string;
  receiptId: string;
  runId: string;
  runRevision: number;
  candidateId: string;
  candidateOrdinal: number;
  reference: SagaAdobeAuthoringReferenceSnapshot;
  objective: string;
  authorPrompt: string;
  includeAuthorName: boolean;
  authorName: string | null;
  knowledge: SagaAdobeAuthoringKnowledgeSnapshot[];
};

export type SagaAdobeAuthoringPrivateCandidateMaterialization = {
  content: z.infer<typeof generatedContentSchema>;
  quality: SagaAdobeAuthoringQuality;
  model: string;
  responseId: string;
  inputTokens: number | null;
  outputTokens: number | null;
};

export const SAGA_ADOBE_AUTHORING_API_CONTRACT = {
  list: { method: "GET", path: "/api/saga/authoring-runs", response: "{ runs: SagaAdobeAuthoringRun[] }" },
  create: { method: "POST", path: "/api/saga/authoring-runs", body: "SagaAdobeAuthoringRunCreateInput", response: "{ run, reused, noPublication: true }" },
  read: { method: "GET", path: "/api/saga/authoring-runs/:runId", response: "{ run: SagaAdobeAuthoringRun /* includes hasPendingWork, canContinue and generationProgress */ }" },
  generate: { method: "POST", path: "/api/saga/authoring-runs/:runId/generate", body: "SagaAdobeAuthoringRunGenerateInput", response: "{ run, receipt, worker, noPublication: true }" },
  select: { method: "POST", path: "/api/saga/authoring-runs/:runId/candidates/:candidateId/select", body: "SagaAdobeAuthoringCandidateSelectInput", response: "{ run, selectedDraft: { id, href, status: 'in_review', scheduledAt: null }, reused, noPublication: true }" },
  preview: { method: "POST", path: "/api/saga/authoring-preview", body: "SagaAdobeAuthoringPreviewInput", response: "{ draft: GeneratedContent, quality: SagaAdobeAuthoringQuality, selectedKnowledgeEntryIds: string[], saved: false, noPublication: true }" },
} as const;

/** Useful narrow type aliases at server-only boundaries. */
export type SagaAdobeAuthoringReferenceChannels = readonly ContentChannel[];
export type SagaAdobeAuthoringReferenceContentType = ContentType;
