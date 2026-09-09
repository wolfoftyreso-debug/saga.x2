/**
 * Narrow client-side view models for the publishing studio.
 *
 * The durable implementation lives behind `/api/content/*` and the social
 * connector routes. These adapters only make the UI tolerant while those
 * endpoints are being configured; they do not manufacture content.
 */

export type StudioChannelKind = "facebook_page" | "instagram" | "linkedin" | "newsletter";
export type StudioContentKind = "social_post" | "newsletter" | "article";
export type StudioContentStatus = "draft" | "in_review" | "approved" | "scheduled" | "publishing" | "published" | "failed" | "cancelled";

export type StudioMediaView = {
  id: string;
  url: string;
  alt: string;
  state: "ready" | "processing" | "failed";
  kind: "image" | "video" | "document";
};

export type StudioDraftView = {
  id: string;
  /** Selected for new drafts; immutable owner returned by the server after save. */
  brandProfileId?: string | null;
  contentType: StudioContentKind;
  channels: StudioChannelKind[];
  title: string;
  headline: string;
  subject: string;
  body: string;
  cta: string;
  excerpt: string;
  hashtags: string;
  status: StudioContentStatus;
  generationPrompt: string;
  imagePrompt: string;
  timezone: string;
  scheduledAt: string | null;
  scheduledLocalDate: string | null;
  scheduledLocalTime: string | null;
  /** Optimistic-concurrency value returned by the durable content API. */
  revision: number | null;
  approvalRequired: boolean;
  /**
   * Server-owned delivery boundary for deterministic ad-automation briefs.
   * Older API responses omit this field, which intentionally means false.
   */
  deliveryLocked?: boolean;
  /** Server-owned marker for a private, non-generative creative brief. */
  privateBrief?: boolean;
  /**
   * Server-owned boundary for a real private draft generated from a
 * quarterly activity-plan batch. It remains editable copy, but normal
 * Studio approval, scheduling and publication controls must stay hidden
 * until the batch-review API records an approved human decision.
   */
  quarterlyPrivateReview?: boolean;
  media: StudioMediaView[];
  templateId: string | null;
  automationRuleId: string | null;
  newsletterAudienceId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type StudioCalendarEntryView = {
  id: string;
  kind: "draft" | "automation_job";
  startAt: string;
  endAt: string | null;
  status: string;
  draftId: string | null;
  automationRuleId: string | null;
  title: string;
  channels: StudioChannelKind[];
};

export type StudioTemplateView = {
  id: string;
  name: string;
  description: string;
  contentType: StudioContentKind;
  channels: StudioChannelKind[];
  structure: string;
  isBuiltIn: boolean;
};

export type StudioAutomationView = {
  id: string;
  brandProfileId?: string | null;
  name: string;
  active: boolean;
  contentType: StudioContentKind;
  channels: StudioChannelKind[];
  postsPerWeek: number;
  weekdays: number[];
  localTime: string;
  timezone: string;
  topic: string;
  prompt: string;
  tone: string;
  targetLength: "short" | "medium" | "long";
  imageDirection: string;
  approvalRequired: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  updatedAt: string;
};

export type StudioChannelView = {
  id: string;
  kind: StudioChannelKind;
  accountName: string | null;
  state: "checking" | "connected" | "disconnected" | "needs_reauth" | "unavailable";
  canPublish: boolean;
  lastSyncedAt: string | null;
  connectUrl?: string | null;
  /** Environment requirements reported by the safe social-channel endpoint. */
  missingConfiguration?: string[];
  /** A transport or discovery error that is safe to surface in Studio. */
  unavailableReason?: string | null;
};

/**
 * Safe newsletter audience data only. Recipient contact details deliberately
 * never enter the Studio client payload.
 */
export type StudioNewsletterAudienceView = {
  id: string;
  name: string;
  description: string;
  senderName: string | null;
  senderEmail: string | null;
  replyToEmail: string | null;
  active: boolean;
  contactCount: number | null;
  subscribedCount: number | null;
};

/** Contact details are deliberately only loaded inside the audience manager. */
export type StudioNewsletterContactView = {
  id: string;
  audienceId: string;
  email: string;
  displayName: string | null;
  status: "subscribed" | "unsubscribed" | "bounced" | "complained" | "suppressed";
  consentSource: string;
  consentedAt: string | null;
};

export type StudioNewsletterDeliveryStatus = {
  configured: boolean;
  missing: string[];
};

/**
 * Studio must not render write controls until it has established that the
 * durable content backend is available. This is deliberately separate from a
 * channel's publish availability: drafts and automations still need their
 * own database even when no social account is connected yet.
 */
export type StudioBackendState = "checking" | "ready" | "unconfigured" | "unavailable";

export type StudioBackendIssue = {
  message: string;
  missingConfiguration: string[];
};

export type StudioBackendProbe = {
  ok: boolean;
  data: unknown;
  /** A successful diagnostic endpoint must not unlock content writes. */
  establishesPersistence?: boolean;
};

export type StudioData = {
  timezone: string;
  drafts: StudioDraftView[];
  calendarEntries: StudioCalendarEntryView[];
  templates: StudioTemplateView[];
  automations: StudioAutomationView[];
  channels: StudioChannelView[];
  newsletterAudiences: StudioNewsletterAudienceView[];
  newsletterDelivery: StudioNewsletterDeliveryStatus;
  channelLoadState: "loading" | "ready" | "error";
  channelLoadError: string | null;
  channelLoadMissing: string[];
  loaded: boolean;
  backendState: StudioBackendState;
  backendIssue: StudioBackendIssue | null;
};

export const STUDIO_CHANNELS: StudioChannelKind[] = ["instagram", "facebook_page", "linkedin", "newsletter"];
export const STUDIO_CONTENT_TYPES: StudioContentKind[] = ["social_post", "newsletter", "article"];

/**
 * The Studio preflight is rendered on the server before its client probe can
 * run. Create a fresh, deterministic snapshot for every render rather than
 * using a module-level object: a shared object can be retained by Fast Refresh
 * in development and makes the server preview diverge from the first client
 * render.
 */
export function createEmptyStudioData(): StudioData {
  return {
    timezone: "Europe/Stockholm",
    drafts: [],
    calendarEntries: [],
    templates: [],
    automations: [],
    channels: [],
    newsletterAudiences: [],
    newsletterDelivery: { configured: false, missing: [] },
    channelLoadState: "loading",
    channelLoadError: null,
    channelLoadMissing: [],
    loaded: false,
    backendState: "checking",
    backendIssue: null,
  };
}

/** @deprecated Use `createEmptyStudioData` when initializing state. */
export const EMPTY_STUDIO_DATA: StudioData = createEmptyStudioData();

const statusValues = new Set<StudioContentStatus>(["draft", "in_review", "approved", "scheduled", "publishing", "published", "failed", "cancelled"]);
const channelValues = new Set<StudioChannelKind>(STUDIO_CHANNELS);
const contentTypeValues = new Set<StudioContentKind>(STUDIO_CONTENT_TYPES);

export function channelLabel(kind: StudioChannelKind) {
  return { instagram: "Instagram", facebook_page: "Facebook", linkedin: "LinkedIn", newsletter: "Nyhetsbrev" }[kind];
}

export function contentTypeLabel(type: StudioContentKind) {
  return { social_post: "Inlägg", newsletter: "Nyhetsbrev", article: "Artikel" }[type];
}

export function contentStatusLabel(status: StudioContentStatus) {
  return {
    draft: "Utkast",
    in_review: "Väntar på granskning",
    approved: "Godkänd",
    scheduled: "Schemalagd",
    publishing: "Publicerar",
    published: "Publicerad",
    failed: "Kunde inte publiceras",
    cancelled: "Avbruten",
  }[status];
}

/**
 * Fail closed when either server-owned boundary is present. The client must
 * never turn a private ad brief back into the generic publication editor.
 */
export function isDeliveryLockedPrivateBrief(draft: Pick<StudioDraftView, "deliveryLocked" | "privateBrief">) {
  return draft.deliveryLocked === true || draft.privateBrief === true;
}

/**
 * A quarterly batch draft is deliberately different from an ad brief: the
 * author may edit its copy after it is returned, but the batch remains the
 * only place where it can be approved, scheduled or published. The marker is
 * derived server-side from durable metadata and is never accepted from an
 * editor write.
 */
export function isQuarterlyPrivateReviewDraft(draft: Pick<StudioDraftView, "quarterlyPrivateReview"> & Partial<Pick<StudioDraftView, "status">>) {
  // The immutable source marker stays on the draft for auditability. The
  // durable draft status is the server-owned projection of the batch decision:
  // `approved` and rejected (`cancelled`) are no longer held in the editable
  // private-review boundary.
  return draft.quarterlyPrivateReview === true && draft.status !== "approved" && draft.status !== "cancelled";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function string(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function nullableString(value: unknown) {
  return typeof value === "string" && value ? value : null;
}

function bool(value: unknown, fallback = false) {
  return typeof value === "boolean" ? value : fallback;
}

function number(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function revision(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 2_147_483_647
    ? value
    : null;
}

function channelKinds(value: unknown): StudioChannelKind[] {
  return Array.isArray(value) ? value.filter((entry): entry is StudioChannelKind => typeof entry === "string" && channelValues.has(entry as StudioChannelKind)) : [];
}

function weekdayValues(value: unknown) {
  return Array.isArray(value) ? value.filter((entry): entry is number => typeof entry === "number" && Number.isInteger(entry) && entry >= 0 && entry <= 6) : [];
}

function status(value: unknown): StudioContentStatus {
  return typeof value === "string" && statusValues.has(value as StudioContentStatus) ? value as StudioContentStatus : "draft";
}

function contentType(value: unknown): StudioContentKind {
  return typeof value === "string" && contentTypeValues.has(value as StudioContentKind) ? value as StudioContentKind : "social_post";
}

/**
 * Turns the safe API setup response into a UI-only status. It accepts only
 * variable names and messages that the server already exposed; no key value
 * can reach the browser through this adapter.
 */
export function studioBackendIssueFromPayload(value: unknown): StudioBackendIssue | null {
  if (!isRecord(value)) return null;
  const missingConfiguration = Array.isArray(value.missing)
    ? value.missing.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
  if (value.code !== "configuration_required" && missingConfiguration.length === 0) return null;
  return {
    message: string(value.error, "Studio är inte konfigurerad ännu."),
    missingConfiguration,
  };
}

/**
 * A response from e.g. the social diagnostic route is useful for explaining a
 * missing `.env.local`, but it cannot by itself unlock Studio's create/save
 * controls. At least one durable content endpoint has to succeed.
 */
export function studioBackendReadiness(probes: StudioBackendProbe[]): {
  state: Exclude<StudioBackendState, "checking">;
  issue: StudioBackendIssue | null;
} {
  if (probes.some((probe) => probe.ok && probe.establishesPersistence !== false)) {
    return { state: "ready", issue: null };
  }

  const configurationIssue = probes
    .map((probe) => studioBackendIssueFromPayload(probe.data))
    .find((issue): issue is StudioBackendIssue => Boolean(issue));
  if (configurationIssue) return { state: "unconfigured", issue: configurationIssue };

  const failedPersistentProbe = probes.find((probe) => probe.establishesPersistence !== false && !probe.ok);
  const payload = failedPersistentProbe?.data;
  const message = isRecord(payload)
    ? string(payload.error, "Studio kan inte nå sin sparade arbetsyta just nu.")
    : "Studio kan inte nå sin sparade arbetsyta just nu.";
  return { state: "unavailable", issue: { message, missingConfiguration: [] } };
}

export function mediaFromPayload(value: unknown): StudioMediaView[] {
  if (isRecord(value)) {
    if (Array.isArray(value.media)) return mediaFromPayload(value.media);
    if (isRecord(value.media)) return mediaFromPayload([value.media]);
    return mediaFromPayload([value]);
  }
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry, index) => {
    if (!isRecord(entry)) return [];
    const url = string(entry.url ?? entry.assetUrl ?? entry.asset_url ?? entry.publicUrl ?? entry.previewUrl);
    if (!url) return [];
    return [{
      id: string(entry.id, `media-${index}`),
      url,
      alt: string(entry.alt ?? entry.altText ?? entry.alt_text ?? entry.fileName ?? entry.filename, "Bild till utkastet"),
      state: entry.status === "processing" || entry.status === "failed" || entry.processingStatus === "processing" || entry.processingStatus === "failed" ? entry.status === "failed" || entry.processingStatus === "failed" ? "failed" : "processing" : "ready",
      kind: entry.kind === "video" || entry.kind === "document" ? entry.kind : "image",
    }];
  });
}

export function draftFrom(value: unknown): StudioDraftView | null {
  if (!isRecord(value)) return null;
  const id = string(value.id);
  if (!id) return null;
  // `quarterlyPrivateReview` is the intended public server projection. The
  // nested read is a backwards-compatible narrow fallback while a deployed
  // server is transitioning to that projection; raw metadata is never sent
  // back in an editor write.
  const quarterlyPlan = isRecord(value.sagaQuarterlyActivityPlan)
    ? value.sagaQuarterlyActivityPlan
    : isRecord(value.saga_quarterly_activity_plan)
      ? value.saga_quarterly_activity_plan
      : null;
  return {
    id,
    brandProfileId: nullableString(value.brandProfileId ?? value.brand_profile_id),
    contentType: contentType(value.contentType ?? value.content_type),
    channels: channelKinds(value.channels ?? value.channelKinds ?? value.channel_kinds),
    title: string(value.title),
    headline: string(value.headline),
    subject: string(value.subject),
    body: string(value.body),
    cta: string(value.cta),
    excerpt: string(value.excerpt),
    hashtags: Array.isArray(value.hashtags) ? value.hashtags.filter((entry): entry is string => typeof entry === "string").join(" ") : string(value.hashtags),
    status: status(value.status),
    generationPrompt: string(value.generationPrompt ?? value.generation_prompt),
    imagePrompt: string(value.imagePrompt ?? value.image_prompt),
    timezone: string(value.timezone, "Europe/Stockholm"),
    scheduledAt: nullableString(value.scheduledAt ?? value.scheduled_at),
    scheduledLocalDate: nullableString(value.scheduledLocalDate ?? value.scheduled_local_date),
    scheduledLocalTime: nullableString(value.scheduledLocalTime ?? value.scheduled_local_time),
    revision: revision(value.revision),
    approvalRequired: bool(value.approvalRequired ?? value.approval_required),
    deliveryLocked: bool(value.deliveryLocked ?? value.delivery_locked),
    privateBrief: bool(value.privateBrief ?? value.private_brief),
    quarterlyPrivateReview: bool(value.quarterlyPrivateReview ?? value.quarterly_private_review ?? quarterlyPlan?.privateOnly ?? quarterlyPlan?.private_only),
    media: mediaFromPayload(value.media),
    templateId: nullableString(value.templateId ?? value.template_id),
    automationRuleId: nullableString(value.automationRuleId ?? value.automation_rule_id),
    newsletterAudienceId: nullableString(value.newsletterAudienceId ?? value.newsletter_audience_id),
    createdAt: string(value.createdAt ?? value.created_at),
    updatedAt: string(value.updatedAt ?? value.updated_at),
  };
}

export function draftsFromPayload(value: unknown) {
  const values = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.drafts)
      ? value.drafts
      : isRecord(value) && Array.isArray(value.items)
        ? value.items
        : [];
  return values.map(draftFrom).filter((item): item is StudioDraftView => Boolean(item));
}

export function templatesFromPayload(value: unknown): StudioTemplateView[] {
  const values = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.templates)
      ? value.templates
      : isRecord(value) && Array.isArray(value.items)
        ? value.items
        : [];
  return values.flatMap((entry, index) => {
    if (!isRecord(entry)) return [];
    return [{
      id: string(entry.id, `template-${index}`),
      name: string(entry.name, "Namnlös mall"),
      description: string(entry.description ?? entry.summary),
      contentType: contentType(entry.contentType ?? entry.content_type),
      channels: channelKinds(entry.channels ?? entry.channelKinds ?? entry.channel_kinds),
      structure: string(entry.structure, "single_message"),
      isBuiltIn: bool(entry.isBuiltIn ?? entry.is_built_in ?? entry.isSystemTemplate ?? entry.is_system_template),
    }];
  });
}

