"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  draftFrom,
  type StudioChannelKind,
  type StudioContentKind,
  type StudioDraftView,
} from "@/components/content-studio-adapter";
import styles from "@/components/saga-authoring-workspace.module.css";

/**
 * The batch boundary is deliberately visible in the authoring product.  Ten
 * is a reviewable amount, not a client-side loop over an AI endpoint.
 */
export const SAGA_AUTHORING_MAX_SERIES_SIZE = 10;

export type SagaAuthoringObjective = "explain" | "position" | "trust" | "response";

export type SagaKnowledgeEntry = {
  id: string;
  topic: string;
  title: string;
  summary: string;
  knowledgeDate: string | null;
  evidenceCount: number;
  independentPublisherCount: number;
};

export type SagaAuthoringCandidate = {
  id: string;
  revision: number | null;
  state: string;
  title: string;
  headline: string;
  body: string;
  selectedDraftId: string | null;
  quality: SagaAuthoringQuality | null;
  error: string | null;
};

export type SagaAuthoringQuality = {
  decision: "approved" | "review_required" | "blocked";
  score: number;
  findings: Array<{ severity: "blocker" | "warning"; message: string }>;
  canCreatePrivateDraft: boolean;
};

export type SagaAuthoringGenerationProgress = {
  total: number;
  pending: number;
  completed: number;
  queued: number;
  generating: number;
  ready: number;
  blocked: number;
  failed: number;
  selected: number;
  notSelected: number;
};

export type SagaAuthoringRun = {
  id: string;
  revision: number | null;
  state: string;
  candidateCount: number;
  candidates: SagaAuthoringCandidate[];
  canGenerate: boolean;
  canRetry: boolean;
  canSelect: boolean;
  hasPendingWork: boolean;
  canContinue: boolean;
  failureMessage: string | null;
  generationProgress: SagaAuthoringGenerationProgress;
  knowledge: SagaKnowledgeEntry[];
};

type LoadState = "checking" | "ready" | "unavailable";
type ActionState = "idle" | "working";

export type SagaKnowledgePolicy = {
  topics: string[];
  revision: number | null;
  sourceIds: string[];
  enabled: boolean;
  timezone: string;
  dailyAt: string;
  minimumIndependentPublishers: number;
  minimumEvidenceItems: number;
  maximumEvidenceItems: number;
  evidenceWindowHours: number;
  retentionDays: number;
};

type KnowledgePolicy = SagaKnowledgePolicy;

export type SagaAuthoringForm = {
  objective: SagaAuthoringObjective;
  topics: string[];
  prompt: string;
  includeAuthorName: boolean;
  contentType: StudioContentKind;
  channels: StudioChannelKind[];
  targetLength: "short" | "medium" | "long";
  selectedKnowledgeEntryIds: string[];
};

type AuthoringForm = SagaAuthoringForm;

/** Server-confirmed entry state; anything other than completed keeps authoring closed. */
export type SagaAuthoringBrandContext =
  | { status: "completed"; brandProfileId: string; brandName: string }
  | { status: "selection_required"; brands: Array<{ brandProfileId: string; brandName: string }> }
  | { status: "missing" }
  | { status: "unavailable" };

type SagaAuthoringWorkspaceProps = {
  /** The dynamic route resolves this from the actor-owned onboarding record. */
  brandContext: SagaAuthoringBrandContext;
  /** Transient, server-owned first-draft generation; it accepts opaque knowledge IDs. */
  authoringPreviewApiPath?: string;
  /** Test seam only. Production uses the actor-scoped route. */
  knowledgePolicyApiPath?: string;
  /** Test seam only. Production uses safe, workspace-owned entry summaries. */
  knowledgeEntriesApiPath?: string;
  /** Durable batch endpoint; no browser-only series substitute exists. */
  authoringRunsApiPath?: string;
};

const objectives: Array<{ id: SagaAuthoringObjective; label: string; detail: string; brief: string }> = [
  {
    id: "explain",
    label: "Gör något begripligt",
    detail: "Hjälp läsaren att förstå en fråga, ett val eller en förändring.",
    brief: "Förklara tydligt med ett konkret exempel och utan onödigt fackspråk.",
  },
  {
    id: "position",
    label: "Ta en tydlig position",
    detail: "Sätt ord på en erfarenhet eller en genomtänkt ståndpunkt.",
    brief: "Ta en tydlig men ödmjuk position. Prioritera ett verkligt resonemang framför tvärsäkerhet.",
  },
  {
    id: "trust",
    label: "Bygg förtroende",
    detail: "Visa metod, insikt eller begränsning som gör budskapet trovärdigt.",
    brief: "Bygg förtroende med konkreta detaljer, tydliga begränsningar och ett användbart nästa steg.",
  },
  {
    id: "response",
    label: "Starta ett samtal",
    detail: "Öppna för en relevant reaktion, inte bara räckvidd.",
    brief: "Gör det lätt för rätt person att svara eller ta nästa steg utan tomma uppmaningar.",
  },
];

const channelChoices: Array<{ id: StudioChannelKind; label: string }> = [
  { id: "linkedin", label: "LinkedIn" },
  { id: "instagram", label: "Instagram" },
  { id: "facebook_page", label: "Facebook" },
  { id: "newsletter", label: "Nyhetsbrev" },
];

const contentTypeChoices: Array<{ id: StudioContentKind; label: string }> = [
  { id: "social_post", label: "Inlägg" },
  { id: "newsletter", label: "Nyhetsbrev" },
  { id: "article", label: "Artikel" },
];

