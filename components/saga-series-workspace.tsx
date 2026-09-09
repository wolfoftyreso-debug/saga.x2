"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useState, type ChangeEvent, type FormEvent } from "react";
import styles from "@/components/saga-series-workspace.module.css";

type LoadState = "loading" | "ready" | "unavailable";
type SaveState = "idle" | "saving" | "deleting" | "error";

export type SagaSeriesDraft = {
  id: string;
  revision: number | null;
  title: string;
  body: string;
  channels: string[];
  status: string;
  updatedAt: string | null;
  mediaCount: number;
};

export type SagaSeriesReference = {
  sourceDraftId: string;
  sourceDraftRevision: number | null;
  title: string;
  body: string;
  channels: string[];
  mediaCount: number;
  capturedAt: string | null;
};

export type SagaSeriesObjective = "educate" | "inspire" | "convert" | "community";
export type SagaSeriesTone = "direct" | "warm" | "insightful";
export type SagaSeriesChannel = "facebook_page" | "instagram" | "linkedin" | "newsletter";

export type SagaSeriesControls = {
  objective: SagaSeriesObjective;
  audience: string;
  tone: SagaSeriesTone;
  requiredElements: string[];
  forbiddenElements: string[];
  defaultChannels: SagaSeriesChannel[];
  reviewRequired: true;
};

export type SagaSeries = {
  id: string;
  name: string;
  slug: string;
  revision: number | null;
  active: boolean;
  reference: SagaSeriesReference;
  controls: SagaSeriesControls | null;
  createdAt: string | null;
  updatedAt: string | null;
};

type SeriesControlsForm = {
  objective: SagaSeriesObjective;
  audience: string;
  tone: SagaSeriesTone;
  requiredElements: string;
  forbiddenElements: string;
  defaultChannels: SagaSeriesChannel[];
};

type SagaSeriesWorkspaceProps = {
  /** Test seam only. Production reads the actor-scoped SAGA series endpoint. */
  seriesApiPath?: string;
  /** An explicit saved Studio draft is the only permitted series reference. */
  draftsApiPath?: string;
};

const DEFAULT_CHANNELS: readonly SagaSeriesChannel[] = ["linkedin", "instagram", "facebook_page", "newsletter"];
const DEFAULT_CONTROLS: SeriesControlsForm = {
  objective: "educate",
  audience: "",
  tone: "insightful",
  requiredElements: "",
  forbiddenElements: "",
  defaultChannels: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function nullableText(value: unknown): string | null {
  return text(value) || null;
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 2_147_483_647 ? value : null;
}

function safeStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.flatMap((item) => {
    const entry = text(item);
    return entry && entry.length <= 120 ? [entry] : [];
  }))];
}

function isSeriesObjective(value: unknown): value is SagaSeriesObjective {
  return value === "educate" || value === "inspire" || value === "convert" || value === "community";
}

function isSeriesTone(value: unknown): value is SagaSeriesTone {
  return value === "direct" || value === "warm" || value === "insightful";
}

function isSeriesChannel(value: unknown): value is SagaSeriesChannel {
  return value === "facebook_page" || value === "instagram" || value === "linkedin" || value === "newsletter";
}

function controlsList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 6) return null;
  const items = value.map((item) => text(item));
  if (items.some((item) => !item || item.length > 200) || new Set(items).size !== items.length) return null;
  return items;
}

function mediaCount(value: unknown): number {
  return Array.isArray(value) ? value.filter(isRecord).length : 0;
}

function readReference(value: unknown): SagaSeriesReference | null {
  if (!isRecord(value)) return null;
  const sourceDraftId = text(value.sourceDraftId ?? value.source_draft_id);
  if (!sourceDraftId) return null;

  return {
    sourceDraftId,
    sourceDraftRevision: integer(value.sourceDraftRevision ?? value.source_draft_revision),
    title: text(value.title ?? value.headline, "Sparat utkast"),
    body: text(value.body ?? value.excerpt),
    channels: safeStrings(value.channels),
    // The reference intentionally retains a count only. Raw media addresses
    // must never move from a content draft into this client surface.
    mediaCount: mediaCount(value.media),
    capturedAt: nullableText(value.capturedAt ?? value.captured_at),
  };
}

function readControls(value: unknown): SagaSeriesControls | null {
  if (!isRecord(value)) return null;
  // Series always remain review-gated. Refuse to display a server response as
  // a usable control set if that invariant is weakened.
  if (value.reviewRequired !== true && value.review_required !== true) return null;
  const objective = value.objective;
  const tone = value.tone;
  const audience = text(value.audience);
  const requiredElements = controlsList(value.requiredElements ?? value.required_elements);
  const forbiddenElements = controlsList(value.forbiddenElements ?? value.forbidden_elements);
  const defaultChannelsRaw = value.defaultChannels ?? value.default_channels;
  if (!isSeriesObjective(objective) || !isSeriesTone(tone) || !audience || audience.length > 160 || !requiredElements || !forbiddenElements || !Array.isArray(defaultChannelsRaw)) return null;
  if (defaultChannelsRaw.length > 4 || !defaultChannelsRaw.every(isSeriesChannel) || new Set(defaultChannelsRaw).size !== defaultChannelsRaw.length) return null;
  return {
    objective,
    audience,
    tone,
    requiredElements,
    forbiddenElements,
    defaultChannels: [...defaultChannelsRaw],
    reviewRequired: true,
  };
}

