import { z } from "zod";
import {
  contentChannelSchema,
  contentTypeSchema,
  type ContentChannel,
  type ContentType,
} from "@/lib/domain/content-studio";
import { isValidIanaTimezone, localDateTimeInTimezone } from "@/lib/utils/date";

/**
 * The operational layer deliberately plans only the channels that Studio can
 * currently turn into a private draft. A website is an annual-plan channel,
 * not a quarterly AI-draft destination in this version.
 */
export const SAGA_QUARTERLY_HORIZON_WEEKS = 13 as const;
export const SAGA_QUARTERLY_MAX_BATCH_SIZE = 10 as const;
export const SAGA_QUARTERLY_MAX_SLOTS = 260 as const;
export const SAGA_QUARTERLY_BATCH_STATES = [
  "queued",
  "generating",
  "ready_for_review",
  "rework_required",
  "resolved",
  "failed",
  "stale",
] as const;
export const SAGA_QUARTERLY_BATCH_ITEM_STATES = [
  "queued",
  "generating",
  "ready_for_review",
  "approved",
  "returned",
  "rejected",
  "failed",
  "cancelled",
] as const;
export const SAGA_QUARTERLY_REVIEW_RESOLUTIONS = ["approved", "returned", "rejected"] as const;

/**
 * The retry budget belongs to durable Neon jobs, but the browser needs a
 * truthful, tiny action model. A failed batch with an exhausted job must
 * expose human abandonment instead of a retry button that can only fail.
 */
export function deriveSagaQuarterlyBatchActionability(input: {
  state: (typeof SAGA_QUARTERLY_BATCH_STATES)[number] | string;
  retryableJobCount: number;
  exhaustedJobCount: number;
  activeProcessingJobCount: number;
}): Pick<SagaQuarterlyBatch, "canMaterialize" | "canRetry" | "canAbandon" | "retryExhausted"> {
  const failed = input.state === "failed";
  const retryExhausted = failed && input.exhaustedJobCount > 0;
  return {
    canMaterialize: input.state === "queued" || input.state === "generating",
    canRetry: failed
      && input.retryableJobCount > 0
      && !retryExhausted
      && input.activeProcessingJobCount === 0,
    // The SQL function repeats this lease/state check under row locks. The
    // flag is an affordance, never an authorization decision.
    canAbandon: failed && input.activeProcessingJobCount === 0,
    retryExhausted,
  };
}

const uuidSchema = z.string().uuid();
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Ange datum som YYYY-MM-DD.").superRefine((value, context) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Ange ett verkligt kalenderdatum." });
  }
});
const localTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Ange tid som HH:MM.");
const timezoneSchema = z.string().trim().min(3).max(80).refine(
  isValidIanaTimezone,
  "Ange en giltig IANA-tidszon, till exempel Europe/Stockholm.",
);
const localIdSchema = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,78}$/);
const nonEmptyText = (minimum: number, maximum: number) => z.string().trim().min(minimum).max(maximum);
/** V1 only materializes channels with a proven private Studio-draft contract. */
export const sagaQuarterlyMaterializableChannelSchema = z.enum([
  "facebook_page",
  "instagram",
  "linkedin",
  "newsletter",
]);
export const sagaQuarterlyMaterializableContentTypeSchema = z.enum(["social_post", "newsletter"]);

export const sagaQuarterlyContentThemeSchema = z.object({
  id: localIdSchema,
  title: nonEmptyText(2, 160),
  intent: nonEmptyText(12, 800),
  contentDirection: nonEmptyText(12, 1_500),
  /** Saving the plan is the explicit human approval of the theme. */
  approved: z.literal(true),
}).strict();
export type SagaQuarterlyContentTheme = z.infer<typeof sagaQuarterlyContentThemeSchema>;