const initialForm: AuthoringForm = {
  objective: "explain",
  topics: [],
  prompt: "",
  includeAuthorName: false,
  contentType: "social_post",
  channels: ["linkedin"],
  targetLength: "medium",
  selectedKnowledgeEntryIds: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function boundedRevision(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 2_147_483_647 ? value : null;
}

function uuid(value: unknown): string | null {
  const candidate = stringValue(value).trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(candidate) ? candidate : null;
}

function responseData(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  if (isRecord(value.data)) return value.data;
  return value;
}

function responseMessage(value: unknown, fallback: string): string {
  const record = responseData(value);
  return record ? stringValue(record.error ?? record.message ?? record.detail, fallback) || fallback : fallback;
}

export function sagaAuthoringQualityFromPayload(value: unknown): SagaAuthoringQuality | null {
  if (!isRecord(value)) return null;
  const decision = value.decision;
  if (decision !== "approved" && decision !== "review_required" && decision !== "blocked") return null;
  const score = integerInRange(value.score, 0, 100);
  if (score === null || typeof value.canCreatePrivateDraft !== "boolean") return null;
  const findings = Array.isArray(value.findings)
    ? value.findings.flatMap((finding): Array<{ severity: "blocker" | "warning"; message: string }> => {
      if (!isRecord(finding)) return [];
      const severity = finding.severity;
      const message = stringValue(finding.message).trim();
      return (severity === "blocker" || severity === "warning") && message
        ? [{ severity, message }]
        : [];
    }).slice(0, 4)
    : [];
  return { decision, score, findings, canCreatePrivateDraft: value.canCreatePrivateDraft };
}

function createIdempotencyKey(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  // Browser-only fallback. The server still validates the UUID before writing.
  return "00000000-0000-4000-8000-" + Math.random().toString(16).slice(2, 14).padEnd(12, "0");
}

/** The daily knowledge policy accepts one to twelve explicit subjects. */
export function sagaAuthoringTopics(value: readonly string[]): string[] {
  const unique = new Set<string>();
  for (const entry of value) {
    const normalized = entry.trim().replace(/\s+/g, " ").slice(0, 120);
    if (normalized) unique.add(normalized);
    if (unique.size >= 12) break;
  }
  return [...unique];
}

/** Always keep the one-off request human readable in saved draft metadata. */
export function sagaAuthoringBrief(form: Pick<AuthoringForm, "objective" | "topics" | "prompt">): string {
  const objective = objectives.find((item) => item.id === form.objective) ?? objectives[0]!;
  const sections = [
    `Mål: ${objective.label}. ${objective.brief}`,
    form.topics.length ? `Ämnen: ${form.topics.join(", ")}.` : "",
    form.prompt.trim(),
  ].filter(Boolean);
  return sections.join("\n\n");
}

/** The durable batch contract expects a human-readable goal, never a UI enum. */
export function sagaAuthoringObjective(value: SagaAuthoringObjective): string {
  const objective = objectives.find((item) => item.id === value) ?? objectives[0]!;
  return `${objective.label}. ${objective.brief}`;
}

/**
 * Maps the simple authoring surface to the existing, non-persisting copy API.
 * Daily knowledge is intentionally absent: that legacy endpoint cannot resolve
 * opaque entry IDs server-side, so only the durable authoring run may use it.
 */
export function sagaAuthoringGenerationPayload(form: AuthoringForm, briefOverride?: string) {
  const topic = form.topics.join(", ");
  return {
    contentType: form.contentType,
    channels: normalisedChannels(form.contentType, form.channels),
    topic,
    brief: briefOverride?.trim() || sagaAuthoringBrief(form),
    voice: "Rak, varm och konkret svenska. Undvik reklamspråk och tomma superlativ.",
    targetLength: form.targetLength,
    templateInstructions: "Gör texten specifik nog att redigera. Gör inga faktapåståenden som saknar underlag.",
    desiredCallToAction: "",
    avoid: "Hitta inte på siffror, citat, kundcase eller aktuella fakta. Skriv inte som att något redan är publicerat.",
    imageDirection: "Dokumentär, naturlig och trovärdig. Undvik perfekta reklambilder, text och logotyper i motivet.",
    language: "sv" as const,
  };
}

/** Opaque IDs only: the preview route resolves owned knowledge server-side. */
export function sagaAuthoringPreviewPayload(form: AuthoringForm, briefOverride?: string) {
  return {
    ...sagaAuthoringGenerationPayload(form, briefOverride),
    selectedKnowledgeEntryIds: form.selectedKnowledgeEntryIds
      .map(uuid)
      .filter((id): id is string => Boolean(id))
      .slice(0, 12),
  };
}

/** Exact persistent document shape for the existing Studio draft write contract. */
export function sagaAuthoringDraftPayload(draft: StudioDraftView) {
  const isNewsletter = draft.contentType === "newsletter";
  const channels = normalisedChannels(draft.contentType, draft.channels);
  const expectedRevision = uuid(draft.id) && boundedRevision(draft.revision);
  return {
    contentType: draft.contentType,
    channels: isNewsletter ? ["newsletter"] : channels.filter((channel) => channel !== "newsletter"),
    title: draft.title.trim(),
    headline: nullableText(draft.headline),
    subject: nullableText(draft.subject),
    body: draft.body,
    cta: nullableText(draft.cta),
    excerpt: nullableText(draft.excerpt),
    hashtags: draft.hashtags.split(/[\s,]+/).map((entry) => entry.trim()).filter(Boolean).slice(0, 30),
    status: "draft" as const,
    generationPrompt: nullableText(draft.generationPrompt),
    imagePrompt: nullableText(draft.imagePrompt),
    language: "sv",
    timezone: draft.timezone,
    scheduledAt: null,
    scheduledLocalDate: null,
    scheduledLocalTime: null,
    approvalRequired: true,
    templateId: null,
    automationRuleId: null,
    newsletterAudienceId: null,
    ...(expectedRevision ? { expectedRevision } : {}),
  };
}

/** The browser carries only opaque owned IDs; the server resolves all content. */
export function sagaAuthoringRunPayload(input: {
  referenceDraft: StudioDraftView;
  form: AuthoringForm;
  candidateCount: number;
  idempotencyKey: string;
}) {
  const revision = boundedRevision(input.referenceDraft.revision);
  return {
    idempotencyKey: input.idempotencyKey,
    referenceDraftId: input.referenceDraft.id,
    expectedReferenceDraftRevision: revision,
    objective: sagaAuthoringObjective(input.form.objective),
    // The user can edit this exact prompt in the saved reference document.
    // A name is deliberately never interpolated here: the batch server owns
    // the signed-in profile lookup when includeAuthorName is true.
    prompt: input.referenceDraft.generationPrompt.trim() || sagaAuthoringBrief(input.form),
    includeAuthorName: input.form.includeAuthorName,
    selectedKnowledgeEntryIds: input.form.selectedKnowledgeEntryIds
      .map(uuid)
      .filter((id): id is string => Boolean(id))
      .slice(0, 12),
    candidateCount: Math.max(1, Math.min(SAGA_AUTHORING_MAX_SERIES_SIZE, Math.floor(input.candidateCount))),
  };
}

/** A new saved revision must start a new, explicitly approved series. */
export function sagaAuthoringReferenceRevisionAdvanced(previous: unknown, next: unknown): boolean {
  const previousRevision = boundedRevision(previous);
  const nextRevision = boundedRevision(next);
  return nextRevision !== null && (previousRevision === null || nextRevision > previousRevision);
}

export function sagaAuthoringRunFromPayload(value: unknown): SagaAuthoringRun | null {
  const root = responseData(value);
  const record = root && isRecord(root.run) ? root.run : root;
  if (!record) return null;
  const id = uuid(record.id);
  if (!id) return null;
  const rawCandidates = Array.isArray(record.candidates) ? record.candidates : [];
  const candidates = rawCandidates.flatMap((entry): SagaAuthoringCandidate[] => {
    if (!isRecord(entry)) return [];
    const candidateId = uuid(entry.id);
    if (!candidateId) return [];
    const proposal = isRecord(entry.content) ? entry.content : isRecord(entry.draft) ? entry.draft : entry;
    return [{
      id: candidateId,
      revision: boundedRevision(entry.revision),
      state: stringValue(entry.state ?? entry.status, "queued"),
      title: stringValue(proposal.title),
      headline: stringValue(proposal.headline),
      body: stringValue(proposal.body),
      selectedDraftId: uuid(entry.selectedDraftId ?? entry.selected_draft_id ?? entry.contentDraftId ?? entry.content_draft_id),
      quality: sagaAuthoringQualityFromPayload(entry.quality),
      error: nullableText(stringValue(entry.error ?? entry.errorMessage ?? entry.error_message)),
    }];
  });
  const candidateCount = integerInRange(record.candidateCount ?? record.candidate_count, 1, SAGA_AUTHORING_MAX_SERIES_SIZE) ?? candidates.length;
  const generationProgress = sagaAuthoringProgressFromPayload(record.generationProgress ?? record.generation_progress, candidateCount, candidates);
  const knowledge = sagaKnowledgeEntriesFromPayload({ data: Array.isArray(record.knowledge) ? record.knowledge : [] }) ?? [];
  return {
    id,
    revision: boundedRevision(record.revision),
    state: stringValue(record.state ?? record.status, "queued"),
    candidateCount,
    candidates,
    canGenerate: record.canGenerate === true,
    canRetry: record.canRetry === true,
    canSelect: record.canSelect === true,
    hasPendingWork: record.hasPendingWork === true,
    canContinue: record.canContinue === true,
    failureMessage: nullableText(stringValue(record.failureMessage ?? record.failure_message)),
    generationProgress,
    knowledge,
  };
}

function sagaAuthoringProgressFromPayload(
  value: unknown,
  fallbackTotal: number,
  candidates: readonly SagaAuthoringCandidate[],
): SagaAuthoringGenerationProgress {
  const supportedStates = ["queued", "generating", "ready", "blocked", "failed", "selected", "notSelected"] as const;
  const derived = Object.fromEntries(supportedStates.map((state) => [state, 0])) as Record<(typeof supportedStates)[number], number>;
  for (const candidate of candidates) {
    if (candidate.state === "not_selected") derived.notSelected += 1;
    else if (supportedStates.includes(candidate.state as (typeof supportedStates)[number])) derived[candidate.state as (typeof supportedStates)[number]] += 1;
  }
  const record = isRecord(value) ? value : null;
  const total = integerInRange(record?.total, 1, SAGA_AUTHORING_MAX_SERIES_SIZE) ?? fallbackTotal;
  const number = (key: string, fallback: number) => integerInRange(record?.[key], 0, SAGA_AUTHORING_MAX_SERIES_SIZE) ?? fallback;
  const queued = number("queued", derived.queued);
  const generating = number("generating", derived.generating);
  const pending = number("pending", queued + generating);
  return {
    total,
    pending,
    completed: number("completed", Math.max(0, total - pending)),
    queued,
    generating,
    ready: number("ready", derived.ready),
    blocked: number("blocked", derived.blocked),
    failed: number("failed", derived.failed),
    selected: number("selected", derived.selected),
    notSelected: number("notSelected", derived.notSelected),
  };
}

export function sagaKnowledgeEntriesFromPayload(value: unknown): SagaKnowledgeEntry[] | null {
  const root = responseData(value);
  const rawEntries = isRecord(value) && Array.isArray(value.data)
    ? value.data
    : root && Array.isArray(root.entries)
      ? root.entries
      : null;
  if (!rawEntries) return null;
  return rawEntries.flatMap((entry): SagaKnowledgeEntry[] => {
    if (!isRecord(entry)) return [];
    const id = uuid(entry.id ?? entry.entryId ?? entry.entry_id);
    const topic = stringValue(entry.topic).trim();
    const title = stringValue(entry.title ?? entry.headline).trim();
    if (!id || !topic || !title) return [];
    return [{
      id,
      topic,
      title,
      summary: stringValue(entry.summary).trim(),
      knowledgeDate: nullableText(stringValue(entry.knowledgeDate ?? entry.knowledge_date ?? entry.occurredAt ?? entry.occurred_at)),
      evidenceCount: integerInRange(entry.evidenceCount ?? entry.evidence_count, 0, 30) ?? 0,
      independentPublisherCount: integerInRange(entry.independentPublisherCount ?? entry.independent_publisher_count, 0, 30) ?? 0,
    }];
  });
}

function knowledgePolicyFromPayload(value: unknown): KnowledgePolicy | null | undefined {
  if (!isRecord(value)) return undefined;
  if ("data" in value && value.data === null) return null;
  const root = responseData(value);
  const record = root && isRecord(root.policy) ? root.policy : root;
  if (!record || !Array.isArray(record.topics) || !Array.isArray(record.sourceIds ?? record.source_ids)) return undefined;
  const sourceIds = (record.sourceIds ?? record.source_ids) as unknown[];
  const sourceIdValues = sourceIds.map(uuid).filter((entry): entry is string => Boolean(entry)).slice(0, 40);
  if (!sourceIdValues.length) return undefined;
  return {
    topics: sagaAuthoringTopics(record.topics.filter((entry): entry is string => typeof entry === "string")),
    revision: boundedRevision(record.revision),
    sourceIds: sourceIdValues,
    enabled: record.enabled === true,
    timezone: stringValue(record.timezone, "Europe/Stockholm"),
    dailyAt: stringValue(record.dailyAt ?? record.daily_at, "06:00"),
    minimumIndependentPublishers: integerInRange(record.minimumIndependentPublishers ?? record.minimum_independent_publishers, 2, 12) ?? 2,
    minimumEvidenceItems: integerInRange(record.minimumEvidenceItems ?? record.minimum_evidence_items, 2, 30) ?? 2,
    maximumEvidenceItems: integerInRange(record.maximumEvidenceItems ?? record.maximum_evidence_items, 2, 30) ?? 8,
    evidenceWindowHours: integerInRange(record.evidenceWindowHours ?? record.evidence_window_hours, 12, 168) ?? 72,
    retentionDays: integerInRange(record.retentionDays ?? record.retention_days, 7, 365) ?? 90,
  };
}

/** Existing Daily Knowledge policies are always written with their CAS revision. */
export function sagaKnowledgePolicyPayload(policy: SagaKnowledgePolicy, topics: readonly string[]) {
  const expectedRevision = boundedRevision(policy.revision);
  const normalizedTopics = sagaAuthoringTopics(topics);
  if (!expectedRevision || !normalizedTopics.length) return null;
  return {
    enabled: policy.enabled,
    timezone: policy.timezone,
    dailyAt: policy.dailyAt,
    topics: normalizedTopics,
    sourceIds: policy.sourceIds,
    minimumIndependentPublishers: policy.minimumIndependentPublishers,
    minimumEvidenceItems: policy.minimumEvidenceItems,
    maximumEvidenceItems: policy.maximumEvidenceItems,
    evidenceWindowHours: policy.evidenceWindowHours,
    retentionDays: policy.retentionDays,
    expectedRevision,
  };
}

export function sagaAuthoringDraftFromPreviewPayload(value: unknown, form: AuthoringForm, generationPrompt = sagaAuthoringBrief(form)): StudioDraftView | null {
  const root = responseData(value);
  const record = root && isRecord(root.draft) ? root.draft : null;
  if (!record) return null;
  const title = stringValue(record.title).trim();
  const body = stringValue(record.body).trim();
  if (!title || !body) return null;
  const now = new Date().toISOString();
  const hashtags = Array.isArray(record.hashtags)
    ? record.hashtags.filter((entry): entry is string => typeof entry === "string").join(" ")
    : stringValue(record.hashtags);
  return {
    id: `local-${createIdempotencyKey()}`,
    contentType: form.contentType,
    channels: normalisedChannels(form.contentType, form.channels),
    title,
    headline: stringValue(record.headline),
    subject: stringValue(record.subject),
    body,
    cta: stringValue(record.callToAction ?? record.cta),
    excerpt: stringValue(record.excerpt),
    hashtags,
    status: "draft",
    generationPrompt,
    imagePrompt: stringValue(record.imagePrompt),
    timezone: "Europe/Stockholm",
    scheduledAt: null,
    scheduledLocalDate: null,
    scheduledLocalTime: null,
    revision: null,
    approvalRequired: true,
    media: [],
    templateId: null,
    automationRuleId: null,
    newsletterAudienceId: null,
    createdAt: now,
    updatedAt: now,
  };
}

function normalisedChannels(contentType: StudioContentKind, channels: readonly StudioChannelKind[]): StudioChannelKind[] {
  if (contentType === "newsletter") return ["newsletter"];
  const unique = [...new Set(channels.filter((channel) => channel !== "newsletter"))];
  return unique.length ? unique : ["linkedin"];
}

function nullableText(value: string): string | null {
  const normalized = value.trim();
  return normalized || null;
}

function integerInRange(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : null;
}

function stockholmDate(): string {
  const fields = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Stockholm",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date()).reduce<Record<string, string>>((result, field) => {
    result[field.type] = field.value;
    return result;
  }, {});
  return `${fields.year}-${fields.month}-${fields.day}`;
}

