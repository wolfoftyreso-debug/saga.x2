import "server-only";

import { randomUUID } from "node:crypto";
import {
  CONTENT_CHANNELS,
  CONTENT_DRAFT_STATUSES,
  USER_EDITABLE_DRAFT_STATUSES,
  contentAutomationManualRunInputSchema,
  contentAutomationRuleIdSchema,
  contentAutomationRuleInputSchema,
  contentCalendarQuerySchema,
  contentDraftCalendarMoveSchema,
  contentDraftIdSchema,
  contentDraftInputSchema,
  contentMediaAttachmentCreateSchema,
  contentMediaAttachmentIdSchema,
  contentTemplateIdSchema,
  contentTemplateInputSchema,
  type ContentAutomationRuleInput,
  type ContentAutomationRuleUpdateInput,
  type ContentAutomationRuleView,
  type ContentAutomationScheduleMode,
  type ClaimedContentAutomationJob,
  type ContentCalendarEntry,
  type ContentCalendarView,
  type ContentChannel,
  type ContentAutomationJobState,
  type ContentAutomationJobTriggerKind,
  type ContentAutomationRunView,
  type ContentDraftCalendarMoveInput,
  type ContentAutomationJobView,
  type ContentDraftInput,
  type ContentDraftStatus,
  type ContentDraftUpdateInput,
  type ContentDraftView,
  type ContentMediaAttachmentView,
  type ContentMediaSource,
  type ContentTemplateInput,
  type ContentTemplateUpdateInput,
  type ContentTemplateView,
  type ContentType,
} from "@/lib/domain/content-studio";
import type { AppActor } from "@/lib/neon/auth-repository";
import { createNeonSql, type NeonSql } from "@/lib/neon/database";
import { resolveSagaBrandActor, SagaBrandScopeError } from "@/lib/neon/saga-brand-api-eligibility";
import { listSagaQuarterlyActivityPlanCalendarSlots } from "@/lib/neon/saga-quarterly-planning-repository";
import {
  assessSagaProductionQuality,
  resolveSagaAutomationQualityContext,
  type SagaAutomationQualityContext,
  type SagaProductionQualityAssessment,
} from "@/lib/services/saga-production-quality";
import { isValidIanaTimezone, localDateInTimezone, localDateTimeInTimezone } from "@/lib/utils/date";

const MAX_DRAFT_LIST_SIZE = 250;
const MAX_CALENDAR_RANGE_DAYS = 120;
const DEFAULT_AUTOMATION_HORIZON_DAYS = 42;
const MAX_AUTOMATION_HORIZON_DAYS = 90;
const DEFAULT_JOB_BATCH_SIZE = 20;
const MAX_JOB_BATCH_SIZE = 100;
const DEFAULT_JOB_LEASE_MS = 12 * 60 * 1_000;
const MIN_JOB_LEASE_MS = 60_000;
const MAX_JOB_LEASE_MS = 30 * 60 * 1_000;

type JsonObject = Record<string, unknown>;

type DraftRow = {
  id: string;
  author_user_id: string;
  brand_profile_id: string | null;
  template_id: string | null;
  automation_job_id: string | null;
  content_type: string;
  status: string;
  title: string;
  body: string;
  excerpt: string | null;
  publication_channels: unknown;
  metadata: unknown;
  revision: number | string;
  scheduled_at: string | null;
  published_at: string | null;
  created_at: string;
  updated_at: string;
};

type DraftWrite = {
  templateId: string | null;
  contentType: ContentType;
  status: ContentDraftStatus;
  title: string;
  body: string;
  excerpt: string | null;
  channelsJson: string;
  metadataJson: string;
  scheduledAt: string | null;
};

type MediaRow = {
  id: string;
  draft_id: string;
  blob_url: string;
  blob_pathname: string;
  content_type: string;
  byte_size: number | string | null;
  kind: string;
  status: string;
  alt_text: string | null;
  metadata: unknown;
  created_at: string;
  updated_at: string;
};

type TemplateRow = {
  id: string;
  created_by_user_id: string;
  name: string;
  content_type: string;
  title_template: string;
  body_template: string;
  prompt: string | null;
  channel_defaults: unknown;
  metadata: unknown;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

type AutomationRow = {
  id: string;
  brand_profile_id: string | null;
  created_by_user_id: string;
  template_id: string | null;
  name: string;
  content_type: string;
  schedule_kind: string;
  cron_expression: string | null;
  trigger_config: unknown;
  generation_config: unknown;
  enabled: boolean;
  approval_required: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
};

type JobRow = {
  id: string;
  workspace_id: string;
  automation_id: string | null;
  draft_id: string | null;
  kind: string;
  status: string;
  idempotency_key: string | null;
  claim_token: string | null;
  run_after: string;
  started_at: string | null;
  completed_at: string | null;
  lease_expires_at: string | null;
  locked_by: string | null;
  attempts: number | string;
  max_attempts: number | string;
  payload: unknown;
  result: unknown;
  failure_code: string | null;
  failure_detail: string | null;
  created_at: string;
  updated_at: string;
};

/** The monitor joins only a receipt's private draft outcome, never its body or media. */
type AutomationRunOverviewRow = JobRow & {
  outcome_draft_title: string | null;
  outcome_draft_status: string | null;
};

type ScheduledAutomationRow = AutomationRow & {
  workspace_id: string;
};

type ResolvedClaimedAutomationJob = ClaimedContentAutomationJob & {
  workspaceId: string;
  /** Server-written configuration marker used by the final INSERT guard. */
  finalization: {
    manual: boolean;
    expectedAutomationConfigurationVersion: string | null;
  };
};

type TemplateWrite = {
  name: string;
  contentType: ContentType;
  titleTemplate: string;
  bodyTemplate: string;
  prompt: string;
  channelDefaultsJson: string;
  metadataJson: string;
  active: boolean;
};

type AutomationWrite = {
  name: string;
  contentType: ContentType;
  templateId: string | null;
  scheduleKind: "cron" | "trigger";
  cronExpression: string | null;
  triggerConfigJson: string;
  generationConfigJson: string;
  enabled: boolean;
  approvalRequired: boolean;
  nextRunAt: string | null;
};

export type ListStudioDraftOptions = {
  limit?: number;
  statuses?: ContentDraftStatus[];
  /** Defaults to true so a reload retains media previews without N+1 reads. */
  includeMedia?: boolean;
};

/** Server-only metadata required to operate on a private Vercel Blob object. */
export type StudioOwnedMedia = {
  id: string;
  draftId: string;
  blobUrl: string;
  blobPathname: string;
  contentType: string;
  byteSize: number | null;
  altText: string | null;
};

export type CreateStudioMediaMetadataInput = {
  draftId: string;
  blobUrl: string;
  blobPathname: string;
  contentType: string;
  byteSize: number;
  fileName?: string | null;
  altText?: string | null;
  caption?: string | null;
  source?: ContentMediaSource;
  processingStatus?: "original" | "processing" | "ready" | "failed";
  adaptationPrompt?: string | null;
  variants?: Record<string, unknown>;
  sortOrder?: number;
};

export type StudioAutomationDraftPayload = {
  title?: string;
  headline?: string | null;
  subject?: string | null;
  body?: string;
  cta?: string | null;
  excerpt?: string | null;
  hashtags?: string[];
  generationPrompt?: string | null;
  imagePrompt?: string | null;
  language?: string;
  /** Server-produced audit result from the deterministic quality gate. */
  quality?: SagaProductionQualityAssessment;
  /** Enough immutable context to re-evaluate a later calendar move. */
  qualityContext?: SagaAutomationQualityContext;
};

export type PreparedStudioManualAutomationRun = {
  rule: ContentAutomationRuleView;
  job: ContentAutomationJobView;
  reused: boolean;
};

export type StudioJobMaterializationResult = {
  rulesScanned: number;
  jobsCreated: number;
  nextRunsUpdated: number;
};

export type ListStudioAutomationJobsOptions = {
  limit?: number;
};

export type MaterializeStudioAutomationJobsOptions = {
  now?: Date;
  horizonDays?: number;
  ruleLimit?: number;
  jobLimit?: number;
};

export type ClaimDueStudioAutomationJobsOptions = {
  now?: Date;
  limit?: number;
  leaseMs?: number;
  workerId?: string;
};

/**
 * An actor-scoped exact claim used by the explicit “Kör nu” action. Unlike
 * the global cron claim this can never pick another automation's due job.
 */
export type ClaimStudioManualAutomationJobOptions = {
  automationId: string;
  idempotencyKey: string;
  now?: Date;
  leaseMs?: number;
  workerId?: string;
};

export class StudioContentAccessError extends Error {
  constructor() {
    super("Du har bara läsrättighet i den här arbetsytan.");
    this.name = "StudioContentAccessError";
  }
}

export class StudioContentNotFoundError extends Error {
  constructor(message = "Utkastet hittades inte i arbetsytan.") {
    super(message);
    this.name = "StudioContentNotFoundError";
  }
}

/** A safe, expected conflict such as two people moving the same calendar item. */
export class StudioContentConflictError extends Error {
  constructor(message = "Utkastet ändrades på annat håll. Ladda om kalendern och försök igen.") {
    super(message);
    this.name = "StudioContentConflictError";
  }
}

/** A recoverable editor input error which should never become a 500 response. */
export class StudioContentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StudioContentValidationError";
  }
}

function objectValue(value: unknown): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as JsonObject;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonObject : {};
  } catch {
    return {};
  }
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function numberValue(value: unknown, fallback: number | null = null): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : fallback;
}

function stringArray(value: unknown): string[] {
  const source = Array.isArray(value) ? value : typeof value === "string" ? (() => {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  })() : [];
  return source.filter((item): item is string => typeof item === "string");
}

function channels(value: unknown): ContentChannel[] {
  return stringArray(value).filter((channel): channel is ContentChannel => (CONTENT_CHANNELS as readonly string[]).includes(channel));
}

function draftStatus(value: unknown): ContentDraftStatus {
  return (CONTENT_DRAFT_STATUSES as readonly string[]).includes(String(value))
    ? value as ContentDraftStatus
    : "draft";
}

function contentType(value: unknown): ContentType {
  return value === "newsletter" || value === "article" ? value : "social_post";
}

function slugify(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (normalized || "egen-mall").slice(0, 68).replace(/-+$/g, "") || "egen-mall";
}

function automationScheduleMode(value: unknown, config: JsonObject): ContentAutomationScheduleMode {
  return value === "cron" || config.scheduleMode === "cron" ? "cron" : "weekly_count";
}

function weekdayNumbers(value: unknown): number[] {
  const source = Array.isArray(value) ? value : typeof value === "string" ? (() => {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  })() : [];
  return source.filter((item): item is number => typeof item === "number" && Number.isInteger(item) && item >= 0 && item <= 6);
}

function normalizedLocalTime(value: unknown): string | null {
  const raw = nullableString(value);
  return raw && /^([01]\d|2[0-3]):[0-5]\d$/.test(raw) ? raw : null;
}

/**
 * This marker is separate from `updated_at`: cron moves `next_run_at` and
 * therefore updates the timestamp without a user changing the rule.
 */
function automationConfigurationVersion(value: unknown): string | null {
  return metadataString(objectValue(value), "automationConfigurationVersion");
}

function localTimes(value: unknown): string[] {
  const source = Array.isArray(value) ? value : typeof value === "string" ? (() => {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  })() : [];
  return source.map(normalizedLocalTime).filter((time): time is string => Boolean(time));
}

function metadataString(metadata: JsonObject, key: string): string | null {
  return nullableString(metadata[key]);
}

function metadataList(metadata: JsonObject, key: string): string[] {
  return stringArray(metadata[key]);
}

/**
 * Ad-automation output is an intentionally non-deliverable, private brief.
 * This marker is written only by the server-side ad draft producer and must
 * survive generic editor writes. It stops a normal content PATCH or calendar
 * drag from quietly turning a deterministic brief into a deliverable post.
 */
function isDeliveryLockedAdAutomationDraft(metadata: JsonObject): boolean {
  const hasServerOwnedSource = typeof metadata.adAutomationRunId === "string"
    || typeof metadata.adAutomationTestReceiptId === "string";
  return metadata.adAutomationDeliveryLocked === true
    && metadata.adAutomationDraftKind === "deterministic_creative_brief"
    && hasServerOwnedSource;
}

type SagaQuarterlyPrivateDraftLink = {
  planId: string;
  batchId: string;
  batchItemId: string;
};

type SagaQuarterlyPrivateDraftReviewState = {
  itemState: string;
  reviewResolution: string | null;
  batchState: string;
};

const QUARTERLY_GENERIC_EDITOR_PROTECTED_FIELDS = [
  "contentType",
  "channels",
  "timezone",
  "scheduledAt",
  "scheduledLocalDate",
  "scheduledLocalTime",
  "approvalRequired",
  "templateId",
  "automationRuleId",
  "newsletterAudienceId",
] as const satisfies readonly (keyof ContentDraftInput)[];

const QUARTERLY_GENERIC_EDITORIAL_FIELDS = [
  "title",
  "headline",
  "subject",
  "body",
  "cta",
  "excerpt",
  "hashtags",
  "generationPrompt",
  "imagePrompt",
  "language",
] as const satisfies readonly (keyof ContentDraftInput)[];

