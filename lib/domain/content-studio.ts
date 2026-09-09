import { z } from "zod";
import { isValidIanaTimezone } from "@/lib/utils/date";

/** The four delivery surfaces intentionally supported by Content Studio V1. */
export const CONTENT_CHANNELS = ["facebook_page", "instagram", "linkedin", "newsletter"] as const;
export const CONTENT_TYPES = ["social_post", "newsletter", "article"] as const;
export const CONTENT_DRAFT_STATUSES = [
  "draft",
  "in_review",
  "approved",
  "scheduled",
  "publishing",
  "published",
  "failed",
  "cancelled",
] as const;
export const USER_EDITABLE_DRAFT_STATUSES = ["draft", "in_review", "approved", "scheduled", "cancelled"] as const;
export const CONTENT_MEDIA_KINDS = ["image", "video", "document"] as const;
export const CONTENT_MEDIA_SOURCES = ["upload", "generated", "library", "external"] as const;
export const CONTENT_MEDIA_PROCESSING_STATUSES = ["original", "processing", "ready", "failed"] as const;
export const CONTENT_AUTOMATION_SCHEDULE_MODES = ["weekly_count", "cron"] as const;
export const CONTENT_AUTOMATION_JOB_STATES = ["queued", "processing", "completed", "failed", "cancelled", "skipped"] as const;
/** A manual run is durable, but it must never inherit a publish schedule. */
export const CONTENT_AUTOMATION_JOB_TRIGGER_KINDS = ["scheduled", "manual"] as const;

export type ContentChannel = (typeof CONTENT_CHANNELS)[number];
export type ContentType = (typeof CONTENT_TYPES)[number];
export type ContentDraftStatus = (typeof CONTENT_DRAFT_STATUSES)[number];
export type ContentMediaKind = (typeof CONTENT_MEDIA_KINDS)[number];
export type ContentMediaSource = (typeof CONTENT_MEDIA_SOURCES)[number];
export type ContentMediaProcessingStatus = (typeof CONTENT_MEDIA_PROCESSING_STATUSES)[number];
export type ContentAutomationScheduleMode = (typeof CONTENT_AUTOMATION_SCHEDULE_MODES)[number];
export type ContentAutomationJobState = (typeof CONTENT_AUTOMATION_JOB_STATES)[number];
export type ContentAutomationJobTriggerKind = (typeof CONTENT_AUTOMATION_JOB_TRIGGER_KINDS)[number];

const uuidSchema = z.string().uuid();
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Ange datum som YYYY-MM-DD.");
const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Ange tid som HH:MM.");
const timezoneSchema = z.string().min(3).max(80).refine(isValidIanaTimezone, "Ange en giltig IANA-tidszon, till exempel Europe/Stockholm.");
const nullableUuidSchema = uuidSchema.nullable().optional();
const nullableShortText = z.string().trim().max(280).nullable().optional();
const nullableLongText = z.string().max(60_000).nullable().optional();
const hashtagsSchema = z.array(z.string().trim().min(1).max(100)).max(30);

export const contentChannelSchema = z.enum(CONTENT_CHANNELS);
export const contentTypeSchema = z.enum(CONTENT_TYPES);
export const contentDraftStatusSchema = z.enum(CONTENT_DRAFT_STATUSES);
export const userEditableDraftStatusSchema = z.enum(USER_EDITABLE_DRAFT_STATUSES);
export const contentMediaKindSchema = z.enum(CONTENT_MEDIA_KINDS);
export const contentMediaSourceSchema = z.enum(CONTENT_MEDIA_SOURCES);
export const contentMediaProcessingStatusSchema = z.enum(CONTENT_MEDIA_PROCESSING_STATUSES);
export const contentAutomationScheduleModeSchema = z.enum(CONTENT_AUTOMATION_SCHEDULE_MODES);
export const contentAutomationJobStateSchema = z.enum(CONTENT_AUTOMATION_JOB_STATES);
export const contentAutomationJobTriggerKindSchema = z.enum(CONTENT_AUTOMATION_JOB_TRIGGER_KINDS);