function readSeries(value: unknown): SagaSeries | null {
  if (!isRecord(value)) return null;
  const id = text(value.id);
  const reference = readReference(value.reference);
  if (!id || !reference) return null;
  const rawReference = isRecord(value.reference) ? value.reference : null;
  // The durable contract keeps controls beside the immutable reference
  // snapshot. Accept the short-lived nested shape as a migration fallback;
  // the browser never invents controls when neither exists.
  const rawControls = value.controls ?? rawReference?.controls;
  const controls = rawControls === undefined || rawControls === null ? null : readControls(rawControls);
  // An invalid controls payload must not silently turn into an apparently
  // safe, review-gated series.
  if (rawControls !== undefined && rawControls !== null && !controls) return null;

  return {
    id,
    name: text(value.name, "Namnlös serie"),
    slug: text(value.slug),
    revision: integer(value.revision),
    active: value.active === true,
    reference,
    controls,
    createdAt: nullableText(value.createdAt ?? value.created_at),
    updatedAt: nullableText(value.updatedAt ?? value.updated_at),
  };
}

/** Narrow the persisted contract to editorial data only; it deliberately omits media URLs. */
export function sagaSeriesFromPayload(payload: unknown): SagaSeries[] | null {
  if (!isRecord(payload) || !Array.isArray(payload.series)) return null;
  return payload.series.flatMap((entry): SagaSeries[] => {
    const series = readSeries(entry);
    return series ? [series] : [];
  });
}

/** Mutation endpoints return one confirmed persisted series, never an optimistic substitute. */
export function sagaSeriesMutationFromPayload(payload: unknown): SagaSeries | null {
  if (!isRecord(payload)) return null;
  return readSeries(payload.series);
}

/** A safe, metadata-only list of already persisted Studio drafts. */
export function sagaSeriesDraftsFromPayload(payload: unknown): SagaSeriesDraft[] | null {
  if (!isRecord(payload) || !Array.isArray(payload.drafts)) return null;
  return payload.drafts.flatMap((entry): SagaSeriesDraft[] => {
    if (!isRecord(entry)) return [];
    const id = text(entry.id);
    if (!id) return [];
    return [{
      id,
      revision: integer(entry.revision),
      title: text(entry.title ?? entry.headline ?? entry.subject, "Utan rubrik"),
      body: text(entry.body ?? entry.excerpt),
      channels: safeStrings(entry.channels ?? entry.channelKinds ?? entry.channel_kinds),
      status: text(entry.status, "utkast"),
      updatedAt: nullableText(entry.updatedAt ?? entry.updated_at),
      mediaCount: mediaCount(entry.media),
    }];
  });
}

export function sagaSeriesMessage(payload: unknown, fallback: string): string {
  if (!isRecord(payload)) return fallback;
  if (payload.code === "configuration_required" || payload.code === "configuration_missing" || payload.code === "database_configuration_invalid") {
    return "Arbetsytan behöver vara redo innan innehållsserier kan sparas.";
  }
  return text(payload.error ?? payload.message ?? payload.detail, fallback);
}

function slugFrom(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 79);
}

function controlsLines(value: string): string[] {
  return value.split(/\r?\n|,/).map((entry) => entry.trim()).filter(Boolean);
}

function controlsFormFrom(value: SagaSeriesControls | null): SeriesControlsForm {
  if (!value) return DEFAULT_CONTROLS;
  return {
    objective: value.objective,
    audience: value.audience,
    tone: value.tone,
    requiredElements: value.requiredElements.join("\n"),
    forbiddenElements: value.forbiddenElements.join("\n"),
    defaultChannels: value.defaultChannels,
  };
}

export function sagaSeriesControlsValidation(value: SeriesControlsForm): string | null {
  if (!isSeriesObjective(value.objective)) return "Välj ett syfte för serien.";
  if (!value.audience.trim() || value.audience.trim().length > 160) return "Målgruppen behöver anges med högst 160 tecken.";
  if (!isSeriesTone(value.tone)) return "Välj en godkänd tonalitet.";
  const requiredElements = controlsLines(value.requiredElements);
  const forbiddenElements = controlsLines(value.forbiddenElements);
  for (const [label, elements] of [["Måste finnas med", requiredElements], ["Undvik", forbiddenElements]] as const) {
    if (elements.length > 6) return `${label} kan innehålla högst sex punkter.`;
    if (elements.some((entry) => entry.length > 200)) return `${label} kan ha högst 200 tecken per punkt.`;
    if (new Set(elements.map((entry) => entry.toLocaleLowerCase("sv-SE"))).size !== elements.length) return `${label} innehåller samma punkt flera gånger.`;
  }
  const required = new Set(requiredElements.map((entry) => entry.toLocaleLowerCase("sv-SE")));
  if (forbiddenElements.some((entry) => required.has(entry.toLocaleLowerCase("sv-SE")))) return "Samma punkt kan inte både krävas och undvikas.";
  if (value.defaultChannels.length > 4 || value.defaultChannels.some((channel) => !isSeriesChannel(channel)) || new Set(value.defaultChannels).size !== value.defaultChannels.length) return "Välj högst fyra unika standardkanaler.";
  return null;
}

export function sagaSeriesControlsPayload(value: SeriesControlsForm): SagaSeriesControls {
  return {
    objective: value.objective,
    audience: value.audience.trim(),
    tone: value.tone,
    requiredElements: controlsLines(value.requiredElements),
    forbiddenElements: controlsLines(value.forbiddenElements),
    defaultChannels: value.defaultChannels,
    reviewRequired: true,
  };
}

export function sagaSeriesCreatePayload(input: { name: string; slug: string; referenceDraftId: string; controls: SeriesControlsForm }) {
  return {
    name: input.name.trim(),
    slug: input.slug.trim(),
    referenceDraftId: input.referenceDraftId,
    controls: sagaSeriesControlsPayload(input.controls),
    active: false,
  };
}