function isUuid(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/**
 * Quarterly draft metadata is written only by the materialization function.
 * It lets the generic Studio editor recognise the special review contract
 * without exposing plan/batch metadata to the browser.
 */
function sagaQuarterlyPrivateDraftLink(metadata: JsonObject): SagaQuarterlyPrivateDraftLink | null {
  const marker = objectValue(metadata.sagaQuarterlyActivityPlan);
  if (marker.privateOnly !== true) return null;
  const planId = marker.planId;
  const batchId = marker.batchId;
  const batchItemId = marker.batchItemId;
  if (!isUuid(planId) || !isUuid(batchId) || !isUuid(batchItemId)) {
    throw new StudioContentValidationError(
      "SAGA:s kvartalskoppling kan inte verifieras. Ändra inte utkastet förrän granskningen har laddats om.",
    );
  }
  return { planId, batchId, batchItemId };
}

function isSagaQuarterlyPrivateDraft(metadata: JsonObject): boolean {
  return objectValue(metadata.sagaQuarterlyActivityPlan).privateOnly === true;
}

async function getSagaQuarterlyPrivateDraftReviewState(
  workspaceId: string,
  draftId: string,
  metadata: JsonObject,
  sql: NeonSql,
): Promise<SagaQuarterlyPrivateDraftReviewState | null> {
  const link = sagaQuarterlyPrivateDraftLink(metadata);
  if (!link) return null;
  const rows = await sql.query(
    `select
       item.state as item_state,
       item.review_resolution,
       batch.state as batch_state
     from saga_quarterly_activity_plan_batch_items item
     join saga_quarterly_activity_plan_batches batch
       on batch.workspace_id = item.workspace_id and batch.id = item.batch_id
     join saga_quarterly_activity_plans plan
       on plan.workspace_id = batch.workspace_id and plan.id = batch.plan_id
     where item.workspace_id = $1::uuid
       and item.studio_draft_id = $2::uuid
       and batch.id = $3::uuid
       and item.id = $4::uuid
       and plan.id = $5::uuid
     limit 1`,
    [workspaceId, draftId, link.batchId, link.batchItemId, link.planId],
  ) as unknown as Array<{ item_state: string; review_resolution: string | null; batch_state: string }>;
  const row = rows[0];
  if (!row) {
    // Fail closed: a copied/corrupt marker must not quietly turn a private
    // review draft into an ordinary deliverable Studio document.
    throw new StudioContentValidationError(
      "SAGA:s privata kvartalsutkast kan inte verifieras. Använd batchgranskningen och försök igen.",
    );
  }
  return {
    itemState: row.item_state,
    reviewResolution: row.review_resolution,
    batchState: row.batch_state,
  };
}

function isQuarterlyDraftApprovedForCalendar(state: SagaQuarterlyPrivateDraftReviewState): boolean {
  return state.itemState === "approved" && state.reviewResolution === "approved";
}

function valuesMatch(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Content Editor serializes a complete editor document and consequently sends
 * `status: draft` for unscheduled documents. Returned quarterly drafts must
 * remain `in_review` so the resubmit endpoint can prove a real edit happened.
 * Preserve that benign form default while rejecting actual workflow, channel
 * or scheduling changes until the durable batch item is approved.
 */
async function normalizeQuarterlyPrivateDraftEditorPatch(
  workspaceId: string,
  draftId: string,
  existing: ContentDraftView,
  metadata: JsonObject,
  patch: ContentDraftUpdateInput,
  sql: NeonSql,
): Promise<ContentDraftUpdateInput> {
  const state = await getSagaQuarterlyPrivateDraftReviewState(workspaceId, draftId, metadata, sql);
  if (!state) return patch;
  if (patch.expectedRevision === undefined) {
    throw new StudioContentValidationError(
      "Ladda om det privata kvartalsutkastet innan du sparar en ändring.",
    );
  }

  const safePatch = { ...patch };
  // See the comment above: this is a transport default, not a valid state
  // transition. Preserving the server state lets an edit/save/resubmit cycle
  // work without giving the generic editor approval authority.
  const isEditorTransportStatus = (existing.status === "in_review" && safePatch.status === "draft")
    || (existing.status === "approved" && (safePatch.status === "draft" || safePatch.status === "in_review"));
  if (isEditorTransportStatus) {
    delete safePatch.status;
  } else if (safePatch.status !== undefined && safePatch.status !== existing.status) {
    throw new StudioContentValidationError(
      "Godkännande och status för ett kvartalsutkast ändras inte via vanliga Studio-redigeringar.",
    );
  }

  const current = inputFromDraft(existing);
  const changedProtectedField = QUARTERLY_GENERIC_EDITOR_PROTECTED_FIELDS.find((field) => (
    Object.prototype.hasOwnProperty.call(safePatch, field)
      && !valuesMatch(safePatch[field], current[field])
  ));
  if (changedProtectedField) {
    throw new StudioContentValidationError(
      "Kanal, tidszon, schema och godkännande för ett privat kvartalsutkast ändras bara i batchgranskningen.",
    );
  }
  if (isQuarterlyDraftApprovedForCalendar(state)) {
    const changedEditorialField = QUARTERLY_GENERIC_EDITORIAL_FIELDS.find((field) => (
      Object.prototype.hasOwnProperty.call(safePatch, field)
        && !valuesMatch(safePatch[field], current[field])
    ));
    if (changedEditorialField) {
      throw new StudioContentValidationError(
        "Det här kvartalsutkastet är redan godkänt. Returnera eller skapa ett nytt granskningsbeslut innan innehållet ändras.",
      );
    }
  }
  return safePatch;
}

/**
 * Media is part of the private production artifact, not a side door around
 * batch review. A real image may be attached only after the exact item has a
 * durable approved decision; a stale/rejected/returned item stays immutable.
 */
async function assertSagaQuarterlyPrivateDraftMediaMutationAllowed(
  workspaceId: string,
  draftId: string,
  metadata: JsonObject,
  sql: NeonSql,
): Promise<void> {
  const state = await getSagaQuarterlyPrivateDraftReviewState(workspaceId, draftId, metadata, sql);
  if (!state) return;
  if (!isQuarterlyDraftApprovedForCalendar(state) || state.batchState === "stale") {
    throw new StudioContentValidationError(
      "Bilder för ett privat kvartalsutkast ändras först efter batchgodkännandet. Returnerade, avvisade och avslutade batchar är skrivskyddade.",
    );
  }
}

async function assertStudioDraftMediaMutationAllowed(
  actor: AppActor,
  draftId: string,
  row: DraftRow,
  sql: NeonSql,
): Promise<void> {
  const metadata = objectValue(row.metadata);
  if (isDeliveryLockedAdAutomationDraft(metadata)) {
    throw new StudioContentValidationError(
      "Det här SAGA-annonsutkastet är ett låst privat kreativt underlag. Generella mediaåtgärder är inte tillgängliga.",
    );
  }
  await assertSagaQuarterlyPrivateDraftMediaMutationAllowed(actor.workspaceId, draftId, metadata, sql);
}

function assertDeliveryLockedAdAutomationDraftInvariant(
  metadata: JsonObject,
  input: ContentDraftInput,
): void {
  if (!isDeliveryLockedAdAutomationDraft(metadata)) return;
  const isPrivateReviewState = input.status === "draft" || input.status === "in_review";
  if (
    input.contentType !== "article"
    || input.channels.length !== 0
    || input.scheduledAt !== null
    || input.scheduledLocalDate !== null
    || input.scheduledLocalTime !== null
    || input.approvalRequired !== true
    || !isPrivateReviewState
  ) {
    throw new StudioContentValidationError(
      "Det här SAGA-annonsutkastet är ett låst privat kreativt underlag. Det kan redigeras, men kan inte få kanal, schema eller leveransstatus här.",
    );
  }
}

/**
 * Only drafts written by the automation worker carry this server-owned audit
 * marker. Older/manual editor drafts keep their existing approval policy, but
 * a generated draft is rechecked from its current text before a calendar move
 * can turn it into a scheduled item.
 */
function assertAutomationQualityAllowsCalendar(
  metadata: JsonObject,
  input: ContentDraftInput,
): SagaProductionQualityAssessment | null {
  if (!objectValue(metadata.sagaProductionQuality).version) return null;
  let context: SagaAutomationQualityContext;
  try {
    context = resolveSagaAutomationQualityContext(metadata.sagaProductionQualityContext);
  } catch {
    // The marker tells us this draft was produced by an automation. Do not
    // quietly drop its policy context if the stored audit record is corrupt.
    throw new StudioContentValidationError(
      "SAGA:s sparade kvalitetskontext kan inte verifieras. Granska utkastet igen innan det läggs i kalendern.",
    );
  }
  const quality = assessSagaProductionQuality({
    kind: "content_draft",
    contentType: input.contentType,
    channels: input.channels,
    targetLength: context.targetLength,
    title: input.title,
    headline: input.headline ?? null,
    subject: input.subject ?? null,
    previewText: input.excerpt ?? null,
    body: input.body,
    callToAction: input.cta ?? null,
    imagePrompt: input.imagePrompt ?? null,
    editorialLens: context.editorialLens,
    seriesReference: context.seriesReference,
    deliveryIntent: "calendar",
  });
  if (quality.canEnterCalendar) return quality;
  const finding = quality.findings.find((item) => item.severity === "blocker") ?? quality.findings[0];
  throw new StudioContentValidationError(
    finding?.message ?? "SAGA:s kvalitetsgrind kräver redaktionell bearbetning innan utkastet kan läggas i kalendern.",
  );
}

function withSagaProductionQuality(metadataJson: string, quality: SagaProductionQualityAssessment): string {
  return JSON.stringify({
    ...objectValue(metadataJson),
    sagaProductionQuality: quality,
  });
}

function metadataForDraft(input: ContentDraftInput, existing: JsonObject = {}, now = new Date()): JsonObject {
  const metadata: JsonObject = {
    ...existing,
    headline: input.headline ?? null,
    subject: input.subject ?? null,
    cta: input.cta ?? null,
    hashtags: input.hashtags,
    generationPrompt: input.generationPrompt ?? null,
    imagePrompt: input.imagePrompt ?? null,
    language: input.language,
    timezone: input.timezone,
    scheduledLocalDate: input.scheduledLocalDate ?? null,
    scheduledLocalTime: input.scheduledLocalTime ?? null,
    approvalRequired: input.approvalRequired,
    automationRuleId: input.automationRuleId ?? null,
    newsletterAudienceId: input.newsletterAudienceId ?? null,
  };

  const currentApprovedAt = metadataString(existing, "approvedAt");
  if (input.status === "approved") {
    metadata.approvedAt = currentApprovedAt ?? now.toISOString();
  } else if (input.status === "draft" || input.status === "in_review" || input.status === "cancelled") {
    metadata.approvedAt = null;
  } else {
    metadata.approvedAt = currentApprovedAt;
  }

  return metadata;
}

function mapDraft(row: DraftRow, media: ContentMediaAttachmentView[] = []): ContentDraftView {
  const metadata = objectValue(row.metadata);
  return {
    id: stringValue(row.id),
    userId: stringValue(row.author_user_id),
    brandProfileId: nullableString(row.brand_profile_id),
    revision: numberValue(row.revision, 1) ?? 1,
    contentType: contentType(row.content_type),
    channels: channels(row.publication_channels),
    title: stringValue(row.title),
    headline: metadataString(metadata, "headline"),
    subject: metadataString(metadata, "subject"),
    body: stringValue(row.body),
    cta: metadataString(metadata, "cta"),
    excerpt: nullableString(row.excerpt),
    hashtags: metadataList(metadata, "hashtags"),
    status: draftStatus(row.status),
    generationPrompt: metadataString(metadata, "generationPrompt"),
    imagePrompt: metadataString(metadata, "imagePrompt"),
    language: metadataString(metadata, "language") ?? "sv",
    timezone: metadataString(metadata, "timezone") ?? "Europe/Stockholm",
    scheduledAt: nullableString(row.scheduled_at),
    scheduledLocalDate: metadataString(metadata, "scheduledLocalDate"),
    scheduledLocalTime: metadataString(metadata, "scheduledLocalTime"),
    approvalRequired: booleanValue(metadata.approvalRequired, true),
    deliveryLocked: isDeliveryLockedAdAutomationDraft(metadata),
    privateBrief: isDeliveryLockedAdAutomationDraft(metadata),
    quarterlyPrivateReview: isSagaQuarterlyPrivateDraft(metadata),
    approvedAt: metadataString(metadata, "approvedAt"),
    publishedAt: nullableString(row.published_at),
    templateId: nullableString(row.template_id),
    automationRuleId: metadataString(metadata, "automationRuleId"),
    automationJobId: nullableString(row.automation_job_id) ?? metadataString(metadata, "automationJobId"),
    newsletterAudienceId: metadataString(metadata, "newsletterAudienceId"),
    media,
    createdAt: stringValue(row.created_at),
    updatedAt: stringValue(row.updated_at),
  };
}

function mediaKind(value: unknown): "image" | "video" | "document" {
  return value === "video" || value === "document" ? value : "image";
}

function mediaSource(value: unknown): ContentMediaSource {
  return value === "generated" || value === "library" || value === "external" ? value : "upload";
}

function mediaProcessingStatus(value: unknown): "original" | "processing" | "ready" | "failed" {
  return value === "processing" || value === "ready" || value === "failed" ? value : "original";
}

function mapMedia(row: MediaRow): ContentMediaAttachmentView {
  const metadata = objectValue(row.metadata);
  return {
    id: stringValue(row.id),
    contentDraftId: stringValue(row.draft_id),
    kind: mediaKind(metadata.contentKind),
    source: mediaSource(metadata.source),
    storagePath: stringValue(row.blob_pathname) || null,
    // Private Blob URLs stay server-only. The browser receives only a
    // same-origin asset route, which verifies its actor before streaming.
    assetUrl: `/api/content/drafts/${encodeURIComponent(stringValue(row.draft_id))}/media/${encodeURIComponent(stringValue(row.id))}/asset`,
    filename: metadataString(metadata, "filename"),
    mimeType: stringValue(row.content_type) || null,
    byteSize: numberValue(row.byte_size),
    altText: nullableString(row.alt_text),
    caption: metadataString(metadata, "caption"),
    processingStatus: mediaProcessingStatus(metadata.processingStatus),
    adaptationPrompt: metadataString(metadata, "adaptationPrompt"),
    variants: objectValue(metadata.variants),
    sortOrder: numberValue(metadata.sortOrder, 0) ?? 0,
    createdAt: stringValue(row.created_at),
    updatedAt: stringValue(row.updated_at),
  };
}

function mapOwnedMedia(row: MediaRow): StudioOwnedMedia {
  return {
    id: stringValue(row.id),
    draftId: stringValue(row.draft_id),
    blobUrl: stringValue(row.blob_url),
    blobPathname: stringValue(row.blob_pathname),
    contentType: stringValue(row.content_type),
    byteSize: numberValue(row.byte_size),
    altText: nullableString(row.alt_text),
  };
}

function mapTemplate(row: TemplateRow): ContentTemplateView {
  const metadata = objectValue(row.metadata);
  const channelDefaults = objectValue(row.channel_defaults);
  return {
    id: stringValue(row.id),
    userId: stringValue(row.created_by_user_id) || null,
    isSystemTemplate: false,
    slug: metadataString(metadata, "slug") ?? slugify(stringValue(row.name)),
    name: stringValue(row.name),
    description: metadataString(metadata, "description") ?? "",
    contentType: contentType(row.content_type),
    channels: channels(channelDefaults.channels),
    defaultTitle: stringValue(row.title_template),
    defaultHeadline: metadataString(metadata, "defaultHeadline"),
    defaultSubject: metadataString(metadata, "defaultSubject"),
    defaultBody: stringValue(row.body_template),
    defaultCta: metadataString(metadata, "defaultCta"),
    defaultExcerpt: metadataString(metadata, "defaultExcerpt"),
    defaultHashtags: metadataList(metadata, "defaultHashtags"),
    generationPrompt: stringValue(row.prompt),
    imagePrompt: metadataString(metadata, "imagePrompt") ?? "",
    defaultLanguage: metadataString(metadata, "defaultLanguage") ?? "sv",
    active: booleanValue(row.is_active, true),
    createdAt: stringValue(row.created_at),
    updatedAt: stringValue(row.updated_at),
  };
}

function mapAutomation(row: AutomationRow): ContentAutomationRuleView {
  const triggerConfig = objectValue(row.trigger_config);
  const generationConfig = objectValue(row.generation_config);
  const scheduleMode = automationScheduleMode(row.schedule_kind, triggerConfig);
  return {
    id: stringValue(row.id),
    brandProfileId: nullableString(row.brand_profile_id),
    userId: stringValue(row.created_by_user_id),
    name: stringValue(row.name),
    active: booleanValue(row.enabled, false),
    contentType: contentType(row.content_type),
    channels: channels(generationConfig.channels),
    templateId: nullableString(row.template_id),
    seriesId: metadataString(generationConfig, "seriesId"),
    newsletterAudienceId: metadataString(generationConfig, "newsletterAudienceId"),
    generationPrompt: metadataString(generationConfig, "generationPrompt") ?? "",
    imagePrompt: metadataString(generationConfig, "imagePrompt") ?? "",
    desiredLength: numberValue(generationConfig.desiredLength),
    tone: metadataString(generationConfig, "tone"),
    language: metadataString(generationConfig, "language") ?? "sv",
    approvalRequired: booleanValue(row.approval_required, true),
    timezone: metadataString(generationConfig, "timezone") ?? "Europe/Stockholm",
    scheduleMode,
    weeklyCount: scheduleMode === "weekly_count" ? numberValue(triggerConfig.weeklyCount) : null,
    weekdays: scheduleMode === "weekly_count" ? weekdayNumbers(triggerConfig.weekdays) : [],
    localTimes: localTimes(triggerConfig.localTimes).length ? localTimes(triggerConfig.localTimes) : ["09:00"],
    cronExpression: scheduleMode === "cron" ? nullableString(row.cron_expression) : null,
    startsOn: metadataString(triggerConfig, "startsOn"),
    endsOn: metadataString(triggerConfig, "endsOn"),
    nextRunAt: nullableString(row.next_run_at),
    lastRunAt: nullableString(row.last_run_at),
    createdAt: stringValue(row.created_at),
    updatedAt: stringValue(row.updated_at),
  };
}

function automationJobState(value: unknown): ContentAutomationJobState {
  if (value === "running") return "processing";
  return value === "completed" || value === "failed" || value === "cancelled" ? value : "queued";
}

function automationJobTriggerKind(payload: JsonObject): ContentAutomationJobTriggerKind {
  return payload.triggerKind === "manual" ? "manual" : "scheduled";
}

function mapAutomationJob(row: JobRow, userId: string, fallbackTimezone = "Europe/Stockholm"): ContentAutomationJobView {
  const payload = objectValue(row.payload);
  const timezone = metadataString(payload, "timezone") ?? fallbackTimezone;
  const local = localDateAndTime(new Date(stringValue(row.run_after)), timezone);
  const triggerKind = automationJobTriggerKind(payload);
  return {
    id: stringValue(row.id),
    userId,
    automationRuleId: nullableString(row.automation_id) ?? "",
    contentDraftId: nullableString(row.draft_id),
    triggerKind,
    manualRunKey: triggerKind === "manual" ? nullableString(row.idempotency_key) : null,
    state: automationJobState(row.status),
    scheduledFor: stringValue(row.run_after),
    timezone,
    scheduledLocalDate: metadataString(payload, "scheduledLocalDate") ?? local?.date ?? stringValue(row.run_after).slice(0, 10),
    scheduledLocalTime: metadataString(payload, "scheduledLocalTime") ?? local?.time ?? "00:00",
    attemptCount: numberValue(row.attempts, 0) ?? 0,
    lockedUntil: nullableString(row.lease_expires_at),
    claimedAt: nullableString(row.started_at),
    completedAt: nullableString(row.completed_at),
    lastError: nullableString(row.failure_detail),
    createdAt: stringValue(row.created_at),
    updatedAt: stringValue(row.updated_at),
  };
}

function mapAutomationRunOverview(
  row: AutomationRunOverviewRow,
  automation: ContentAutomationRuleView,
): ContentAutomationRunView {
  const job = mapAutomationJob(row, automation.userId, automation.timezone);
  const draftId = job.contentDraftId;
  return {
    ...job,
    automationName: automation.name,
    automationActive: automation.active,
    maxAttemptCount: Math.max(1, numberValue(row.max_attempts, 1) ?? 1),
    failureCode: nullableString(row.failure_code),
    draft: draftId
      ? {
        id: draftId,
        title: stringValue(row.outcome_draft_title, "Namnlöst utkast"),
        status: draftStatus(row.outcome_draft_status),
      }
      : null,
  };
}

function inputFromTemplate(template: ContentTemplateView): ContentTemplateInput {
  return {
    slug: template.slug,
    name: template.name,
    description: template.description,
    contentType: template.contentType,
    channels: template.channels,
    defaultTitle: template.defaultTitle,
    defaultHeadline: template.defaultHeadline,
    defaultSubject: template.defaultSubject,
    defaultBody: template.defaultBody,
    defaultCta: template.defaultCta,
    defaultExcerpt: template.defaultExcerpt,
    defaultHashtags: template.defaultHashtags,
    generationPrompt: template.generationPrompt,
    imagePrompt: template.imagePrompt,
    defaultLanguage: template.defaultLanguage,
    active: template.active,
  };
}

function inputFromAutomation(rule: ContentAutomationRuleView): ContentAutomationRuleInput {
  return {
    brandProfileId: rule.brandProfileId ?? null,
    name: rule.name,
    active: rule.active,
    contentType: rule.contentType,
    channels: rule.channels,
    templateId: rule.templateId,
    seriesId: rule.seriesId ?? null,
    newsletterAudienceId: rule.newsletterAudienceId,
    generationPrompt: rule.generationPrompt,
    imagePrompt: rule.imagePrompt,
    desiredLength: rule.desiredLength,
    tone: rule.tone,
    language: rule.language,
    approvalRequired: rule.approvalRequired,
    timezone: rule.timezone,
    scheduleMode: rule.scheduleMode,
    weeklyCount: rule.weeklyCount,
    weekdays: rule.weekdays,
    localTimes: rule.localTimes,
    cronExpression: rule.cronExpression,
    startsOn: rule.startsOn,
    endsOn: rule.endsOn,
  };
}

function writeTemplate(
  input: ContentTemplateInput,
  slug: string,
  existingMetadata: JsonObject = {},
  existingChannelDefaults: JsonObject = {},
): TemplateWrite {
  const metadata: JsonObject = {
    ...existingMetadata,
    slug,
    description: input.description,
    defaultHeadline: input.defaultHeadline ?? null,
    defaultSubject: input.defaultSubject ?? null,
    defaultCta: input.defaultCta ?? null,
    defaultExcerpt: input.defaultExcerpt ?? null,
    defaultHashtags: input.defaultHashtags,
    imagePrompt: input.imagePrompt,
    defaultLanguage: input.defaultLanguage,
  };
  return {
    name: input.name,
    contentType: input.contentType,
    titleTemplate: input.defaultTitle,
    bodyTemplate: input.defaultBody,
    prompt: input.generationPrompt,
    channelDefaultsJson: JSON.stringify({ ...existingChannelDefaults, channels: input.channels }),
    metadataJson: JSON.stringify(metadata),
    active: input.active,
  };
}

function writeAutomation(
  input: ContentAutomationRuleInput,
  nextRunAt: string | null,
  existingTriggerConfig: JsonObject = {},
  existingGenerationConfig: JsonObject = {},
): AutomationWrite {
  const triggerConfig: JsonObject = {
    ...existingTriggerConfig,
    scheduleMode: input.scheduleMode,
    weeklyCount: input.scheduleMode === "weekly_count" ? input.weeklyCount : null,
    weekdays: input.scheduleMode === "weekly_count" ? input.weekdays : [],
    localTimes: input.localTimes,
    startsOn: input.startsOn ?? null,
    endsOn: input.endsOn ?? null,
  };
  const generationConfig: JsonObject = {
    ...existingGenerationConfig,
    // A fresh opaque version is written only through create/updateStudioAutomation.
    // Scheduler bookkeeping may move `next_run_at`, but must not invalidate a
    // leased generation just because it touched the row's `updated_at`.
    automationConfigurationVersion: randomUUID(),
    channels: input.channels,
    // A Series is referenced by an opaque UUID only. Its immutable snapshot
    // is resolved later by the server worker after it has a leased job and a
    // trusted workspace scope; browser data never carries that snapshot.
    seriesId: input.seriesId ?? null,
    newsletterAudienceId: input.newsletterAudienceId ?? null,
    generationPrompt: input.generationPrompt,
    imagePrompt: input.imagePrompt,
    desiredLength: input.desiredLength ?? null,
    tone: input.tone ?? null,
    language: input.language,
    timezone: input.timezone,
  };
  return {
    name: input.name,
    contentType: input.contentType,
    templateId: input.templateId ?? null,
    scheduleKind: input.scheduleMode === "cron" ? "cron" : "trigger",
    cronExpression: input.scheduleMode === "cron" ? input.cronExpression : null,
    triggerConfigJson: JSON.stringify(triggerConfig),
    generationConfigJson: JSON.stringify(generationConfig),
    enabled: input.active,
    approvalRequired: input.approvalRequired,
    nextRunAt,
  };
}

/**
 * Keep the first visible run time accurate without coupling Studio writes to a
 * background worker. The worker still owns durable job creation; this value is
 * an actor-facing schedule preview and is recalculated on every rule edit.
 */
function nextAutomationRunAt(rule: ContentAutomationRuleInput, now = new Date()): string | null {
  return upcomingAutomationOccurrences(rule, { now, horizonDays: MAX_AUTOMATION_HORIZON_DAYS })[0]?.runAt ?? null;
}

type AutomationOccurrence = {
  runAt: string;
  localDate: string;
  localTime: string;
};

function upcomingAutomationOccurrences(
  rule: ContentAutomationRuleInput,
  options: { now?: Date; horizonDays?: number } = {},
): AutomationOccurrence[] {
  const now = options.now ?? new Date();
  const horizonDays = Math.max(1, Math.min(options.horizonDays ?? DEFAULT_AUTOMATION_HORIZON_DAYS, MAX_AUTOMATION_HORIZON_DAYS));
  if (!rule.active || !isValidIanaTimezone(rule.timezone)) return [];
  const startDate = maxDate(localDateInTimezone(rule.timezone, now), rule.startsOn ?? null);
  const horizonEnd = addCalendarDays(localDateInTimezone(rule.timezone, new Date(now.getTime() + horizonDays * 86_400_000)), 1);
  const endDate = minDate(horizonEnd, rule.endsOn ?? null);
  if (startDate > endDate) return [];

  const weeklyDays = rule.scheduleMode === "weekly_count"
    ? resolveWeeklyDays(rule.weeklyCount ?? 1, rule.weekdays)
    : [];
  const cron = rule.scheduleMode === "cron" && rule.cronExpression
    ? parseSimpleCron(rule.cronExpression)
    : null;
  if (rule.scheduleMode === "cron" && !cron) return [];

  const occurrences: AutomationOccurrence[] = [];
  for (let localDate = startDate; localDate <= endDate; localDate = addCalendarDays(localDate, 1)) {
    const weekday = weekdayForDate(localDate);
    const times = rule.scheduleMode === "weekly_count"
      ? weeklyTimesForDate(rule.localTimes, weeklyDays, weekday)
      : cron && cron.weekdays.includes(weekday) ? [cron.time] : [];
    for (const localTime of times) {
      const instant = zonedDateTimeToUtc(localDate, localTime, rule.timezone);
      if (instant && instant.getTime() > now.getTime()) {
        occurrences.push({ runAt: instant.toISOString(), localDate, localTime });
      }
    }
  }
  return occurrences.sort((left, right) => left.runAt.localeCompare(right.runAt));
}

function resolveWeeklyDays(count: number, explicitDays: number[]): number[] {
  if (explicitDays.length) return [...new Set(explicitDays)].sort((left, right) => left - right);
  const preferred: Record<number, number[]> = {
    1: [2],
    2: [1, 4],
    3: [1, 3, 5],
    4: [1, 2, 4, 5],
    5: [1, 2, 3, 4, 5],
    6: [0, 1, 2, 3, 4, 5],
    7: [0, 1, 2, 3, 4, 5, 6],
  };
  return preferred[Math.max(1, Math.min(count, 7))] ?? [2];
}

function weeklyTimesForDate(localTimes: string[], weekdays: number[], weekday: number): string[] {
  const index = weekdays.indexOf(weekday);
  if (index < 0) return [];
  const time = localTimes.length === 1 ? localTimes[0] : localTimes[index];
  return time ? [time] : [];
}

function parseSimpleCron(expression: string): { time: string; weekdays: number[] } | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5 || fields[2] !== "*" || fields[3] !== "*") return null;
  const minute = Number(fields[0]);
  const hour = Number(fields[1]);
  if (!Number.isInteger(minute) || minute < 0 || minute > 59 || !Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  const weekdays = fields[4] === "*"
    ? [0, 1, 2, 3, 4, 5, 6]
    : fields[4].split(",").map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6);
  if (!weekdays.length || new Set(weekdays).size !== weekdays.length) return null;
  return { time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`, weekdays };
}

function zonedDateTimeToUtc(localDate: string, localTime: string, timezone: string): Date | null {
  const [year, month, day] = localDate.split("-").map(Number);
  const [hour, minute] = localTime.split(":").map(Number);
  if (![year, month, day, hour, minute].every(Number.isFinite)) return null;
  const desiredEpoch = Date.UTC(year, month - 1, day, hour, minute);
  let candidate = new Date(desiredEpoch);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actualEpoch = localEpoch(candidate, timezone);
    if (actualEpoch === null) return null;
    const delta = desiredEpoch - actualEpoch;
    if (delta === 0) break;
    candidate = new Date(candidate.getTime() + delta);
  }
  const verify = localDateAndTime(candidate, timezone);
  return verify?.date === localDate && verify.time === localTime ? candidate : null;
}

function localEpoch(value: Date, timezone: string): number | null {
  const parts = localDateAndTime(value, timezone);
  if (!parts) return null;
  const [year, month, day] = parts.date.split("-").map(Number);
  const [hour, minute] = parts.time.split(":").map(Number);
  return Date.UTC(year, month - 1, day, hour, minute);
}

function localDateAndTime(value: Date, timezone: string): { date: string; time: string } | null {
  try {
    const parts = new Map(new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(value).map((part) => [part.type, part.value]));
    const year = parts.get("year");
    const month = parts.get("month");
    const day = parts.get("day");
    const hour = parts.get("hour");
    const minute = parts.get("minute");
    if (!year || !month || !day || !hour || !minute) return null;
    return { date: `${year}-${month}-${day}`, time: `${hour}:${minute}` };
  } catch {
    return null;
  }
}

function weekdayForDate(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

function addCalendarDays(date: string, days: number): string {
  const instance = new Date(`${date}T00:00:00Z`);
  instance.setUTCDate(instance.getUTCDate() + days);
  return instance.toISOString().slice(0, 10);
}

function maxDate(left: string, right: string | null): string {
  return right && right > left ? right : left;
}

function minDate(left: string, right: string | null): string {
  return right && right < left ? right : left;
}

function inputFromDraft(draft: ContentDraftView): ContentDraftInput {
  return {
    contentType: draft.contentType,
    channels: draft.channels,
    title: draft.title,
    headline: draft.headline,
    subject: draft.subject,
    body: draft.body,
    cta: draft.cta,
    excerpt: draft.excerpt,
    hashtags: draft.hashtags,
    status: draft.status === "draft" || draft.status === "in_review" || draft.status === "approved" || draft.status === "scheduled" || draft.status === "cancelled"
      ? draft.status
      : "draft",
    generationPrompt: draft.generationPrompt,
    imagePrompt: draft.imagePrompt,
    language: draft.language,
    timezone: draft.timezone,
    scheduledAt: draft.scheduledAt,
    scheduledLocalDate: draft.scheduledLocalDate,
    scheduledLocalTime: draft.scheduledLocalTime,
    approvalRequired: draft.approvalRequired,
    templateId: draft.templateId,
    automationRuleId: draft.automationRuleId,
    newsletterAudienceId: draft.newsletterAudienceId,
  };
}

/**
 * Converts a claimed receipt into an editable draft. This performs no model
 * call and intentionally never creates a publishing job. Every automation
 * receipt—manual or scheduled—yields a private `draft`; the editor must make
 * a later explicit scheduling or publishing decision.
 */
function draftInputForClaimedAutomationJob(input: {
  job: ContentAutomationJobView;
  rule: ContentAutomationRuleView;
  template: ContentTemplateView | null;
  content: StudioAutomationDraftPayload;
}): ContentDraftInput {
  const { job, rule, template, content } = input;
  return contentDraftInputSchema.parse({
    contentType: rule.contentType,
    channels: rule.channels,
    title: content.title ?? template?.defaultTitle ?? rule.name,
    headline: content.headline ?? template?.defaultHeadline ?? null,
    subject: content.subject ?? template?.defaultSubject ?? null,
    body: content.body ?? template?.defaultBody ?? "",
    cta: content.cta ?? template?.defaultCta ?? null,
    excerpt: content.excerpt ?? template?.defaultExcerpt ?? null,
    hashtags: content.hashtags ?? template?.defaultHashtags ?? [],
    status: "draft",
    generationPrompt: content.generationPrompt ?? rule.generationPrompt,
    imagePrompt: content.imagePrompt ?? rule.imagePrompt,
    language: content.language ?? rule.language,
    timezone: job.timezone,
    scheduledAt: null,
    scheduledLocalDate: null,
    scheduledLocalTime: null,
    approvalRequired: rule.approvalRequired,
    templateId: rule.templateId,
    automationRuleId: rule.id,
    newsletterAudienceId: rule.newsletterAudienceId,
  });
}

function writeValues(input: ContentDraftInput, existingMetadata: JsonObject = {}): DraftWrite {
  const metadata = metadataForDraft(input, existingMetadata);
  return {
    templateId: input.templateId ?? null,
    contentType: input.contentType,
    status: input.status,
    title: input.title,
    body: input.body,
    excerpt: input.excerpt ?? null,
    channelsJson: JSON.stringify(input.channels),
    metadataJson: JSON.stringify(metadata),
    scheduledAt: input.scheduledAt ?? null,
  };
}

function assertCanWrite(actor: AppActor): void {
  if (actor.role === "viewer") throw new StudioContentAccessError();
}

function canMoveCalendarDraft(status: ContentDraftStatus): boolean {
  return (USER_EDITABLE_DRAFT_STATUSES as readonly string[]).includes(status) && status !== "cancelled";
}

function assertCalendarMoveIntegrity(input: ContentDraftCalendarMoveInput, now: Date): void {
  const scheduledAt = new Date(input.scheduledAt);
  if (Number.isNaN(scheduledAt.getTime())) {
    throw new StudioContentValidationError("Ange en giltig schemalagd tidpunkt.");
  }
  if (scheduledAt.getTime() <= now.getTime()) {
    throw new StudioContentValidationError("En kalenderpost kan bara flyttas till en framtida tid.");
  }
  const local = localDateTimeInTimezone(scheduledAt, input.timezone);
  if (!local || local.date !== input.scheduledLocalDate || local.time !== input.scheduledLocalTime) {
    throw new StudioContentValidationError("Tidpunkten och den lokala kalenderplatsen måste beskriva samma ögonblick.");
  }
}

function boundedLimit(value: number | undefined): number {
  return Math.max(1, Math.min(value ?? 100, MAX_DRAFT_LIST_SIZE));
}

function boundedJobLimit(value: number | undefined): number {
  return Math.max(1, Math.min(value ?? DEFAULT_JOB_BATCH_SIZE, MAX_JOB_BATCH_SIZE));
}

function boundedLeaseMs(value: number | undefined): number {
  return Math.max(MIN_JOB_LEASE_MS, Math.min(value ?? DEFAULT_JOB_LEASE_MS, MAX_JOB_LEASE_MS));
}

function calendarDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000);
}

/** Reads only the signed actor's workspace preference; it never trusts a URL or body workspace id. */
export async function getStudioWorkspaceTimezone(
  actor: AppActor,
  sql: NeonSql = createNeonSql(),
): Promise<string> {
  const rows = await sql.query(
    `select timezone
       from app_workspaces
      where id = $1::uuid
      limit 1`,
    [actor.workspaceId],
  ) as unknown as Array<{ timezone: string }>;
  const timezone = rows[0]?.timezone;
  if (!timezone) throw new StudioContentNotFoundError("Arbetsytan hittades inte.");
  if (!isValidIanaTimezone(timezone)) throw new Error("Arbetsytans tidszon är ogiltig.");
  return timezone;
}

async function getDraftRowInWorkspace(workspaceId: string, draftId: string, sql: NeonSql, brandProfileId?: string): Promise<DraftRow | null> {
  const rows = await sql.query(
    `select
       id::text,
       author_user_id::text,
       brand_profile_id::text,
       template_id::text,
       automation_job_id::text,
       content_type,
       status,
       title,
       body,
       excerpt,
       publication_channels,
       metadata,
       revision,
       scheduled_at::text,
       published_at::text,
       created_at::text,
       updated_at::text
     from studio_drafts
     where workspace_id = $1::uuid and id = $2::uuid
       and ($3::uuid is null or brand_profile_id = $3::uuid)
     limit 1`,
    [workspaceId, draftId, brandProfileId ?? null],
  ) as unknown as DraftRow[];
  return rows[0] ?? null;
}

async function getDraftRow(actor: AppActor, draftId: string, sql: NeonSql): Promise<DraftRow | null> {
  return getDraftRowInWorkspace(actor.workspaceId, draftId, sql, actor.brandProfileId);
}

async function getDraftRowForAutomationJob(workspaceId: string, jobId: string, sql: NeonSql): Promise<DraftRow | null> {
  const rows = await sql.query(
    `select
       id::text,
       author_user_id::text,
       brand_profile_id::text,
       template_id::text,
       automation_job_id::text,
       content_type,
       status,
       title,
       body,
       excerpt,
       publication_channels,
       metadata,
       revision,
       scheduled_at::text,
       published_at::text,
       created_at::text,
       updated_at::text
     from studio_drafts
     where workspace_id = $1::uuid and automation_job_id = $2::uuid
     limit 1`,
    [workspaceId, jobId],
  ) as unknown as DraftRow[];
  return rows[0] ?? null;
}

async function listMediaRowsForDraft(actor: AppActor, draftId: string, sql: NeonSql): Promise<MediaRow[]> {
  return await sql.query(
    `select
       id::text,
       draft_id::text,
       blob_url,
       blob_pathname,
       content_type,
       byte_size,
       kind,
       status,
       alt_text,
       metadata,
       created_at::text,
       updated_at::text
     from studio_media
     where workspace_id = $1::uuid and draft_id = $2::uuid and status <> 'deleted'
     order by created_at asc`,
    [actor.workspaceId, draftId],
  ) as unknown as MediaRow[];
}

async function listMediaRowsForDrafts(actor: AppActor, draftIds: string[], sql: NeonSql): Promise<MediaRow[]> {
  if (!draftIds.length) return [];
  return await sql.query(
    `select
       id::text,
       draft_id::text,
       blob_url,
       blob_pathname,
       content_type,
       byte_size,
       kind,
       status,
       alt_text,
       metadata,
       created_at::text,
       updated_at::text
     from studio_media
     where workspace_id = $1::uuid
       and draft_id = any($2::uuid[])
       and status <> 'deleted'
     order by draft_id asc, created_at asc`,
    [actor.workspaceId, draftIds],
  ) as unknown as MediaRow[];
}

async function getTemplateRowInWorkspace(workspaceId: string, templateId: string, sql: NeonSql): Promise<TemplateRow | null> {
  const rows = await sql.query(
    `select
       id::text,
       created_by_user_id::text,
       name,
       content_type,
       title_template,
       body_template,
       prompt,
       channel_defaults,
       metadata,
       is_active,
       created_at::text,
       updated_at::text
     from studio_templates
     where workspace_id = $1::uuid and id = $2::uuid
     limit 1`,
    [workspaceId, templateId],
  ) as unknown as TemplateRow[];
  return rows[0] ?? null;
}

async function getTemplateRow(actor: AppActor, templateId: string, sql: NeonSql): Promise<TemplateRow | null> {
  return getTemplateRowInWorkspace(actor.workspaceId, templateId, sql);
}

async function getAutomationRowInWorkspace(workspaceId: string, automationId: string, sql: NeonSql): Promise<AutomationRow | null> {
  const rows = await sql.query(
    `select
       id::text,
       created_by_user_id::text,
       template_id::text,
       name,
       content_type,
       schedule_kind,
       cron_expression,
       trigger_config,
       generation_config, brand_profile_id::text,
       enabled,
       approval_required,
       next_run_at::text,
       last_run_at::text,
       created_at::text,
       updated_at::text
     from studio_automations
     where workspace_id = $1::uuid and id = $2::uuid
       and saga_daily_knowledge_brand_is_eligible(workspace_id, brand_profile_id)
     limit 1`,
    [workspaceId, automationId],
  ) as unknown as AutomationRow[];
  return rows[0] ?? null;
}

async function getAutomationRow(actor: AppActor, automationId: string, sql: NeonSql): Promise<AutomationRow | null> {
  return getAutomationRowInWorkspace(actor.workspaceId, automationId, sql);
}

async function getClaimedJobRow(jobId: string, claimToken: string, sql: NeonSql): Promise<JobRow | null> {
  const rows = await sql.query(
    `select
       id::text,
       workspace_id::text,
       automation_id::text,
       draft_id::text,
       kind,
       status,
       idempotency_key,
       claim_token::text,
       run_after::text,
       started_at::text,
       completed_at::text,
       lease_expires_at::text,
       locked_by,
       attempts,
       max_attempts,
       payload,
       result,
       failure_code,
       failure_detail,
       created_at::text,
       updated_at::text
     from studio_jobs
     where id = $1::uuid
       and status = 'running'
       and claim_token = $2::uuid
       and lease_expires_at > clock_timestamp()
     limit 1`,
    [jobId, claimToken],
  ) as unknown as JobRow[];
  return rows[0] ?? null;
}

async function resolveClaimedAutomationJob(
  jobId: string,
  claimToken: string,
  sql: NeonSql,
): Promise<ResolvedClaimedAutomationJob | null> {
  const jobRow = await getClaimedJobRow(jobId, claimToken, sql);
  if (!jobRow?.automation_id) return null;
  const automationRow = await getAutomationRowInWorkspace(jobRow.workspace_id, jobRow.automation_id, sql);
  if (!automationRow) return null;
  const rule = mapAutomation(automationRow);
  const templateRow = rule.templateId
    ? await getTemplateRowInWorkspace(jobRow.workspace_id, rule.templateId, sql)
    : null;
  const jobPayload = objectValue(jobRow.payload);
  const manual = automationJobTriggerKind(jobPayload) === "manual";
  return {
    ...mapAutomationJob(jobRow, rule.userId, rule.timezone),
    claimToken,
    rule,
    template: templateRow ? mapTemplate(templateRow) : null,
    workspaceId: jobRow.workspace_id,
    finalization: {
      manual,
      // Older jobs did not capture a configuration version. They retain their
      // legacy behavior but still require an enabled rule at final write.
      expectedAutomationConfigurationVersion: manual
        ? null
        : metadataString(jobPayload, "automationConfigurationVersion"),
    },
  };
}

async function recordAutomationRun(workspaceId: string, automationId: string, at: string, sql: NeonSql): Promise<void> {
  await sql.query(
    `update studio_automations
        set last_run_at = $3::timestamptz
      where workspace_id = $1::uuid and id = $2::uuid`,
    [workspaceId, automationId, at],
  );
}

async function assertTemplateInWorkspace(actor: AppActor, templateId: string | null, sql: NeonSql): Promise<void> {
  if (!templateId) return;
  const template = await getTemplateRow(actor, templateId, sql);
  if (!template) throw new StudioContentNotFoundError("Mallen hittades inte i arbetsytan.");
}

/**
 * An automation can opt in to one Series Reference, but it may only retain
 * the opaque ID after Neon has proved that the Series is both active and in
 * the signed actor's workspace. This deliberately stores no source draft,
 * media URL, prompt snapshot, or cross-workspace identifier in the rule.
 */
async function assertActiveSagaSeriesReferenceInWorkspace(
  actor: AppActor,
  seriesId: string | null,
  sql: NeonSql,
): Promise<void> {
  if (!seriesId) return;
  const rows = await sql.query(
    `select series.id::text
       from saga_series_references series
       join saga_series_reference_revisions reference
         on reference.workspace_id = series.workspace_id and reference.series_id = series.id
        and reference.revision = series.current_reference_revision
       join studio_drafts draft
         on draft.workspace_id = reference.workspace_id and draft.id = reference.source_draft_id
      where series.workspace_id = $1::uuid
        and series.id = $2::uuid
        and series.active = true
        and draft.brand_profile_id = $3::uuid
      limit 1`,
    [actor.workspaceId, seriesId, actor.brandProfileId ?? null],
  ) as unknown as Array<{ id: string }>;
  if (!rows[0]) {
    throw new StudioContentNotFoundError("Den valda SAGA-serien är inte aktiv för automationens varumärke.");
  }
}

async function uniqueStudioTemplateSlug(
  actor: AppActor,
  requested: string,
  sql: NeonSql,
  ownTemplateId?: string,
): Promise<string> {
  const base = slugify(requested);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base.slice(0, 68)}-${randomUUID().slice(0, 8)}`;
    const rows = await sql.query(
      `select id::text
       from studio_templates
       where workspace_id = $1::uuid
         and metadata ->> 'slug' = $2
         and ($3::uuid is null or id <> $3::uuid)
       limit 1`,
      [actor.workspaceId, candidate, ownTemplateId ?? null],
    ) as unknown as Array<{ id: string }>;
    if (!rows[0]) return candidate;
  }
  throw new Error("Kunde inte skapa en unik malladress. Försök igen.");
}