/**
 * User-facing document shape. Publishing-only states are intentionally not
 * accepted here; provider workers own `publishing`, `published` and `failed`.
 */
const contentDraftInputBaseSchema = z.object({
  contentType: contentTypeSchema,
  channels: z.array(contentChannelSchema).max(CONTENT_CHANNELS.length),
  title: z.string().trim().max(240),
  headline: nullableShortText,
  subject: nullableShortText,
  body: z.string().max(60_000),
  cta: nullableShortText,
  excerpt: nullableShortText,
  hashtags: hashtagsSchema,
  status: userEditableDraftStatusSchema,
  generationPrompt: nullableLongText,
  imagePrompt: nullableLongText,
  language: z.string().trim().regex(/^[a-z]{2}(-[A-Z]{2})?$/).default("sv"),
  timezone: timezoneSchema,
  scheduledAt: z.string().datetime({ offset: true }).nullable(),
  scheduledLocalDate: dateSchema.nullable(),
  scheduledLocalTime: timeSchema.nullable(),
  approvalRequired: z.boolean(),
  templateId: nullableUuidSchema,
  automationRuleId: nullableUuidSchema,
  newsletterAudienceId: nullableUuidSchema,
});

export const contentDraftInputSchema = contentDraftInputBaseSchema.superRefine((value, context) => {
  const uniqueChannels = new Set(value.channels);
  if (uniqueChannels.size !== value.channels.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["channels"], message: "En kanal får bara väljas en gång." });
  }
  if (value.contentType === "social_post" && value.channels.length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["channels"], message: "Ett socialt inlägg måste ha minst en kanal." });
  }
  if (value.contentType === "newsletter" && (value.channels.length !== 1 || value.channels[0] !== "newsletter")) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["channels"], message: "Ett nyhetsbrev skickas endast via kanalen newsletter." });
  }
  if (value.contentType !== "newsletter" && value.channels.includes("newsletter")) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["channels"], message: "Kanalen newsletter kräver innehållstypen newsletter." });
  }
  const scheduleValues = [value.scheduledAt, value.scheduledLocalDate, value.scheduledLocalTime];
  if (scheduleValues.some(Boolean) && scheduleValues.some((entry) => !entry)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["scheduledAt"], message: "Schemaläggning kräver tidpunkt, lokalt datum och lokal tid." });
  }
  if (value.status === "scheduled" && scheduleValues.some((entry) => !entry)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["status"], message: "Ett schemalagt inlägg behöver datum och tid." });
  }
});

export const contentDraftCreateSchema = contentDraftInputSchema;
export const contentDraftUpdateSchema = contentDraftInputBaseSchema.partial().extend({
  id: uuidSchema.optional(),
  /** Optional for ordinary unscheduled edits; required by the repository once a schedule exists. */
  expectedRevision: z.number().int().min(1).max(2_147_483_647).optional(),
});
export const contentDraftIdSchema = uuidSchema;

/**
 * Narrow, optimistic-concurrency contract for a calendar drag/drop or time
 * edit. The complete local representation is required alongside the ISO
 * instant; the repository verifies that they describe the same moment.
 */
export const contentDraftCalendarMoveSchema = z.object({
  scheduledAt: z.string().datetime({ offset: true }),
  scheduledLocalDate: dateSchema,
  scheduledLocalTime: timeSchema,
  timezone: timezoneSchema,
  expectedRevision: z.number().int().min(1).max(2_147_483_647),
});

