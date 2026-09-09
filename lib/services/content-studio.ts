import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CONTENT_AUTOMATION_JOB_STATES,
  CONTENT_AUTOMATION_JOB_TRIGGER_KINDS,
  CONTENT_DRAFT_STATUSES,
  CONTENT_CHANNELS,
  contentAutomationManualRunInputSchema,
  contentAutomationRuleInputSchema,
  contentDraftInputSchema,
  contentMediaAttachmentCreateSchema,
  contentTemplateInputSchema,
  newsletterAudienceInputSchema,
  type ClaimedContentAutomationJob,
  type ContentAutomationJobState,
  type ContentAutomationJobTriggerKind,
  type ContentAutomationJobView,
  type ContentAutomationRuleInput,
  type ContentAutomationRuleUpdateInput,
  type ContentAutomationRuleView,
  type ContentCalendarEntry,
  type ContentCalendarView,
  type ContentChannel,
  type ContentDraftInput,
  type ContentDraftStatus,
  type ContentDraftUpdateInput,
  type ContentDraftView,
  type ContentMediaAttachmentCreateInput,
  type ContentMediaAttachmentUpdateInput,
  type ContentMediaAttachmentView,
  type ContentTemplateInput,
  type ContentTemplateUpdateInput,
  type ContentTemplateView,
  type ContentType,
  type NewsletterAudienceInput,
  type NewsletterAudienceUpdateInput,
  type NewsletterAudienceView,
} from "@/lib/domain/content-studio";
import { isValidIanaTimezone, localDateInTimezone } from "@/lib/utils/date";

type DatabaseClient = SupabaseClient;
type RawRecord = Record<string, unknown>;

const MAX_CALENDAR_RANGE_DAYS = 120;
const DEFAULT_AUTOMATION_HORIZON_DAYS = 42;
const MAX_AUTOMATION_HORIZON_DAYS = 90;
const AUTOMATION_CLAIM_LEASE_MS = 12 * 60 * 1_000;