/** Reads one draft strictly through the authenticated actor's workspace. */
export async function getStudioDraft(
  actor: AppActor,
  draftId: string,
  sql: NeonSql = createNeonSql(),
): Promise<ContentDraftView | null> {
  const validatedId = contentDraftIdSchema.parse(draftId);
  const row = await getDraftRow(actor, validatedId, sql);
  if (!row) return null;
  const media = await listMediaRowsForDraft(actor, validatedId, sql);
  return mapDraft(row, media.map(mapMedia));
}

/** Lists current workspace drafts. There is intentionally no caller-supplied workspace id. */
export async function listStudioDrafts(
  actor: AppActor,
  options: ListStudioDraftOptions = {},
  sql: NeonSql = createNeonSql(),
): Promise<ContentDraftView[]> {
  const statuses = options.statuses?.filter((status): status is ContentDraftStatus => (CONTENT_DRAFT_STATUSES as readonly string[]).includes(status)) ?? null;
  const rows = await sql.query(
    `select
       id::text,
       author_user_id::text,
       brand_profile_id::text,
       template_id::text,
       automation_job_id::text,
       content_type,
       status,
       title,
       body,
       excerpt,
       publication_channels,
       metadata,
       revision,
       scheduled_at::text,
       published_at::text,
       created_at::text,
       updated_at::text
     from studio_drafts
     where workspace_id = $1::uuid
       and ($2::text[] is null or status = any($2::text[]))
       and ($4::uuid is null or brand_profile_id = $4::uuid)
     order by scheduled_at asc nulls last, updated_at desc
     limit $3::int`,
    [actor.workspaceId, statuses?.length ? statuses : null, boundedLimit(options.limit), actor.brandProfileId ?? null],
  ) as unknown as DraftRow[];
  if (options.includeMedia === false || !rows.length) return rows.map((row) => mapDraft(row));

  const mediaRows = await listMediaRowsForDrafts(actor, rows.map((row) => row.id), sql);
  const mediaByDraftId = new Map<string, ContentMediaAttachmentView[]>();
  for (const row of mediaRows) {
    const draftMedia = mediaByDraftId.get(row.draft_id) ?? [];
    draftMedia.push(mapMedia(row));
    mediaByDraftId.set(row.draft_id, draftMedia);
  }
  return rows.map((row) => mapDraft(row, mediaByDraftId.get(row.id) ?? []));
}