const weeklyCadenceSchema = z.object({
  unit: z.literal("weekly"),
  count: z.number().int().min(1).max(7),
  /** Sunday = 0, Monday = 1, matching JavaScript and Studio schedules. */
  weekdayIds: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  /** One recurring time, or one time matching each selected weekday. */
  localTimes: z.array(localTimeSchema).min(1).max(7),
}).strict().superRefine((value, context) => {
  if (new Set(value.weekdayIds).size !== value.weekdayIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["weekdayIds"], message: "Varje veckodag får bara väljas en gång." });
  }
  if (value.weekdayIds.length !== value.count) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["weekdayIds"], message: "Välj en veckodag för varje planerat inlägg per vecka." });
  }
  if (value.localTimes.length !== 1 && value.localTimes.length !== value.count) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["localTimes"], message: "Ange en återkommande tid eller en tid per veckodag." });
  }
});

const monthlyCadenceSchema = z.object({
  unit: z.literal("monthly"),
  count: z.number().int().min(1).max(8),
  /** Day 1–28 avoids silently skipping a month. */
  dayOfMonth: z.array(z.number().int().min(1).max(28)).min(1).max(8),
  localTimes: z.array(localTimeSchema).min(1).max(8),
}).strict().superRefine((value, context) => {
  if (new Set(value.dayOfMonth).size !== value.dayOfMonth.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["dayOfMonth"], message: "Varje månadsvardag får bara väljas en gång." });
  }
  if (value.dayOfMonth.length !== value.count) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["dayOfMonth"], message: "Välj en dag för varje planerat utskick per månad." });
  }
  if (value.localTimes.length !== 1 && value.localTimes.length !== value.count) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["localTimes"], message: "Ange en återkommande tid eller en tid per månadsdag." });
  }
});

export const sagaQuarterlyChannelPlanSchema = z.object({
  id: localIdSchema,
  channel: sagaQuarterlyMaterializableChannelSchema,
  contentType: sagaQuarterlyMaterializableContentTypeSchema,
  objective: nonEmptyText(12, 1_200),
  cadence: z.union([weeklyCadenceSchema, monthlyCadenceSchema]),
  themes: z.array(sagaQuarterlyContentThemeSchema).min(1).max(12),
  desiredCallToAction: z.string().trim().max(300).default(""),
  imageDirection: z.string().trim().max(1_000).default(""),
  targetLength: z.enum(["short", "medium", "long"]).default("medium"),
}).strict().superRefine((value, context) => {
  if (value.channel === "newsletter" && value.contentType !== "newsletter") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["contentType"], message: "Nyhetsbrevskanalen behöver innehållstypen newsletter." });
  }
  if (value.channel !== "newsletter" && value.contentType !== "social_post") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["contentType"], message: "Sociala kanaler använder social_post i den här 13-veckorsplanen." });
  }
  if (new Set(value.themes.map((theme) => theme.id)).size !== value.themes.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["themes"], message: "Varje innehållstema behöver ett eget id." });
  }
});
export type SagaQuarterlyChannelPlan = z.infer<typeof sagaQuarterlyChannelPlanSchema>;

export const sagaQuarterlyActivityPlanInputSchema = z.object({
  name: nonEmptyText(2, 160).default("Rullande 13-veckorsplan"),
  horizonStartDate: dateSchema,
  timezone: timezoneSchema,
  channelPlans: z.array(sagaQuarterlyChannelPlanSchema).min(1).max(4),
}).strict().superRefine((value, context) => {
  if (weekdayForDate(value.horizonStartDate) !== 1) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["horizonStartDate"], message: "13-veckorshorisonten behöver börja på en måndag." });
  }
  if (new Set(value.channelPlans.map((plan) => plan.id)).size !== value.channelPlans.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["channelPlans"], message: "Varje kanalplan behöver ett eget id." });
  }
  if (new Set(value.channelPlans.map((plan) => plan.channel)).size !== value.channelPlans.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["channelPlans"], message: "Välj en tydlig frekvens per kanal i samma 13-veckorsplan." });
  }
});
export type SagaQuarterlyActivityPlanInput = z.infer<typeof sagaQuarterlyActivityPlanInputSchema>;