export function automationsFromPayload(value: unknown): StudioAutomationView[] {
  const values = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.automations)
      ? value.automations
      : isRecord(value) && Array.isArray(value.rules)
        ? value.rules
      : isRecord(value) && Array.isArray(value.items)
        ? value.items
        : [];
  return values.flatMap((entry, index) => {
    if (!isRecord(entry)) return [];
    const cadence = isRecord(entry.cadence) ? entry.cadence : entry;
    const brief = isRecord(entry.brief) ? entry.brief : entry;
    return [{
      id: string(entry.id, `automation-${index}`),
      brandProfileId: nullableString(entry.brandProfileId ?? entry.brand_profile_id),
      name: string(entry.name, "Namnlös automation"),
      active: bool(entry.active, true),
      contentType: contentType(entry.contentType ?? entry.content_type),
      channels: channelKinds(entry.channels ?? entry.channelKinds ?? entry.channel_kinds),
      postsPerWeek: Math.max(1, Math.min(7, number(cadence.postsPerWeek ?? cadence.posts_per_week ?? cadence.weeklyCount ?? cadence.weekly_count, 1))),
      weekdays: weekdayValues(cadence.weekdays),
      localTime: string(cadence.localTime ?? cadence.local_time ?? (Array.isArray(cadence.localTimes) ? cadence.localTimes[0] : null) ?? (Array.isArray(cadence.local_times) ? cadence.local_times[0] : null), "09:00"),
      timezone: string(cadence.timezone ?? entry.timezone, "Europe/Stockholm"),
      topic: string(brief.topic ?? entry.topic),
      prompt: string(brief.prompt ?? entry.generationPrompt ?? entry.generation_prompt),
      tone: string(brief.tone, "Rak och varm"),
      targetLength: brief.targetLength === "short" || brief.targetLength === "long" ? brief.targetLength : number(entry.desiredLength ?? entry.desired_length) >= 280 ? "long" : number(entry.desiredLength ?? entry.desired_length) > 0 && number(entry.desiredLength ?? entry.desired_length) <= 90 ? "short" : "medium",
      imageDirection: string(brief.imageDirection ?? brief.image_direction ?? entry.imagePrompt ?? entry.image_prompt),
      approvalRequired: bool(brief.approvalRequired ?? brief.approval_required ?? entry.approvalRequired ?? entry.approval_required, true),
      nextRunAt: nullableString(entry.nextRunAt ?? entry.next_run_at),
      lastRunAt: nullableString(entry.lastRunAt ?? entry.last_run_at),
      updatedAt: string(entry.updatedAt ?? entry.updated_at),
    }];
  });
}