function databaseError(context: string, error: { message?: string } | null): Error {
  return new Error(`${context}${error?.message ? `: ${error.message}` : ""}`);
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function channels(value: unknown): ContentChannel[] {
  return strings(value).filter((channel): channel is ContentChannel => (CONTENT_CHANNELS as readonly string[]).includes(channel));
}

function asDraftStatus(value: unknown): ContentDraftStatus {
  return (CONTENT_DRAFT_STATUSES as readonly string[]).includes(String(value))
    ? value as ContentDraftStatus
    : "draft";
}

function asJobState(value: unknown): ContentAutomationJobState {
  return (CONTENT_AUTOMATION_JOB_STATES as readonly string[]).includes(String(value))
    ? value as ContentAutomationJobState
    : "queued";
}

function asJobTriggerKind(value: unknown): ContentAutomationJobTriggerKind {
  return (CONTENT_AUTOMATION_JOB_TRIGGER_KINDS as readonly string[]).includes(String(value))
    ? value as ContentAutomationJobTriggerKind
    : "scheduled";
}

function asContentType(value: unknown): ContentType {
  return value === "newsletter" || value === "article" ? value : "social_post";
}

function normalizeTime(value: unknown): string | null {
  const raw = nullableString(value);
  return raw && /^([01]\d|2[0-3]):[0-5]\d/.test(raw) ? raw.slice(0, 5) : null;
}

function mapMedia(row: RawRecord): ContentMediaAttachmentView {
  const kind = row.kind === "video" || row.kind === "document" ? row.kind : "image";
  const source = row.source === "generated" || row.source === "library" || row.source === "external" ? row.source : "upload";
  const processingStatus = row.processing_status === "processing" || row.processing_status === "ready" || row.processing_status === "failed"
    ? row.processing_status
    : "original";
  return {
    id: stringValue(row.id),
    contentDraftId: stringValue(row.content_draft_id),
    kind,
    source,
    storagePath: nullableString(row.storage_path),
    assetUrl: nullableString(row.asset_url),
    filename: nullableString(row.filename),
    mimeType: nullableString(row.mime_type),
    byteSize: nullableNumber(row.byte_size),
    altText: nullableString(row.alt_text),
    caption: nullableString(row.caption),
    processingStatus,
    adaptationPrompt: nullableString(row.adaptation_prompt),
    variants: objectValue(row.variants),
    sortOrder: numberValue(row.sort_order),
    createdAt: stringValue(row.created_at),
    updatedAt: stringValue(row.updated_at),
  };
}

function mapDraft(row: RawRecord, media: ContentMediaAttachmentView[] = []): ContentDraftView {
  return {
    id: stringValue(row.id),
    userId: stringValue(row.user_id),
    revision: Math.max(1, numberValue(row.revision, 1)),
    contentType: asContentType(row.content_type),
    channels: channels(row.channels),
    title: stringValue(row.title),
    headline: nullableString(row.headline),
    subject: nullableString(row.subject),
    body: stringValue(row.body),
    cta: nullableString(row.cta),
    excerpt: nullableString(row.excerpt),
    hashtags: strings(row.hashtags),
    status: asDraftStatus(row.status),
    generationPrompt: nullableString(row.generation_prompt),
    imagePrompt: nullableString(row.image_prompt),
    language: stringValue(row.language, "sv"),
    timezone: stringValue(row.timezone, "Europe/Stockholm"),
    scheduledAt: nullableString(row.scheduled_at),
    scheduledLocalDate: nullableString(row.scheduled_local_date),
    scheduledLocalTime: normalizeTime(row.scheduled_local_time),
    approvalRequired: Boolean(row.approval_required),
    deliveryLocked: false,
    privateBrief: false,
    approvedAt: nullableString(row.approved_at),
    publishedAt: nullableString(row.published_at),
    templateId: nullableString(row.template_id),
    automationRuleId: nullableString(row.automation_rule_id),
    automationJobId: nullableString(row.automation_job_id),
    newsletterAudienceId: nullableString(row.newsletter_audience_id),
    media,
    createdAt: stringValue(row.created_at),
    updatedAt: stringValue(row.updated_at),
  };
}

function mapTemplate(row: RawRecord): ContentTemplateView {
  return {
    id: stringValue(row.id),
    userId: nullableString(row.user_id),
    isSystemTemplate: Boolean(row.is_system_template),
    slug: stringValue(row.slug),
    name: stringValue(row.name),
    description: stringValue(row.description),
    contentType: asContentType(row.content_type),
    channels: channels(row.channels),
    defaultTitle: stringValue(row.default_title),
    defaultHeadline: nullableString(row.default_headline),
    defaultSubject: nullableString(row.default_subject),
    defaultBody: stringValue(row.default_body),
    defaultCta: nullableString(row.default_cta),
    defaultExcerpt: nullableString(row.default_excerpt),
    defaultHashtags: strings(row.default_hashtags),
    generationPrompt: stringValue(row.generation_prompt),
    imagePrompt: stringValue(row.image_prompt),
    defaultLanguage: stringValue(row.default_language, "sv"),
    active: Boolean(row.active),
    createdAt: stringValue(row.created_at),
    updatedAt: stringValue(row.updated_at),
  };
}

function mapRule(row: RawRecord): ContentAutomationRuleView {
  const scheduleMode = row.schedule_mode === "cron" ? "cron" : "weekly_count";
  return {
    id: stringValue(row.id),
    userId: stringValue(row.user_id),
    name: stringValue(row.name),
    active: Boolean(row.active),
    contentType: asContentType(row.content_type),
    channels: channels(row.channels),
    templateId: nullableString(row.template_id),
    newsletterAudienceId: nullableString(row.newsletter_audience_id),
    generationPrompt: stringValue(row.generation_prompt),
    imagePrompt: stringValue(row.image_prompt),
    desiredLength: nullableNumber(row.desired_length),
    tone: nullableString(row.tone),
    language: stringValue(row.language, "sv"),
    approvalRequired: Boolean(row.approval_required),
    timezone: stringValue(row.timezone, "Europe/Stockholm"),
    scheduleMode,
    weeklyCount: nullableNumber(row.weekly_count),
    weekdays: Array.isArray(row.weekdays)
      ? row.weekdays.filter((weekday): weekday is number => typeof weekday === "number" && weekday >= 0 && weekday <= 6)
      : [],
    localTimes: Array.isArray(row.local_times)
      ? row.local_times.map(normalizeTime).filter((time): time is string => Boolean(time))
      : ["09:00"],
    cronExpression: nullableString(row.cron_expression),
    startsOn: nullableString(row.starts_on),
    endsOn: nullableString(row.ends_on),
    nextRunAt: nullableString(row.next_run_at),
    lastRunAt: nullableString(row.last_run_at),
    createdAt: stringValue(row.created_at),
    updatedAt: stringValue(row.updated_at),
  };
}

function mapJob(row: RawRecord): ContentAutomationJobView {
  return {
    id: stringValue(row.id),
    userId: stringValue(row.user_id),
    automationRuleId: stringValue(row.automation_rule_id),
    contentDraftId: nullableString(row.content_draft_id),
    triggerKind: asJobTriggerKind(row.trigger_kind),
    manualRunKey: nullableString(row.manual_run_key),
    state: asJobState(row.state),
    scheduledFor: stringValue(row.scheduled_for),
    timezone: stringValue(row.timezone, "Europe/Stockholm"),
    scheduledLocalDate: stringValue(row.scheduled_local_date),
    scheduledLocalTime: normalizeTime(row.scheduled_local_time) ?? "00:00",
    attemptCount: numberValue(row.attempt_count),
    lockedUntil: nullableString(row.locked_until),
    claimedAt: nullableString(row.claimed_at),
    completedAt: nullableString(row.completed_at),
    lastError: nullableString(row.last_error),
    createdAt: stringValue(row.created_at),
    updatedAt: stringValue(row.updated_at),
  };
}

function mapAudience(row: RawRecord): NewsletterAudienceView {
  return {
    id: stringValue(row.id),
    userId: stringValue(row.user_id),
    name: stringValue(row.name),
    description: stringValue(row.description),
    senderName: nullableString(row.sender_name),
    senderEmail: nullableString(row.sender_email),
    replyToEmail: nullableString(row.reply_to_email),
    audienceMetadata: objectValue(row.audience_metadata),
    active: Boolean(row.active),
    createdAt: stringValue(row.created_at),
    updatedAt: stringValue(row.updated_at),
  };
}

function draftRow(userId: string, value: ContentDraftInput, automationJobId?: string | null) {
  return {
    user_id: userId,
    content_type: value.contentType,
    channels: value.channels,
    title: value.title,
    headline: value.headline ?? null,
    subject: value.subject ?? null,
    body: value.body,
    cta: value.cta ?? null,
    excerpt: value.excerpt ?? null,
    hashtags: value.hashtags,
    status: value.status,
    generation_prompt: value.generationPrompt ?? null,
    image_prompt: value.imagePrompt ?? null,
    language: value.language,
    timezone: value.timezone,
    scheduled_at: value.scheduledAt ?? null,
    scheduled_local_date: value.scheduledLocalDate ?? null,
    scheduled_local_time: value.scheduledLocalTime ?? null,
    approval_required: value.approvalRequired,
    template_id: value.templateId ?? null,
    automation_rule_id: value.automationRuleId ?? null,
    ...(automationJobId === undefined ? {} : { automation_job_id: automationJobId }),
    newsletter_audience_id: value.newsletterAudienceId ?? null,
  };
}

function mediaRow(userId: string, draftId: string, value: ContentMediaAttachmentCreateInput) {
  return {
    user_id: userId,
    content_draft_id: draftId,
    kind: value.kind,
    source: value.source,
    storage_path: value.storagePath ?? null,
    asset_url: value.assetUrl ?? null,
    filename: value.filename ?? null,
    mime_type: value.mimeType ?? null,
    byte_size: value.byteSize ?? null,
    alt_text: value.altText ?? null,
    caption: value.caption ?? null,
    processing_status: value.processingStatus,
    adaptation_prompt: value.adaptationPrompt ?? null,
    variants: value.variants,
    sort_order: value.sortOrder,
  };
}

function templateRow(userId: string, slug: string, value: ContentTemplateInput) {
  return {
    user_id: userId,
    is_system_template: false,
    slug,
    name: value.name,
    description: value.description,
    content_type: value.contentType,
    channels: value.channels,
    default_title: value.defaultTitle,
    default_headline: value.defaultHeadline ?? null,
    default_subject: value.defaultSubject ?? null,
    default_body: value.defaultBody,
    default_cta: value.defaultCta ?? null,
    default_excerpt: value.defaultExcerpt ?? null,
    default_hashtags: value.defaultHashtags,
    generation_prompt: value.generationPrompt,
    image_prompt: value.imagePrompt,
    default_language: value.defaultLanguage,
    active: value.active,
  };
}

function ruleRow(userId: string, value: ContentAutomationRuleInput, nextRunAt: string | null = null) {
  return {
    user_id: userId,
    name: value.name,
    active: value.active,
    content_type: value.contentType,
    channels: value.channels,
    template_id: value.templateId ?? null,
    newsletter_audience_id: value.newsletterAudienceId ?? null,
    generation_prompt: value.generationPrompt,
    image_prompt: value.imagePrompt,
    desired_length: value.desiredLength ?? null,
    tone: value.tone ?? null,
    language: value.language,
    approval_required: value.approvalRequired,
    timezone: value.timezone,
    schedule_mode: value.scheduleMode,
    weekly_count: value.scheduleMode === "weekly_count" ? value.weeklyCount : null,
    weekdays: value.scheduleMode === "weekly_count" ? value.weekdays : [],
    local_times: value.localTimes,
    cron_expression: value.scheduleMode === "cron" ? value.cronExpression : null,
    starts_on: value.startsOn ?? null,
    ends_on: value.endsOn ?? null,
    next_run_at: nextRunAt,
  };
}

function audienceRow(userId: string, value: NewsletterAudienceInput) {
  return {
    user_id: userId,
    name: value.name,
    description: value.description,
    sender_name: value.senderName ?? null,
    sender_email: value.senderEmail ?? null,
    reply_to_email: value.replyToEmail ?? null,
    audience_metadata: value.audienceMetadata,
    active: value.active,
  };
}

function draftAsInput(draft: ContentDraftView): ContentDraftInput {
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

function templateAsInput(template: ContentTemplateView): ContentTemplateInput {
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

function ruleAsInput(rule: ContentAutomationRuleView): ContentAutomationRuleInput {
  return {
    name: rule.name,
    active: rule.active,
    contentType: rule.contentType,
    channels: rule.channels,
    templateId: rule.templateId,
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

function audienceAsInput(audience: NewsletterAudienceView): NewsletterAudienceInput {
  return {
    name: audience.name,
    description: audience.description,
    senderName: audience.senderName,
    senderEmail: audience.senderEmail,
    replyToEmail: audience.replyToEmail,
    audienceMetadata: audience.audienceMetadata,
    active: audience.active,
  };
}

/** Read a draft through the single ownership seam used by UI, publisher and newsletters. */
export async function getContentDraftForUser(
  client: DatabaseClient,
  userId: string,
  contentDraftId: string,
): Promise<ContentDraftView | null> {
  const { data, error } = await client
    .from("content_drafts")
    .select("*")
    .eq("id", contentDraftId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw databaseError("Kunde inte läsa utkastet", error);
  if (!data) return null;
  const media = await listContentMediaForDraft(client, userId, contentDraftId);
  return mapDraft(data as RawRecord, media);
}

export async function listContentDrafts(
  client: DatabaseClient,
  userId: string,
  options: { includeMedia?: boolean; limit?: number; statuses?: ContentDraftStatus[] } = {},
): Promise<ContentDraftView[]> {
  const limit = Math.max(1, Math.min(options.limit ?? 100, 250));
  let query = client
    .from("content_drafts")
    .select("*")
    .eq("user_id", userId)
    .order("scheduled_at", { ascending: true, nullsFirst: false })
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (options.statuses?.length) query = query.in("status", options.statuses);
  const { data, error } = await query;
  if (error) throw databaseError("Kunde inte läsa utkasten", error);
  const rows = (data ?? []).map((row) => row as RawRecord);
  const mediaByDraft = options.includeMedia ? await listContentMediaForDrafts(client, userId, rows.map((row) => stringValue(row.id))) : new Map<string, ContentMediaAttachmentView[]>();
  return rows.map((row) => mapDraft(row, mediaByDraft.get(stringValue(row.id)) ?? []));
}

export async function createContentDraft(
  client: DatabaseClient,
  userId: string,
  input: ContentDraftInput,
): Promise<ContentDraftView> {
  const payload = contentDraftInputSchema.parse(input);
  if (payload.approvalRequired && payload.status === "scheduled") {
    throw new Error("Godkänn utkastet innan det schemaläggs, eller stäng av krav på godkännande.");
  }
  const { data, error } = await client
    .from("content_drafts")
    .insert(draftRow(userId, payload))
    .select("id")
    .single();
  if (error || !data) throw databaseError("Kunde inte skapa utkastet", error);
  const draft = await getContentDraftForUser(client, userId, String((data as RawRecord).id));
  if (!draft) throw new Error("Utkastet kunde inte läsas efter att det skapats.");
  return draft;
}

export async function updateContentDraft(
  client: DatabaseClient,
  userId: string,
  contentDraftId: string,
  patch: ContentDraftUpdateInput,
): Promise<ContentDraftView | null> {
  const existing = await getContentDraftForUser(client, userId, contentDraftId);
  if (!existing) return null;
  if (!["draft", "in_review", "approved", "scheduled", "failed", "cancelled"].includes(existing.status)) {
    throw new Error("Ett utkast som publiceras eller har publicerats kan inte redigeras här.");
  }
  const merged = contentDraftInputSchema.parse({ ...draftAsInput(existing), ...patch });
  if (merged.approvalRequired && merged.status === "scheduled" && !existing.approvedAt) {
    throw new Error("Godkänn utkastet innan det schemaläggs, eller stäng av krav på godkännande.");
  }
  const { error } = await client
    .from("content_drafts")
    .update(draftRow(userId, merged))
    .eq("id", contentDraftId)
    .eq("user_id", userId);
  if (error) throw databaseError("Kunde inte uppdatera utkastet", error);
  return getContentDraftForUser(client, userId, contentDraftId);
}

export async function deleteContentDraft(client: DatabaseClient, userId: string, contentDraftId: string): Promise<boolean> {
  const { data, error } = await client
    .from("content_drafts")
    .delete()
    .eq("id", contentDraftId)
    .eq("user_id", userId)
    .select("id")
    .maybeSingle();
  if (error) throw databaseError("Kunde inte ta bort utkastet", error);
  return Boolean(data);
}

export async function listContentMediaForDraft(
  client: DatabaseClient,
  userId: string,
  contentDraftId: string,
): Promise<ContentMediaAttachmentView[]> {
  const { data, error } = await client
    .from("content_media_attachments")
    .select("*")
    .eq("user_id", userId)
    .eq("content_draft_id", contentDraftId)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw databaseError("Kunde inte läsa bild- och mediefilerna", error);
  return withContentMediaPreviewUrls(client, (data ?? []).map((row) => mapMedia(row as RawRecord)));
}

async function listContentMediaForDrafts(
  client: DatabaseClient,
  userId: string,
  contentDraftIds: string[],
): Promise<Map<string, ContentMediaAttachmentView[]>> {
  const result = new Map<string, ContentMediaAttachmentView[]>();
  if (!contentDraftIds.length) return result;
  const { data, error } = await client
    .from("content_media_attachments")
    .select("*")
    .eq("user_id", userId)
    .in("content_draft_id", contentDraftIds)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw databaseError("Kunde inte läsa bild- och mediefilerna", error);
  const hydrated = await withContentMediaPreviewUrls(client, (data ?? []).map((raw) => mapMedia(raw as RawRecord)));
  for (const media of hydrated) {
    result.set(media.contentDraftId, [...(result.get(media.contentDraftId) ?? []), media]);
  }
  return result;
}

export async function createContentMediaAttachment(
  client: DatabaseClient,
  userId: string,
  contentDraftId: string,
  input: ContentMediaAttachmentCreateInput,
): Promise<ContentMediaAttachmentView> {
  const draft = await getContentDraftForUser(client, userId, contentDraftId);
  if (!draft) throw new Error("Utkastet hittades inte.");
  const payload = contentMediaAttachmentCreateSchema.parse(input);
  const { data, error } = await client
    .from("content_media_attachments")
    .insert(mediaRow(userId, contentDraftId, payload))
    .select("*")
    .single();
  if (error || !data) throw databaseError("Kunde inte spara mediefilen", error);
  return withContentMediaPreviewUrl(client, mapMedia(data as RawRecord));
}

export async function updateContentMediaAttachment(
  client: DatabaseClient,
  userId: string,
  contentDraftId: string,
  mediaId: string,
  patch: ContentMediaAttachmentUpdateInput,
): Promise<ContentMediaAttachmentView | null> {
  const { data: existing, error: existingError } = await client
    .from("content_media_attachments")
    .select("*")
    .eq("id", mediaId)
    .eq("user_id", userId)
    .eq("content_draft_id", contentDraftId)
    .maybeSingle();
  if (existingError) throw databaseError("Kunde inte läsa mediefilen", existingError);
  if (!existing) return null;
  const current = mapMedia(existing as RawRecord);
  const payload = contentMediaAttachmentCreateSchema.parse({
    kind: current.kind,
    source: current.source,
    storagePath: current.storagePath,
    assetUrl: current.assetUrl,
    filename: current.filename,
    mimeType: current.mimeType,
    byteSize: current.byteSize,
    altText: current.altText,
    caption: current.caption,
    processingStatus: current.processingStatus,
    adaptationPrompt: current.adaptationPrompt,
    variants: current.variants,
    sortOrder: current.sortOrder,
    ...patch,
  });
  const { data, error } = await client
    .from("content_media_attachments")
    .update(mediaRow(userId, contentDraftId, payload))
    .eq("id", mediaId)
    .eq("user_id", userId)
    .eq("content_draft_id", contentDraftId)
    .select("*")
    .maybeSingle();
  if (error) throw databaseError("Kunde inte uppdatera mediefilen", error);
  return data ? withContentMediaPreviewUrl(client, mapMedia(data as RawRecord)) : null;
}

export async function deleteContentMediaAttachment(
  client: DatabaseClient,
  userId: string,
  contentDraftId: string,
  mediaId: string,
): Promise<boolean> {
  const { data, error } = await client
    .from("content_media_attachments")
    .delete()
    .eq("id", mediaId)
    .eq("user_id", userId)
    .eq("content_draft_id", contentDraftId)
    .select("id")
    .maybeSingle();
  if (error) throw databaseError("Kunde inte ta bort mediefilen", error);
  return Boolean(data);
}

export async function listContentTemplates(client: DatabaseClient, userId: string): Promise<ContentTemplateView[]> {
  const { data, error } = await client
    .from("content_templates")
    .select("*")
    .or(`is_system_template.eq.true,user_id.eq.${userId}`)
    .order("is_system_template", { ascending: false })
    .order("name", { ascending: true });
  if (error) throw databaseError("Kunde inte läsa mallarna", error);
  return (data ?? []).map((row) => mapTemplate(row as RawRecord));
}

export async function getContentTemplateForUser(
  client: DatabaseClient,
  userId: string,
  templateId: string,
): Promise<ContentTemplateView | null> {
  const { data, error } = await client
    .from("content_templates")
    .select("*")
    .eq("id", templateId)
    .or(`is_system_template.eq.true,user_id.eq.${userId}`)
    .maybeSingle();
  if (error) throw databaseError("Kunde inte läsa mallen", error);
  return data ? mapTemplate(data as RawRecord) : null;
}

export async function createContentTemplate(
  client: DatabaseClient,
  userId: string,
  input: ContentTemplateInput,
): Promise<ContentTemplateView> {
  const payload = contentTemplateInputSchema.parse(input);
  const slug = await uniqueContentTemplateSlug(client, payload.slug ?? slugify(payload.name));
  const { data, error } = await client
    .from("content_templates")
    .insert(templateRow(userId, slug, payload))
    .select("*")
    .single();
  if (error || !data) throw databaseError("Kunde inte skapa mallen", error);
  return mapTemplate(data as RawRecord);
}

export async function updateContentTemplate(
  client: DatabaseClient,
  userId: string,
  templateId: string,
  patch: ContentTemplateUpdateInput,
): Promise<ContentTemplateView | null> {
  const { data: existing, error: existingError } = await client
    .from("content_templates")
    .select("*")
    .eq("id", templateId)
    .eq("user_id", userId)
    .eq("is_system_template", false)
    .maybeSingle();
  if (existingError) throw databaseError("Kunde inte läsa mallen", existingError);
  if (!existing) return null;
  const current = mapTemplate(existing as RawRecord);
  const merged = contentTemplateInputSchema.parse({ ...templateAsInput(current), ...patch });
  const slug = merged.slug && merged.slug !== current.slug
    ? await uniqueContentTemplateSlug(client, merged.slug, current.id)
    : current.slug;
  const { data, error } = await client
    .from("content_templates")
    .update(templateRow(userId, slug, merged))
    .eq("id", templateId)
    .eq("user_id", userId)
    .eq("is_system_template", false)
    .select("*")
    .maybeSingle();
  if (error) throw databaseError("Kunde inte uppdatera mallen", error);
  return data ? mapTemplate(data as RawRecord) : null;
}

export async function deleteContentTemplate(client: DatabaseClient, userId: string, templateId: string): Promise<boolean> {
  const { data, error } = await client
    .from("content_templates")
    .delete()
    .eq("id", templateId)
    .eq("user_id", userId)
    .eq("is_system_template", false)
    .select("id")
    .maybeSingle();
  if (error) throw databaseError("Kunde inte ta bort mallen", error);
  return Boolean(data);
}

export async function listNewsletterAudiences(client: DatabaseClient, userId: string): Promise<NewsletterAudienceView[]> {
  const { data, error } = await client
    .from("newsletter_audiences")
    .select("*")
    .eq("user_id", userId)
    .order("active", { ascending: false })
    .order("name", { ascending: true });
  if (error) throw databaseError("Kunde inte läsa nyhetsbrevsmålgrupperna", error);
  return (data ?? []).map((row) => mapAudience(row as RawRecord));
}

export async function getNewsletterAudienceForUser(
  client: DatabaseClient,
  userId: string,
  audienceId: string,
): Promise<NewsletterAudienceView | null> {
  const { data, error } = await client
    .from("newsletter_audiences")
    .select("*")
    .eq("id", audienceId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw databaseError("Kunde inte läsa nyhetsbrevsmålgruppen", error);
  return data ? mapAudience(data as RawRecord) : null;
}

export async function createNewsletterAudience(
  client: DatabaseClient,
  userId: string,
  input: NewsletterAudienceInput,
): Promise<NewsletterAudienceView> {
  const payload = newsletterAudienceInputSchema.parse(input);
  const { data, error } = await client
    .from("newsletter_audiences")
    .insert(audienceRow(userId, payload))
    .select("*")
    .single();
  if (error || !data) throw databaseError("Kunde inte skapa nyhetsbrevsmålgruppen", error);
  return mapAudience(data as RawRecord);
}

export async function updateNewsletterAudience(
  client: DatabaseClient,
  userId: string,
  audienceId: string,
  patch: NewsletterAudienceUpdateInput,
): Promise<NewsletterAudienceView | null> {
  const existing = await getNewsletterAudienceForUser(client, userId, audienceId);
  if (!existing) return null;
  const payload = newsletterAudienceInputSchema.parse({ ...audienceAsInput(existing), ...patch });
  const { data, error } = await client
    .from("newsletter_audiences")
    .update(audienceRow(userId, payload))
    .eq("id", audienceId)
    .eq("user_id", userId)
    .select("*")
    .maybeSingle();
  if (error) throw databaseError("Kunde inte uppdatera nyhetsbrevsmålgruppen", error);
  return data ? mapAudience(data as RawRecord) : null;
}

export async function deleteNewsletterAudience(client: DatabaseClient, userId: string, audienceId: string): Promise<boolean> {
  const { data, error } = await client
    .from("newsletter_audiences")
    .delete()
    .eq("id", audienceId)
    .eq("user_id", userId)
    .select("id")
    .maybeSingle();
  if (error) throw databaseError("Kunde inte ta bort nyhetsbrevsmålgruppen", error);
  return Boolean(data);
}

export async function listContentAutomationRules(client: DatabaseClient, userId: string): Promise<ContentAutomationRuleView[]> {
  const { data, error } = await client
    .from("content_automation_rules")
    .select("*")
    .eq("user_id", userId)
    .order("active", { ascending: false })
    .order("next_run_at", { ascending: true, nullsFirst: false })
    .order("name", { ascending: true });
  if (error) throw databaseError("Kunde inte läsa automationerna", error);
  return (data ?? []).map((row) => mapRule(row as RawRecord));
}

export async function getContentAutomationRuleForUser(
  client: DatabaseClient,
  userId: string,
  automationRuleId: string,
): Promise<ContentAutomationRuleView | null> {
  const { data, error } = await client
    .from("content_automation_rules")
    .select("*")
    .eq("id", automationRuleId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw databaseError("Kunde inte läsa automationen", error);
  return data ? mapRule(data as RawRecord) : null;
}

/**
 * Read one run receipt through the same ownership boundary as its rule. A
 * linked draft is resolved separately because the database deliberately keeps
 * the job table free from a mutable draft foreign key.
 */
export async function getContentAutomationJobForUser(
  client: DatabaseClient,
  userId: string,
  automationJobId: string,
): Promise<ContentAutomationJobView | null> {
  const { data, error } = await client
    .from("content_automation_jobs")
    .select("*")
    .eq("id", automationJobId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw databaseError("Kunde inte läsa automationskörningen", error);
  if (!data) return null;
  return attachContentDraftToAutomationJob(client, userId, data as RawRecord);
}

/** A compact, private run history used by an automation detail sheet. */
export async function listContentAutomationJobsForRule(
  client: DatabaseClient,
  userId: string,
  automationRuleId: string,
  options: { limit?: number } = {},
): Promise<ContentAutomationJobView[]> {
  const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
  const { data, error } = await client
    .from("content_automation_jobs")
    .select("*")
    .eq("user_id", userId)
    .eq("automation_rule_id", automationRuleId)
    .order("scheduled_for", { ascending: false })
    .limit(limit);
  if (error) throw databaseError("Kunde inte läsa automationshistoriken", error);
  return Promise.all((data ?? []).map((row) => attachContentDraftToAutomationJob(client, userId, row as RawRecord)));
}

export type PreparedContentAutomationManualRun = {
  rule: ContentAutomationRuleView;
  job: ContentAutomationJobView;
  reused: boolean;
};

/**
 * Creates one durable, user-owned manual run. A partial unique database index
 * on `(automation_rule_id, manual_run_key)` makes retrying the same click
 * exact-once even if the network response was lost.
 *
 * A paused rule is intentionally allowed here: pausing prevents background
 * schedule creation, not an explicit request to make a private draft.
 */
export async function createManualContentAutomationJob(
  client: DatabaseClient,
  input: { userId: string; automationRuleId: string; idempotencyKey: string; now?: Date },
): Promise<PreparedContentAutomationManualRun | null> {
  const idempotencyKey = contentAutomationManualRunInputSchema.parse({ idempotencyKey: input.idempotencyKey }).idempotencyKey;
  const rule = await getContentAutomationRuleForUser(client, input.userId, input.automationRuleId);
  if (!rule) return null;

  const findExisting = async () => {
    const { data, error } = await client
      .from("content_automation_jobs")
      .select("*")
      .eq("user_id", input.userId)
      .eq("automation_rule_id", rule.id)
      .eq("manual_run_key", idempotencyKey)
      .maybeSingle();
    if (error) throw databaseError("Kunde inte läsa den manuella körningen", error);
    return data ? attachContentDraftToAutomationJob(client, input.userId, data as RawRecord) : null;
  };

  const existing = await findExisting();
  if (existing) return { rule, job: existing, reused: true };

  const now = input.now ?? new Date();
  // Scheduled slots are stored on exact minute boundaries. A manual receipt is
  // made one millisecond due in the past so it cannot collide with a regular
  // `(rule, scheduled_for)` slot and can still be claimed immediately.
  const scheduledAt = new Date(now.getTime() - 1);
  const local = localParts(scheduledAt, rule.timezone);
  if (!local) throw new Error("Kunde inte beräkna tidpunkten för den manuella körningen.");
  const { data, error } = await client
    .from("content_automation_jobs")
    .insert({
      user_id: input.userId,
      automation_rule_id: rule.id,
      trigger_kind: "manual",
      manual_run_key: idempotencyKey,
      state: "queued",
      scheduled_for: scheduledAt.toISOString(),
      timezone: rule.timezone,
      scheduled_local_date: local.date,
      scheduled_local_time: local.time,
    })
    .select("*")
    .maybeSingle();
  if (error) {
    // A second request with the same key may win between the read and insert.
    // The partial unique index turns that race into a safe lookup.
    if ((error as { code?: string }).code === "23505") {
      const duplicate = await findExisting();
      if (duplicate) return { rule, job: duplicate, reused: true };
    }
    throw databaseError("Kunde inte starta den manuella automationen", error);
  }
  if (!data) throw new Error("Den manuella automationen kunde inte sparas.");
  return {
    rule,
    job: await attachContentDraftToAutomationJob(client, input.userId, data as RawRecord),
    reused: false,
  };
}

/** Duplicate settings only. The copy starts paused and therefore cannot queue work by surprise. */
export async function duplicateContentAutomationRule(
  client: DatabaseClient,
  userId: string,
  automationRuleId: string,
): Promise<ContentAutomationRuleView | null> {
  const existing = await getContentAutomationRuleForUser(client, userId, automationRuleId);
  if (!existing) return null;
  const copy = contentAutomationRuleInputSchema.parse({
    ...ruleAsInput(existing),
    name: duplicateAutomationRuleName(existing.name),
    active: false,
  });
  return createContentAutomationRule(client, userId, copy);
}

async function attachContentDraftToAutomationJob(
  client: DatabaseClient,
  userId: string,
  row: RawRecord,
): Promise<ContentAutomationJobView> {
  const job = mapJob(row);
  if (job.contentDraftId) return job;
  const { data, error } = await client
    .from("content_drafts")
    .select("id")
    .eq("user_id", userId)
    .eq("automation_job_id", job.id)
    .maybeSingle();
  if (error) throw databaseError("Kunde inte läsa utkastet från automationskörningen", error);
  return data ? mapJob({ ...row, content_draft_id: stringValue((data as RawRecord).id) }) : job;
}

function duplicateAutomationRuleName(name: string): string {
  const suffix = " – kopia";
  const trimmed = name.trim();
  return `${trimmed.slice(0, Math.max(2, 160 - suffix.length)).trimEnd()}${suffix}`;
}

export async function createContentAutomationRule(
  client: DatabaseClient,
  userId: string,
  input: ContentAutomationRuleInput,
): Promise<ContentAutomationRuleView> {
  const payload = contentAutomationRuleInputSchema.parse(input);
  const nextRunAt = payload.active ? firstOccurrence(payload, new Date())?.scheduledFor ?? null : null;
  const { data, error } = await client
    .from("content_automation_rules")
    .insert(ruleRow(userId, payload, nextRunAt))
    .select("*")
    .single();
  if (error || !data) throw databaseError("Kunde inte skapa automationen", error);
  const rule = mapRule(data as RawRecord);
  if (rule.active) await ensureContentAutomationJobs(client, { userId, automationRuleId: rule.id });
  return (await getContentAutomationRuleForUser(client, userId, rule.id)) ?? rule;
}

export async function updateContentAutomationRule(
  client: DatabaseClient,
  userId: string,
  automationRuleId: string,
  patch: ContentAutomationRuleUpdateInput,
): Promise<ContentAutomationRuleView | null> {
  const existing = await getContentAutomationRuleForUser(client, userId, automationRuleId);
  if (!existing) return null;
  const payload = contentAutomationRuleInputSchema.parse({ ...ruleAsInput(existing), ...patch });
  const nextRunAt = payload.active ? firstOccurrence(payload, new Date())?.scheduledFor ?? null : null;
  const { data, error } = await client
    .from("content_automation_rules")
    .update(ruleRow(userId, payload, nextRunAt))
    .eq("id", automationRuleId)
    .eq("user_id", userId)
    .select("*")
    .maybeSingle();
  if (error) throw databaseError("Kunde inte uppdatera automationen", error);
  if (!data) return null;

  const now = new Date().toISOString();
  if (payload.active) {
    const { error: clearError } = await client
      .from("content_automation_jobs")
      .delete()
      .eq("user_id", userId)
      .eq("automation_rule_id", automationRuleId)
      .eq("trigger_kind", "scheduled")
      .eq("state", "queued")
      .gte("scheduled_for", now);
    if (clearError) throw databaseError("Kunde inte uppdatera automationens kö", clearError);
    await ensureContentAutomationJobs(client, { userId, automationRuleId });
  } else {
    const { error: cancelError } = await client
      .from("content_automation_jobs")
      .update({ state: "cancelled", claim_token: null, locked_until: null })
      .eq("user_id", userId)
      .eq("automation_rule_id", automationRuleId)
      .eq("trigger_kind", "scheduled")
      .eq("state", "queued")
      .gte("scheduled_for", now);
    if (cancelError) throw databaseError("Kunde inte pausa automationens kö", cancelError);
  }
  return (await getContentAutomationRuleForUser(client, userId, automationRuleId)) ?? mapRule(data as RawRecord);
}

export async function deleteContentAutomationRule(client: DatabaseClient, userId: string, automationRuleId: string): Promise<boolean> {
  const { data, error } = await client
    .from("content_automation_rules")
    .delete()
    .eq("id", automationRuleId)
    .eq("user_id", userId)
    .select("id")
    .maybeSingle();
  if (error) throw databaseError("Kunde inte ta bort automationen", error);
  return Boolean(data);
}

/**
 * Generate durable, future queue rows. It is safe to call from every 15-minute
 * cron tick because `(automation_rule_id, scheduled_for)` is unique.
 */
export async function ensureContentAutomationJobs(
  client: DatabaseClient,
  input: { userId?: string; automationRuleId?: string; now?: Date; horizonDays?: number } = {},
): Promise<{ rulesScanned: number; jobsCreated: number }> {
  const now = input.now ?? new Date();
  const horizonDays = Math.max(1, Math.min(input.horizonDays ?? DEFAULT_AUTOMATION_HORIZON_DAYS, MAX_AUTOMATION_HORIZON_DAYS));
  let query = client
    .from("content_automation_rules")
    .select("*")
    .eq("active", true);
  if (input.userId) query = query.eq("user_id", input.userId);
  if (input.automationRuleId) query = query.eq("id", input.automationRuleId);
  const { data, error } = await query;
  if (error) throw databaseError("Kunde inte läsa automationerna för köbyggnad", error);

  let jobsCreated = 0;
  for (const raw of data ?? []) {
    const rule = mapRule(raw as RawRecord);
    const occurrences = upcomingOccurrences(ruleAsInput(rule), now, horizonDays);
    const rows = occurrences.map((occurrence) => ({
      user_id: rule.userId,
      automation_rule_id: rule.id,
      trigger_kind: "scheduled",
      state: "queued",
      scheduled_for: occurrence.scheduledFor,
      timezone: rule.timezone,
      scheduled_local_date: occurrence.localDate,
      scheduled_local_time: occurrence.localTime,
    }));
    if (rows.length) {
      const { data: inserted, error: insertError } = await client
        .from("content_automation_jobs")
        .upsert(rows, { onConflict: "automation_rule_id,scheduled_for", ignoreDuplicates: true })
        .select("id");
      if (insertError) throw databaseError("Kunde inte skapa automationens köposter", insertError);
      jobsCreated += inserted?.length ?? 0;
    }
    const nextRunAt = occurrences[0]?.scheduledFor ?? null;
    const { error: nextRunError } = await client
      .from("content_automation_rules")
      .update({ next_run_at: nextRunAt })
      .eq("id", rule.id)
      .eq("user_id", rule.userId);
    if (nextRunError) throw databaseError("Kunde inte uppdatera automationens nästa körning", nextRunError);
  }
  return { rulesScanned: (data ?? []).length, jobsCreated };
}

/** Return due jobs, including expired leases, but never claim or mutate them. */
export async function getDueContentAutomationJobs(
  client: DatabaseClient,
  input: { userId?: string; now?: Date; limit?: number } = {},
): Promise<ContentAutomationJobView[]> {
  const now = input.now ?? new Date();
  const limit = Math.max(1, Math.min(input.limit ?? 25, 100));
  const nowIso = now.toISOString();
  let queuedQuery = client
    .from("content_automation_jobs")
    .select("*")
    .lte("scheduled_for", nowIso)
    .eq("state", "queued")
    .order("scheduled_for", { ascending: true })
    .limit(limit);
  let expiredQuery = client
    .from("content_automation_jobs")
    .select("*")
    .lte("scheduled_for", nowIso)
    .eq("state", "processing")
    .lt("locked_until", nowIso)
    .order("scheduled_for", { ascending: true })
    .limit(limit);
  if (input.userId) {
    queuedQuery = queuedQuery.eq("user_id", input.userId);
    expiredQuery = expiredQuery.eq("user_id", input.userId);
  }
  const [queued, expired] = await Promise.all([queuedQuery, expiredQuery]);
  if (queued.error) throw databaseError("Kunde inte läsa väntande automationsjobb", queued.error);
  if (expired.error) throw databaseError("Kunde inte läsa utgångna automationslås", expired.error);
  return [...(queued.data ?? []), ...(expired.data ?? [])]
    .map((row) => mapJob(row as RawRecord))
    .sort((left, right) => left.scheduledFor.localeCompare(right.scheduledFor))
    .slice(0, limit);
}

/** Claim one job with a short lease. A second worker receives null, not a race. */
export async function claimContentAutomationJob(
  client: DatabaseClient,
  jobId: string,
  options: { now?: Date; leaseMs?: number } = {},
): Promise<ClaimedContentAutomationJob | null> {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const claimToken = randomUUID();
  const lockUntil = new Date(now.getTime() + Math.max(60_000, options.leaseMs ?? AUTOMATION_CLAIM_LEASE_MS)).toISOString();

  let result = await client
    .from("content_automation_jobs")
    .update({
      state: "processing",
      claim_token: claimToken,
      locked_until: lockUntil,
      claimed_at: nowIso,
      attempt_count: 1,
      last_error: null,
    })
    .eq("id", jobId)
    .eq("state", "queued")
    .lte("scheduled_for", nowIso)
    .select("*")
    .maybeSingle();
  if (result.error) throw databaseError("Kunde inte reservera automationsjobbet", result.error);

  if (!result.data) {
    result = await client
      .from("content_automation_jobs")
      .update({
        state: "processing",
        claim_token: claimToken,
        locked_until: lockUntil,
        claimed_at: nowIso,
        attempt_count: 1,
        last_error: null,
      })
      .eq("id", jobId)
      .eq("state", "processing")
      .lt("locked_until", nowIso)
      .lte("scheduled_for", nowIso)
      .select("*")
      .maybeSingle();
    if (result.error) throw databaseError("Kunde inte återta automationsjobbet", result.error);
  }
  if (!result.data) return null;

  const job = mapJob(result.data as RawRecord);
  const rule = await getContentAutomationRuleForUser(client, job.userId, job.automationRuleId);
  if (!rule || (!rule.active && job.triggerKind === "scheduled")) {
    await client
      .from("content_automation_jobs")
      .update({ state: "cancelled", claim_token: null, locked_until: null })
      .eq("id", job.id)
      .eq("claim_token", claimToken);
    return null;
  }
  const template = rule.templateId ? await getContentTemplateForUser(client, job.userId, rule.templateId) : null;
  return { ...job, claimToken, rule, template };
}

export type ContentAutomationDraftPayload = {
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
};

/**
 * A scheduled queue item may create a scheduled draft when the owner opted out
 * of approval. A manually triggered job never may: it becomes an unscheduled
 * editable draft regardless of the rule's normal publication setting.
 */
export function contentAutomationDraftInputForJob(input: {
  job: ContentAutomationJobView;
  rule: ContentAutomationRuleView;
  template: ContentTemplateView | null;
  content: ContentAutomationDraftPayload;
}): ContentDraftInput {
  const isManual = input.job.triggerKind === "manual";
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
    status: isManual ? "draft" : rule.approvalRequired ? "in_review" : "scheduled",
    generationPrompt: content.generationPrompt ?? rule.generationPrompt,
    imagePrompt: content.imagePrompt ?? rule.imagePrompt,
    language: content.language ?? rule.language,
    timezone: job.timezone,
    scheduledAt: isManual ? null : job.scheduledFor,
    scheduledLocalDate: isManual ? null : job.scheduledLocalDate,
    scheduledLocalTime: isManual ? null : job.scheduledLocalTime,
    approvalRequired: rule.approvalRequired,
    templateId: rule.templateId,
    automationRuleId: rule.id,
    newsletterAudienceId: rule.newsletterAudienceId,
  });
}

/**
 * Persist an AI-produced draft exactly once for a claimed job. The unique
 * `automation_job_id` prevents duplicate drafts if a worker crashes after its
 * insert and retries the same lease later.
 */
export async function materializeContentAutomationJobDraft(
  client: DatabaseClient,
  input: { jobId: string; claimToken: string; content: ContentAutomationDraftPayload; now?: Date },
): Promise<ContentDraftView | null> {
  const { data: rawJob, error: jobError } = await client
    .from("content_automation_jobs")
    .select("*")
    .eq("id", input.jobId)
    .eq("state", "processing")
    .eq("claim_token", input.claimToken)
    .maybeSingle();
  if (jobError) throw databaseError("Kunde inte läsa automationsjobbet", jobError);
  if (!rawJob) return null;
  const job = mapJob(rawJob as RawRecord);

  const { data: existingDraft, error: existingDraftError } = await client
    .from("content_drafts")
    .select("id")
    .eq("automation_job_id", job.id)
    .eq("user_id", job.userId)
    .maybeSingle();
  if (existingDraftError) throw databaseError("Kunde inte kontrollera tidigare genererat utkast", existingDraftError);
  if (existingDraft) {
    await completeContentAutomationJob(client, { jobId: job.id, claimToken: input.claimToken, now: input.now });
    return getContentDraftForUser(client, job.userId, String((existingDraft as RawRecord).id));
  }

  const rule = await getContentAutomationRuleForUser(client, job.userId, job.automationRuleId);
  if (!rule) throw new Error("Automationens regel hittades inte.");
  const template = rule.templateId ? await getContentTemplateForUser(client, job.userId, rule.templateId) : null;
  const payload = contentAutomationDraftInputForJob({ job, rule, template, content: input.content });
  const { data: created, error: createError } = await client
    .from("content_drafts")
    .insert(draftRow(job.userId, payload, job.id))
    .select("id")
    .maybeSingle();
  if (createError) {
    if ((createError as { code?: string }).code === "23505") {
      const { data: duplicate } = await client
        .from("content_drafts")
        .select("id")
        .eq("automation_job_id", job.id)
        .eq("user_id", job.userId)
        .maybeSingle();
      if (duplicate) {
        await completeContentAutomationJob(client, { jobId: job.id, claimToken: input.claimToken, now: input.now });
        return getContentDraftForUser(client, job.userId, String((duplicate as RawRecord).id));
      }
    }
    throw databaseError("Kunde inte skapa utkast från automationsjobbet", createError);
  }
  if (!created) throw new Error("Automationsutkastet kunde inte sparas.");
  await completeContentAutomationJob(client, { jobId: job.id, claimToken: input.claimToken, now: input.now });
  return getContentDraftForUser(client, job.userId, String((created as RawRecord).id));
}

export async function completeContentAutomationJob(
  client: DatabaseClient,
  input: { jobId: string; claimToken: string; now?: Date },
): Promise<boolean> {
  const nowIso = (input.now ?? new Date()).toISOString();
  const { data, error } = await client
    .from("content_automation_jobs")
    .update({
      state: "completed",
      completed_at: nowIso,
      locked_until: null,
      claim_token: null,
      last_error: null,
    })
    .eq("id", input.jobId)
    .eq("state", "processing")
    .eq("claim_token", input.claimToken)
    .select("id, user_id, automation_rule_id")
    .maybeSingle();
  if (error) throw databaseError("Kunde inte slutföra automationsjobbet", error);
  if (!data) return false;
  await recordContentAutomationRuleRun(client, data as RawRecord, nowIso);
  return true;
}

export async function failContentAutomationJob(
  client: DatabaseClient,
  input: { jobId: string; claimToken: string; errorMessage: string; retry?: boolean; now?: Date },
): Promise<boolean> {
  const message = input.errorMessage.slice(0, 4000);
  const nextState = input.retry ? "queued" : "failed";
  const nowIso = (input.now ?? new Date()).toISOString();
  const { data, error } = await client
    .from("content_automation_jobs")
    .update({
      state: nextState,
      locked_until: null,
      claim_token: null,
      last_error: message,
      ...(input.retry ? {} : { completed_at: nowIso }),
    })
    .eq("id", input.jobId)
    .eq("state", "processing")
    .eq("claim_token", input.claimToken)
    .select("id, user_id, automation_rule_id")
    .maybeSingle();
  if (error) throw databaseError("Kunde inte registrera fel i automationsjobbet", error);
  if (!data) return false;
  await recordContentAutomationRuleRun(client, data as RawRecord, nowIso);
  return true;
}

async function recordContentAutomationRuleRun(client: DatabaseClient, job: RawRecord, at: string): Promise<void> {
  const userId = stringValue(job.user_id);
  const automationRuleId = stringValue(job.automation_rule_id);
  if (!userId || !automationRuleId) return;
  const { error } = await client
    .from("content_automation_rules")
    .update({ last_run_at: at })
    .eq("id", automationRuleId)
    .eq("user_id", userId);
  if (error) throw databaseError("Kunde inte spara automationens senaste körning", error);
}

/** Provider integrations may update the content lifecycle but cannot bypass ownership. */
export async function markContentDraftPublicationResult(
  client: DatabaseClient,
  input: {
    userId: string;
    contentDraftId: string;
    status: Extract<ContentDraftStatus, "publishing" | "published" | "failed">;
    publishedAt?: string | null;
  },
): Promise<ContentDraftView | null> {
  const { data, error } = await client
    .from("content_drafts")
    .update({
      status: input.status,
      ...(input.publishedAt === undefined ? {} : { published_at: input.publishedAt }),
    })
    .eq("id", input.contentDraftId)
    .eq("user_id", input.userId)
    .select("id")
    .maybeSingle();
  if (error) throw databaseError("Kunde inte uppdatera publiceringsstatus", error);
  if (!data) return null;
  return getContentDraftForUser(client, input.userId, input.contentDraftId);
}

export async function getContentCalendar(
  client: DatabaseClient,
  userId: string,
  input: { from: string; to: string; timezone: string },
): Promise<ContentCalendarView> {
  if (!isValidIanaTimezone(input.timezone)) throw new Error("Ogiltig tidszon för kalendern.");
  const rangeDays = daysBetween(input.from, input.to);
  if (rangeDays < 0 || rangeDays > MAX_CALENDAR_RANGE_DAYS) {
    throw new Error(`Kalenderintervallet måste vara mellan 0 och ${MAX_CALENDAR_RANGE_DAYS} dagar.`);
  }
  const start = zonedDateTimeToUtc(input.from, "00:00", input.timezone);
  const end = zonedDateTimeToUtc(addDays(input.to, 1), "00:00", input.timezone);
  if (!start || !end) throw new Error("Kunde inte tolka kalenderns datum i vald tidszon.");
  const [draftResult, jobResult, ruleResult] = await Promise.all([
    client
      .from("content_drafts")
      .select("*")
      .eq("user_id", userId)
      .gte("scheduled_at", start.toISOString())
      .lt("scheduled_at", end.toISOString())
      .order("scheduled_at", { ascending: true }),
    client
      .from("content_automation_jobs")
      .select("*")
      .eq("user_id", userId)
      .gte("scheduled_for", start.toISOString())
      .lt("scheduled_for", end.toISOString())
      .neq("state", "cancelled")
      .order("scheduled_for", { ascending: true }),
    client
      .from("content_automation_rules")
      .select("*")
      .eq("user_id", userId),
  ]);
  if (draftResult.error) throw databaseError("Kunde inte läsa kalenderutkasten", draftResult.error);
  if (jobResult.error) throw databaseError("Kunde inte läsa kalenderjobben", jobResult.error);
  if (ruleResult.error) throw databaseError("Kunde inte läsa kalenderautomationerna", ruleResult.error);
  const drafts = (draftResult.data ?? []).map((row) => mapDraft(row as RawRecord));
  const draftJobIds = new Set(drafts.map((draft) => draft.automationJobId).filter((id): id is string => Boolean(id)));
  const rules = new Map((ruleResult.data ?? []).map((row) => {
    const rule = mapRule(row as RawRecord);
    return [rule.id, rule] as const;
  }));
  const entries: ContentCalendarEntry[] = [
    ...drafts.map((draft) => {
      const startsAt = draft.scheduledAt as string;
      const placement = localParts(new Date(startsAt), input.timezone);
      const original = localParts(new Date(startsAt), draft.timezone);
      return {
        id: `draft:${draft.id}`,
        kind: "draft" as const,
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
        editable: ["draft", "in_review", "approved", "scheduled"].includes(draft.status),
        excerpt: draft.excerpt,
        thumbnail: null,
      };
    }),
    ...(jobResult.data ?? [])
      .map((row) => mapJob(row as RawRecord))
      .filter((job) => !draftJobIds.has(job.id))
      .map((job) => {
        const rule = rules.get(job.automationRuleId);
        const placement = localParts(new Date(job.scheduledFor), input.timezone);
        const original = localParts(new Date(job.scheduledFor), job.timezone);
        return {
          id: `automation_job:${job.id}`,
          kind: "automation_job" as const,
          title: rule?.name ?? "Planerad automation",
          status: job.state,
          channels: rule?.channels ?? [],
          contentType: rule?.contentType ?? "social_post",
          startsAt: job.scheduledFor,
          localDate: placement?.date ?? "",
          localTime: placement?.time ?? "",
          scheduledLocalDate: original?.date ?? "",
          scheduledLocalTime: original?.time ?? "",
          timezone: job.timezone,
          draftId: null,
          automationRuleId: job.automationRuleId,
          automationJobId: job.id,
          approvalRequired: rule?.approvalRequired ?? true,
          revision: null,
          editable: false,
          excerpt: null,
          thumbnail: null,
        };
      }),
  ].sort((left, right) => left.startsAt.localeCompare(right.startsAt));
  return { from: input.from, to: input.to, timezone: input.timezone, entries };
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

async function uniqueContentTemplateSlug(client: DatabaseClient, requested: string, ownId?: string): Promise<string> {
  const base = slugify(requested);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base.slice(0, 68)}-${randomUUID().slice(0, 8)}`;
    const { data, error } = await client
      .from("content_templates")
      .select("id")
      .eq("slug", candidate)
      .maybeSingle();
    if (error) throw databaseError("Kunde inte kontrollera mallens adress", error);
    if (!data || String((data as RawRecord).id) === ownId) return candidate;
  }
  throw new Error("Kunde inte skapa en unik malladress. Försök igen.");
}

type Occurrence = { scheduledFor: string; localDate: string; localTime: string };

/** A pure preview for settings validation and scheduler tests; it does not write queue rows. */
export function previewContentAutomationOccurrences(
  input: ContentAutomationRuleInput,
  options: { now?: Date; horizonDays?: number } = {},
): Occurrence[] {
  const rule = contentAutomationRuleInputSchema.parse(input);
  return upcomingOccurrences(rule, options.now ?? new Date(), Math.max(1, Math.min(options.horizonDays ?? 14, MAX_AUTOMATION_HORIZON_DAYS)));
}

function firstOccurrence(rule: ContentAutomationRuleInput, now: Date): Occurrence | null {
  return upcomingOccurrences(rule, now, DEFAULT_AUTOMATION_HORIZON_DAYS)[0] ?? null;
}

function upcomingOccurrences(rule: ContentAutomationRuleInput, now: Date, horizonDays: number): Occurrence[] {
  if (!isValidIanaTimezone(rule.timezone)) return [];
  const startDate = maxDate(localDateInTimezone(rule.timezone, now), rule.startsOn ?? null);
  const horizonEnd = addDays(localDateInTimezone(rule.timezone, new Date(now.getTime() + horizonDays * 86_400_000)), 1);
  const endDate = minDate(horizonEnd, rule.endsOn ?? null);
  if (startDate > endDate) return [];
  const occurrences: Occurrence[] = [];
  const weeklyDays = rule.scheduleMode === "weekly_count" ? resolveWeeklyDays(rule.weeklyCount ?? 1, rule.weekdays) : [];
  const cron = rule.scheduleMode === "cron" && rule.cronExpression ? parseSimpleCron(rule.cronExpression) : null;
  if (rule.scheduleMode === "cron" && !cron) return [];

  for (let localDate = startDate; localDate <= endDate; localDate = addDays(localDate, 1)) {
    const weekday = weekdayForDate(localDate);
    const times = rule.scheduleMode === "weekly_count"
      ? weeklyTimesForDate(rule.localTimes, weeklyDays, weekday)
      : cron && cron.weekdays.includes(weekday) ? [cron.time] : [];
    for (const localTime of times) {
      const instant = zonedDateTimeToUtc(localDate, localTime, rule.timezone);
      if (!instant || instant.getTime() <= now.getTime()) continue;
      occurrences.push({ scheduledFor: instant.toISOString(), localDate, localTime });
    }
  }
  return occurrences.sort((left, right) => left.scheduledFor.localeCompare(right.scheduledFor));
}

function resolveWeeklyDays(count: number, explicitDays: number[]): number[] {
  if (explicitDays.length) return [...explicitDays].sort((left, right) => left - right);
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
  return [localTimes.length === 1 ? localTimes[0] : localTimes[index]].filter((time): time is string => Boolean(time));
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
  if (!isValidIanaTimezone(timezone)) return null;
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
  const verify = localParts(candidate, timezone);
  if (!verify || verify.date !== localDate || verify.time !== localTime) return null;
  return candidate;
}

function localEpoch(date: Date, timezone: string): number | null {
  const parts = localParts(date, timezone);
  if (!parts) return null;
  const [year, month, day] = parts.date.split("-").map(Number);
  const [hour, minute] = parts.time.split(":").map(Number);
  return Date.UTC(year, month - 1, day, hour, minute);
}

function localParts(date: Date, timezone: string): { date: string; time: string } | null {
  try {
    const parts = new Map(new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date).map((part) => [part.type, part.value]));
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

function addDays(date: string, days: number): string {
  const instance = new Date(`${date}T00:00:00Z`);
  instance.setUTCDate(instance.getUTCDate() + days);
  return instance.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  const left = Date.parse(`${from}T00:00:00Z`);
  const right = Date.parse(`${to}T00:00:00Z`);
  return Math.round((right - left) / 86_400_000);
}

function maxDate(left: string, right: string | null): string {
  return right && right > left ? right : left;
}

function minDate(left: string, right: string | null): string {
  return right && right < left ? right : left;
}

/**
 * The bucket is private. A stored path is never handed to the browser as if it
 * were directly fetchable; each reader receives a short-lived signed URL while
 * external asset URLs stay intact. Failure to sign one image must not hide the
 * entire draft or leak a storage error to a feed.
 */
async function withContentMediaPreviewUrls(
  client: DatabaseClient,
  media: ContentMediaAttachmentView[],
): Promise<ContentMediaAttachmentView[]> {
  return Promise.all(media.map((item) => withContentMediaPreviewUrl(client, item)));
}

async function withContentMediaPreviewUrl(
  client: DatabaseClient,
  media: ContentMediaAttachmentView,
): Promise<ContentMediaAttachmentView> {
  if (media.assetUrl || !media.storagePath) return media;
  try {
    const { data, error } = await client.storage.from("content-media").createSignedUrl(media.storagePath, 60 * 20);
    if (error || !data?.signedUrl) return media;
    return { ...media, assetUrl: data.signedUrl };
  } catch {
    return media;
  }
}
