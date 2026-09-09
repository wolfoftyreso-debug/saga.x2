import { z } from "zod";
import { CONTENT_CHANNELS, CONTENT_TYPES } from "@/lib/domain/content-studio";

/**
 * Browser-safe contracts for a saved SAGA Series Reference. A series is a
 * workspace-owned editorial reference, not an automation or publishing rule.
 * Its example draft is copied into an immutable revision on the server so a
 * later edit or deletion of the original Studio draft cannot silently change
 * the reference used by an AI or quality caller.
 */

const uuidSchema = z.string().uuid();
const timestampSchema = z.string().min(1);
const slugSchema = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,78}$/);
const boundedElementSchema = z.string().trim().min(1).max(200);

export const SAGA_SERIES_REFERENCE_OBJECTIVES = ["educate", "inspire", "convert", "community"] as const;
export const SAGA_SERIES_REFERENCE_TONES = ["direct", "warm", "insightful"] as const;
export const SAGA_SERIES_MEDIA_KINDS = ["upload", "generated", "derived"] as const;
export const SAGA_SERIES_MEDIA_STATUSES = ["processing", "ready", "failed", "deleted"] as const;

export type SagaSeriesReferenceObjective = (typeof SAGA_SERIES_REFERENCE_OBJECTIVES)[number];
export type SagaSeriesReferenceTone = (typeof SAGA_SERIES_REFERENCE_TONES)[number];

function hasDuplicateStrings(values: readonly string[]): boolean {
  return new Set(values.map((value) => value.toLocaleLowerCase("sv-SE"))).size !== values.length;
}

export const sagaSeriesReferenceControlsSchema = z.object({
  objective: z.enum(SAGA_SERIES_REFERENCE_OBJECTIVES),
  audience: z.string().trim().min(1).max(160),
  tone: z.enum(SAGA_SERIES_REFERENCE_TONES),
  requiredElements: z.array(boundedElementSchema).max(6),
  forbiddenElements: z.array(boundedElementSchema).max(6),
  defaultChannels: z.array(z.enum(CONTENT_CHANNELS)).max(CONTENT_CHANNELS.length),
  /** Series references are always review-first. Automation owns cadence. */
  reviewRequired: z.literal(true),
}).strict().superRefine((value, context) => {
  if (hasDuplicateStrings(value.requiredElements)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["requiredElements"], message: "Ett obligatoriskt element får bara anges en gång." });
  }
  if (hasDuplicateStrings(value.forbiddenElements)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["forbiddenElements"], message: "Ett förbjudet element får bara anges en gång." });
  }
  if (new Set(value.defaultChannels).size !== value.defaultChannels.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["defaultChannels"], message: "En standardkanal får bara anges en gång." });
  }
  const required = new Set(value.requiredElements.map((value) => value.toLocaleLowerCase("sv-SE")));
  if (value.forbiddenElements.some((value) => required.has(value.toLocaleLowerCase("sv-SE")))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["forbiddenElements"], message: "Samma element kan inte både krävas och förbjudas." });
  }
});
export type SagaSeriesReferenceControls = z.infer<typeof sagaSeriesReferenceControlsSchema>;

/** This is deliberately metadata only; Blob URLs, paths, hashes and raw metadata never enter a reference. */
export const sagaSeriesReferenceMediaSchema = z.object({
  kind: z.enum(SAGA_SERIES_MEDIA_KINDS),
  contentType: z.string().trim().min(1).max(120),
  width: z.number().int().positive().max(20_000).nullable(),
  height: z.number().int().positive().max(20_000).nullable(),
  altText: z.string().max(1_000).nullable(),
  status: z.enum(SAGA_SERIES_MEDIA_STATUSES),
}).strict();
export type SagaSeriesReferenceMedia = z.infer<typeof sagaSeriesReferenceMediaSchema>;