/** Creates a draft in the actor's workspace and keeps UI-rich fields in metadata. */
export async function createStudioDraft(
  actor: AppActor,
  input: ContentDraftInput,
  sql: NeonSql = createNeonSql(),
): Promise<ContentDraftView> {
  assertCanWrite(actor);
  const parsed = contentDraftInputSchema.parse(input);
  if (parsed.approvalRequired && parsed.status === "scheduled") {
    throw new Error("Godkänn utkastet innan det schemaläggs, eller stäng av krav på godkännande.");
  }
  const draft = writeValues(parsed);
  const rows = await sql.query(
    `insert into studio_drafts (
       workspace_id, author_user_id, template_id, content_type, status,
       title, body, excerpt, publication_channels, metadata, scheduled_at, brand_profile_id
     ) values (
       $1::uuid, $2::uuid, $3::uuid, $4, $5,
       $6, $7, $8, $9::jsonb, $10::jsonb, $11::timestamptz, $12::uuid
     )
     returning
       id::text,
       author_user_id::text,
       brand_profile_id::text,
       template_id::text,
       automation_job_id::text,
       content_type,
       status,
       title,
       body,
       excerpt,
       publication_channels,
       metadata,
       revision,
       scheduled_at::text,
       published_at::text,
       created_at::text,
       updated_at::text`,
    [
      actor.workspaceId,
      actor.userId,
      draft.templateId,
      draft.contentType,
      draft.status,
      draft.title,
      draft.body,
      draft.excerpt,
      draft.channelsJson,
      draft.metadataJson,
      draft.scheduledAt,
      actor.brandProfileId ?? null,
    ],
  ) as unknown as DraftRow[];
  const row = rows[0];
  if (!row) throw new Error("Utkastet kunde inte skapas.");
  return mapDraft(row);
}