export function calendarFromPayload(value: unknown): StudioCalendarEntryView[] {
  if (isRecord(value) && isRecord(value.calendar)) return calendarFromPayload(value.calendar);
  const values = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.entries)
      ? value.entries
      : isRecord(value) && Array.isArray(value.items)
        ? value.items
        : [];
  return values.flatMap((entry, index) => {
    if (!isRecord(entry)) return [];
    const startAt = string(entry.startAt ?? entry.startsAt ?? entry.start_at ?? entry.starts_at ?? entry.scheduledAt ?? entry.scheduled_at);
    if (!startAt) return [];
    return [{
      id: string(entry.id, `calendar-${index}`),
      kind: entry.kind === "automation_job" ? "automation_job" : "draft",
      startAt,
      endAt: nullableString(entry.endAt ?? entry.end_at),
      status: string(entry.status, "scheduled"),
      draftId: nullableString(entry.draftId ?? entry.draft_id),
      automationRuleId: nullableString(entry.automationRuleId ?? entry.automation_rule_id),
      title: string(entry.title, "Schemalagd publicering"),
      channels: channelKinds(entry.channels ?? entry.channelKinds ?? entry.channel_kinds),
    }];
  });
}

export function newsletterAudiencesFromPayload(value: unknown): StudioNewsletterAudienceView[] {
  const values = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.audiences)
      ? value.audiences
      : isRecord(value) && Array.isArray(value.items)
        ? value.items
        : [];
  return values.flatMap((entry, index) => {
    if (!isRecord(entry)) return [];
    const id = string(entry.id ?? entry.audienceId ?? entry.audience_id);
    if (!id) return [];
    return [{
      id,
      name: string(entry.name ?? entry.audienceName ?? entry.audience_name, `Mottagarlista ${index + 1}`),
      description: string(entry.description),
      senderName: nullableString(entry.senderName ?? entry.sender_name),
      senderEmail: nullableString(entry.senderEmail ?? entry.sender_email),
      replyToEmail: nullableString(entry.replyToEmail ?? entry.reply_to_email),
      active: bool(entry.active ?? entry.audienceActive ?? entry.audience_active, true),
      contactCount: typeof (entry.contactCount ?? entry.contact_count ?? entry.subscribedCount ?? entry.subscribed_count) === "number"
        ? number(entry.contactCount ?? entry.contact_count ?? entry.subscribedCount ?? entry.subscribed_count)
        : null,
      subscribedCount: typeof (entry.subscribedCount ?? entry.subscribed_count) === "number"
        ? number(entry.subscribedCount ?? entry.subscribed_count)
        : null,
    }];
  });
}