/** Keep the client inside the frozen, bounded daily-knowledge read contract. */
export function sagaKnowledgeEntriesUrl(apiPath: string, date = stockholmDate()): string {
  const separator = apiPath.includes("?") ? "&" : "?";
  return `${apiPath}${separator}date=${encodeURIComponent(date)}&limit=24`;
}

function runNeedsExplicitContinuation(run: SagaAuthoringRun | null): boolean {
  return Boolean(run?.hasPendingWork || run?.canContinue);
}

function runStatusLabel(run: SagaAuthoringRun | null): string {
  if (!run) return "Väntar på referens";
  if (run.state === "ready_to_select") return "Kandidater redo";
  if (run.state === "selected") return "En kandidat vald";
  if (run.state === "failed") return "Kunde inte skapa serien";
  if (run.canContinue) return "Fortsätt produktionen";
  if (run.state === "queued") return "Redo att starta";
  return "Privat körning";
}

function qualityLabel(quality: SagaAuthoringQuality): string {
  if (quality.decision === "approved") return "Kontrollen godkände förslaget";
  if (quality.decision === "review_required") return "Kontrollen kräver mänsklig granskning";
  return "Kontrollen stoppade förslaget";
}

function progressLabel(progress: SagaAuthoringGenerationProgress): string {
  const parts = [`${progress.completed} av ${progress.total} bearbetade`, `${progress.pending} återstår`];
  if (progress.ready) parts.push(`${progress.ready} redo`);
  if (progress.blocked) parts.push(`${progress.blocked} stoppade av kvalitetskontrollen`);
  if (progress.failed) parts.push(`${progress.failed} misslyckade`);
  return parts.join(" · ");
}

function candidateStatusLabel(candidate: SagaAuthoringCandidate): string {
  if (candidate.state === "blocked") return "Stoppad av kvalitetskontrollen";
  if (candidate.state === "failed") return candidate.error || "Kunde inte skapas";
  if (candidate.state === "not_selected") return "Inte vald";
  if (candidate.state === "selected") return "Vald för redigering";
  if (candidate.state === "generating" || candidate.state === "queued") return "Väntar på nästa serversteg";
  return "Inte valbar i den här körningen";
}