const contentMediaAttachmentInputBaseSchema = z.object({
  kind: contentMediaKindSchema,
  source: contentMediaSourceSchema,
  storagePath: z.string().trim().min(3).max(1_000).nullable().optional(),
  assetUrl: z.string().url().max(2_000).nullable().optional(),
  filename: z.string().trim().max(255).nullable().optional(),
  mimeType: z.string().trim().max(120).nullable().optional(),
  byteSize: z.number().int().min(0).max(100_000_000).nullable().optional(),
  altText: z.string().trim().max(1_000).nullable().optional(),
  caption: z.string().trim().max(2_000).nullable().optional(),
  processingStatus: contentMediaProcessingStatusSchema.default("original"),
  adaptationPrompt: z.string().max(8_000).nullable().optional(),
  variants: z.record(z.string(), z.unknown()).default({}),
  sortOrder: z.number().int().min(0).max(100).default(0),
});

export const contentMediaAttachmentCreateSchema = contentMediaAttachmentInputBaseSchema.superRefine((value, context) => {
  if (!value.storagePath && !value.assetUrl) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["storagePath"], message: "Ange en lagringssökväg eller en asset-URL." });
  }
});

export const contentMediaAttachmentUpdateSchema = contentMediaAttachmentInputBaseSchema.partial();
export const contentMediaAttachmentIdSchema = uuidSchema;

const contentTemplateInputBaseSchema = z.object({
  slug: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).min(2).max(80).nullable().optional(),
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(1_000),
  contentType: contentTypeSchema,
  channels: z.array(contentChannelSchema).max(CONTENT_CHANNELS.length),
  defaultTitle: z.string().trim().max(240),
  defaultHeadline: nullableShortText,
  defaultSubject: nullableShortText,
  defaultBody: z.string().max(60_000),
  defaultCta: nullableShortText,
  defaultExcerpt: nullableShortText,
  defaultHashtags: hashtagsSchema,
  generationPrompt: z.string().max(12_000),
  imagePrompt: z.string().max(12_000),
  defaultLanguage: z.string().trim().regex(/^[a-z]{2}(-[A-Z]{2})?$/).default("sv"),
  active: z.boolean(),
});

export const contentTemplateInputSchema = contentTemplateInputBaseSchema.superRefine((value, context) => {
  if (value.contentType === "social_post" && value.channels.length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["channels"], message: "En social mall behöver minst en kanal." });
  }
  if (value.contentType === "newsletter" && (value.channels.length !== 1 || value.channels[0] !== "newsletter")) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["channels"], message: "En nyhetsbrevsmall använder endast newsletter." });
  }
});

export const contentTemplateUpdateSchema = contentTemplateInputBaseSchema.partial();
export const contentTemplateIdSchema = uuidSchema;

const simpleCronSchema = z.string().trim().min(9).max(160).regex(
  /^[0-5]?\d\s+(?:[01]?\d|2[0-3])\s+\*\s+\*\s+(?:\*|[0-6](?:,[0-6])*)$/,
  "Ange enkel cron: minut timme * * veckodag, till exempel 0 9 * * 1,3,5.",
);

const contentAutomationRuleInputBaseSchema = z.object({
  /** Selection is verified against the signed workspace before the first save. */
  brandProfileId: nullableUuidSchema,
  name: z.string().trim().min(2).max(160),
  active: z.boolean(),
  contentType: contentTypeSchema,
  channels: z.array(contentChannelSchema).min(1).max(CONTENT_CHANNELS.length),
  templateId: nullableUuidSchema,
  /**
   * Optional immutable continuity source for this rule. The browser may name
   * a UUID, but the Neon repository must prove that it is an active Series in
   * the current workspace before saving the rule. It is never a snapshot
   * payload and it grants no publishing authority.
   */
  seriesId: nullableUuidSchema,
  newsletterAudienceId: nullableUuidSchema,
  generationPrompt: z.string().max(12_000),
  imagePrompt: z.string().max(12_000),
  desiredLength: z.number().int().min(20).max(60_000).nullable().optional(),
  tone: z.string().trim().max(500).nullable().optional(),
  language: z.string().trim().regex(/^[a-z]{2}(-[A-Z]{2})?$/).default("sv"),
  approvalRequired: z.boolean(),
  timezone: timezoneSchema,
  scheduleMode: contentAutomationScheduleModeSchema,
  weeklyCount: z.number().int().min(1).max(7).nullable(),
  weekdays: z.array(z.number().int().min(0).max(6)).max(7),
  localTimes: z.array(timeSchema).min(1).max(7),
  cronExpression: simpleCronSchema.nullable(),
  startsOn: dateSchema.nullable(),
  endsOn: dateSchema.nullable(),
});