export function sagaSeriesUpdatePayload(series: SagaSeries, controls: SeriesControlsForm) {
  return {
    id: series.id,
    expectedRevision: series.revision,
    controls: sagaSeriesControlsPayload(controls),
  };
}

/**
 * Activation is deliberately separate from writing editorial controls. It
 * only makes a frozen, review-gated reference selectable in AI Lab; it does
 * not start an automation, create a calendar item or publish anything.
 */
export function sagaSeriesActivationPayload(series: SagaSeries): { id: string; expectedRevision: number; active: true } | null {
  if (series.active || series.revision === null || !series.reference.sourceDraftId || !series.controls || series.controls.reviewRequired !== true) return null;
  return { id: series.id, expectedRevision: series.revision, active: true };
}

function sagaSeriesDeleteConfirmed(payload: unknown, id: string): boolean {
  return isRecord(payload) && isRecord(payload.deleted) && text(payload.deleted.id) === id;
}

export function sagaSeriesFlowState(series: SagaSeries | null) {
  const hasReference = Boolean(series?.reference.sourceDraftId);
  const hasControls = Boolean(series?.controls?.reviewRequired);
  const active = Boolean(series?.active && hasControls);
  return {
    reference: hasReference ? "complete" : "required",
    controls: hasReference ? hasControls ? "complete" : "ready" : "locked",
    variants: active ? "ready" : hasControls ? "waiting" : "locked",
    calendar: active ? "ready" : hasControls ? "waiting" : "locked",
  } as const;
}

function channelLabel(channel: string): string {
  return { linkedin: "LinkedIn", instagram: "Instagram", facebook_page: "Facebook", newsletter: "Nyhetsbrev" }[channel] ?? channel;
}

function formatWhen(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("sv-SE", { day: "numeric", month: "short", year: "numeric" }).format(date);
}