export const sagaSeriesReferenceSnapshotSchema = z.object({
  revision: z.number().int().min(1),
  sourceDraftId: uuidSchema,
  sourceDraftRevision: z.number().int().min(1),
  contentType: z.enum(CONTENT_TYPES),
  title: z.string().trim().min(1).max(240),
  body: z.string().trim().min(1).max(60_000),
  channels: z.array(z.enum(CONTENT_CHANNELS)).max(CONTENT_CHANNELS.length),
  media: z.array(sagaSeriesReferenceMediaSchema).max(12),
  capturedAt: timestampSchema,
}).strict();
export type SagaSeriesReferenceSnapshot = z.infer<typeof sagaSeriesReferenceSnapshotSchema>;

const sagaSeriesReferenceBaseSchema = z.object({
  slug: slugSchema,
  name: z.string().trim().min(2).max(160),
  active: z.boolean().default(false),
});

export const sagaSeriesReferenceCreateSchema = sagaSeriesReferenceBaseSchema.extend({
  /** A persisted Studio draft. The server, not the client, turns it into a snapshot. */
  referenceDraftId: uuidSchema,
  controls: sagaSeriesReferenceControlsSchema,
}).strict();
export type SagaSeriesReferenceCreateInput = z.infer<typeof sagaSeriesReferenceCreateSchema>;

export const sagaSeriesReferencePatchSchema = z.object({
  id: uuidSchema,
  expectedRevision: z.number().int().min(1).max(2_147_483_647),
  slug: slugSchema.optional(),
  name: z.string().trim().min(2).max(160).optional(),
  active: z.boolean().optional(),
  /** Replacing this creates a new immutable reference snapshot. */
  referenceDraftId: uuidSchema.optional(),
  /** Replacing controls also creates a new immutable reference snapshot. */
  controls: sagaSeriesReferenceControlsSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.slug === undefined && value.name === undefined && value.active === undefined && value.referenceDraftId === undefined && value.controls === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Ange minst en ändring för serien." });
  }
});
export type SagaSeriesReferencePatchInput = z.infer<typeof sagaSeriesReferencePatchSchema>;

export const sagaSeriesReferenceDeleteSchema = z.object({
  id: uuidSchema,
  expectedRevision: z.number().int().min(1).max(2_147_483_647),
}).strict();
export type SagaSeriesReferenceDeleteInput = z.infer<typeof sagaSeriesReferenceDeleteSchema>;

export const sagaSeriesReferenceSchema = sagaSeriesReferenceBaseSchema.extend({
  id: uuidSchema,
  createdByUserId: uuidSchema,
  updatedByUserId: uuidSchema,
  revision: z.number().int().min(1),
  reference: sagaSeriesReferenceSnapshotSchema,
  /** Fixed editorial controls stored beside the same immutable snapshot revision. */
  controls: sagaSeriesReferenceControlsSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict();
export type SagaSeriesReference = z.infer<typeof sagaSeriesReferenceSchema>;

/** Minimal server-side context for AI and quality callers. It is never a browser credential or media locator. */
export const sagaSeriesReferenceContextSchema = z.object({
  seriesId: uuidSchema,
  seriesRevision: z.number().int().min(1),
  seriesName: z.string().min(2).max(160),
  reference: sagaSeriesReferenceSnapshotSchema,
  controls: sagaSeriesReferenceControlsSchema,
}).strict();
export type SagaSeriesReferenceContext = z.infer<typeof sagaSeriesReferenceContextSchema>;

export const sagaSeriesReferenceReadResponseSchema = z.object({
  series: z.array(sagaSeriesReferenceSchema),
}).strict();

export const SAGA_SERIES_REFERENCE_API_CONTRACT = {
  list: { method: "GET", path: "/api/saga/series", response: "{ series: SagaSeriesReference[] }" },
  create: { method: "POST", path: "/api/saga/series", body: "SagaSeriesReferenceCreateInput", response: "{ series: SagaSeriesReference }" },
  patch: { method: "PATCH", path: "/api/saga/series", body: "SagaSeriesReferencePatchInput", response: "{ series: SagaSeriesReference }" },
  remove: { method: "DELETE", path: "/api/saga/series", body: "SagaSeriesReferenceDeleteInput", response: "{ deleted: { id: string } }" },
} as const;