export const contentAutomationRuleInputSchema = contentAutomationRuleInputBaseSchema.superRefine((value, context) => {
  if (new Set(value.channels).size !== value.channels.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["channels"], message: "En kanal får bara väljas en gång." });
  }
  if (value.contentType === "newsletter" && (value.channels.length !== 1 || value.channels[0] !== "newsletter")) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["channels"], message: "Nyhetsbrevsautomationer använder endast newsletter." });
  }
  if (value.contentType !== "newsletter" && value.channels.includes("newsletter")) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["channels"], message: "Kanalen newsletter kräver innehållstypen newsletter." });
  }
  if (value.scheduleMode === "weekly_count") {
    if (!value.weeklyCount) context.addIssue({ code: z.ZodIssueCode.custom, path: ["weeklyCount"], message: "Ange antal poster per vecka." });
    if (value.cronExpression) context.addIssue({ code: z.ZodIssueCode.custom, path: ["cronExpression"], message: "Veckofrekvens använder inte cron-uttryck." });
    if (value.weekdays.length && value.weeklyCount && value.weekdays.length !== value.weeklyCount) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["weekdays"], message: "Välj lika många veckodagar som poster per vecka, eller låt systemet fördela dem." });
    }
    if (value.localTimes.length !== 1 && value.weeklyCount && value.localTimes.length !== value.weeklyCount) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["localTimes"], message: "Ange en återkommande tid eller en tid per veckopost." });
    }
  }
  if (value.scheduleMode === "cron") {
    if (!value.cronExpression) context.addIssue({ code: z.ZodIssueCode.custom, path: ["cronExpression"], message: "Ange ett cron-uttryck." });
    if (value.weeklyCount) context.addIssue({ code: z.ZodIssueCode.custom, path: ["weeklyCount"], message: "Cron använder inte antal per vecka." });
  }
  if (value.startsOn && value.endsOn && value.startsOn > value.endsOn) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["endsOn"], message: "Slutdatum kan inte vara före startdatum." });
  }
});

export const contentAutomationRuleUpdateSchema = contentAutomationRuleInputBaseSchema.partial();
export const contentAutomationRuleIdSchema = uuidSchema;

/**
 * The browser supplies this key once per intentional "Kör nu" click. Reusing
 * it across a retry returns the same durable job/draft instead of generating
 * another item. It is deliberately not a user-controlled content field.
 */
export const contentAutomationManualRunInputSchema = z.object({
  idempotencyKey: uuidSchema,
});

export const contentCalendarQuerySchema = z.object({
  from: dateSchema,
  to: dateSchema,
  timezone: timezoneSchema.optional(),
}).superRefine((value, context) => {
  if (value.from > value.to) context.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: "Slutdatum kan inte vara före startdatum." });
});

export const newsletterAudienceInputSchema = z.object({
  name: z.string().trim().min(2).max(160),
  description: z.string().trim().max(1_000),
  senderName: z.string().trim().max(160).nullable().optional(),
  senderEmail: z.string().trim().email().max(320).nullable().optional(),
  replyToEmail: z.string().trim().email().max(320).nullable().optional(),
  audienceMetadata: z.record(z.string(), z.unknown()).default({}),
  active: z.boolean(),
});
export const newsletterAudienceUpdateSchema = newsletterAudienceInputSchema.partial();
export const newsletterAudienceIdSchema = uuidSchema;