export const sagaQuarterlyActivityPlanCreateSchema = z.object({
  createIdempotencyKey: uuidSchema,
  brandProfileId: uuidSchema,
  plan: sagaQuarterlyActivityPlanInputSchema,
}).strict();
export type SagaQuarterlyActivityPlanCreateInput = z.infer<typeof sagaQuarterlyActivityPlanCreateSchema>;

export const sagaQuarterlyActivityPlanUpdateSchema = z.object({
  expectedRevision: z.number().int().min(1).max(2_147_483_647),
  plan: sagaQuarterlyActivityPlanInputSchema,
}).strict();
export type SagaQuarterlyActivityPlanUpdateInput = z.infer<typeof sagaQuarterlyActivityPlanUpdateSchema>;

export const sagaQuarterlyBatchRequestSchema = z.object({
  idempotencyKey: uuidSchema,
  expectedPlanRevision: z.number().int().min(1).max(2_147_483_647),
  planItemIds: z.array(uuidSchema).min(1).max(SAGA_QUARTERLY_MAX_BATCH_SIZE),
}).strict().superRefine((value, context) => {
  if (new Set(value.planItemIds).size !== value.planItemIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["planItemIds"], message: "Välj varje planerat innehållstillfälle högst en gång i batchen." });
  }
});
export type SagaQuarterlyBatchRequest = z.infer<typeof sagaQuarterlyBatchRequestSchema>;

/** A command is retry-safe at the job lease boundary; it never schedules or delivers. */
export const sagaQuarterlyBatchMaterializeSchema = z.object({
  idempotencyKey: uuidSchema,
  expectedPlanRevision: z.number().int().min(1).max(2_147_483_647),
  expectedBatchRevision: z.number().int().min(1).max(2_147_483_647),
  /** Explicitly lets a human retry a failed private-generation receipt. */
  retryFailed: z.boolean().default(false),
}).strict();
export type SagaQuarterlyBatchMaterializeInput = z.infer<typeof sagaQuarterlyBatchMaterializeSchema>;

export const sagaQuarterlyBatchReviewSchema = z.object({
  idempotencyKey: uuidSchema,
  expectedPlanRevision: z.number().int().min(1).max(2_147_483_647),
  expectedBatchRevision: z.number().int().min(1).max(2_147_483_647),
  expectedItemRevision: z.number().int().min(1).max(2_147_483_647),
  expectedDraftRevision: z.number().int().min(1).max(2_147_483_647),
  resolution: z.enum(SAGA_QUARTERLY_REVIEW_RESOLUTIONS),
  note: z.string().trim().max(2_000).default(""),
}).strict().superRefine((value, context) => {
  if (value.resolution === "returned" && !value.note.trim()) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["note"], message: "Skriv vad som behöver ändras när du skickar tillbaka ett utkast." });
  }
});
export type SagaQuarterlyBatchReviewInput = z.infer<typeof sagaQuarterlyBatchReviewSchema>;

/** A returned draft stays in the same batch until a human has edited and resubmitted it. */
export const sagaQuarterlyBatchResubmitSchema = z.object({
  idempotencyKey: uuidSchema,
  expectedPlanRevision: z.number().int().min(1).max(2_147_483_647),
  expectedBatchRevision: z.number().int().min(1).max(2_147_483_647),
  expectedItemRevision: z.number().int().min(1).max(2_147_483_647),
  expectedDraftRevision: z.number().int().min(2).max(2_147_483_647),
}).strict();
export type SagaQuarterlyBatchResubmitInput = z.infer<typeof sagaQuarterlyBatchResubmitSchema>;

/** Explicit terminal recovery after a failed receipt exhausts its retries. */
export const sagaQuarterlyBatchAbandonSchema = z.object({
  idempotencyKey: uuidSchema,
  expectedPlanRevision: z.number().int().min(1).max(2_147_483_647),
  expectedBatchRevision: z.number().int().min(1).max(2_147_483_647),
  note: z.string().trim().min(3).max(2_000),
}).strict();
export type SagaQuarterlyBatchAbandonInput = z.infer<typeof sagaQuarterlyBatchAbandonSchema>;