/** A candidate becomes selectable only at the server's explicit review gate. */
export function sagaAuthoringCanSelectCandidate(run: SagaAuthoringRun | null, candidate: SagaAuthoringCandidate): boolean {
  return Boolean(
    run
    && run.state === "ready_to_select"
    && run.canSelect
    && candidate.state === "ready"
    && boundedRevision(run.revision)
    && boundedRevision(candidate.revision),
  );
}

export function SagaAuthoringWorkspace({
  brandContext,
  authoringPreviewApiPath = "/api/saga/authoring-preview",
  knowledgePolicyApiPath = "/api/saga/knowledge/policy",
  knowledgeEntriesApiPath = "/api/saga/knowledge/entries",
  authoringRunsApiPath = "/api/saga/authoring-runs",
}: SagaAuthoringWorkspaceProps) {
  const selectedBrandId = brandContext.status === "completed" ? brandContext.brandProfileId : null;
  const brandApiPath = useCallback((path: string) => {
    const url = new URL(path, "https://studio.invalid");
    if (selectedBrandId) url.searchParams.set("brandProfileId", selectedBrandId);
    return `${url.pathname}${url.search}`;
  }, [selectedBrandId]);
  const [form, setForm] = useState<AuthoringForm>(initialForm);
  const [topicInput, setTopicInput] = useState("");
  const [knowledgePolicy, setKnowledgePolicy] = useState<KnowledgePolicy | null>(null);
  const [knowledgePolicyState, setKnowledgePolicyState] = useState<LoadState>("checking");
  const [knowledgeEntries, setKnowledgeEntries] = useState<SagaKnowledgeEntry[]>([]);
  const [knowledgeEntriesState, setKnowledgeEntriesState] = useState<LoadState>("checking");
  const [knowledgeOpen, setKnowledgeOpen] = useState(false);
  const [draft, setDraft] = useState<StudioDraftView | null>(null);
  const [previewQuality, setPreviewQuality] = useState<SagaAuthoringQuality | null>(null);
  const [generationState, setGenerationState] = useState<ActionState>("idle");
  const [saveState, setSaveState] = useState<ActionState>("idle");
  const [policySaveState, setPolicySaveState] = useState<ActionState>("idle");
  const [runState, setRunState] = useState<LoadState>("checking");
  const [runUnavailableReason, setRunUnavailableReason] = useState<string | null>(null);
  const [runActionState, setRunActionState] = useState<ActionState>("idle");
  const [run, setRun] = useState<SagaAuthoringRun | null>(null);
  const [candidateCount, setCandidateCount] = useState(5);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const runCreateKey = useRef<string | null>(null);
  const selectKeys = useRef(new Map<string, string>());
  const prefix = useId().replace(/:/g, "");

  const savedDraft = Boolean(draft && uuid(draft.id) && boundedRevision(draft.revision));
  const policyDirty = useMemo(
    () => JSON.stringify(sagaAuthoringTopics(form.topics)) !== JSON.stringify(knowledgePolicy?.topics ?? []),
    [form.topics, knowledgePolicy],
  );

  const loadKnowledgePolicy = useCallback(async () => {
    setKnowledgePolicyState("checking");
    try {
      const response = await fetch(brandApiPath(knowledgePolicyApiPath), { credentials: "same-origin", cache: "no-store" });
      const payload: unknown = await response.json().catch(() => null);
      const policy = response.ok ? knowledgePolicyFromPayload(payload) : null;
      if (!response.ok || policy === undefined) {
        setKnowledgePolicy(null);
        setKnowledgePolicyState("unavailable");
        return;
      }
      setKnowledgePolicy(policy);
      setKnowledgePolicyState("ready");
      if (policy) {
        setForm((current) => current.topics.length ? current : { ...current, topics: policy.topics });
      }
    } catch {
      setKnowledgePolicy(null);
      setKnowledgePolicyState("unavailable");
    }
  }, [knowledgePolicyApiPath, brandApiPath]);

  const loadKnowledgeEntries = useCallback(async () => {
    setKnowledgeEntriesState("checking");
    try {
      const response = await fetch(brandApiPath(sagaKnowledgeEntriesUrl(knowledgeEntriesApiPath)), { credentials: "same-origin", cache: "no-store" });
      const payload: unknown = await response.json().catch(() => null);
      const entries = response.ok ? sagaKnowledgeEntriesFromPayload(payload) : null;
      if (!entries) {
        setKnowledgeEntries([]);
        setKnowledgeEntriesState("unavailable");
        return;
      }
      setKnowledgeEntries(entries);
      setKnowledgeEntriesState("ready");
      setForm((current) => ({
        ...current,
        selectedKnowledgeEntryIds: current.selectedKnowledgeEntryIds.filter((id) => entries.some((entry) => entry.id === id)),
      }));
    } catch {
      setKnowledgeEntries([]);
      setKnowledgeEntriesState("unavailable");
    }
  }, [knowledgeEntriesApiPath, brandApiPath]);

  const loadRuns = useCallback(async () => {
    setRunState("checking");
    try {
      const response = await fetch(brandApiPath(authoringRunsApiPath), { credentials: "same-origin", cache: "no-store" });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        setRunUnavailableReason(responseMessage(payload, response.status === 401 ? "Logga in för att kontrollera batchmotorn." : "Batchmotorn kunde inte bekräftas just nu."));
        setRunState("unavailable");
        return;
      }
      setRunUnavailableReason(null);
      setRunState("ready");
      const root = responseData(payload);
      const candidates = root && Array.isArray(root.runs) ? root.runs : [];
      const latest = candidates.map(sagaAuthoringRunFromPayload).find((entry): entry is SagaAuthoringRun => Boolean(entry)) ?? null;
      if (latest) setRun(latest);
    } catch {
      setRunUnavailableReason("Batchmotorn kunde inte bekräftas just nu.");
      setRunState("unavailable");
    }
  }, [authoringRunsApiPath, brandApiPath]);

  useEffect(() => {
    if (brandContext.status !== "completed") return;
    // Defer initial external reads until after this paint. The load functions
    // update state from their fetch lifecycle rather than during the effect.
    const timer = window.setTimeout(() => {
      void Promise.all([loadKnowledgePolicy(), loadRuns()]);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [brandContext.status, loadKnowledgePolicy, loadRuns]);

  function updateForm<K extends keyof AuthoringForm>(key: K, value: AuthoringForm[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function addTopic() {
    const candidate = topicInput.trim();
    if (!candidate) return;
    setForm((current) => ({ ...current, topics: sagaAuthoringTopics([...current.topics, candidate]) }));
    setTopicInput("");
  }

  function removeTopic(topic: string) {
    setForm((current) => ({ ...current, topics: current.topics.filter((entry) => entry !== topic) }));
  }

  function changeContentType(contentType: StudioContentKind) {
    updateForm("contentType", contentType);
    updateForm("channels", normalisedChannels(contentType, form.channels));
  }

  function toggleChannel(channel: StudioChannelKind) {
    if (form.contentType === "newsletter") return;
    updateForm("channels", normalisedChannels(form.contentType, form.channels.includes(channel)
      ? form.channels.filter((item) => item !== channel)
      : [...form.channels, channel]));
  }

  function toggleKnowledgeEntry(id: string) {
    updateForm("selectedKnowledgeEntryIds", form.selectedKnowledgeEntryIds.includes(id)
      ? form.selectedKnowledgeEntryIds.filter((entry) => entry !== id)
      : [...form.selectedKnowledgeEntryIds, id].slice(0, 12));
  }

  async function saveKnowledgePolicy() {
    if (knowledgePolicyState !== "ready") {
      setError("Kunskapspolicyn kan inte bekräftas ännu. Ämnena används i utkastet, men blir inte sparade för daglig uppdatering.");
      return;
    }
    if (!knowledgePolicy) {
      setError("Lägg först till minst en godkänd källa i Research. Utan en sparad källa kan SAGA inte skapa en daglig kunskapspolicy.");
      return;
    }
    const policyTopics = sagaAuthoringTopics(form.topics);
    if (!policyTopics.length) {
      setError("Välj minst ett ämne innan du sparar den dagliga kunskapspolicyn.");
      return;
    }
    const policyPayload = sagaKnowledgePolicyPayload(knowledgePolicy, policyTopics);
    if (!policyPayload) {
      setError("Kunskapspolicyn saknar en bekräftad version. Läs in Research igen innan du sparar.");
      return;
    }
    setPolicySaveState("working");
    setError(null);
    try {
      const response = await fetch(brandApiPath(knowledgePolicyApiPath), {
        method: "PUT",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(policyPayload),
      });
      const payload: unknown = await response.json().catch(() => null);
      const policy = response.ok ? knowledgePolicyFromPayload(payload) : null;
      if (!policy || policy === undefined) throw new Error(response.status === 409 ? "Kunskapspolicyn har ändrats i en annan vy. Läs in den igen och försök på nytt." : responseMessage(payload, "Kunskapspolicyn kunde inte sparas."));
      setKnowledgePolicy(policy);
      setForm((current) => ({ ...current, topics: policy.topics }));
      setNotice(policy.enabled ? "Ämnena är sparade för den dagliga kunskapsuppdateringen." : "Ämnena är sparade, men den dagliga kunskapskörningen är avstängd i Research.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Kunskapspolicyn kunde inte sparas.");
    } finally {
      setPolicySaveState("idle");
    }
  }

  async function openKnowledge() {
    setKnowledgeOpen((open) => !open);
    if (!knowledgeOpen && knowledgeEntriesState !== "ready") await loadKnowledgeEntries();
  }

  async function generateDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = sagaAuthoringPreviewPayload(form, draft?.generationPrompt);
    if (input.topic.trim().length < 3) {
      setError("Välj eller skriv minst ett ämne innan AI:n gör ett första utkast.");
      return;
    }
    if (form.prompt.trim().length < 3) {
      setError("Skriv en kort instruktion till AI:n så att utkastet får en tydlig riktning.");
      return;
    }
    if (input.brief.length > 4_000) {
      setError("Den samlade AI-prompten är för lång för en senare serie. Kort ned den till högst 4 000 tecken.");
      return;
    }
    setGenerationState("working");
    setError(null);
    setPreviewQuality(null);
    try {
      const response = await fetch(brandApiPath(authoringPreviewApiPath), {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      const payload: unknown = await response.json().catch(() => null);
      const generated = response.ok ? sagaAuthoringDraftFromPreviewPayload(payload, form, input.brief) : null;
      if (!generated) throw new Error(responseMessage(payload, "AI-utkastet kunde inte skapas. Inget har sparats."));
      setDraft(generated);
      const preview = responseData(payload);
      setPreviewQuality(sagaAuthoringQualityFromPayload(preview?.quality));
      setRun(null);
      runCreateKey.current = null;
      setNotice("Första AI-utkastet är klart. Ändra text och prompt fritt, och spara först den version du vill använda som referens.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "AI-utkastet kunde inte skapas. Inget har sparats.");
    } finally {
      setGenerationState("idle");
    }
  }

  function updateDraft<K extends keyof StudioDraftView>(key: K, value: StudioDraftView[K]) {
    setDraft((current) => current ? { ...current, [key]: value, updatedAt: new Date().toISOString() } : current);
  }

  async function saveDraft() {
    if (!draft) return;
    if (!draft.title.trim() || !draft.body.trim()) {
      setError("Utkastet behöver en titel och text innan det kan sparas.");
      return;
    }
    const currentId = uuid(draft.id);
    setSaveState("working");
    setError(null);
    try {
      const response = await fetch(brandApiPath(currentId ? `/api/content/drafts/${encodeURIComponent(currentId)}` : "/api/content/drafts"), {
        method: currentId ? "PATCH" : "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(sagaAuthoringDraftPayload(draft)),
      });
      const payload: unknown = await response.json().catch(() => null);
      const root = responseData(payload);
      const saved = response.ok && root ? draftFrom(root.draft ?? root) : null;
      if (!saved) throw new Error(responseMessage(payload, "Utkastet kunde inte sparas."));
      const referenceAdvanced = sagaAuthoringReferenceRevisionAdvanced(draft.revision, saved.revision);
      setDraft(saved);
      if (referenceAdvanced) {
        // A batch snapshots a single reference revision. Never let an older
        // batch masquerade as the result of a newly saved reference.
        setRun(null);
        runCreateKey.current = null;
        selectKeys.current.clear();
      }
      setNotice(referenceAdvanced && run
        ? "Utkastet är sparat privat i Studio. Referensen har ändrats; skapa en ny privat serie när du är redo."
        : "Utkastet är sparat privat i Studio. Det är inte schemalagt eller publicerat.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Utkastet kunde inte sparas.");
    } finally {
      setSaveState("idle");
    }
  }

  async function createRun() {
    if (!draft || !savedDraft || !boundedRevision(draft.revision)) {
      setError("Spara den färdiga referensversionen först. Serien får aldrig byggas från ett osparat utkast.");
      return;
    }
    if (runState !== "ready") {
      setError("Seriemotorn kan inte bekräftas ännu. Ingen serie har skapats.");
      return;
    }
    const runPrompt = draft.generationPrompt.trim() || sagaAuthoringBrief(form);
    if (runPrompt.length > 4_000) {
      setError("AI-prompten för serien är för lång. Kort ned den till högst 4 000 tecken innan du fryser referensen.");
      return;
    }
    const idempotencyKey = runCreateKey.current ?? createIdempotencyKey();
    runCreateKey.current = idempotencyKey;
    setRunActionState("working");
    setError(null);
    try {
      const response = await fetch(brandApiPath(authoringRunsApiPath), {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(sagaAuthoringRunPayload({ referenceDraft: draft, form, candidateCount, idempotencyKey })),
      });
      const payload: unknown = await response.json().catch(() => null);
      const created = response.ok ? sagaAuthoringRunFromPayload(payload) : null;
      if (!created) throw new Error(responseMessage(payload, "Serien kunde inte förberedas. Ingen kandidat har skapats."));
      setRun(created);
      try {
        await generateRun(created);
      } catch (reason) {
        setError(reason instanceof Error ? `Referensen är sparad, men produktionen startade inte: ${reason.message}` : "Referensen är sparad, men produktionen startade inte.");
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Serien kunde inte förberedas. Ingen kandidat har skapats.");
    } finally {
      setRunActionState("idle");
    }
  }

  async function generateRun(currentRun: SagaAuthoringRun) {
    const revision = boundedRevision(currentRun.revision);
    if (!revision) throw new Error("Serien saknar en bekräftad version och kan inte startas säkert.");
    const idempotencyKey = createIdempotencyKey();
    const response = await fetch(brandApiPath(`${authoringRunsApiPath}/${encodeURIComponent(currentRun.id)}/generate`), {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey, expectedRunRevision: revision, retryFailed: currentRun.canRetry }),
    });
    const payload: unknown = await response.json().catch(() => null);
    const updated = response.ok ? sagaAuthoringRunFromPayload(payload) : null;
    if (!updated) throw new Error(responseMessage(payload, "Serieproduktionen kunde inte startas. Inget har publicerats."));
    setRun(updated);
    setNotice(`Ett privat kandidatsteg är klart för serien med högst ${updated.candidateCount || candidateCount} variationer. Inget är publicerat eller schemalagt.`);
  }

  async function continueRun() {
    if (!run || !(run.canContinue || run.canGenerate || run.canRetry)) {
      setError("Servern har inte bekräftat att den här serien kan fortsätta.");
      return;
    }
    setRunActionState("working");
    setError(null);
    try {
      await generateRun(run);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Kunde inte fortsätta den privata produktionen.");
    } finally {
      setRunActionState("idle");
    }
  }

  async function refreshRun() {
    if (!run) return;
    setRunActionState("working");
    try {
      const response = await fetch(brandApiPath(`${authoringRunsApiPath}/${encodeURIComponent(run.id)}`), { credentials: "same-origin", cache: "no-store" });
      const payload: unknown = await response.json().catch(() => null);
      const updated = response.ok ? sagaAuthoringRunFromPayload(payload) : null;
      if (!updated) throw new Error(responseMessage(payload, "Kunde inte uppdatera seriestatusen."));
      setRun(updated);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Kunde inte uppdatera seriestatusen.");
    } finally {
      setRunActionState("idle");
    }
  }

  async function selectCandidate(candidate: SagaAuthoringCandidate) {
    if (!run || !sagaAuthoringCanSelectCandidate(run, candidate)) {
      setError("Kandidaten saknar en bekräftad version och kan inte väljas säkert.");
      return;
    }
    const idempotencyKey = selectKeys.current.get(candidate.id) ?? createIdempotencyKey();
    selectKeys.current.set(candidate.id, idempotencyKey);
    setRunActionState("working");
    setError(null);
    try {
      const response = await fetch(brandApiPath(`${authoringRunsApiPath}/${encodeURIComponent(run.id)}/candidates/${encodeURIComponent(candidate.id)}/select`), {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          idempotencyKey,
          expectedRunRevision: run.revision,
          expectedCandidateRevision: candidate.revision,
        }),
      });
      const payload: unknown = await response.json().catch(() => null);
      const updated = response.ok ? sagaAuthoringRunFromPayload(payload) : null;
      if (!updated) throw new Error(responseMessage(payload, "Kandidaten kunde inte väljas."));
      setRun(updated);
      setNotice("Kandidaten är vald. Servern skapar nu ett eget privat Studio-utkast som kan redigeras fullt ut.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Kandidaten kunde inte väljas.");
    } finally {
      setRunActionState("idle");
    }
  }

  if (brandContext.status !== "completed") {
    return (
      <section className={styles.workspace} aria-labelledby={`${prefix}-title`}>
        <header className={styles.header}>
          <div>
            <p className={styles.eyebrow}>INNEHÅLL / STARTPUNKT</p>
            <h1 id={`${prefix}-title`}>Sätt varumärkesgrunden först.</h1>
            <p>Studio skapar inte ett fristående AI-utkast förrän arbetsytan har en verifierad grund för mål, målgrupp, årsplan och budgetram.</p>
          </div>
          <aside className={styles.safetyCard} aria-label="Produktionsgräns">
            <span aria-hidden="true">01</span>
            <div><strong>Brand → plan → referens</strong><small>Inget utkast, schema eller utskick har skapats.</small></div>
          </aside>
        </header>
        <AuthoringBrandGate context={brandContext} />
      </section>
    );
  }

  const planHref = `/studio/plan?brandProfileId=${encodeURIComponent(brandContext.brandProfileId)}`;

  return (
    <section className={styles.workspace} aria-labelledby={`${prefix}-title`}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>INNEHÅLL / NYTT UTKAST</p>
          <h1 id={`${prefix}-title`}>Skapa ett redigerbart utkast.</h1>
          <p>Ange mål, ämnen och instruktion. Generera, redigera och spara en referensversion. Därefter kan du skapa högst tio privata variationer för granskning.</p>
        </div>
        <aside className={styles.safetyCard} aria-label="Produktionsgräns">
          <span aria-hidden="true">OK</span>
          <div><strong>Privat arbetsläge</strong><small>Här skapas inga utskick, scheman eller publiceringar.</small></div>
        </aside>
      </header>

      <section className={styles.brandContext} aria-label="Verifierad varumärkesgrund">
        <div>
          <p>VARUMÄRKESGRUND VERIFIERAD</p>
          <strong>{brandContext.brandName}</strong>
          <small>Onboarding med årsram och budget är sparad. Planera nästa 13 veckor eller skapa ett fristående referensutkast.</small>
        </div>
        <Link href={planHref}>Öppna aktivitetsplan <span aria-hidden="true">→</span></Link>
      </section>

      {(notice || error) && <div className={error ? styles.messageError : styles.message} role={error ? "alert" : "status"} aria-live="polite">
        <span>{error ?? notice}</span><button type="button" onClick={() => { setNotice(null); setError(null); }} aria-label="Stäng meddelande">×</button>
      </div>}

      <div className={styles.flow} aria-label="Skapaflöde">
        <span className={styles.flowDone}>1. Riktning</span><i aria-hidden="true" />
        <span className={draft ? styles.flowDone : undefined}>2. Utkast</span><i aria-hidden="true" />
        <span className={savedDraft ? styles.flowDone : undefined}>3. Referens</span><i aria-hidden="true" />
        <span className={run ? styles.flowDone : undefined}>4. Serie</span>
      </div>

      <form className={styles.authoringGrid} onSubmit={generateDraft}>
        <aside className={styles.briefPanel} aria-label="Brief och riktning">
          <section>
            <div className={styles.sectionTitle}><span>01</span><div><p>VÄLJ MÅL</p><h2>Vad ska texten göra?</h2></div></div>
            <div className={styles.objectiveGrid}>
              {objectives.map((objective) => <label className={form.objective === objective.id ? styles.objectiveActive : undefined} key={objective.id}>
                <input type="radio" name="objective" checked={form.objective === objective.id} onChange={() => updateForm("objective", objective.id)} />
                <strong>{objective.label}</strong><small>{objective.detail}</small>
              </label>)}
            </div>
          </section>

          <section>
            <div className={styles.sectionTitle}><span>02</span><div><p>ÄMNEN</p><h2>Vad ska SAGA följa?</h2></div></div>
            <div className={styles.topicInputRow}>
              <input value={topicInput} onChange={(event) => setTopicInput(event.target.value)} onKeyDown={(event) => {
                if (event.key === "Enter") { event.preventDefault(); addTopic(); }
              }} placeholder="Exempel: automation av mänskligt arbete" aria-label="Lägg till ämne" />
              <button type="button" onClick={addTopic}>Lägg till</button>
            </div>
            {form.topics.length ? <ul className={styles.topicList} aria-label="Valda ämnen">{form.topics.map((topic) => <li key={topic}><span>{topic}</span><button type="button" onClick={() => removeTopic(topic)} aria-label={`Ta bort ${topic}`}>×</button></li>)}</ul> : <p className={styles.hint}>Välj ett eller flera ämnen. De blir både skrivram och, när du sparar dem, bevakning för din kunskapsgenerator.</p>}
            <div className={styles.knowledgePolicyRow}>
              <span>{knowledgePolicyState === "ready" ? knowledgePolicy ? policyDirty ? "Ändringar är inte sparade för daglig kunskap." : knowledgePolicy.enabled ? "Sparat för daglig kunskap." : "Ämnena är sparade, men den dagliga körningen är avstängd i Research." : "Lägg till en godkänd källa innan bevakningen kan sparas." : knowledgePolicyState === "checking" ? "Kontrollerar kunskapspolicyn…" : "Kunskapspolicyn är inte ansluten ännu."}</span>
              {knowledgePolicyState === "ready" && !knowledgePolicy ? <Link href="/studio/research">Öppna Research</Link> : <button type="button" onClick={() => void saveKnowledgePolicy()} disabled={knowledgePolicyState !== "ready" || !knowledgePolicy || policySaveState === "working" || !policyDirty}>{policySaveState === "working" ? "Sparar…" : "Spara ämnen"}</button>}
            </div>
          </section>

          <section>
            <div className={styles.sectionTitle}><span>03</span><div><p>AKTUELLT UNDERLAG</p><h2>Vill du använda färskt material?</h2></div></div>
            <p className={styles.hint}>SAGA skickar bara dina valda post-id:n till den serverägda AI-körningen. Servern hämtar då korta, arbetsytägda sammanfattningar — inte länkar eller artikeltexter. Granska alltid källor och påståenden i Research.</p>
            <button className={styles.knowledgeToggle} type="button" onClick={() => void openKnowledge()} aria-expanded={knowledgeOpen}>
              {knowledgeOpen ? "Dölj aktuellt underlag" : "Välj aktuellt underlag"}<span aria-hidden="true">{knowledgeOpen ? "↑" : "↓"}</span>
            </button>
            {knowledgeOpen && <div className={styles.knowledgeEntries}>
              {knowledgeEntriesState === "checking" && <p>Hämtar sparade dagsunderlag från arbetsytan…</p>}
              {knowledgeEntriesState === "unavailable" && <div className={styles.unavailable}><strong>Aktuellt underlag är inte tillgängligt.</strong><p>Ingen färsk information skickas till AI:n förrän kunskapsgeneratorn kan bekräfta sparade poster.</p><button type="button" onClick={() => void loadKnowledgeEntries()}>Försök igen</button></div>}
              {knowledgeEntriesState === "ready" && !knowledgeEntries.length && <p>Inga sparade aktuella poster ännu. Spara ämnen och låt kunskapsgeneratorn bygga underlag först.</p>}
              {knowledgeEntriesState === "ready" && knowledgeEntries.map((entry) => <label key={entry.id} className={form.selectedKnowledgeEntryIds.includes(entry.id) ? styles.knowledgeEntrySelected : undefined}>
                <input type="checkbox" checked={form.selectedKnowledgeEntryIds.includes(entry.id)} onChange={() => toggleKnowledgeEntry(entry.id)} />
                <span><small>{entry.topic}{entry.knowledgeDate ? ` · ${entry.knowledgeDate}` : ""}</small><strong>{entry.title}</strong>{entry.summary && <em>{entry.summary}</em>}<b>{entry.evidenceCount} underlag · {entry.independentPublisherCount} oberoende publicister</b></span>
              </label>)}
              {knowledgeEntriesState === "ready" && <Link className={styles.knowledgeResearchLink} href="/studio/research">Öppna Research för källor och underlag <span aria-hidden="true">→</span></Link>}
            </div>}
          </section>

          <section>
            <div className={styles.sectionTitle}><span>04</span><div><p>AVSÄNDARE</p><h2>Vill du använda ditt kontonamn i serien?</h2></div></div>
            <label className={styles.toggleRow}><input type="checkbox" checked={form.includeAuthorName} onChange={(event) => updateForm("includeAuthorName", event.target.checked)} /><span><strong>Använd namnet från mitt konto</strong><small>För serien läser servern endast namnet i din inloggade profil. Saknas det går serien vidare utan namn. Det första AI-utkastet får aldrig ett påhittat namn.</small></span></label>
          </section>

          <section>
            <div className={styles.sectionTitle}><span>05</span><div><p>FORMAT</p><h2>Var ska det fungera?</h2></div></div>
            <div className={styles.typeRow}>{contentTypeChoices.map((choice) => <label className={form.contentType === choice.id ? styles.typeActive : undefined} key={choice.id}><input type="radio" name="contentType" checked={form.contentType === choice.id} onChange={() => changeContentType(choice.id)} />{choice.label}</label>)}</div>
            <fieldset className={styles.channelSet}><legend>Förbered för kanal</legend><div>{channelChoices.map((choice) => {
              const disabled = form.contentType === "newsletter" ? choice.id !== "newsletter" : choice.id === "newsletter";
              return <label className={form.channels.includes(choice.id) ? styles.channelActive : undefined} key={choice.id}><input type="checkbox" checked={form.channels.includes(choice.id)} disabled={disabled} onChange={() => toggleChannel(choice.id)} />{choice.label}</label>;
            })}</div></fieldset>
            <label className={styles.field}><span>Längd</span><select value={form.targetLength} onChange={(event) => updateForm("targetLength", event.target.value as AuthoringForm["targetLength"])}><option value="short">Kort</option><option value="medium">Mellan</option><option value="long">Fördjupad</option></select></label>
          </section>

          <section className={styles.promptSection}>
            <div className={styles.sectionTitle}><span>06</span><div><p>DIN INSTRUKTION</p><h2>Vad är viktigt i just den här texten?</h2></div></div>
            <label className={styles.promptField}><span>Prompt <em>{form.prompt.length}/4 000</em></span><textarea value={form.prompt} onChange={(event) => updateForm("prompt", event.target.value)} rows={7} placeholder="Skriv vinkeln, vilka detaljer som måste finnas med och vad du vill att läsaren ska känna eller förstå." maxLength={4_000} /></label>
            <button className={styles.generateButton} type="submit" disabled={generationState === "working"}>{generationState === "working" ? "AI skapar utkast…" : draft ? "Skapa om från redigerad prompt" : "Skapa första utkastet"}<span aria-hidden="true">→</span></button>
            <small className={styles.privateNote}>AI-svaret är bara ett arbetsförslag. Det sparas inte automatiskt.</small>
          </section>
        </aside>

        <main className={styles.canvas} aria-label="Redaktionell arbetsyta">
          {!draft && <div className={styles.emptyCanvas}><span aria-hidden="true">01</span><p>ARBETSYTA</p><h2>Generera ett första utkast.</h2><p>Välj mål, ämnen och skriv en instruktion. Resultatet blir ett dokument som du kan redigera här.</p></div>}
          {draft && <>
            <header className={styles.canvasHeader}><div><p>UTKAST / {savedDraft ? "SPARAD VERSION" : "OSPARAD VERSION"}</p><h2>{savedDraft ? "Finslipa referensversionen." : "Redigera innan du sparar."}</h2></div><div className={styles.canvasActions}><span>{savedDraft ? `Version ${draft.revision}` : "Inte sparad"}</span><button type="button" onClick={() => void saveDraft()} disabled={saveState === "working"}>{saveState === "working" ? "Sparar…" : savedDraft ? "Spara ändringar" : "Spara utkast"}</button></div></header>
            {previewQuality && <aside className={`${styles.qualityCard} ${previewQuality.decision === "blocked" ? styles.qualityBlocked : previewQuality.decision === "review_required" ? styles.qualityReview : styles.qualityApproved}`} aria-label="Senaste kvalitetskontroll">
              <div><strong>{qualityLabel(previewQuality)}</strong><span>{previewQuality.score}/100</span></div>
              {previewQuality.findings.length > 0 && <ul>{previewQuality.findings.map((finding, index) => <li key={`${finding.severity}-${index}`}>{finding.message}</li>)}</ul>}
              <p>Detta gäller AI-förslaget före dina ändringar. Varje kandidat i en serie kontrolleras igen på servern; blockerade kandidater blir inte valbara.</p>
            </aside>}
            <div className={styles.document}>
              {draft.contentType === "newsletter" && <label className={styles.documentField}><span>Ämnesrad</span><input value={draft.subject} onChange={(event) => updateDraft("subject", event.target.value)} placeholder="Vad får läsaren om den öppnar?" /></label>}
              <label className={styles.documentField}><span>Intern titel</span><input value={draft.title} onChange={(event) => updateDraft("title", event.target.value)} placeholder="Ge utkastet ett namn" /></label>
              <label className={styles.documentField}><span>Rubrik</span><textarea value={draft.headline} onChange={(event) => updateDraft("headline", event.target.value)} rows={3} placeholder="Börja med huvudpoängen." /></label>
              <label className={`${styles.documentField} ${styles.bodyField}`}><span>Text</span><textarea value={draft.body} onChange={(event) => updateDraft("body", event.target.value)} rows={17} placeholder="Skriv eller redigera texten." /></label>
              <div className={styles.documentTwoColumns}><label className={styles.documentField}><span>Avslut / uppmaning</span><input value={draft.cta} onChange={(event) => updateDraft("cta", event.target.value)} placeholder="Ett relevant nästa steg" /></label><label className={styles.documentField}><span>Hashtags</span><input value={draft.hashtags} onChange={(event) => updateDraft("hashtags", event.target.value)} placeholder="#automation #system" /></label></div>
              <details className={styles.promptEditor}><summary>Redigera AI-prompten som följer utkastet</summary><textarea value={draft.generationPrompt} onChange={(event) => updateDraft("generationPrompt", event.target.value)} rows={8} maxLength={4_000} /><small>{draft.generationPrompt.length}/4 000 tecken. Knappen “Skapa om” använder den här redigerade prompten.</small></details>
            </div>
            <footer className={styles.documentFooter}><p>Texten är redigerbar. Bild, tid och publicering beslutas senare i Studio — inte här.</p><button type="button" onClick={() => void saveDraft()} disabled={saveState === "working"}>{saveState === "working" ? "Sparar…" : "Spara privat utkast"}</button></footer>
          </>}
        </main>

        <aside className={styles.seriesPanel} aria-label="Serieproduktion">
          <header><p>SERIEPRODUKTION</p><h2>Skapa variationer från en godkänd referens.</h2><span>{runStatusLabel(run)}</span></header>
          <ol className={styles.seriesSteps}>
            <li className={draft ? styles.stepDone : undefined}><span>01</span><div><strong>Skapa ett utkast</strong><small>{draft ? "En version finns i arbetsytan." : "Väntar på ett första AI-utkast."}</small></div></li>
            <li className={savedDraft ? styles.stepDone : undefined}><span>02</span><div><strong>Spara referensen</strong><small>{savedDraft ? "Servern kan frysa just den här revisionsversionen." : "Kräver ett sparat privat utkast."}</small></div></li>
            <li className={run ? styles.stepDone : undefined}><span>03</span><div><strong>Skapa serien</strong><small>{run ? "Varje kandidat är privat och granskningsbar." : "Max tio variationer i samma körning."}</small></div></li>
          </ol>

          <section className={styles.runControls}>
            <label><span>Antal variationer</span><input type="number" min={1} max={SAGA_AUTHORING_MAX_SERIES_SIZE} value={candidateCount} onChange={(event) => setCandidateCount(Math.max(1, Math.min(SAGA_AUTHORING_MAX_SERIES_SIZE, Number(event.target.value) || 1)))} disabled={!savedDraft || runActionState === "working"} /><small>Högst {SAGA_AUTHORING_MAX_SERIES_SIZE} åt gången så att serien går att bedöma.</small></label>
            <p className={styles.authorNameNote}>{form.includeAuthorName ? "Serien använder kontonamnet i din inloggade profil om ett sådant finns. Saknas det skapas serien utan namn." : "Serien använder inget avsändarnamn automatiskt."}</p>
            {runState === "checking" && <p className={styles.runStatus}>Kontrollerar den säkra batchmotorn…</p>}
            {runState === "unavailable" && <div className={styles.runUnavailable}><strong>Batchmotorn är inte tillgänglig ännu.</strong><p>{runUnavailableReason ?? "Referensen kan sparas, men SAGA skapar inte en osparad låtsasserie i webbläsaren."}</p><button type="button" onClick={() => void loadRuns()}>Kontrollera igen</button></div>}
            {runState === "ready" && <button className={styles.seriesButton} type="button" onClick={() => void createRun()} disabled={!savedDraft || runActionState === "working"}>{runActionState === "working" ? "Förbereder serie…" : `Frys referensen och skapa ${candidateCount} variationer`}<span aria-hidden="true">→</span></button>}
          </section>

          {run && <section className={styles.runResult}>
            <div className={styles.runResultHeader}><div><p>PRIVAT BATCH</p><h3>{run.candidateCount || candidateCount} variationer</h3><small>{runStatusLabel(run)}</small></div><button type="button" onClick={() => void refreshRun()} disabled={runActionState === "working"}>Läs in status</button></div>
            <p className={styles.progressText}>{progressLabel(run.generationProgress)}</p>
            {run.state === "failed" && <p className={styles.failureText}>{run.failureMessage || "Serien behöver ett nytt explicit försök från den sparade referensen. Inget har publicerats eller schemalagts."}</p>}
            {runNeedsExplicitContinuation(run) && <p className={styles.processingText}>Servern har bekräftat att privata kandidatjobb återstår. Det går inte vidare av sig självt från den här vyn.</p>}
            {run.canContinue && <button className={styles.continueButton} type="button" onClick={() => void continueRun()} disabled={runActionState === "working"}>{runActionState === "working" ? "Fortsätter…" : "Fortsätt produktionen"}</button>}
            {!run.canContinue && run.canGenerate && <button className={styles.continueButton} type="button" onClick={() => void continueRun()} disabled={runActionState === "working"}>{runActionState === "working" ? "Startar…" : "Starta privat produktion"}</button>}
            {!run.canContinue && !run.canGenerate && run.canRetry && <button className={styles.continueButton} type="button" onClick={() => void continueRun()} disabled={runActionState === "working"}>{runActionState === "working" ? "Försöker igen…" : "Försök igen säkert"}</button>}
            {run.candidates.length > 0 && <ul className={styles.candidateList}>{run.candidates.map((candidate, index) => <li key={candidate.id}>
              <div><span>Variation {index + 1}</span><strong>{candidate.title || candidate.headline || "Kandidat utan rubrik"}</strong><p>{candidate.body ? truncate(candidate.body, 180) : "Kandidaten förbereds fortfarande."}</p>{candidate.quality && <small className={styles.candidateQuality}>Kvalitetsagent: {qualityLabel(candidate.quality)} · {candidate.quality.score}/100</small>}</div>
              {candidate.selectedDraftId
                ? <Link href={`/studio/content/${encodeURIComponent(candidate.selectedDraftId)}?edit=1`}>Öppna redigerbart utkast <span aria-hidden="true">→</span></Link>
                : sagaAuthoringCanSelectCandidate(run, candidate)
                  ? <button type="button" onClick={() => void selectCandidate(candidate)} disabled={runActionState === "working"}>Välj för redigering</button>
                  : <span className={`${styles.candidateWaiting} ${candidate.state === "blocked" || candidate.state === "failed" || candidate.state === "not_selected" ? styles.candidateTerminal : ""}`}>{candidateStatusLabel(candidate)}</span>}
            </li>)}</ul>}
            {run.knowledge.length > 0 && <section className={styles.frozenKnowledge} aria-label="Fryst kunskapsunderlag">
              <p>FRYST UNDERLAG</p><strong>Det här är de sparade dagsunderlag som servern använde för just den här serien.</strong>
              <ul>{run.knowledge.map((entry) => <li key={entry.id}><span>{entry.topic}{entry.knowledgeDate ? ` · ${entry.knowledgeDate}` : ""}</span><b>{entry.title}</b><small>{entry.evidenceCount} underlag · {entry.independentPublisherCount} oberoende publicister</small></li>)}</ul>
              <Link href="/studio/research">Öppna Research för källor och underlag <span aria-hidden="true">→</span></Link>
            </section>}
            {run.candidates.length > 0 && <p className={styles.candidateNote}>Kandidaterna är oföränderliga jämförelser. När du väljer en gör servern ett eget privat Studio-utkast som du kan redigera fullt ut.</p>}
          </section>}
        </aside>
      </form>
    </section>
  );
}

function AuthoringBrandGate({ context }: { context: Exclude<SagaAuthoringBrandContext, { status: "completed" }> }) {
  if (context.status === "selection_required") {
    return <section className={styles.brandGate} aria-labelledby="authoring-brand-gate-title">
      <p>VÄLJ VARUMÄRKE</p>
      <h2 id="authoring-brand-gate-title">Vilket varumärke ska utkastet tillhöra?</h2>
      <p>Välj en slutförd aktiv varumärkesgrund innan du skapar text. Valet avgör vilken plan, budgetram och framtida serie som används — Studio väljer aldrig en profil åt dig.</p>
      <ul className={styles.brandSelectionList} aria-label="Tillgängliga varumärken">
        {context.brands.map((brand) => <li key={brand.brandProfileId}>
          <Link href={`/studio/create?brandProfileId=${encodeURIComponent(brand.brandProfileId)}`}>
            <span><strong>{brand.brandName}</strong><small>Välj som grund för detta utkast</small></span>
            <b aria-hidden="true">→</b>
          </Link>
        </li>)}
      </ul>
      <div className={styles.brandGateActions}>
        <Link href="/studio/brands/new">Skapa ett nytt varumärke <span aria-hidden="true">→</span></Link>
        <a href="/studio/create">Läs in valen igen</a>
      </div>
    </section>;
  }

  if (context.status === "missing") {
    return <section className={styles.brandGate} aria-labelledby="authoring-brand-gate-title">
      <p>FÖRST VARUMÄRKET</p>
      <h2 id="authoring-brand-gate-title">Slutför varumärkesonboarding innan du skriver.</h2>
      <p>Där beslutar du om mål, målgrupp, årsplan och budgetram. Först därefter kan Studio hjälpa dig att skapa och förfina ett referensinlägg.</p>
      <div className={styles.brandGateActions}>
        <Link href="/studio/brands/new">Starta varumärkesonboarding <span aria-hidden="true">→</span></Link>
        <a href="/studio/create">Kontrollera igen</a>
      </div>
    </section>;
  }

  return <section className={styles.brandGate} aria-labelledby="authoring-brand-gate-title">
    <p>VARUMÄRKESGRUND KAN INTE BEKRÄFTAS</p>
    <h2 id="authoring-brand-gate-title">Textproduktionen hålls stängd tills underlaget kan läsas.</h2>
    <p>Studio kunde inte säkert avgöra om arbetsytan har en slutförd varumärkesonboarding. Inget AI-utkast, privat utkast eller serie har skapats.</p>
    <div className={styles.brandGateActions}>
      <a href="/studio/create">Kontrollera igen</a>
      <Link href="/studio/brands/new">Öppna varumärkesonboarding</Link>
    </div>
  </section>;
}

function truncate(value: string, limit: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > limit ? `${compact.slice(0, limit).trimEnd()}…` : compact;
}