/** Updates one editable draft and preserves metadata unrelated to the editor. */
export async function updateStudioDraft(
  actor: AppActor,
  draftId: string,
  patch: ContentDraftUpdateInput,
  sql: NeonSql = createNeonSql(),
): Promise<ContentDraftView | null> {
  assertCanWrite(actor);
  const validatedId = contentDraftIdSchema.parse(draftId);
  const existingRow = await getDraftRow(actor, validatedId, sql);
  if (!existingRow) return null;

  const existing = mapDraft(existingRow);
  if (existing.status === "publishing" || existing.status === "published") {
    throw new StudioContentValidationError("Ett utkast som publiceras eller har publicerats kan inte redigeras här.");
  }
  const { expectedRevision } = patch;
  let editorPatch = { ...patch };
  delete editorPatch.id;
  editorPatch = await normalizeQuarterlyPrivateDraftEditorPatch(
    actor.workspaceId,
    validatedId,
    existing,
    objectValue(existingRow.metadata),
    editorPatch,
    sql,
  );
  delete editorPatch.expectedRevision;
  const merged = contentDraftInputSchema.parse({ ...inputFromDraft(existing), ...editorPatch });
  assertDeliveryLockedAdAutomationDraftInvariant(objectValue(existingRow.metadata), merged);
  const scheduleFieldsTouched = ["scheduledAt", "scheduledLocalDate", "scheduledLocalTime", "timezone"]
    .some((field) => Object.prototype.hasOwnProperty.call(editorPatch, field));
  if ((existing.scheduledAt || merged.scheduledAt) && expectedRevision === undefined) {
    throw new StudioContentValidationError("Ladda om utkastet innan du ändrar ett schemalagt inlägg.");
  }
  if (expectedRevision !== undefined && existing.revision !== expectedRevision) {
    throw new StudioContentConflictError();
  }
  if (scheduleFieldsTouched && merged.scheduledAt) {
    assertCalendarMoveIntegrity({
      scheduledAt: merged.scheduledAt,
      scheduledLocalDate: merged.scheduledLocalDate as string,
      scheduledLocalTime: merged.scheduledLocalTime as string,
      timezone: merged.timezone,
      expectedRevision: expectedRevision ?? existing.revision,
    }, new Date());
  }
  if (merged.approvalRequired && merged.status === "scheduled" && !existing.approvedAt) {
    throw new StudioContentValidationError("Godkänn utkastet innan det schemaläggs, eller stäng av krav på godkännande.");
  }
  const calendarQuality = merged.scheduledAt
    ? assertAutomationQualityAllowsCalendar(objectValue(existingRow.metadata), merged)
    : null;
  const draft = writeValues(merged, objectValue(existingRow.metadata));
  if (calendarQuality) {
    draft.metadataJson = withSagaProductionQuality(draft.metadataJson, calendarQuality);
  }
  const rows = await sql.query(
    `update studio_drafts
        set template_id = $3::uuid,
            content_type = $4,
            status = $5,
            title = $6,
            body = $7,
            excerpt = $8,
            publication_channels = $9::jsonb,
            metadata = $10::jsonb,
            scheduled_at = $11::timestamptz,
            revision = revision + 1
      where workspace_id = $1::uuid
        and id = $2::uuid
        and ($12::int is null or revision = $12::int)
      returning
        id::text,
        author_user_id::text,
        brand_profile_id::text,
        template_id::text,
        automation_job_id::text,
        content_type,
        status,
        title,
        body,
        excerpt,
        publication_channels,
        metadata,
        revision,
        scheduled_at::text,
        published_at::text,
        created_at::text,
        updated_at::text`,
    [
      actor.workspaceId,
      validatedId,
      draft.templateId,
      draft.contentType,
      draft.status,
      draft.title,
      draft.body,
      draft.excerpt,
      draft.channelsJson,
      draft.metadataJson,
      draft.scheduledAt,
      expectedRevision ?? null,
    ],
  ) as unknown as DraftRow[];
  if (!rows[0] && expectedRevision !== undefined) throw new StudioContentConflictError();
  return rows[0] ? mapDraft(rows[0]) : null;
}

/**
 * Moves one existing calendar item without changing its approval or delivery
 * state. The revision predicate makes concurrent drag/drop actions fail
 * visibly instead of overwriting another editor's chosen time.
 *
 * This function only updates schedule metadata and `scheduled_at`; it never
 * creates a publish job, calls a provider, or transitions `status`.
 */
export async function rescheduleStudioDraft(
  actor: AppActor,
  draftId: string,
  input: ContentDraftCalendarMoveInput,
  sql: NeonSql = createNeonSql(),
  options: { now?: Date } = {},
): Promise<ContentDraftView | null> {
  assertCanWrite(actor);
  const validatedId = contentDraftIdSchema.parse(draftId);
  const move = contentDraftCalendarMoveSchema.parse(input);
  const existingRow = await getDraftRow(actor, validatedId, sql);
  if (!existingRow) return null;

  const existing = mapDraft(existingRow);
  if (isDeliveryLockedAdAutomationDraft(objectValue(existingRow.metadata))) {
    throw new StudioContentValidationError(
      "Det här SAGA-annonsutkastet är ett låst privat kreativt underlag och kan inte placeras i publiceringskalendern.",
    );
  }
  const quarterlyReviewState = await getSagaQuarterlyPrivateDraftReviewState(
    actor.workspaceId,
    validatedId,
    objectValue(existingRow.metadata),
    sql,
  );
  if (quarterlyReviewState && !isQuarterlyDraftApprovedForCalendar(quarterlyReviewState)) {
    throw new StudioContentValidationError(
      "Det här privata kvartalsutkastet måste godkännas i batchgranskningen innan det kan läggas i publiceringskalendern.",
    );
  }
  if (!canMoveCalendarDraft(existing.status)) {
    throw new StudioContentValidationError("En post som publiceras, är publicerad eller har avbrutits kan inte flyttas i kalendern.");
  }
  if (existing.revision !== move.expectedRevision) {
    throw new StudioContentConflictError();
  }
  assertCalendarMoveIntegrity(move, options.now ?? new Date());

  // Build the metadata through the same canonical path as the editor, while
  // deliberately retaining the existing state, approval receipt and content.
  const merged = contentDraftInputSchema.parse({
    ...inputFromDraft(existing),
    scheduledAt: move.scheduledAt,
    scheduledLocalDate: move.scheduledLocalDate,
    scheduledLocalTime: move.scheduledLocalTime,
    timezone: move.timezone,
  });
  if (merged.approvalRequired && merged.status === "scheduled" && !existing.approvedAt) {
    throw new StudioContentValidationError("Godkänn utkastet innan det schemaläggs, eller stäng av krav på godkännande.");
  }
  const calendarQuality = assertAutomationQualityAllowsCalendar(objectValue(existingRow.metadata), merged);
  const write = writeValues(merged, objectValue(existingRow.metadata));
  if (calendarQuality) {
    write.metadataJson = withSagaProductionQuality(write.metadataJson, calendarQuality);
  }
  const rows = await sql.query(
    `update studio_drafts
        set metadata = $4::jsonb,
            scheduled_at = $5::timestamptz,
            revision = revision + 1
      where workspace_id = $1::uuid
        and id = $2::uuid
        and revision = $3::int
      returning
        id::text,
        author_user_id::text,
        brand_profile_id::text,
        template_id::text,
        automation_job_id::text,
        content_type,
        status,
        title,
        body,
        excerpt,
        publication_channels,
        metadata,
        revision,
        scheduled_at::text,
        published_at::text,
        created_at::text,
        updated_at::text`,
    [
      actor.workspaceId,
      validatedId,
      move.expectedRevision,
      write.metadataJson,
      write.scheduledAt,
    ],
  ) as unknown as DraftRow[];
  if (!rows[0]) throw new StudioContentConflictError();
  return mapDraft(rows[0]);
}

/** Deletes only a draft owned by the actor's workspace. */
export async function deleteStudioDraft(
  actor: AppActor,
  draftId: string,
  sql: NeonSql = createNeonSql(),
): Promise<boolean> {
  assertCanWrite(actor);
  const validatedId = contentDraftIdSchema.parse(draftId);
  const rows = await sql.query(
    `delete from studio_drafts
      where workspace_id = $1::uuid and id = $2::uuid
        and ($3::uuid is null or brand_profile_id = $3::uuid)
      returning id::text`,
    [actor.workspaceId, validatedId, actor.brandProfileId ?? null],
  ) as unknown as Array<{ id: string }>;
  return Boolean(rows[0]);
}

/** Resolves an existing draft through the actor's workspace before Blob work starts. */
export async function requireOwnedStudioDraft(
  actor: AppActor,
  draftId: string,
  sql: NeonSql = createNeonSql(),
): Promise<ContentDraftView> {
  assertCanWrite(actor);
  const validatedDraftId = contentDraftIdSchema.parse(draftId);
  const row = await getDraftRow(actor, validatedDraftId, sql);
  if (!row) throw new StudioContentNotFoundError();
  await assertStudioDraftMediaMutationAllowed(actor, validatedDraftId, row, sql);
  const media = await listMediaRowsForDraft(actor, validatedDraftId, sql);
  return mapDraft(row, media.map(mapMedia));
}

/** Lists safe UI media metadata. Private Vercel Blob URLs are never returned. */
export async function listStudioMediaForDraft(
  actor: AppActor,
  draftId: string,
  sql: NeonSql = createNeonSql(),
): Promise<ContentMediaAttachmentView[]> {
  const validatedId = contentDraftIdSchema.parse(draftId);
  const rows = await listMediaRowsForDraft(actor, validatedId, sql);
  return rows.map(mapMedia);
}

/** Returns private Blob metadata only after workspace + draft + media ownership is verified. */
export async function getOwnedStudioMedia(
  actor: AppActor,
  draftId: string,
  mediaId: string,
  sql: NeonSql = createNeonSql(),
): Promise<StudioOwnedMedia | null> {
  const validatedDraftId = contentDraftIdSchema.parse(draftId);
  const validatedMediaId = contentMediaAttachmentIdSchema.parse(mediaId);
  const rows = await sql.query(
    `select
       id::text,
       draft_id::text,
       blob_url,
       blob_pathname,
       content_type,
       byte_size,
       kind,
       status,
       alt_text,
       metadata,
       created_at::text,
       updated_at::text
     from studio_media
     where workspace_id = $1::uuid
       and draft_id = $2::uuid
       and id = $3::uuid
       and status <> 'deleted'
     limit 1`,
    [actor.workspaceId, validatedDraftId, validatedMediaId],
  ) as unknown as MediaRow[];
  return rows[0] ? mapOwnedMedia(rows[0]) : null;
}

/**
 * Stores an uploaded Blob's metadata only for an already-owned draft. Blob
 * bytes are handled by lib/vercel/blob-media.ts; this function never accepts a
 * workspace id or a raw storage token from a request.
 */
export async function createStudioMediaMetadata(
  actor: AppActor,
  input: CreateStudioMediaMetadataInput,
  sql: NeonSql = createNeonSql(),
): Promise<ContentMediaAttachmentView> {
  assertCanWrite(actor);
  const draftId = contentDraftIdSchema.parse(input.draftId);
  const draft = await getDraftRow(actor, draftId, sql);
  if (!draft) throw new StudioContentNotFoundError();
  await assertStudioDraftMediaMutationAllowed(actor, draftId, draft, sql);

  const media = contentMediaAttachmentCreateSchema.parse({
    kind: "image",
    source: input.source ?? "upload",
    storagePath: input.blobPathname,
    assetUrl: input.blobUrl,
    filename: input.fileName ?? null,
    mimeType: input.contentType,
    byteSize: input.byteSize,
    altText: input.altText ?? null,
    caption: input.caption ?? null,
    processingStatus: input.processingStatus ?? "original",
    adaptationPrompt: input.adaptationPrompt ?? null,
    variants: input.variants ?? {},
    sortOrder: input.sortOrder ?? 0,
  });
  const recordKind = media.source === "generated" ? "generated" : media.source === "library" || media.source === "external" ? "derived" : "upload";
  const storedStatus = media.processingStatus === "failed" ? "failed" : media.processingStatus === "processing" ? "processing" : "ready";
  const metadata = JSON.stringify({
    contentKind: media.kind,
    source: media.source,
    filename: media.filename ?? null,
    caption: media.caption ?? null,
    processingStatus: media.processingStatus,
    adaptationPrompt: media.adaptationPrompt ?? null,
    variants: media.variants,
    sortOrder: media.sortOrder,
  });
  const rows = await sql.query(
    `insert into studio_media (
       workspace_id, draft_id, created_by_user_id, blob_url, blob_pathname,
       content_type, byte_size, kind, status, alt_text, metadata
     ) values (
       $1::uuid, $2::uuid, $3::uuid, $4, $5,
       $6, $7::bigint, $8, $9, $10, $11::jsonb
     )
     returning
       id::text,
       draft_id::text,
       blob_url,
       blob_pathname,
       content_type,
       byte_size,
       kind,
       status,
       alt_text,
       metadata,
       created_at::text,
       updated_at::text`,
    [
      actor.workspaceId,
      draftId,
      actor.userId,
      input.blobUrl,
      input.blobPathname,
      media.mimeType,
      media.byteSize,
      recordKind,
      storedStatus,
      media.altText,
      metadata,
    ],
  ) as unknown as MediaRow[];
  const row = rows[0];
  if (!row) throw new Error("Bildens metadata kunde inte sparas.");
  return mapMedia(row);
}