const contactStatuses = new Set<StudioNewsletterContactView["status"]>(["subscribed", "unsubscribed", "bounced", "complained", "suppressed"]);

export function newsletterContactsFromPayload(value: unknown): StudioNewsletterContactView[] {
  const values = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.contacts)
      ? value.contacts
      : isRecord(value) && Array.isArray(value.items)
        ? value.items
        : [];
  return values.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const id = string(entry.id);
    const audienceId = string(entry.audienceId ?? entry.audience_id);
    const email = string(entry.email);
    const rawStatus = string(entry.status);
    if (!id || !audienceId || !email || !contactStatuses.has(rawStatus as StudioNewsletterContactView["status"])) return [];
    return [{
      id,
      audienceId,
      email,
      displayName: nullableString(entry.displayName ?? entry.display_name),
      status: rawStatus as StudioNewsletterContactView["status"],
      consentSource: string(entry.consentSource ?? entry.consent_source, "manual"),
      consentedAt: nullableString(entry.consentedAt ?? entry.consented_at),
    }];
  });
}

export function newsletterDeliveryStatusFromPayload(value: unknown): StudioNewsletterDeliveryStatus {
  if (!isRecord(value)) return { configured: false, missing: [] };
  return {
    configured: bool(value.configured),
    missing: Array.isArray(value.missing) ? value.missing.filter((entry): entry is string => typeof entry === "string" && entry.length > 0) : [],
  };
}