export const sagaQuarterlyDerivedSlotSchema = z.object({
  slotKey: z.string().min(3).max(240),
  channelPlanId: localIdSchema,
  weekIndex: z.number().int().min(1).max(SAGA_QUARTERLY_HORIZON_WEEKS),
  plannedAt: z.string().datetime({ offset: true }),
  plannedLocalDate: dateSchema,
  plannedLocalTime: localTimeSchema,
  timezone: timezoneSchema,
  channel: sagaQuarterlyMaterializableChannelSchema,
  contentType: sagaQuarterlyMaterializableContentTypeSchema,
  theme: sagaQuarterlyContentThemeSchema,
  objective: nonEmptyText(12, 1_200),
  contentDirection: nonEmptyText(12, 1_500),
  desiredCallToAction: z.string().trim().max(300),
  imageDirection: z.string().trim().max(1_000),
  targetLength: z.enum(["short", "medium", "long"]),
  planningLabel: nonEmptyText(2, 240),
}).strict();
export type SagaQuarterlyDerivedSlot = z.infer<typeof sagaQuarterlyDerivedSlotSchema>;

export const sagaQuarterlyActivityPlanSlotSchema = sagaQuarterlyDerivedSlotSchema.extend({
  id: uuidSchema,
  planRevision: z.number().int().min(1),
  state: z.enum(["planned", "in_batch", "draft_ready", "review_resolved", "cancelled"]),
  revision: z.number().int().min(1),
  draftId: uuidSchema.nullable(),
  draftHref: z.string().min(1).nullable(),
}).strict();
export type SagaQuarterlyActivityPlanSlot = z.infer<typeof sagaQuarterlyActivityPlanSlotSchema>;

export const sagaQuarterlyBatchItemSchema = z.object({
  id: uuidSchema,
  planItemId: uuidSchema,
  slot: sagaQuarterlyActivityPlanSlotSchema,
  state: z.enum(SAGA_QUARTERLY_BATCH_ITEM_STATES),
  reviewResolution: z.enum(SAGA_QUARTERLY_REVIEW_RESOLUTIONS).nullable(),
  reviewNote: z.string(),
  /** Revision immediately after return; resubmit requires the real draft to exceed it. */
  returnedDraftRevision: z.number().int().min(1).nullable(),
  revision: z.number().int().min(1),
  draftId: uuidSchema.nullable(),
  draftHref: z.string().min(1).nullable(),
  draftRevision: z.number().int().min(1).nullable(),
  error: z.string().min(1).nullable(),
}).strict();
export type SagaQuarterlyBatchItem = z.infer<typeof sagaQuarterlyBatchItemSchema>;