/** Removes only the metadata record scoped to the actor's current workspace and draft. */
export async function deleteStudioMediaMetadata(
  actor: AppActor,
  draftId: string,
  mediaId: string,
  sql: NeonSql = createNeonSql(),
): Promise<StudioOwnedMedia | null> {
  assertCanWrite(actor);
  const validatedDraftId = contentDraftIdSchema.parse(draftId);
  const validatedMediaId = contentMediaAttachmentIdSchema.parse(mediaId);
  const draft = await getDraftRow(actor, validatedDraftId, sql);
  if (!draft) throw new StudioContentNotFoundError();
  await assertStudioDraftMediaMutationAllowed(actor, validatedDraftId, draft, sql);
  const rows = await sql.query(
    `delete from studio_media
      where workspace_id = $1::uuid
        and draft_id = $2::uuid
        and id = $3::uuid
      returning
        id::text,
        draft_id::text,
        blob_url,
        blob_pathname,
        content_type,
        byte_size,
        kind,
        status,
        alt_text,
        metadata,
        created_at::text,
        updated_at::text`,
    [actor.workspaceId, validatedDraftId, validatedMediaId],
  ) as unknown as MediaRow[];
  return rows[0] ? mapOwnedMedia(rows[0]) : null;
}

/** Lists workspace templates. System templates are intentionally not implicit in Neon V1. */
export async function listStudioTemplates(
  actor: AppActor,
  sql: NeonSql = createNeonSql(),
): Promise<ContentTemplateView[]> {
  const rows = await sql.query(
    `select
       id::text,
       created_by_user_id::text,
       name,
       content_type,
       title_template,
       body_template,
       prompt,
       channel_defaults,
       metadata,
       is_active,
       created_at::text,
       updated_at::text
     from studio_templates
     where workspace_id = $1::uuid
     order by is_active desc, name asc, created_at asc`,
    [actor.workspaceId],
  ) as unknown as TemplateRow[];
  return rows.map((row) => mapTemplate(row));
}

/** Reads one template through the current actor's workspace. */
export async function getStudioTemplate(
  actor: AppActor,
  templateId: string,
  sql: NeonSql = createNeonSql(),
): Promise<ContentTemplateView | null> {
  const validatedId = contentTemplateIdSchema.parse(templateId);
  const row = await getTemplateRow(actor, validatedId, sql);
  return row ? mapTemplate(row) : null;
}

/** Creates a workspace-shared template while retaining legacy UI fields in JSON metadata. */
export async function createStudioTemplate(
  actor: AppActor,
  input: ContentTemplateInput,
  sql: NeonSql = createNeonSql(),
): Promise<ContentTemplateView> {
  assertCanWrite(actor);
  const parsed = contentTemplateInputSchema.parse(input);
  const slug = await uniqueStudioTemplateSlug(actor, parsed.slug ?? slugify(parsed.name), sql);
  const template = writeTemplate(parsed, slug);
  const rows = await sql.query(
    `insert into studio_templates (
       workspace_id, created_by_user_id, name, content_type, title_template,
       body_template, prompt, channel_defaults, metadata, is_active
     ) values (
       $1::uuid, $2::uuid, $3, $4, $5,
       $6, $7, $8::jsonb, $9::jsonb, $10
     )
     returning
       id::text,
       created_by_user_id::text,
       name,
       content_type,
       title_template,
       body_template,
       prompt,
       channel_defaults,
       metadata,
       is_active,
       created_at::text,
       updated_at::text`,
    [
      actor.workspaceId,
      actor.userId,
      template.name,
      template.contentType,
      template.titleTemplate,
      template.bodyTemplate,
      template.prompt,
      template.channelDefaultsJson,
      template.metadataJson,
      template.active,
    ],
  ) as unknown as TemplateRow[];
  const row = rows[0];
  if (!row) throw new Error("Mallen kunde inte skapas.");
  return mapTemplate(row);
}

/** Updates a template within the actor's workspace and preserves unknown metadata fields. */
export async function updateStudioTemplate(
  actor: AppActor,
  templateId: string,
  patch: ContentTemplateUpdateInput,
  sql: NeonSql = createNeonSql(),
): Promise<ContentTemplateView | null> {
  assertCanWrite(actor);
  const validatedId = contentTemplateIdSchema.parse(templateId);
  const existingRow = await getTemplateRow(actor, validatedId, sql);
  if (!existingRow) return null;

  const existing = mapTemplate(existingRow);
  const merged = contentTemplateInputSchema.parse({ ...inputFromTemplate(existing), ...patch });
  const slug = merged.slug && merged.slug !== existing.slug
    ? await uniqueStudioTemplateSlug(actor, merged.slug, sql, validatedId)
    : existing.slug;
  const template = writeTemplate(
    merged,
    slug,
    objectValue(existingRow.metadata),
    objectValue(existingRow.channel_defaults),
  );
  const rows = await sql.query(
    `update studio_templates
        set name = $3,
            content_type = $4,
            title_template = $5,
            body_template = $6,
            prompt = $7,
            channel_defaults = $8::jsonb,
            metadata = $9::jsonb,
            is_active = $10
      where workspace_id = $1::uuid and id = $2::uuid
      returning
        id::text,
        created_by_user_id::text,
        name,
        content_type,
        title_template,
        body_template,
        prompt,
        channel_defaults,
        metadata,
        is_active,
        created_at::text,
        updated_at::text`,
    [
      actor.workspaceId,
      validatedId,
      template.name,
      template.contentType,
      template.titleTemplate,
      template.bodyTemplate,
      template.prompt,
      template.channelDefaultsJson,
      template.metadataJson,
      template.active,
    ],
  ) as unknown as TemplateRow[];
  return rows[0] ? mapTemplate(rows[0]) : null;
}

/** Deletes only a template in the actor's workspace. Referenced templates remain protected by SQL FKs. */
export async function deleteStudioTemplate(
  actor: AppActor,
  templateId: string,
  sql: NeonSql = createNeonSql(),
): Promise<boolean> {
  assertCanWrite(actor);
  const validatedId = contentTemplateIdSchema.parse(templateId);
  const rows = await sql.query(
    `delete from studio_templates
      where workspace_id = $1::uuid and id = $2::uuid
      returning id::text`,
    [actor.workspaceId, validatedId],
  ) as unknown as Array<{ id: string }>;
  return Boolean(rows[0]);
}

/** Lists workspace automations with the exact legacy ContentAutomationRuleView shape. */
export async function listStudioAutomations(
  actor: AppActor,
  sql: NeonSql = createNeonSql(),
): Promise<ContentAutomationRuleView[]> {
  const rows = await sql.query(
    `select
       id::text,
       created_by_user_id::text,
       template_id::text,
       name,
       content_type,
       schedule_kind,
       cron_expression,
       trigger_config,
       generation_config, brand_profile_id::text,
       enabled,
       approval_required,
       next_run_at::text,
       last_run_at::text,
       created_at::text,
       updated_at::text
     from studio_automations
     where workspace_id = $1::uuid
     order by enabled desc, next_run_at asc nulls last, name asc`,
    [actor.workspaceId],
  ) as unknown as AutomationRow[];
  return rows.map((row) => mapAutomation(row));
}

/** Reads one automation only from the actor's current workspace. */
export async function getStudioAutomation(
  actor: AppActor,
  automationId: string,
  sql: NeonSql = createNeonSql(),
): Promise<ContentAutomationRuleView | null> {
  const validatedId = contentAutomationRuleIdSchema.parse(automationId);
  const row = await getAutomationRow(actor, validatedId, sql);
  return row ? mapAutomation(row) : null;
}

/** Creates an automation and stores a fresh, timezone-aware next-run preview. */
export async function createStudioAutomation(
  actor: AppActor,
  input: ContentAutomationRuleInput,
  sql: NeonSql = createNeonSql(),
): Promise<ContentAutomationRuleView> {
  assertCanWrite(actor);
  const parsed = contentAutomationRuleInputSchema.parse(input);
  const brandActor = await resolveSagaBrandActor(actor, parsed.brandProfileId, sql);
  await assertTemplateInWorkspace(actor, parsed.templateId ?? null, sql);
  await assertActiveSagaSeriesReferenceInWorkspace(brandActor, parsed.seriesId ?? null, sql);
  const automation = writeAutomation(parsed, nextAutomationRunAt(parsed));
  const rows = await sql.query(
    `insert into studio_automations (
       workspace_id, created_by_user_id, template_id, name, content_type,
       schedule_kind, cron_expression, trigger_config, generation_config,
       enabled, approval_required, next_run_at, brand_profile_id
     ) values (
       $1::uuid, $2::uuid, $3::uuid, $4, $5,
       $6, $7, $8::jsonb, $9::jsonb,
       $10, $11, $12::timestamptz, $13::uuid
     )
     returning
       id::text,
       created_by_user_id::text,
       template_id::text,
       name,
       content_type,
       schedule_kind,
       cron_expression,
       trigger_config,
       generation_config, brand_profile_id::text,
       enabled,
       approval_required,
       next_run_at::text,
       last_run_at::text,
       created_at::text,
       updated_at::text`,
    [
      actor.workspaceId,
      actor.userId,
      automation.templateId,
      automation.name,
      automation.contentType,
      automation.scheduleKind,
      automation.cronExpression,
      automation.triggerConfigJson,
      automation.generationConfigJson,
      automation.enabled,
      automation.approvalRequired,
      automation.nextRunAt,
      brandActor.brandProfileId,
    ],
  ) as unknown as AutomationRow[];
  const row = rows[0];
  if (!row) throw new Error("Automationen kunde inte skapas.");
  return mapAutomation(row);
}

/** Updates an automation, retains unowned config metadata and recalculates its next run. */
export async function updateStudioAutomation(
  actor: AppActor,
  automationId: string,
  patch: ContentAutomationRuleUpdateInput,
  sql: NeonSql = createNeonSql(),
): Promise<ContentAutomationRuleView | null> {
  assertCanWrite(actor);
  const validatedId = contentAutomationRuleIdSchema.parse(automationId);
  const existingRow = await getAutomationRow(actor, validatedId, sql);
  if (!existingRow) return null;

  const existing = mapAutomation(existingRow);
  if (!existing.brandProfileId) throw new SagaBrandScopeError("brand_selection_required", "Skapa en ny automation med ett uttryckligt varumärke. Den äldre automationen är pausad.");
  if (patch.brandProfileId !== undefined && patch.brandProfileId !== existing.brandProfileId) {
    throw new SagaBrandScopeError("brand_not_found", "Automationens varumärke går inte att byta. Skapa en ny automation för ett annat varumärke.");
  }
  const merged = contentAutomationRuleInputSchema.parse({ ...inputFromAutomation(existing), ...patch });
  await assertTemplateInWorkspace(actor, merged.templateId ?? null, sql);
  await assertActiveSagaSeriesReferenceInWorkspace({ ...actor, brandProfileId: existing.brandProfileId }, merged.seriesId ?? null, sql);
  const automation = writeAutomation(
    merged,
    nextAutomationRunAt(merged),
    objectValue(existingRow.trigger_config),
    objectValue(existingRow.generation_config),
  );
  const rows = await sql.query(
    `update studio_automations
        set template_id = $3::uuid,
            name = $4,
            content_type = $5,
            schedule_kind = $6,
            cron_expression = $7,
            trigger_config = $8::jsonb,
            generation_config = $9::jsonb,
            enabled = $10,
            approval_required = $11,
            next_run_at = $12::timestamptz
      where workspace_id = $1::uuid and id = $2::uuid
      returning
        id::text,
        created_by_user_id::text,
        template_id::text,
        name,
        content_type,
        schedule_kind,
        cron_expression,
        trigger_config,
        generation_config, brand_profile_id::text,
        enabled,
        approval_required,
        next_run_at::text,
        last_run_at::text,
        created_at::text,
        updated_at::text`,
    [
      actor.workspaceId,
      validatedId,
      automation.templateId,
      automation.name,
      automation.contentType,
      automation.scheduleKind,
      automation.cronExpression,
      automation.triggerConfigJson,
      automation.generationConfigJson,
      automation.enabled,
      automation.approvalRequired,
      automation.nextRunAt,
    ],
  ) as unknown as AutomationRow[];
  const updated = rows[0];
  if (!updated) return null;
  // Any configuration edit invalidates only still-queued scheduled receipts.
  // Explicit manual runs are never cancelled by changing a schedule.
  await sql.query(
    `update studio_jobs
        set status = 'cancelled',
            completed_at = $3::timestamptz,
            failure_code = 'automation_reconfigured',
            failure_detail = 'Automationen ändrades innan den planerade körningen startade.'
      where workspace_id = $1::uuid
        and automation_id = $2::uuid
        and status = 'queued'
        and coalesce(payload ->> 'triggerKind', 'scheduled') = 'scheduled'`,
    [actor.workspaceId, validatedId, new Date().toISOString()],
  );
  return mapAutomation(updated);
}

/** Deletes an automation only from the actor's workspace. Durable jobs keep the FK protective. */
export async function deleteStudioAutomation(
  actor: AppActor,
  automationId: string,
  sql: NeonSql = createNeonSql(),
): Promise<boolean> {
  assertCanWrite(actor);
  const validatedId = contentAutomationRuleIdSchema.parse(automationId);
  const rows = await sql.query(
    `delete from studio_automations
      where workspace_id = $1::uuid and id = $2::uuid
      returning id::text`,
    [actor.workspaceId, validatedId],
  ) as unknown as Array<{ id: string }>;
  return Boolean(rows[0]);
}

/** Reads run history through the actor's automation and workspace boundary. */
export async function listStudioAutomationJobs(
  actor: AppActor,
  automationId: string,
  options: ListStudioAutomationJobsOptions = {},
  sql: NeonSql = createNeonSql(),
): Promise<ContentAutomationJobView[]> {
  const validatedId = contentAutomationRuleIdSchema.parse(automationId);
  const ruleRow = await getAutomationRow(actor, validatedId, sql);
  if (!ruleRow) return [];
  const rule = mapAutomation(ruleRow);
  const rows = await sql.query(
    `select
       id::text,
       workspace_id::text,
       automation_id::text,
       draft_id::text,
       kind,
       status,
       idempotency_key,
       claim_token::text,
       run_after::text,
       started_at::text,
       completed_at::text,
       lease_expires_at::text,
       locked_by,
       attempts,
       max_attempts,
       payload,
       result,
       failure_code,
       failure_detail,
       created_at::text,
       updated_at::text
     from studio_jobs
     where workspace_id = $1::uuid and automation_id = $2::uuid
     order by run_after desc, created_at desc
     limit $3::int`,
    [actor.workspaceId, validatedId, boundedJobLimit(options.limit)],
  ) as unknown as JobRow[];
  return rows.map((row) => mapAutomationJob(row, rule.userId, rule.timezone));
}