export function channelsFromPayload(value: unknown): StudioChannelView[] {
  const values = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.channels)
      ? value.channels
      : isRecord(value) && Array.isArray(value.items)
        ? value.items
        : [];
  return values.flatMap((entry, index) => {
    if (!isRecord(entry)) return [];
    const kind = string(entry.kind ?? entry.platform ?? entry.channel) as StudioChannelKind;
    if (!channelValues.has(kind)) return [];
    const rawState = string(entry.state ?? entry.status, "disconnected");
    return [{
      id: string(entry.id, `channel-${index}`),
      kind,
      accountName: nullableString(entry.accountName ?? entry.account_name ?? entry.handle),
      state: rawState === "connected" || rawState === "needs_reauth" || rawState === "unavailable" ? rawState : "disconnected",
      canPublish: bool(entry.canPublish ?? entry.can_publish),
      lastSyncedAt: nullableString(entry.lastSyncedAt ?? entry.last_synced_at),
      connectUrl: nullableString(entry.connectUrl ?? entry.connect_url),
      missingConfiguration: stringList(entry.missing ?? entry.missingConfiguration ?? entry.missing_configuration),
      unavailableReason: nullableString(entry.unavailableReason ?? entry.unavailable_reason),
    }];
  });
}

/** Maps the deliberately safe social OAuth discovery response to channel cards. */
export function socialChannelsFromPayload(value: unknown): StudioChannelView[] {
  if (!isRecord(value)) return [];
  const connections = Array.isArray(value.connections) ? value.connections : [];
  const providers = Array.isArray(value.providers) ? value.providers : [];
  const byKind = new Map<StudioChannelKind, StudioChannelView>();

  // `/api/social/channels` is the channel-centric response consumed by the
  // Studio. It deliberately provides no access or refresh tokens.
  if (Array.isArray(value.channels)) {
    for (const entry of value.channels) {
      if (!isRecord(entry)) continue;
      const kind = string(entry.channel) as StudioChannelKind;
      if (!channelValues.has(kind)) continue;
      const nestedConnections = Array.isArray(entry.connections) ? entry.connections.filter(isRecord) : [];
      const active = nestedConnections.find((connection) => string(connection.state) === "active") ?? nestedConnections[0];
      const state = active
        ? string(active.state) === "active" ? "connected" : string(active.state) === "needs_reauth" || string(active.state) === "error" ? "needs_reauth" : "disconnected"
        : bool(entry.configured) ? "disconnected" : "unavailable";
      byKind.set(kind, {
        id: active ? string(active.id, `connection-${kind}`) : `channel-${kind}`,
        kind,
        accountName: active ? nullableString(active.accountLabel ?? active.account_label ?? active.accountHandle ?? active.account_handle) : null,
        state,
        canPublish: bool(entry.canPublish) && state === "connected",
        lastSyncedAt: active ? nullableString(active.lastVerifiedAt ?? active.last_verified_at) : null,
        connectUrl: nullableString(entry.connectUrl ?? entry.connect_url),
        missingConfiguration: stringList(entry.missing),
      });
    }
  }

  for (const entry of connections) {
    if (!isRecord(entry)) continue;
    const provider = string(entry.provider);
    const kind: StudioChannelKind | null = provider === "instagram_professional" ? "instagram" : provider === "facebook_page" || provider === "linkedin" ? provider : null;
    if (!kind) continue;
    const state = string(entry.state);
    // The channel-centric payload carries the safe OAuth start URL. Keep it
    // when a concrete connection record subsequently refines the state.
    const discovered = byKind.get(kind);
    byKind.set(kind, {
      id: string(entry.id, `connection-${kind}`),
      kind,
      accountName: nullableString(entry.accountLabel ?? entry.account_label ?? entry.accountHandle ?? entry.account_handle),
      state: state === "active" ? "connected" : state === "needs_reauth" || state === "error" ? "needs_reauth" : "disconnected",
      canPublish: state === "active",
      lastSyncedAt: nullableString(entry.lastVerifiedAt ?? entry.last_verified_at),
      connectUrl: discovered?.connectUrl ?? null,
      missingConfiguration: discovered?.missingConfiguration ?? [],
    });
  }

  for (const entry of providers) {
    if (!isRecord(entry)) continue;
    const provider = string(entry.provider);
    const kind: StudioChannelKind | null = provider === "instagram_professional" ? "instagram" : provider === "facebook_page" || provider === "linkedin" ? provider : null;
    if (!kind || byKind.has(kind)) continue;
    const configured = bool(entry.configured);
    byKind.set(kind, {
      id: `provider-${kind}`,
      kind,
      accountName: null,
      state: configured ? "disconnected" : "unavailable",
      canPublish: false,
      lastSyncedAt: null,
      connectUrl: nullableString(entry.connectUrl ?? entry.connect_url),
      missingConfiguration: stringList(entry.missing),
    });
  }

  return [...byKind.values()];
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

export function localDateTime(date: Date, timezone = "Europe/Stockholm") {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date).reduce<Record<string, string>>((result, part) => {
    result[part.type] = part.value;
    return result;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