export type ContentDraftInput = z.infer<typeof contentDraftInputSchema>;
export type ContentDraftUpdateInput = z.infer<typeof contentDraftUpdateSchema>;
export type ContentDraftCalendarMoveInput = z.infer<typeof contentDraftCalendarMoveSchema>;
export type ContentMediaAttachmentCreateInput = z.infer<typeof contentMediaAttachmentCreateSchema>;
export type ContentMediaAttachmentUpdateInput = z.infer<typeof contentMediaAttachmentUpdateSchema>;
export type ContentTemplateInput = z.infer<typeof contentTemplateInputSchema>;
export type ContentTemplateUpdateInput = z.infer<typeof contentTemplateUpdateSchema>;
export type ContentAutomationRuleInput = z.infer<typeof contentAutomationRuleInputSchema>;
export type ContentAutomationRuleUpdateInput = z.infer<typeof contentAutomationRuleUpdateSchema>;
export type ContentAutomationManualRunInput = z.infer<typeof contentAutomationManualRunInputSchema>;
export type NewsletterAudienceInput = z.infer<typeof newsletterAudienceInputSchema>;
export type NewsletterAudienceUpdateInput = z.infer<typeof newsletterAudienceUpdateSchema>;

export type ContentMediaAttachmentView = {
  id: string;
  contentDraftId: string;
  kind: ContentMediaKind;
  source: ContentMediaSource;
  storagePath: string | null;
  assetUrl: string | null;
  filename: string | null;
  mimeType: string | null;
  byteSize: number | null;
  altText: string | null;
  caption: string | null;
  processingStatus: ContentMediaProcessingStatus;
  adaptationPrompt: string | null;
  variants: Record<string, unknown>;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

export type ContentDraftView = {
  id: string;
  userId: string;
  /** Immutable server-owned brand; null means an unassigned historical draft. */
  brandProfileId?: string | null;
  /** Monotonic value for conflict-safe calendar moves. */
  revision: number;
  contentType: ContentType;
  channels: ContentChannel[];
  title: string;
  headline: string | null;
  subject: string | null;
  body: string;
  cta: string | null;
  excerpt: string | null;
  hashtags: string[];
  status: ContentDraftStatus;
  generationPrompt: string | null;
  imagePrompt: string | null;
  language: string;
  timezone: string;
  scheduledAt: string | null;
  scheduledLocalDate: string | null;
  scheduledLocalTime: string | null;
  approvalRequired: boolean;
  /** Server-owned policy: this document must remain a private brief. */
  deliveryLocked?: boolean;
  /** A deterministic SAGA ad-automation brief, never a delivery-ready post. */
  privateBrief?: boolean;
  /** Server-derived marker for a private quarterly-plan draft under batch review. */
  quarterlyPrivateReview?: boolean;
  approvedAt: string | null;
  publishedAt: string | null;
  templateId: string | null;
  automationRuleId: string | null;
  automationJobId: string | null;
  newsletterAudienceId: string | null;
  media: ContentMediaAttachmentView[];
  createdAt: string;
  updatedAt: string;
};

export type ContentTemplateView = {
  id: string;
  userId: string | null;
  isSystemTemplate: boolean;
  slug: string;
  name: string;
  description: string;
  contentType: ContentType;
  channels: ContentChannel[];
  defaultTitle: string;
  defaultHeadline: string | null;
  defaultSubject: string | null;
  defaultBody: string;
  defaultCta: string | null;
  defaultExcerpt: string | null;
  defaultHashtags: string[];
  generationPrompt: string;
  imagePrompt: string;
  defaultLanguage: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ContentAutomationRuleView = {
  id: string;
  /** Null only for retained, paused legacy rules with an ambiguous owner. */
  brandProfileId?: string | null;
  userId: string;
  name: string;
  active: boolean;
  contentType: ContentType;
  channels: ContentChannel[];
  templateId: string | null;
  /** Present for Neon-backed rules that explicitly use a Series Reference. */
  seriesId?: string | null;
  newsletterAudienceId: string | null;
  generationPrompt: string;
  imagePrompt: string;
  desiredLength: number | null;
  tone: string | null;
  language: string;
  approvalRequired: boolean;
  timezone: string;
  scheduleMode: ContentAutomationScheduleMode;
  weeklyCount: number | null;
  weekdays: number[];
  localTimes: string[];
  cronExpression: string | null;
  startsOn: string | null;
  endsOn: string | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ContentAutomationJobView = {
  id: string;
  userId: string;
  automationRuleId: string;
  contentDraftId: string | null;
  triggerKind: ContentAutomationJobTriggerKind;
  manualRunKey: string | null;
  state: ContentAutomationJobState;
  scheduledFor: string;
  timezone: string;
  scheduledLocalDate: string;
  scheduledLocalTime: string;
  attemptCount: number;
  lockedUntil: string | null;
  claimedAt: string | null;
  completedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * A deliberately narrow, actor-safe view of a durable Studio automation
 * receipt. It is used by the automation run monitor; the draft outcome has
 * no body, prompt, media URL, or provider metadata.
 */
export type ContentAutomationRunView = ContentAutomationJobView & {
  automationName: string;
  automationActive: boolean;
  /** The persisted retry budget, not a browser-side estimate. */
  maxAttemptCount: number;
  /** Stable server reason for support/audit correlation; UI shows the safe detail. */
  failureCode: string | null;
  draft: {
    id: string;
    title: string;
    status: ContentDraftStatus;
  } | null;
};

export type NewsletterAudienceView = {
  id: string;
  userId: string;
  name: string;
  description: string;
  senderName: string | null;
  senderEmail: string | null;
  replyToEmail: string | null;
  audienceMetadata: Record<string, unknown>;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ContentScheduledCalendarEntry = {
  id: string;
  kind: "draft" | "automation_job";
  title: string;
  status: ContentDraftStatus | ContentAutomationJobState;
  channels: ContentChannel[];
  contentType: ContentType;
  startsAt: string;
  /** Placement in the calendar response's `timezone`. */
  localDate: string;
  localTime: string;
  /** Original editorial schedule in the draft's own timezone. */
  scheduledLocalDate: string;
  scheduledLocalTime: string;
  timezone: string;
  draftId: string | null;
  automationRuleId: string | null;
  automationJobId: string | null;
  approvalRequired: boolean;
  /** A revision is present only for an actual draft and is required to move it. */
  revision: number | null;
  /** Calendar moves are intentionally unavailable for published/publishing items. */
  editable: boolean;
  excerpt: string | null;
  thumbnail: {
    assetUrl: string;
    altText: string;
  } | null;
};

/**
 * A read-only activity-plan overlay. Its planned date/time must never be
 * interpreted as `studio_drafts.scheduled_at`; a real draft is still private
 * and unscheduled until a separate human calendar action exists.
 */
export type ContentPlanSlotCalendarEntry = {
  id: string;
  kind: "plan_slot";
  title: string;
  status: "planned_activity";
  channels: ContentChannel[];
  contentType: ContentType;
  /** Display placement only, derived from the plan slot's desired time. */
  startsAt: string;
  localDate: string;
  localTime: string;
  plannedLocalDate: string;
  plannedLocalTime: string;
  timezone: string;
  draftId: string | null;
  automationRuleId: null;
  automationJobId: null;
  approvalRequired: true;
  revision: null;
  editable: false;
  excerpt: string | null;
  thumbnail: null;
  calendarLabel: "Planerad aktivitet";
};

export type ContentCalendarEntry = ContentScheduledCalendarEntry | ContentPlanSlotCalendarEntry;

export type ContentCalendarView = {
  from: string;
  to: string;
  timezone: string;
  entries: ContentCalendarEntry[];
};

export type ClaimedContentAutomationJob = ContentAutomationJobView & {
  /** Server-only scope supplied by the Neon lease row; never a browser field. */
  workspaceId?: string;
  claimToken: string;
  rule: ContentAutomationRuleView;
  template: ContentTemplateView | null;
};