/**
 * Returns the real, durable content-automation activity for one signed
 * workspace. The monitor is deliberately bounded and receives only a draft
 * outcome summary, never draft text, media addresses, prompts, or provider
 * state. This is separate from the dedicated ad-automation scheduler.
 */
export async function getStudioAutomationRunOverview(
  actor: AppActor,
  options: ListStudioAutomationJobsOptions = {},
  sql: NeonSql = createNeonSql(),
): Promise<{ automations: ContentAutomationRuleView[]; runs: ContentAutomationRunView[] }> {
  const automations = await listStudioAutomations(actor, sql);
  const byId = new Map(automations.map((automation) => [automation.id, automation]));
  const rows = await sql.query(
    `select
       job.id::text,
       job.workspace_id::text,
       job.automation_id::text,
       coalesce(job.draft_id, outcome.id)::text as draft_id,
       job.kind,
       job.status,
       job.idempotency_key,
       job.claim_token::text,
       job.run_after::text,
       job.started_at::text,
       job.completed_at::text,
       job.lease_expires_at::text,
       job.locked_by,
       job.attempts,
       job.max_attempts,
       job.payload,
       job.result,
       job.failure_code,
       job.failure_detail,
       job.created_at::text,
       job.updated_at::text,
       outcome.title as outcome_draft_title,
       outcome.status as outcome_draft_status
     from studio_jobs as job
     inner join studio_automations as automation
       on automation.workspace_id = job.workspace_id
      and automation.id = job.automation_id
     left join studio_drafts as outcome
       on outcome.workspace_id = job.workspace_id
      and (outcome.id = job.draft_id or outcome.automation_job_id = job.id)
     where job.workspace_id = $1::uuid
       and job.kind = 'draft_generation'
     order by job.created_at desc, job.run_after desc
     limit $2::int`,
    [actor.workspaceId, boundedJobLimit(options.limit)],
  ) as unknown as AutomationRunOverviewRow[];

  return {
    automations,
    runs: rows.flatMap((row) => {
      const automationId = nullableString(row.automation_id);
      const automation = automationId ? byId.get(automationId) : null;
      return automation ? [mapAutomationRunOverview(row, automation)] : [];
    }),
  };
}

/**
 * Adds one durable manual receipt. Reusing the caller's UUID idempotency key
 * returns that same receipt; the later materializer always creates a private,
 * unscheduled draft for it.
 */
export async function createStudioManualAutomationJob(
  actor: AppActor,
  input: { automationId: string; idempotencyKey: string; now?: Date },
  sql: NeonSql = createNeonSql(),
): Promise<PreparedStudioManualAutomationRun | null> {
  assertCanWrite(actor);
  const automationId = contentAutomationRuleIdSchema.parse(input.automationId);
  const idempotencyKey = contentAutomationManualRunInputSchema.parse({ idempotencyKey: input.idempotencyKey }).idempotencyKey;
  const ruleRow = await getAutomationRow(actor, automationId, sql);
  if (!ruleRow) return null;
  const rule = mapAutomation(ruleRow);
  const now = input.now ?? new Date();
  const local = localDateAndTime(now, rule.timezone);
  const payload = JSON.stringify({
    triggerKind: "manual",
    timezone: rule.timezone,
    scheduledLocalDate: local?.date ?? null,
    scheduledLocalTime: local?.time ?? null,
  });
  const rows = await sql.query(
    `insert into studio_jobs (
       workspace_id, automation_id, kind, status, idempotency_key, run_after, payload
     ) values (
       $1::uuid, $2::uuid, 'draft_generation', 'queued', $3, $4::timestamptz, $5::jsonb
     )
     on conflict (workspace_id, idempotency_key) do nothing
     returning
       id::text,
       workspace_id::text,
       automation_id::text,
       draft_id::text,
       kind,
       status,
       idempotency_key,
       claim_token::text,
       run_after::text,
       started_at::text,
       completed_at::text,
       lease_expires_at::text,
       locked_by,
       attempts,
       max_attempts,
       payload,
       result,
       failure_code,
       failure_detail,
       created_at::text,
       updated_at::text`,
    [actor.workspaceId, automationId, idempotencyKey, now.toISOString(), payload],
  ) as unknown as JobRow[];
  const created = rows[0];
  if (created) {
    return { rule, job: mapAutomationJob(created, rule.userId, rule.timezone), reused: false };
  }

  const existingRows = await sql.query(
    `select
       id::text,
       workspace_id::text,
       automation_id::text,
       draft_id::text,
       kind,
       status,
       idempotency_key,
       claim_token::text,
       run_after::text,
       started_at::text,
       completed_at::text,
       lease_expires_at::text,
       locked_by,
       attempts,
       max_attempts,
       payload,
       result,
       failure_code,
       failure_detail,
       created_at::text,
       updated_at::text
     from studio_jobs
     where workspace_id = $1::uuid
       and automation_id = $2::uuid
       and idempotency_key = $3
     limit 1`,
    [actor.workspaceId, automationId, idempotencyKey],
  ) as unknown as JobRow[];
  const existing = existingRows[0];
  if (!existing) throw new Error("Idempotensnyckeln används redan av en annan automation i arbetsytan.");
  return { rule, job: mapAutomationJob(existing, rule.userId, rule.timezone), reused: true };
}

/**
 * Claims exactly one manual receipt belonging to the current actor and rule.
 * It is safe to call immediately after `createStudioManualAutomationJob`:
 * another browser tab or cron cannot make this route generate an unrelated
 * queued item. Completed, failed and actively leased receipts are left alone.
 */
export async function claimStudioManualAutomationJob(
  actor: AppActor,
  input: ClaimStudioManualAutomationJobOptions,
  sql: NeonSql = createNeonSql(),
): Promise<ClaimedContentAutomationJob | null> {
  assertCanWrite(actor);
  const automationId = contentAutomationRuleIdSchema.parse(input.automationId);
  const idempotencyKey = contentAutomationManualRunInputSchema.parse({ idempotencyKey: input.idempotencyKey }).idempotencyKey;
  const ruleRow = await getAutomationRow(actor, automationId, sql);
  if (!ruleRow) return null;
  const rule = mapAutomation(ruleRow);
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const claimToken = randomUUID();
  const leaseUntil = new Date(now.getTime() + boundedLeaseMs(input.leaseMs)).toISOString();
  const workerId = input.workerId?.trim().slice(0, 160) || "studio-manual";
  const rows = await sql.query(
    `update studio_jobs as claimed
        set status = 'running',
            claim_token = $4::uuid,
            locked_by = $5,
            lease_expires_at = $6::timestamptz,
            started_at = $1::timestamptz,
            attempts = claimed.attempts + 1,
            failure_code = null,
            failure_detail = null
      where claimed.id = (
        select job.id
         from studio_jobs as job
         where job.workspace_id = $2::uuid
           and job.automation_id = $3::uuid
           and job.idempotency_key = $7
           and exists (select 1 from studio_automations rule
             where rule.workspace_id = job.workspace_id and rule.id = job.automation_id
               and saga_daily_knowledge_brand_is_eligible(rule.workspace_id, rule.brand_profile_id))
           and job.kind = 'draft_generation'
           and coalesce(job.payload ->> 'triggerKind', 'scheduled') = 'manual'
           and job.run_after <= $1::timestamptz
           and job.attempts < job.max_attempts
           and (
             job.status = 'queued'
             or (job.status = 'running' and coalesce(job.lease_expires_at, '-infinity'::timestamptz) < $1::timestamptz)
           )
         order by job.created_at asc
         for update skip locked
         limit 1
      )
      returning
        claimed.id::text,
        claimed.workspace_id::text,
        claimed.automation_id::text,
        claimed.draft_id::text,
        claimed.kind,
        claimed.status,
        claimed.idempotency_key,
        claimed.claim_token::text,
        claimed.run_after::text,
        claimed.started_at::text,
        claimed.completed_at::text,
        claimed.lease_expires_at::text,
        claimed.locked_by,
        claimed.attempts,
        claimed.max_attempts,
        claimed.payload,
        claimed.result,
        claimed.failure_code,
        claimed.failure_detail,
        claimed.created_at::text,
        claimed.updated_at::text`,
    [nowIso, actor.workspaceId, automationId, claimToken, workerId, leaseUntil, idempotencyKey],
  ) as unknown as JobRow[];
  const jobRow = rows[0];
  if (!jobRow) return null;
  const templateRow = rule.templateId
    ? await getTemplateRowInWorkspace(actor.workspaceId, rule.templateId, sql)
    : null;
  return {
    ...mapAutomationJob(jobRow, rule.userId, rule.timezone),
    workspaceId: actor.workspaceId,
    claimToken,
    rule,
    template: templateRow ? mapTemplate(templateRow) : null,
  };
}

/**
 * Internal scheduler primitive. It discovers enabled rules across all
 * workspaces and inserts only idempotent draft-generation receipts; it never
 * calls a model, delivers a message, or publishes content.
 */
export async function materializeStudioAutomationJobs(
  options: MaterializeStudioAutomationJobsOptions = {},
  sql: NeonSql = createNeonSql(),
): Promise<StudioJobMaterializationResult> {
  const now = options.now ?? new Date();
  const horizonDays = Math.max(1, Math.min(options.horizonDays ?? DEFAULT_AUTOMATION_HORIZON_DAYS, MAX_AUTOMATION_HORIZON_DAYS));
  const ruleLimit = boundedJobLimit(options.ruleLimit);
  const jobLimit = boundedJobLimit(options.jobLimit);
  const rows = await sql.query(
    `select
       workspace_id::text,
       id::text,
       created_by_user_id::text,
       template_id::text,
       name,
       content_type,
       schedule_kind,
       cron_expression,
       trigger_config,
       generation_config, brand_profile_id::text,
       enabled,
       approval_required,
       next_run_at::text,
       last_run_at::text,
       created_at::text,
       updated_at::text
     from studio_automations
     where enabled = true
       and saga_daily_knowledge_brand_is_eligible(workspace_id, brand_profile_id)
     order by next_run_at asc nulls first, updated_at asc
     limit $1::int`,
    [ruleLimit],
  ) as unknown as ScheduledAutomationRow[];

  let jobsCreated = 0;
  let jobWrites = 0;
  let nextRunsUpdated = 0;
  let rulesScanned = 0;
  for (const row of rows) {
    rulesScanned += 1;
    const rule = mapAutomation(row);
    const configurationVersion = automationConfigurationVersion(row.generation_config);
    const occurrences = upcomingAutomationOccurrences(inputFromAutomation(rule), { now, horizonDays });
    for (const occurrence of occurrences) {
      if (jobWrites >= jobLimit) break;
      jobWrites += 1;
      const payload = JSON.stringify({
        triggerKind: "scheduled",
        // This is a server-written configuration marker. A running job checks
        // it again immediately before final draft materialization so a pause
        // or edit cannot race a slow AI response into a new draft.
        automationConfigurationVersion: configurationVersion,
        timezone: rule.timezone,
        scheduledLocalDate: occurrence.localDate,
        scheduledLocalTime: occurrence.localTime,
      });
      const inserted = await sql.query(
        `insert into studio_jobs (
           workspace_id, automation_id, kind, status, run_after, payload
         ) values (
           $1::uuid, $2::uuid, 'draft_generation', 'queued', $3::timestamptz, $4::jsonb
         )
         on conflict do nothing
         returning id::text`,
        [row.workspace_id, rule.id, occurrence.runAt, payload],
      ) as unknown as Array<{ id: string }>;
      jobsCreated += inserted.length;
    }
    await sql.query(
      `update studio_automations
          set next_run_at = $3::timestamptz
        where workspace_id = $1::uuid and id = $2::uuid`,
      [row.workspace_id, rule.id, occurrences[0]?.runAt ?? null],
    );
    nextRunsUpdated += 1;
    if (jobWrites >= jobLimit) break;
  }

  return { rulesScanned, jobsCreated, nextRunsUpdated };
}

/**
 * Claims a bounded batch atomically with row locks and lease tokens. It has no
 * caller-provided workspace scope: only an authorized server cron may invoke
 * this cross-workspace scheduler primitive.
 */
export async function claimDueStudioAutomationJobs(
  options: ClaimDueStudioAutomationJobsOptions = {},
  sql: NeonSql = createNeonSql(),
): Promise<ClaimedContentAutomationJob[]> {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const limit = boundedJobLimit(options.limit);
  const leaseUntil = new Date(now.getTime() + boundedLeaseMs(options.leaseMs)).toISOString();
  const workerId = options.workerId?.trim().slice(0, 160) || "vercel-cron";
  const claims: ClaimedContentAutomationJob[] = [];

  for (let index = 0; index < limit; index += 1) {
    const claimToken = randomUUID();
    const rows = await sql.query(
      `update studio_jobs as claimed
          set status = 'running',
              claim_token = $2::uuid,
              locked_by = $3,
              lease_expires_at = $4::timestamptz,
              started_at = $1::timestamptz,
              attempts = claimed.attempts + 1,
              failure_code = null,
              failure_detail = null
        where claimed.id = (
          select job.id
          from studio_jobs as job
          inner join studio_automations as rule
            on rule.workspace_id = job.workspace_id and rule.id = job.automation_id
          where job.kind = 'draft_generation'
            and job.run_after <= $1::timestamptz
            and job.attempts < job.max_attempts
            and (
              job.status = 'queued'
              or (job.status = 'running' and coalesce(job.lease_expires_at, '-infinity'::timestamptz) < $1::timestamptz)
            )
            and (rule.enabled = true or coalesce(job.payload ->> 'triggerKind', 'scheduled') = 'manual')
            and saga_daily_knowledge_brand_is_eligible(rule.workspace_id, rule.brand_profile_id)
          order by job.run_after asc, job.created_at asc
          for update of job skip locked
          limit 1
        )
      returning
        claimed.id::text,
        claimed.workspace_id::text,
        claimed.automation_id::text,
        claimed.draft_id::text,
        claimed.kind,
        claimed.status,
        claimed.idempotency_key,
        claimed.claim_token::text,
        claimed.run_after::text,
        claimed.started_at::text,
        claimed.completed_at::text,
        claimed.lease_expires_at::text,
        claimed.locked_by,
        claimed.attempts,
        claimed.max_attempts,
        claimed.payload,
        claimed.result,
        claimed.failure_code,
        claimed.failure_detail,
        claimed.created_at::text,
        claimed.updated_at::text`,
      [nowIso, claimToken, workerId, leaseUntil],
    ) as unknown as JobRow[];
    const jobRow = rows[0];
    if (!jobRow?.automation_id) break;

    const ruleRow = await getAutomationRowInWorkspace(jobRow.workspace_id, jobRow.automation_id, sql);
    const rule = ruleRow ? mapAutomation(ruleRow) : null;
    const isManual = automationJobTriggerKind(objectValue(jobRow.payload)) === "manual";
    if (!rule?.brandProfileId || (!rule.active && !isManual)) {
      await sql.query(
        `update studio_jobs
            set status = 'cancelled',
                completed_at = $3::timestamptz,
                lease_expires_at = null,
                locked_by = null,
                claim_token = null,
                failure_code = 'automation_inactive',
                failure_detail = 'Automationen var pausad när jobbet skulle köras.'
          where id = $1::uuid and status = 'running' and claim_token = $2::uuid
            and lease_expires_at > clock_timestamp()`,
        [jobRow.id, claimToken, nowIso],
      );
      continue;
    }

    const templateRow = rule.templateId
      ? await getTemplateRowInWorkspace(jobRow.workspace_id, rule.templateId, sql)
      : null;
    claims.push({
      ...mapAutomationJob(jobRow, rule.userId, rule.timezone),
      workspaceId: jobRow.workspace_id,
      claimToken,
      rule,
      template: templateRow ? mapTemplate(templateRow) : null,
    });
  }
  return claims;
}