export const sagaQuarterlyBatchSchema = z.object({
  id: uuidSchema,
  planRevision: z.number().int().min(1),
  requestedCount: z.number().int().min(1).max(SAGA_QUARTERLY_MAX_BATCH_SIZE),
  state: z.enum(SAGA_QUARTERLY_BATCH_STATES),
  revision: z.number().int().min(1),
  /** A queued/running receipt can be resumed; this is never a delivery action. */
  canMaterialize: z.boolean(),
  /** A failed receipt still has at least one durable job attempt remaining. */
  canRetry: z.boolean(),
  /** A human may explicitly close a failed batch after reading its failure. */
  canAbandon: z.boolean(),
  /** Retry is impossible because at least one durable job exhausted its capped attempts. */
  retryExhausted: z.boolean(),
  canRequestNextBatch: z.boolean(),
  failureMessage: z.string().min(1).nullable(),
  /** Present when a human explicitly closed a terminal failed batch. */
  abandonedAt: z.string().datetime({ offset: true }).nullable(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  items: z.array(sagaQuarterlyBatchItemSchema).max(SAGA_QUARTERLY_MAX_BATCH_SIZE),
}).strict();
export type SagaQuarterlyBatch = z.infer<typeof sagaQuarterlyBatchSchema>;

export const sagaQuarterlyMaterializationReceiptSchema = z.object({
  id: uuidSchema,
  state: z.enum(["running", "completed", "failed", "stale"]),
  jobCount: z.number().int().min(1).max(SAGA_QUARTERLY_MAX_BATCH_SIZE),
  failureMessage: z.string().min(1).nullable(),
  reused: z.boolean(),
}).strict();
export type SagaQuarterlyMaterializationReceipt = z.infer<typeof sagaQuarterlyMaterializationReceiptSchema>;

export const sagaQuarterlyActivityPlanSchema = z.object({
  id: uuidSchema,
  brandProfileId: uuidSchema,
  brandName: nonEmptyText(2, 160),
  onboardingId: uuidSchema,
  revision: z.number().int().min(1),
  plan: sagaQuarterlyActivityPlanInputSchema,
  horizonWeeks: z.literal(SAGA_QUARTERLY_HORIZON_WEEKS),
  slots: z.array(sagaQuarterlyActivityPlanSlotSchema).min(1).max(SAGA_QUARTERLY_MAX_SLOTS),
  canRequestBatch: z.boolean(),
  nextBatchReason: z.string().min(1).nullable(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();
export type SagaQuarterlyActivityPlan = z.infer<typeof sagaQuarterlyActivityPlanSchema>;

export const sagaQuarterlyActivityPlanSummarySchema = z.object({
  id: uuidSchema,
  brandProfileId: uuidSchema,
  brandName: nonEmptyText(2, 160),
  revision: z.number().int().min(1),
  timezone: timezoneSchema,
  horizonStartDate: dateSchema,
  slotCount: z.number().int().min(1).max(SAGA_QUARTERLY_MAX_SLOTS),
  openBatchCount: z.number().int().min(0),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();
export type SagaQuarterlyActivityPlanSummary = z.infer<typeof sagaQuarterlyActivityPlanSummarySchema>;

/** Read-only overlay for the Studio calendar. It is intentionally not a scheduled draft. */
export const sagaQuarterlyPlanCalendarSlotSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("plan_slot"),
  planId: uuidSchema,
  brandProfileId: uuidSchema,
  brandName: nonEmptyText(2, 160),
  title: nonEmptyText(2, 240),
  startsAt: z.string().datetime({ offset: true }),
  plannedLocalDate: dateSchema,
  plannedLocalTime: localTimeSchema,
  timezone: timezoneSchema,
  channel: sagaQuarterlyMaterializableChannelSchema,
  contentType: sagaQuarterlyMaterializableContentTypeSchema,
  state: z.enum(["planned", "in_batch", "draft_ready", "review_resolved"]),
  draftId: uuidSchema.nullable(),
  draftHref: z.string().min(1).nullable(),
  editable: z.literal(false),
  calendarLabel: z.literal("Planerad aktivitet"),
}).strict();
export type SagaQuarterlyPlanCalendarSlot = z.infer<typeof sagaQuarterlyPlanCalendarSlotSchema>;

export type SagaQuarterlyGenerationClaim = {
  jobId: string;
  claimToken: string;
  batchId: string;
  batchItemId: string;
  planId: string;
  planRevision: number;
  materializationReceiptId: string;
  authorUserId: string;
  timezone: string;
  brand: {
    name: string;
    summary: string;
    voice: Record<string, unknown>;
  };
  slot: SagaQuarterlyDerivedSlot & { id: string; revision: number };
};

/**
 * Internal server-to-database materialization payload. The route never takes
 * this from a browser: it is assembled after the Gateway response has passed
 * the deterministic quality gate.
 */
export const sagaQuarterlyPrivateDraftMaterializationSchema = z.object({
  contentType: contentTypeSchema,
  channels: z.array(contentChannelSchema).min(1).max(4),
  title: nonEmptyText(1, 140),
  headline: z.string().trim().max(200).nullable(),
  subject: z.string().trim().max(160).nullable(),
  body: nonEmptyText(1, 12_000),
  cta: z.string().trim().max(220).nullable(),
  excerpt: z.string().trim().max(320).nullable(),
  hashtags: z.array(z.string().trim().min(2).max(80)).max(10),
  generationPrompt: z.string().trim().max(6_000),
  imagePrompt: z.string().trim().max(1_500),
  targetLength: z.enum(["short", "medium", "long"]),
  timezone: timezoneSchema,
  quality: z.object({
    version: z.string().min(1).max(80),
    decision: z.enum(["approved", "review_required", "blocked"]),
    score: z.number().finite().min(0).max(100),
    findings: z.array(z.object({
      code: z.string().min(1).max(160),
      severity: z.enum(["blocker", "warning"]),
      field: z.string().min(1).max(160),
      message: z.string().min(1).max(1_000),
    }).strict()).max(50),
    canCreatePrivateDraft: z.literal(true),
    canEnterCalendar: z.boolean(),
    canDeliver: z.literal(false),
  }).passthrough(),
}).strict().superRefine((value, context) => {
  if (value.contentType === "newsletter" && (value.channels.length !== 1 || value.channels[0] !== "newsletter")) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["channels"], message: "Nyhetsbrevsutkastet behöver endast newsletter." });
  }
  if (value.contentType !== "newsletter" && value.channels.includes("newsletter")) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["channels"], message: "Newsletter kräver innehållstypen newsletter." });
  }
});
export type SagaQuarterlyPrivateDraftMaterialization = z.infer<typeof sagaQuarterlyPrivateDraftMaterializationSchema>;