function excerpt(value: string, max = 220): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max).trimEnd()}…` : compact;
}

function Icon({ name }: { name: "document" | "controls" | "variants" | "calendar" | "arrow" | "reload" | "check" | "lock" | "trash" | "info" }) {
  const props = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  if (name === "document") return <svg viewBox="0 0 24 24" aria-hidden="true"><path {...props} d="M7 3.8h7.4L19 8.4v11.8H7V3.8Zm7.1.5v4.4h4.4M9.6 12h5.1M9.6 15.6h5.1" /></svg>;
  if (name === "controls") return <svg viewBox="0 0 24 24" aria-hidden="true"><path {...props} d="M5 7h14M5 17h14M9 4.5v5M15 14.5v5" /></svg>;
  if (name === "variants") return <svg viewBox="0 0 24 24" aria-hidden="true"><path {...props} d="M5 7.2h8.3M5 12h14M5 16.8h8.3M16.2 5.2 19 7.2l-2.8 2M10.8 14.8 8 16.8l2.8 2" /></svg>;
  if (name === "calendar") return <svg viewBox="0 0 24 24" aria-hidden="true"><rect {...props} x="4" y="5.2" width="16" height="14.2" rx="2.5" /><path {...props} d="M7.6 3.7v3M16.4 3.7v3M4 9.3h16M8 12.7h.01M12 12.7h.01M16 12.7h.01" /></svg>;
  if (name === "arrow") return <svg viewBox="0 0 24 24" aria-hidden="true"><path {...props} d="M5 12h13M13.2 6.8 18.4 12l-5.2 5.2" /></svg>;
  if (name === "reload") return <svg viewBox="0 0 24 24" aria-hidden="true"><path {...props} d="M19.2 9.1A7.5 7.5 0 1 0 19 15M19.2 4.8v4.3h-4.3" /></svg>;
  if (name === "check") return <svg viewBox="0 0 24 24" aria-hidden="true"><path {...props} d="m5 12.4 4.3 4.2L19 6.9" /></svg>;
  if (name === "lock") return <svg viewBox="0 0 24 24" aria-hidden="true"><rect {...props} x="5" y="10.1" width="14" height="10" rx="2.2" /><path {...props} d="M8.3 10.1V7.6a3.7 3.7 0 0 1 7.4 0v2.5" /></svg>;
  if (name === "trash") return <svg viewBox="0 0 24 24" aria-hidden="true"><path {...props} d="M5.5 7.2h13M9.3 7.2V5.3h5.4v1.9m-7.8 0 .8 11.1h8.6l.8-11.1M10 10.3v5.4m4 0v-5.4" /></svg>;
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle {...props} cx="12" cy="12" r="8.2" /><path {...props} d="M12 10.2v5m0-8h.01" /></svg>;
}

export function SagaSeriesWorkspace({ seriesApiPath = "/api/saga/series", draftsApiPath = "/api/content/drafts?limit=250&include=media" }: SagaSeriesWorkspaceProps) {
  const nameId = useId();
  const slugId = useId();
  const draftListId = useId();
  const initialObjectiveId = useId();
  const initialAudienceId = useId();
  const initialToneId = useId();
  const objectiveId = useId();
  const audienceId = useId();
  const toneId = useId();
  const requiredId = useId();
  const forbiddenId = useId();
  const [series, setSeries] = useState<SagaSeries[]>([]);
  const [drafts, setDrafts] = useState<SagaSeriesDraft[]>([]);
  const [seriesState, setSeriesState] = useState<LoadState>("loading");
  const [draftsState, setDraftsState] = useState<LoadState>("loading");
  const [seriesMessage, setSeriesMessage] = useState<string | null>(null);
  const [draftsMessage, setDraftsMessage] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [selectedDraftId, setSelectedDraftId] = useState("");
  const [selectedSeriesId, setSelectedSeriesId] = useState<string | null>(null);
  const [controlsForm, setControlsForm] = useState<SeriesControlsForm>(DEFAULT_CONTROLS);

  const loadSeries = useCallback(async (signal?: AbortSignal): Promise<boolean> => {
    setSeriesState("loading");
    setSeriesMessage(null);
    try {
      const response = await fetch(seriesApiPath, { credentials: "same-origin", cache: "no-store", signal });
      const payload: unknown = await response.json().catch(() => null);
      const parsed = sagaSeriesFromPayload(payload);
      if (!response.ok || !parsed) {
        setSeries([]);
        setSeriesState("unavailable");
        setSeriesMessage(sagaSeriesMessage(payload, "Innehållsserier kan inte läsas just nu."));
        return false;
      }
      setSeries(parsed);
      // Do not auto-open a saved series. Controls are deliberate edits, and
      // selecting a row is what loads its immutable control snapshot into the
      // form. This prevents a first render from ever overwriting it with form
      // defaults.
      setSelectedSeriesId((current) => current && parsed.some((entry) => entry.id === current) ? current : null);
      setSeriesState("ready");
      return true;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return false;
      setSeries([]);
      setSeriesState("unavailable");
      setSeriesMessage("Innehållsserier kan inte nås just nu. Försök igen.");
      return false;
    }
  }, [seriesApiPath]);

  const loadDrafts = useCallback(async (signal?: AbortSignal): Promise<boolean> => {
    setDraftsState("loading");
    setDraftsMessage(null);
    try {
      const response = await fetch(draftsApiPath, { credentials: "same-origin", cache: "no-store", signal });
      const payload: unknown = await response.json().catch(() => null);
      const parsed = sagaSeriesDraftsFromPayload(payload);
      if (!response.ok || !parsed) {
        setDrafts([]);
        setDraftsState("unavailable");
        setDraftsMessage(sagaSeriesMessage(payload, "Sparade utkast kan inte läsas just nu."));
        return false;
      }
      setDrafts(parsed);
      setDraftsState("ready");
      return true;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return false;
      setDrafts([]);
      setDraftsState("unavailable");
      setDraftsMessage("Sparade utkast kan inte nås just nu. Försök igen.");
      return false;
    }
  }, [draftsApiPath]);

  const reload = useCallback(async () => {
    await Promise.all([loadSeries(), loadDrafts()]);
  }, [loadDrafts, loadSeries]);

  useEffect(() => {
    const controller = new AbortController();
    // Let the effect commit before its request changes loading state. This
    // avoids a synchronous render cascade while preserving a single abortable
    // refresh for both actor-scoped resources.
    void Promise.resolve().then(() => Promise.all([loadSeries(controller.signal), loadDrafts(controller.signal)]));
    return () => controller.abort();
  }, [loadDrafts, loadSeries]);

  const selectedDraft = drafts.find((draft) => draft.id === selectedDraftId) ?? null;
  const selectedSeries = series.find((entry) => entry.id === selectedSeriesId) ?? null;
  const flow = sagaSeriesFlowState(selectedSeries);
  const controlsValidationMessage = sagaSeriesControlsValidation(controlsForm);
  const canMutate = saveState !== "saving" && saveState !== "deleting";
  const canCreate = seriesState === "ready" && draftsState === "ready" && canMutate && name.trim().length >= 2 && slug.trim().length >= 2 && Boolean(selectedDraft) && !controlsValidationMessage;
  const canSaveControls = Boolean(selectedSeries) && selectedSeries?.revision !== null && seriesState === "ready" && canMutate && !controlsValidationMessage;
  const activationPayload = selectedSeries ? sagaSeriesActivationPayload(selectedSeries) : null;
  const canActivateSeries = Boolean(activationPayload) && seriesState === "ready" && canMutate;

  const currentReference = selectedSeries?.reference ?? null;

  function updateName(value: string) {
    setName(value);
    if (!slugTouched) setSlug(slugFrom(value));
  }

  function selectSeries(next: SagaSeries) {
    setSelectedSeriesId(next.id);
    setSelectedDraftId("");
    setControlsForm(controlsFormFrom(next.controls));
    setSaveMessage(null);
  }

  function updateControls<Key extends keyof SeriesControlsForm>(key: Key, value: SeriesControlsForm[Key]) {
    setControlsForm((current) => ({ ...current, [key]: value }));
  }

  function toggleChannel(channel: (typeof DEFAULT_CHANNELS)[number]) {
    setControlsForm((current) => ({
      ...current,
      defaultChannels: current.defaultChannels.includes(channel)
        ? current.defaultChannels.filter((entry) => entry !== channel)
        : [...current.defaultChannels, channel],
    }));
  }

  async function createSeries(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canCreate || !selectedDraft) {
      setSaveState("error");
      setSaveMessage(controlsValidationMessage || "Välj ett sparat referensutkast och fyll i seriens namn innan du sparar.");
      return;
    }
    setSaveState("saving");
    setSaveMessage(null);
    try {
      const response = await fetch(seriesApiPath, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(sagaSeriesCreatePayload({ name, slug, referenceDraftId: selectedDraft.id, controls: controlsForm })),
      });
      const payload: unknown = await response.json().catch(() => null);
      const saved = sagaSeriesMutationFromPayload(payload);
      if (!response.ok || !saved) {
        setSaveState("error");
        setSaveMessage(sagaSeriesMessage(payload, "Serien kunde inte sparas. Inga kontroller, varianter eller kalenderposter har skapats."));
        return;
      }
      setSeries((current) => [saved, ...current.filter((entry) => entry.id !== saved.id)]);
      selectSeries(saved);
      setName("");
      setSlug("");
      setSlugTouched(false);
      setSelectedDraftId("");
      setSaveState("idle");
      setSaveMessage("Referensposten är fryst i serien. Ingen variant, kalenderpost eller publicering har skapats.");
    } catch {
      setSaveState("error");
      setSaveMessage("Serien kunde inte sparas. Kontrollera anslutningen och försök igen.");
    }
  }

  async function saveControls(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedSeries || !canSaveControls) {
      setSaveState("error");
      setSaveMessage(controlsValidationMessage || "Kontroller kan sparas först när serien och dess versionsnummer har bekräftats av arbetsytan.");
      return;
    }
    setSaveState("saving");
    setSaveMessage(null);
    try {
      const response = await fetch(seriesApiPath, {
        method: "PATCH",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(sagaSeriesUpdatePayload(selectedSeries, controlsForm)),
      });
      const payload: unknown = await response.json().catch(() => null);
      const saved = sagaSeriesMutationFromPayload(payload);
      if (!response.ok || !saved) {
        setSaveState("error");
        setSaveMessage(sagaSeriesMessage(payload, "Kontrollerna kunde inte sparas. Ingen variant, kalenderpost eller publicering har skapats."));
        return;
      }
      setSeries((current) => current.map((entry) => entry.id === saved.id ? saved : entry));
      selectSeries(saved);
      setSaveState("idle");
      setSaveMessage("Kontrollerna är sparade. Granskning krävs fortfarande och inga utkast har producerats här.");
    } catch {
      setSaveState("error");
      setSaveMessage("Kontrollerna kunde inte sparas. Kontrollera anslutningen och försök igen.");
    }
  }

  async function activateSeries() {
    if (!selectedSeries || !activationPayload || !canActivateSeries) {
      setSaveState("error");
      setSaveMessage("Spara giltiga kontroller med obligatorisk granskning innan referensen kan användas i AI-labbet.");
      return;
    }
    setSaveState("saving");
    setSaveMessage(null);
    try {
      const response = await fetch(seriesApiPath, {
        method: "PATCH",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        // A separately saved, observed revision prevents controls and active
        // state from being changed underneath a user in another tab.
        body: JSON.stringify(activationPayload),
      });
      const payload: unknown = await response.json().catch(() => null);
      const saved = sagaSeriesMutationFromPayload(payload);
      if (!response.ok || !saved || !saved.active) {
        setSaveState("error");
        setSaveMessage(sagaSeriesMessage(payload, "Referensen kunde inte aktiveras för AI-labbet. Inga utkast, kalenderposter eller publiceringar har skapats."));
        return;
      }
      setSeries((current) => current.map((entry) => entry.id === saved.id ? saved : entry));
      selectSeries(saved);
      setSaveState("idle");
      setSaveMessage("Referensen är aktiv i AI-labbet. Varje test är fortfarande granskningspliktigt och ingenting publiceras härifrån.");
    } catch {
      setSaveState("error");
      setSaveMessage("Referensen kunde inte aktiveras. Kontrollera anslutningen och försök igen.");
    }
  }

  async function deleteSeries(item: SagaSeries) {
    if (item.revision === null) {
      setSaveState("error");
      setSaveMessage("Serien saknar ett bekräftat versionsnummer och kan inte tas bort säkert här.");
      return;
    }
    if (!window.confirm(`Ta bort serien “${item.name}”? Referensposten i Studio tas inte bort.`)) return;
    setSaveState("deleting");
    setSaveMessage(null);
    try {
      const response = await fetch(seriesApiPath, {
        method: "DELETE",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: item.id, expectedRevision: item.revision }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok || !sagaSeriesDeleteConfirmed(payload, item.id)) {
        setSaveState("error");
        setSaveMessage(sagaSeriesMessage(payload, "Serien kunde inte tas bort."));
        return;
      }
      setSeries((current) => current.filter((entry) => entry.id !== item.id));
      setSelectedSeriesId((current) => current === item.id ? null : current);
      setControlsForm(DEFAULT_CONTROLS);
      setSaveState("idle");
      setSaveMessage("Serien är borttagen. Referensutkastet i Studio finns kvar.");
    } catch {
      setSaveState("error");
      setSaveMessage("Serien kunde inte tas bort. Kontrollera anslutningen och försök igen.");
    }
  }

  return (
    <section className={styles.workspace} aria-labelledby="series-title">
      <header className={styles.hero}>
        <div>
          <p className={styles.eyebrow}>SAGA SERIES</p>
          <h1 id="series-title">Börja med en post som sätter ribban.</h1>
          <p>En serie utgår alltid från ett redan sparat Studio-utkast. SAGA fryser dess redaktionella riktning innan ni sätter kontroller för det som kommer efter.</p>
        </div>
        <aside className={styles.heroNote} aria-label="Seriesprincip">
          <span><Icon name="document" /></span>
          <div><strong>Referensen kommer först</strong><p>Ingen serie skapas från en lös idé, ett kalenderobjekt eller en publicering.</p></div>
        </aside>
      </header>

      <ol className={styles.flow} aria-label="Seriesflöde">
        <li className={styles.flowCurrent}><span>01</span><div><strong>Referenspost</strong><small>Obligatorisk</small></div></li>
        <li className={flow.controls === "locked" ? styles.flowLocked : undefined}><span>02</span><div><strong>Kontroller</strong><small>{flow.controls === "locked" ? "Väntar på referens" : flow.controls === "complete" ? "Sparade" : "Kan ställas in"}</small></div></li>
        <li className={flow.variants === "locked" ? styles.flowLocked : undefined}><span>03</span><div><strong>Varianter</strong><small>{flow.variants === "locked" ? "Väntar på kontroller" : flow.variants === "waiting" ? "Aktivera referensen" : "Öppna AI-labbet"}</small></div></li>
        <li className={flow.calendar === "locked" ? styles.flowLocked : undefined}><span>04</span><div><strong>Kalender</strong><small>{flow.calendar === "locked" ? "Väntar på kontroller" : flow.calendar === "waiting" ? "Efter AI-labbtest" : "Manuell överlämning"}</small></div></li>
      </ol>

      <div className={styles.notice} role="status" aria-live="polite">
        <Icon name="info" />
        <p><strong>Series bygger riktning, inte publicering.</strong> Den här ytan skapar inga inlägg, inga kalenderpunkter och skickar inget till en kanal.</p>
      </div>

      {(seriesState === "unavailable" || draftsState === "unavailable") && (
        <section className={styles.unavailable} aria-live="polite">
          <span><Icon name="info" /></span>
          <div>
            <strong>Arbetsytan behöver åtgärd</strong>
            <p>{seriesState === "unavailable" ? seriesMessage : draftsMessage}</p>
          </div>
          <button type="button" onClick={() => void reload()}><Icon name="reload" />Försök igen</button>
        </section>
      )}

      <div className={styles.layout}>
        <div className={styles.primaryColumn}>
          <section className={styles.card} aria-labelledby="reference-post-title">
            <header className={styles.cardHeader}>
              <span className={styles.cardNumber}>01</span>
              <div><p>OBLIGATORISK START</p><h2 id="reference-post-title">Välj en sparad referenspost</h2><span>Serien får en fryst, läsbar snapshot när den sparas.</span></div>
            </header>
            <form className={styles.referenceForm} onSubmit={createSeries}>
              <div className={styles.twoFields}>
                <label className={styles.field} htmlFor={nameId}><span>Seriens namn</span><input id={nameId} maxLength={160} value={name} onChange={(event) => updateName(event.target.value)} minLength={2} required disabled={seriesState !== "ready" || saveState === "saving"} placeholder="Exempel: System som frigör tid" /></label>
                <label className={styles.field} htmlFor={slugId}><span>Intern adress</span><input id={slugId} maxLength={79} value={slug} onChange={(event) => { setSlugTouched(true); setSlug(slugFrom(event.target.value)); }} minLength={2} required disabled={seriesState !== "ready" || saveState === "saving"} placeholder="system-som-frigor-tid" aria-describedby={`${slugId}-hint`} /></label>
              </div>
              <p id={`${slugId}-hint`} className={styles.fieldHint}>Används internt för att känna igen serien. Den går att ändra senare när en redigeringsyta finns.</p>

              <fieldset className={styles.draftFieldset} disabled={draftsState !== "ready" || seriesState !== "ready" || saveState === "saving"} aria-describedby={`${draftListId}-hint`}>
                <legend>Referenspost i Studio</legend>
                <p id={`${draftListId}-hint`}>Välj ett verkligt, sparat utkast. Inget textfält här blir en ersättning för ett sparat Studio-utkast.</p>
                {draftsState === "loading" && <div className={styles.skeletonList} aria-label="Hämtar sparade utkast"><i /><i /><i /></div>}
                {draftsState === "ready" && drafts.length === 0 && (
                  <div className={styles.emptyDrafts}>
                    <span><Icon name="document" /></span>
                    <div><strong>Det finns inget sparat utkast att använda ännu.</strong><p>Skapa och spara en referenspost i Studio först. När den är sparad syns den här.</p><Link href="/studio/content/new?edit=1">Skapa ett utkast i Studio <Icon name="arrow" /></Link></div>
                  </div>
                )}
                {draftsState === "ready" && drafts.length > 0 && <div className={styles.draftList}>{drafts.map((draft) => (
                  <label className={selectedDraftId === draft.id ? styles.draftOptionSelected : styles.draftOption} key={draft.id}>
                    <input type="radio" name="reference-draft" value={draft.id} checked={selectedDraftId === draft.id} onChange={(event: ChangeEvent<HTMLInputElement>) => { setSelectedDraftId(event.target.value); setSelectedSeriesId(null); setControlsForm(DEFAULT_CONTROLS); }} />
                    <span className={styles.draftMark}><Icon name="document" /></span>
                    <span className={styles.draftCopy}><strong>{draft.title}</strong><small>{draft.channels.length ? draft.channels.map(channelLabel).join(" · ") : "Ingen kanal vald"} · {draft.status}</small>{draft.body && <em>{excerpt(draft.body, 150)}</em>}</span>
                    <span className={styles.draftMeta}>{draft.mediaCount ? `${draft.mediaCount} media` : "Text"}</span>
                  </label>
                ))}</div>}
              </fieldset>

              {selectedDraft && <article className={styles.referencePreview} aria-label="Vald referenspost">
                <div className={styles.previewHead}><span><Icon name="document" /></span><div><p>VALD REFERENSPOST</p><strong>{selectedDraft.title}</strong></div><i>Fryst vid sparande</i></div>
                {selectedDraft.body && <p>{excerpt(selectedDraft.body)}</p>}
                <footer><span>{selectedDraft.channels.length ? selectedDraft.channels.map(channelLabel).join(" · ") : "Ingen kanal vald"}</span><span>{selectedDraft.mediaCount ? `${selectedDraft.mediaCount} mediatillgångar` : "Ingen media i snapshot"}</span></footer>
              </article>}

              {selectedDraft && <section className={styles.initialControls} aria-labelledby={`${initialObjectiveId}-title`}>
                <header><span>02</span><div><p>FÖRSTA KONTROLLER</p><h3 id={`${initialObjectiveId}-title`}>Sätt ramen innan serien sparas</h3><small>Servern kräver ett syfte, en målgrupp och en tonalitet. Granskning är alltid på.</small></div></header>
                <div className={styles.initialControlFields}>
                  <label className={styles.field} htmlFor={initialObjectiveId}><span>Syfte</span><select id={initialObjectiveId} value={controlsForm.objective} onChange={(event) => updateControls("objective", event.target.value as SagaSeriesObjective)}><option value="educate">Förklara och utbilda</option><option value="inspire">Inspirera</option><option value="convert">Hjälpa till beslut</option><option value="community">Bygga gemenskap</option></select></label>
                  <label className={styles.field} htmlFor={initialAudienceId}><span>Målgrupp</span><input id={initialAudienceId} maxLength={160} value={controlsForm.audience} onChange={(event) => updateControls("audience", event.target.value)} required placeholder="Vem ska serien hjälpa?" /></label>
                  <label className={styles.field} htmlFor={initialToneId}><span>Tonalitet</span><select id={initialToneId} value={controlsForm.tone} onChange={(event) => updateControls("tone", event.target.value as SagaSeriesTone)}><option value="insightful">Insiktsdriven och lugn</option><option value="warm">Varm och mänsklig</option><option value="direct">Rak och konkret</option></select></label>
                </div>
              </section>}

              <div className={styles.formActions}>
                <button className={styles.primaryAction} type="submit" disabled={!canCreate}>{saveState === "saving" ? "Sparar referens…" : "Spara referenspost i serien"}<Icon name="arrow" /></button>
                <p>Serien är inaktiv tills referensen har sparats, kontrollerats och aktiverats för AI-labbet. Inga variationer eller automationer startar här.</p>
              </div>
            </form>
          </section>

          <section className={selectedSeries ? styles.card : `${styles.card} ${styles.cardLocked}`} aria-labelledby="series-controls-title">
            <header className={styles.cardHeader}>
              <span className={styles.cardNumber}>02</span>
              <div><p>KONTROLLER</p><h2 id="series-controls-title">Bestäm redaktionell riktning</h2><span>{selectedSeries ? "Kontrollerna sparas på den valda serien och kräver fortsatt granskning." : "Spara först en referenspost för att låsa upp kontroller."}</span></div>
              {!selectedSeries && <i className={styles.headerLock}><Icon name="lock" /></i>}
            </header>
            <form className={styles.controlsForm} onSubmit={saveControls}>
              <fieldset disabled={!selectedSeries || seriesState !== "ready" || saveState === "saving"}>
                <div className={styles.twoFields}>
                  <label className={styles.field} htmlFor={objectiveId}><span>Syfte</span><select id={objectiveId} value={controlsForm.objective} onChange={(event) => updateControls("objective", event.target.value as SagaSeriesObjective)}><option value="educate">Förklara och utbilda</option><option value="inspire">Inspirera</option><option value="convert">Hjälpa till beslut</option><option value="community">Bygga gemenskap</option></select></label>
                  <label className={styles.field} htmlFor={audienceId}><span>Målgrupp</span><input id={audienceId} maxLength={160} value={controlsForm.audience} onChange={(event) => updateControls("audience", event.target.value)} placeholder="Vem är den till för?" /></label>
                </div>
                <label className={styles.field} htmlFor={toneId}><span>Tonalitet</span><select id={toneId} value={controlsForm.tone} onChange={(event) => updateControls("tone", event.target.value as SagaSeriesTone)}><option value="insightful">Insiktsdriven och lugn</option><option value="warm">Varm och mänsklig</option><option value="direct">Rak och konkret</option></select></label>
                <div className={styles.twoFields}>
                  <label className={styles.field} htmlFor={requiredId}><span>Måste finnas med</span><textarea id={requiredId} rows={3} value={controlsForm.requiredElements} onChange={(event) => updateControls("requiredElements", event.target.value)} placeholder="En punkt per rad" /></label>
                  <label className={styles.field} htmlFor={forbiddenId}><span>Undvik</span><textarea id={forbiddenId} rows={3} value={controlsForm.forbiddenElements} onChange={(event) => updateControls("forbiddenElements", event.target.value)} placeholder="En punkt per rad" /></label>
                </div>
                <fieldset className={styles.channelFieldset}><legend>Föreslagna kanaler</legend><p>Detta är en redaktionell preferens, inte en kanalanslutning eller publiceringsregel.</p><div>{DEFAULT_CHANNELS.map((channel) => <label key={channel}><input type="checkbox" checked={controlsForm.defaultChannels.includes(channel)} onChange={() => toggleChannel(channel)} /><span>{channelLabel(channel)}</span></label>)}</div></fieldset>
              </fieldset>
              <div className={styles.reviewStrip}><span><Icon name="check" /></span><p><strong>Granskning är obligatorisk.</strong> Kontrollerna kan vägleda framtida utkast, men de kan inte starta en automation eller publicering.</p></div>
              <div className={styles.formActions}>
                <button className={styles.secondaryAction} type="submit" disabled={!canSaveControls}>{saveState === "saving" ? "Sparar kontroller…" : "Spara kontroller"}<Icon name="controls" /></button>
                {selectedSeries?.revision === null && <p>Servern har ännu inte lämnat ett versionsnummer. Ändringen hålls låst för att undvika att skriva över något.</p>}
              </div>
            </form>
          </section>

          <section className={selectedSeries ? styles.card : `${styles.card} ${styles.cardLocked}`} aria-labelledby="series-variants-title">
            <header className={styles.cardHeader}>
              <span className={styles.cardNumber}>03</span>
              <div><p>VARIANTER</p><h2 id="series-variants-title">Produktionsytan kommer efter riktningen</h2><span>{selectedSeries?.active ? "Den aktiva referensen kan nu användas i AI-labbet — alltid som ett granskningspliktigt test." : selectedSeries ? "Aktivera först den sparade, granskade referensen för AI-labbet." : "Väntar på en sparad referenspost."}</span></div>
              {!selectedSeries && <i className={styles.headerLock}><Icon name="lock" /></i>}
            </header>
            {!selectedSeries && <div className={styles.futurePanel}>
              <span><Icon name="variants" /></span><div><strong>Inga varianter är skapade här.</strong><p>När ett särskilt produktionsflöde är redo ska det skapa granskbara utkast från den sparade referensen och kontrollerna. Det flödet finns inte på den här sidan ännu.</p></div>
            </div>}
            {selectedSeries && !selectedSeries.active && activationPayload && <div className={styles.activationPanel}>
              <span><Icon name="variants" /></span>
              <div><strong>Referensen är redo för AI-labbet.</strong><p>Aktivering gör den frysta referensen och dess kontroller valbara i AI-labbet. Det skapar inga utkast, inga kalenderposter och ingen publicering.</p></div>
              <button type="button" className={styles.secondaryAction} onClick={() => void activateSeries()} disabled={!canActivateSeries}>{saveState === "saving" ? "Aktiverar…" : "Aktivera för AI-labbet"}<Icon name="arrow" /></button>
            </div>}
            {selectedSeries && !selectedSeries.active && !activationPayload && <div className={styles.futurePanel}>
              <span><Icon name="lock" /></span><div><strong>Spara giltiga kontroller först.</strong><p>En serie behöver en fryst referenspost, sparade kontroller och obligatorisk granskning innan den kan användas som referens i AI-labbet.</p></div>
            </div>}
            {selectedSeries?.active && <div className={styles.activeSeriesPanel}>
              <span><Icon name="check" /></span>
              <div><strong>Aktiv referens för AI-labbet</strong><p>Labbet hämtar den frysta referensen på servern för varje test. Varianter är fortfarande bara förslag tills en människa granskar dem.</p></div>
              <Link href={`/studio/engine?seriesId=${encodeURIComponent(selectedSeries.id)}`}>Öppna AI-labbet <Icon name="arrow" /></Link>
            </div>}
          </section>

          <section className={selectedSeries ? styles.card : `${styles.card} ${styles.cardLocked}`} aria-labelledby="series-calendar-title">
            <header className={styles.cardHeader}>
              <span className={styles.cardNumber}>04</span>
              <div><p>KALENDERÖVERLÄMNING</p><h2 id="series-calendar-title">Planera först när ett utkast finns</h2><span>{selectedSeries ? "Kalendern är nästa manuella arbetsyta; ingen kalenderpunkt kommer från den här serien." : "Väntar på en sparad referenspost."}</span></div>
              {!selectedSeries && <i className={styles.headerLock}><Icon name="lock" /></i>}
            </header>
            <div className={styles.calendarPanel}>
              <span><Icon name="calendar" /></span><div><strong>Ingen kalenderpost skapad</strong><p>Öppna kalendern först när ett faktiskt utkast har skapats och granskats i rätt flöde.</p>{selectedSeries && <Link href="/studio/calendar">Öppna kalendern <Icon name="arrow" /></Link>}</div>
            </div>
          </section>
        </div>

        <aside className={styles.sideColumn} aria-label="Sparade innehållsserier">
          <section className={styles.library}>
            <header><div><p>SPARADE SERIER</p><h2>Arbeta vidare från en tydlig grund</h2></div><span>{series.length}</span></header>
            {seriesState === "loading" && <div className={styles.librarySkeleton} aria-label="Hämtar innehållsserier"><i /><i /><i /></div>}
            {seriesState === "ready" && series.length === 0 && <div className={styles.libraryEmpty}><span><Icon name="document" /></span><div><strong>Inga sparade serier ännu.</strong><p>Välj ett Studio-utkast som referenspost för att börja.</p></div></div>}
            {seriesState === "ready" && series.length > 0 && <ul className={styles.seriesList}>{series.map((item) => {
              const active = item.id === selectedSeriesId;
              return <li key={item.id} className={active ? styles.seriesSelected : undefined}><button type="button" onClick={() => selectSeries(item)} aria-pressed={active}><span className={styles.seriesIcon}><Icon name="document" /></span><span className={styles.seriesCopy}><strong>{item.name}</strong><small>{item.reference.title}</small><em>{item.controls ? "Kontroller sparade" : "Referens sparad"}</em></span><span className={styles.seriesArrow}><Icon name="arrow" /></span></button>{active && <div className={styles.seriesFoot}><span>{item.active ? "Aktiv referensregel" : "Ingen automation startad"}</span><button type="button" onClick={() => void deleteSeries(item)} disabled={saveState === "saving" || saveState === "deleting" || item.revision === null}><Icon name="trash" />Ta bort</button></div>}</li>;
            })}</ul>}
          </section>

          {currentReference && <section className={styles.snapshotCard} aria-labelledby="snapshot-title"><p>FRYST SNAPSHOT</p><h2 id="snapshot-title">{currentReference.title}</h2><div className={styles.snapshotRow}><span>Källa</span><strong>Studio-utkast</strong></div><div className={styles.snapshotRow}><span>Senast sparad</span><strong>{formatWhen(currentReference.capturedAt) ?? "Bekräftad av arbetsytan"}</strong></div><div className={styles.snapshotRow}><span>Media</span><strong>{currentReference.mediaCount ? `${currentReference.mediaCount} tillgångar` : "Ingen media"}</strong></div><p className={styles.snapshotNote}>Mediefiler visas inte eller skickas vidare från den här ytan.</p></section>}
        </aside>
      </div>

      {saveMessage && <p className={saveState === "error" ? styles.actionError : styles.actionMessage} role="status" aria-live="polite">{saveMessage}</p>}
    </section>
  );
}