/**
 * Persists caller-supplied generation output for one leased receipt. The
 * `(workspace_id, automation_job_id)` database key makes this exact-once even
 * if a worker dies after the draft insert and another worker later reclaims.
 */
export async function materializeClaimedStudioAutomationDraft(
  input: { jobId: string; claimToken: string; content: StudioAutomationDraftPayload; now?: Date },
  sql: NeonSql = createNeonSql(),
): Promise<ContentDraftView | null> {
  const jobId = contentDraftIdSchema.parse(input.jobId);
  const claimToken = contentDraftIdSchema.parse(input.claimToken);
  const claimed = await resolveClaimedAutomationJob(jobId, claimToken, sql);
  if (!claimed) return null;

  let draftRow = await getDraftRowForAutomationJob(claimed.workspaceId, jobId, sql);
  if (!draftRow) {
    const draftInput = draftInputForClaimedAutomationJob({
      job: claimed,
      rule: claimed.rule,
      template: claimed.template,
      content: input.content,
    });
    const draft = writeValues(draftInput);
    const metadata = JSON.stringify({
      ...objectValue(draft.metadataJson),
      automationJobId: jobId,
      ...(input.content.quality ? { sagaProductionQuality: input.content.quality } : {}),
      ...(input.content.qualityContext ? { sagaProductionQualityContext: input.content.qualityContext } : {}),
    });
    // Hold the receipt row only for this INSERT, never during generation.
    // Reclaim cannot interleave with persistence; evaluate the real database
    // clock after the MATERIALIZED CTE has acquired the row lock.
    const rows = await sql.query(
      `with current_lease as materialized (
         select workspace_id, automation_id, lease_expires_at
           from studio_jobs
          where id = $4::uuid and status = 'running' and claim_token = $17::uuid
          for update
       )
       insert into studio_drafts (
         workspace_id, author_user_id, template_id, automation_job_id,
         content_type, status, title, body, excerpt,
         publication_channels, metadata, scheduled_at, brand_profile_id
       ) select
         $1::uuid, $2::uuid, $3::uuid, $4::uuid,
         $5, $6, $7, $8, $9,
         $10::jsonb, $11::jsonb, $12::timestamptz, $16::uuid
       where exists (
            select 1
              from studio_automations as current_rule
             where current_rule.workspace_id = $1::uuid
               and current_rule.id = $15::uuid
               and current_rule.brand_profile_id = $16::uuid
               and saga_daily_knowledge_brand_is_eligible(current_rule.workspace_id, current_rule.brand_profile_id)
               and exists (select 1 from current_lease current_job
                 where current_job.workspace_id = current_rule.workspace_id and current_job.automation_id = current_rule.id
                   and current_job.lease_expires_at > clock_timestamp())
               and ($14::boolean or (current_rule.enabled = true
                 and ($13::text is null or current_rule.generation_config ->> 'automationConfigurationVersion' = $13::text)))
          )
       on conflict (workspace_id, automation_job_id)
         where automation_job_id is not null
         do nothing
       returning
         id::text,
         author_user_id::text,
         brand_profile_id::text,
         template_id::text,
         automation_job_id::text,
         content_type,
         status,
         title,
         body,
         excerpt,
         publication_channels,
         metadata,
         revision,
         scheduled_at::text,
         published_at::text,
         created_at::text,
         updated_at::text`,
      [
        claimed.workspaceId,
        claimed.rule.userId,
        draft.templateId,
        jobId,
        draft.contentType,
        draft.status,
        draft.title,
        draft.body,
        draft.excerpt,
        draft.channelsJson,
        metadata,
        draft.scheduledAt,
        claimed.finalization.expectedAutomationConfigurationVersion,
        claimed.finalization.manual,
        claimed.automationRuleId,
        claimed.rule.brandProfileId,
        claimToken,
      ],
    ) as unknown as DraftRow[];
    draftRow = rows[0] ?? await getDraftRowForAutomationJob(claimed.workspaceId, jobId, sql);
  }
  if (!draftRow) {
    if (!claimed.finalization.manual) {
      // The INSERT condition above is the last authority, not a best-effort
      // preflight. It closes the pause/edit race while a model response is in
      // flight, then leaves a durable cancellation receipt instead of writing
      // an old rule's draft.
      await sql.query(
        `update studio_jobs
            set status = 'cancelled',
                completed_at = $3::timestamptz,
                lease_expires_at = null,
                locked_by = null,
                claim_token = null,
                failure_code = 'automation_reconfigured',
                failure_detail = 'Automationen pausades eller ändrades innan det pågående jobbet fick skapa sitt utkast.'
          where id = $1::uuid
            and workspace_id = $4::uuid
            and status = 'running'
            and claim_token = $2::uuid
            and lease_expires_at > clock_timestamp()`,
        [jobId, claimToken, (input.now ?? new Date()).toISOString(), claimed.workspaceId],
      );
      return null;
    }
    // Expiry may happen after the first read, while waiting for the final
    // receipt row lock. A lost lease is not a new generation failure.
    if (!await getClaimedJobRow(jobId, claimToken, sql)) return null;
    throw new Error("Automationsutkastet kunde inte sparas.");
  }

  await sql.query(
    `update studio_jobs
        set draft_id = $3::uuid
      where id = $1::uuid and status = 'running' and claim_token = $2::uuid
        and lease_expires_at > clock_timestamp()`,
    [jobId, claimToken, draftRow.id],
  );
  await completeStudioAutomationJob({
    jobId,
    claimToken,
    now: input.now,
    result: { draftId: draftRow.id },
  }, sql);
  return mapDraft(draftRow);
}

/** Completes only a still-live lease owned by this worker, using the database clock. */
export async function completeStudioAutomationJob(
  input: { jobId: string; claimToken: string; result?: Record<string, unknown>; now?: Date },
  sql: NeonSql = createNeonSql(),
): Promise<boolean> {
  const jobId = contentDraftIdSchema.parse(input.jobId);
  const claimToken = contentDraftIdSchema.parse(input.claimToken);
  const at = (input.now ?? new Date()).toISOString();
  const rows = await sql.query(
    `update studio_jobs
        set status = 'completed',
            completed_at = $3::timestamptz,
            lease_expires_at = null,
            locked_by = null,
            claim_token = null,
            failure_code = null,
            failure_detail = null,
            result = result || $4::jsonb
      where id = $1::uuid and status = 'running' and claim_token = $2::uuid
        and lease_expires_at > clock_timestamp()
      returning workspace_id::text, automation_id::text`,
    [jobId, claimToken, at, JSON.stringify(input.result ?? {})],
  ) as unknown as Array<{ workspace_id: string; automation_id: string | null }>;
  const row = rows[0];
  if (!row?.automation_id) return false;
  await recordAutomationRun(row.workspace_id, row.automation_id, at, sql);
  return true;
}

/**
 * Stores a bounded worker failure and either releases the job for one later
 * retry or marks it terminal after its max-attempt budget is exhausted.
 */
export async function failStudioAutomationJob(
  input: {
    jobId: string;
    claimToken: string;
    errorMessage: string;
    errorCode?: string;
    retry?: boolean;
    retryAfterMs?: number;
    now?: Date;
  },
  sql: NeonSql = createNeonSql(),
): Promise<boolean> {
  const jobId = contentDraftIdSchema.parse(input.jobId);
  const claimToken = contentDraftIdSchema.parse(input.claimToken);
  const now = input.now ?? new Date();
  const at = now.toISOString();
  const retryAfterMs = Math.max(MIN_JOB_LEASE_MS, Math.min(input.retryAfterMs ?? MIN_JOB_LEASE_MS, MAX_JOB_LEASE_MS));
  const retryAt = new Date(now.getTime() + retryAfterMs).toISOString();
  const rows = await sql.query(
    `update studio_jobs
        set status = case when $4::boolean and attempts < max_attempts then 'queued' else 'failed' end,
            run_after = case when $4::boolean and attempts < max_attempts then $5::timestamptz else run_after end,
            completed_at = case when $4::boolean and attempts < max_attempts then null else $3::timestamptz end,
            lease_expires_at = null,
            locked_by = null,
            claim_token = null,
            failure_code = $6,
            failure_detail = $7
      where id = $1::uuid and status = 'running' and claim_token = $2::uuid
        and lease_expires_at > clock_timestamp()
      returning workspace_id::text, automation_id::text`,
    [
      jobId,
      claimToken,
      at,
      input.retry ?? false,
      retryAt,
      (input.errorCode ?? "automation_worker_failed").slice(0, 120),
      input.errorMessage.slice(0, 4_000),
    ],
  ) as unknown as Array<{ workspace_id: string; automation_id: string | null }>;
  const row = rows[0];
  if (!row?.automation_id) return false;
  await recordAutomationRun(row.workspace_id, row.automation_id, at, sql);
  return true;
}

/** Returns scheduled drafts as ContentDraftView records for a bounded local calendar range. */
export async function listStudioCalendarDrafts(
  actor: AppActor,
  input: { from: string; to: string; timezone?: string },
  sql: NeonSql = createNeonSql(),
): Promise<ContentDraftView[]> {
  const query = contentCalendarQuerySchema.parse(input);
  const timezone = query.timezone ?? "Europe/Stockholm";
  const rangeDays = calendarDays(query.from, query.to);
  if (!Number.isFinite(rangeDays) || rangeDays < 0 || rangeDays > MAX_CALENDAR_RANGE_DAYS) {
    throw new Error(`Kalenderintervallet måste vara mellan 0 och ${MAX_CALENDAR_RANGE_DAYS} dagar.`);
  }

  const rows = await sql.query(
    `select
       id::text,
       author_user_id::text,
       brand_profile_id::text,
       template_id::text,
       automation_job_id::text,
       content_type,
       status,
       title,
       body,
       excerpt,
       publication_channels,
       metadata,
       revision,
       scheduled_at::text,
       published_at::text,
       created_at::text,
       updated_at::text
     from studio_drafts
     where workspace_id = $1::uuid
       and scheduled_at >= ($2::date::timestamp at time zone $4::text)
       and scheduled_at < (($3::date + interval '1 day')::timestamp at time zone $4::text)
     order by scheduled_at asc`,
    [actor.workspaceId, query.from, query.to, timezone],
  ) as unknown as DraftRow[];
  return rows.map((row) => mapDraft(row));
}

/** Calendar entries are built from the same draft view returned to the editor. */
export async function getStudioContentCalendar(
  actor: AppActor,
  input: { from: string; to: string; timezone?: string },
  sql: NeonSql = createNeonSql(),
): Promise<ContentCalendarView> {
  const query = contentCalendarQuerySchema.parse(input);
  const timezone = query.timezone ?? await getStudioWorkspaceTimezone(actor, sql);
  const drafts = await listStudioCalendarDrafts(actor, { ...query, timezone }, sql);
  const planSlots = await listSagaQuarterlyActivityPlanCalendarSlots(actor, { from: query.from, to: query.to, timezone }, sql);
  const mediaRows = await listMediaRowsForDrafts(actor, drafts.map((draft) => draft.id), sql);
  const mediaByDraftId = new Map<string, ContentMediaAttachmentView[]>();
  for (const row of mediaRows) {
    const media = mediaByDraftId.get(row.draft_id) ?? [];
    media.push(mapMedia(row));
    mediaByDraftId.set(row.draft_id, media);
  }
  const scheduledEntries: ContentCalendarEntry[] = drafts
    .filter((draft) => Boolean(draft.scheduledAt))
    .map((draft) => {
      const startsAt = draft.scheduledAt as string;
      const placement = localDateTimeInTimezone(startsAt, timezone);
      const original = localDateTimeInTimezone(startsAt, draft.timezone);
      const media = mediaByDraftId.get(draft.id) ?? [];
      const hero = media.find((item) => item.kind === "image" && item.processingStatus === "ready" && item.assetUrl);
      return {
        id: `draft:${draft.id}`,
        kind: "draft",
        title: draft.title || draft.headline || "Namnlöst utkast",
        status: draft.status,
        channels: draft.channels,
        contentType: draft.contentType,
        startsAt,
        localDate: placement?.date ?? draft.scheduledLocalDate ?? "",
        localTime: placement?.time ?? draft.scheduledLocalTime ?? "",
        scheduledLocalDate: draft.scheduledLocalDate ?? original?.date ?? "",
        scheduledLocalTime: draft.scheduledLocalTime ?? original?.time ?? "",
        timezone: draft.timezone,
        draftId: draft.id,
        automationRuleId: draft.automationRuleId,
        automationJobId: draft.automationJobId,
        approvalRequired: draft.approvalRequired,
        revision: draft.revision,
        // A private, server-owned ad brief may be visible for audit if
        // historical data already has a schedule. It is still readable and
        // linked to its exact draft, but must never be presented as movable.
        editable: canMoveCalendarDraft(draft.status) && !draft.deliveryLocked,
        excerpt: draft.excerpt,
        thumbnail: hero?.assetUrl ? {
          assetUrl: hero.assetUrl,
          altText: (hero.altText ?? draft.title) || "Bild till kalenderpost",
        } : null,
      };
    });
  const planEntries: ContentCalendarEntry[] = planSlots.map((slot) => {
    const placement = localDateTimeInTimezone(slot.startsAt, timezone);
    return {
      id: slot.id,
      kind: "plan_slot",
      title: slot.title,
      status: "planned_activity",
      channels: [slot.channel],
      contentType: slot.contentType,
      startsAt: slot.startsAt,
      localDate: placement?.date ?? slot.plannedLocalDate,
      localTime: placement?.time ?? slot.plannedLocalTime,
      plannedLocalDate: slot.plannedLocalDate,
      plannedLocalTime: slot.plannedLocalTime,
      timezone: slot.timezone,
      draftId: slot.draftId,
      automationRuleId: null,
      automationJobId: null,
      approvalRequired: true,
      revision: null,
      editable: false,
      excerpt: null,
      thumbnail: null,
      calendarLabel: "Planerad aktivitet",
    };
  });
  const entries = [...scheduledEntries, ...planEntries]
    .sort((left, right) => left.startsAt.localeCompare(right.startsAt) || left.id.localeCompare(right.id));
  return { from: query.from, to: query.to, timezone, entries };
}