/**
 * Derives the full rolling horizon from explicit user choices. There is no
 * audience-size, reach, conversion or performance inference in this layer.
 */
export function deriveSagaQuarterlyActivityPlanSlots(value: SagaQuarterlyActivityPlanInput): SagaQuarterlyDerivedSlot[] {
  const input = sagaQuarterlyActivityPlanInputSchema.parse(value);
  const slots: SagaQuarterlyDerivedSlot[] = [];

  for (const channelPlan of input.channelPlans) {
    const occurrences = channelPlan.cadence.unit === "weekly"
      ? weeklyOccurrences(input.horizonStartDate, channelPlan)
      : monthlyOccurrences(input.horizonStartDate, channelPlan);
    occurrences.forEach((occurrence, occurrenceIndex) => {
      const theme = channelPlan.themes[occurrenceIndex % channelPlan.themes.length];
      if (!theme) throw new SagaQuarterlyPlanningInputError("Varje kanalplan behöver minst ett godkänt innehållstema.");
      const plannedAt = zonedDateTimeToUtc(occurrence.localDate, occurrence.localTime, input.timezone);
      if (!plannedAt) {
        throw new SagaQuarterlyPlanningInputError(
          `${occurrence.localDate} ${occurrence.localTime} finns inte i ${input.timezone}, till exempel på grund av sommartid. Välj en annan tid.`,
        );
      }
      slots.push(sagaQuarterlyDerivedSlotSchema.parse({
        slotKey: `${channelPlan.id}:${occurrence.weekIndex}:${occurrence.localDate}:${occurrence.localTime}`,
        channelPlanId: channelPlan.id,
        weekIndex: occurrence.weekIndex,
        plannedAt: plannedAt.toISOString(),
        plannedLocalDate: occurrence.localDate,
        plannedLocalTime: occurrence.localTime,
        timezone: input.timezone,
        channel: channelPlan.channel,
        contentType: channelPlan.contentType,
        theme,
        objective: channelPlan.objective,
        contentDirection: theme.contentDirection,
        desiredCallToAction: channelPlan.desiredCallToAction,
        imageDirection: channelPlan.imageDirection,
        targetLength: channelPlan.targetLength,
        planningLabel: theme.title,
      }));
    });
  }

  slots.sort((left, right) => left.plannedAt.localeCompare(right.plannedAt) || left.slotKey.localeCompare(right.slotKey));
  if (slots.length > SAGA_QUARTERLY_MAX_SLOTS) {
    throw new SagaQuarterlyPlanningInputError(`Planen innehåller ${slots.length} tillfällen. Minska frekvensen till högst ${SAGA_QUARTERLY_MAX_SLOTS} per 13 veckor.`);
  }
  if (!slots.length) throw new SagaQuarterlyPlanningInputError("Planen behöver minst ett innehållstillfälle i 13-veckorshorisonten.");
  if (new Set(slots.map((slot) => slot.slotKey)).size !== slots.length) {
    throw new SagaQuarterlyPlanningInputError("Två kanalplaner skapar samma innehållstillfälle. Välj unika kanaler, dagar och tider.");
  }
  return slots;
}

export class SagaQuarterlyPlanningInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SagaQuarterlyPlanningInputError";
  }
}

function weeklyOccurrences(start: string, channelPlan: SagaQuarterlyChannelPlan): Array<{ localDate: string; localTime: string; weekIndex: number }> {
  if (channelPlan.cadence.unit !== "weekly") return [];
  const result: Array<{ localDate: string; localTime: string; weekIndex: number }> = [];
  for (let weekIndex = 1; weekIndex <= SAGA_QUARTERLY_HORIZON_WEEKS; weekIndex += 1) {
    channelPlan.cadence.weekdayIds.forEach((weekday, index) => {
      const dayOffset = (weekday - 1 + 7) % 7;
      result.push({
        localDate: addDays(start, (weekIndex - 1) * 7 + dayOffset),
        localTime: timeForIndex(channelPlan.cadence.localTimes, index),
        weekIndex,
      });
    });
  }
  return result;
}

function monthlyOccurrences(start: string, channelPlan: SagaQuarterlyChannelPlan): Array<{ localDate: string; localTime: string; weekIndex: number }> {
  if (channelPlan.cadence.unit !== "monthly") return [];
  const result: Array<{ localDate: string; localTime: string; weekIndex: number }> = [];
  for (let offset = 0; offset < SAGA_QUARTERLY_HORIZON_WEEKS * 7; offset += 1) {
    const localDate = addDays(start, offset);
    const day = Number(localDate.slice(8, 10));
    const index = channelPlan.cadence.dayOfMonth.indexOf(day);
    if (index < 0) continue;
    result.push({
      localDate,
      localTime: timeForIndex(channelPlan.cadence.localTimes, index),
      weekIndex: Math.floor(offset / 7) + 1,
    });
  }
  return result;
}

function timeForIndex(times: readonly string[], index: number): string {
  return times.length === 1 ? times[0] ?? "" : times[index] ?? "";
}

function weekdayForDate(date: string): number {
  return new Date(`${date}T00:00:00.000Z`).getUTCDay();
}

function addDays(date: string, days: number): string {
  const instance = new Date(`${date}T00:00:00.000Z`);
  instance.setUTCDate(instance.getUTCDate() + days);
  return instance.toISOString().slice(0, 10);
}

/** Matches Studio's IANA conversion and rejects a nonexistent local DST time. */
function zonedDateTimeToUtc(localDate: string, localTime: string, timezone: string): Date | null {
  const [year, month, day] = localDate.split("-").map(Number);
  const [hour, minute] = localTime.split(":").map(Number);
  if (![year, month, day, hour, minute].every(Number.isFinite)) return null;
  const desiredEpoch = Date.UTC(year, month - 1, day, hour, minute);
  let candidate = new Date(desiredEpoch);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = localDateTimeInTimezone(candidate, timezone);
    if (!actual) return null;
    const [actualYear, actualMonth, actualDay] = actual.date.split("-").map(Number);
    const [actualHour, actualMinute] = actual.time.split(":").map(Number);
    const delta = desiredEpoch - Date.UTC(actualYear, actualMonth - 1, actualDay, actualHour, actualMinute);
    if (delta === 0) break;
    candidate = new Date(candidate.getTime() + delta);
  }
  const verified = localDateTimeInTimezone(candidate, timezone);
  return verified?.date === localDate && verified.time === localTime ? candidate : null;
}

/** Server-only worker helpers have useful type aliases without leaking a provider. */
export type SagaQuarterlySupportedChannel = ContentChannel;
export type SagaQuarterlySupportedContentType = ContentType;
