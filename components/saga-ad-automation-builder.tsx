"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import styles from "@/components/saga-ad-automation-builder.module.css";

export type AdTriggerKind = "manual" | "schedule" | "signal";
export type AdObjective = "awareness" | "traffic" | "leads" | "sales";
export type AdFormat = "short_form_video" | "paid_social" | "display";
export type AdMediaSource = "ai" | "stock" | "owned" | "mixed";
export type AdDestinationProvider = "meta_ads" | "google_ads" | "linkedin_ads" | "facebook_page" | "instagram" | "linkedin" | "newsletter" | "rss";
export type AdVisualMetaphor = "calendar_turn" | "day_to_evening" | "tread_transition" | "prepared_shelf";

type AdDestination = {
  id: string;
  provider: AdDestinationProvider;
  label: string;
  campaignName?: string;
  destinationUrl?: string;
  execution?: {
    status?: string;
    message?: string;
  };
};

type AdAutomationWorkflow = {
  trigger: {
    kind: AdTriggerKind;
    summary?: string;
  };
  creative: {
    objective: AdObjective;
    mediaSource: AdMediaSource;
    creativeBrief: {
      format: AdFormat;
      hook: string;
      value: string;
      offer: {
        copy: string;
        terms: string;
        verification: {
          status: "verified" | "unverified";
          sourceReference: string;
          verifiedAt?: string;
        };
      };
      callToAction: string;
      visualMetaphor: AdVisualMetaphor;
      customVisualDirection?: string;
    };
  };
  review: { required: true };
  schedule: {
    mode: "manual" | "weekly_count" | "cron";
    timezone: string;
    weeklyCount?: number;
    weekdays?: number[];
    localTimes?: string[];
    cronExpression?: string;
    startsOn?: string;
    endsOn?: string;
  };
  destinations: AdDestination[];
};

export type SavedAdAutomation = {
  id: string;
  name: string;
  active: boolean;
  revision: number | null;
  workflow: AdAutomationWorkflow;
  createdAt?: string;
  updatedAt?: string;
  destinations?: AdDestination[];
};

export type AdAutomationForm = {
  id: string | null;
  revision: number | null;
  name: string;
  active: boolean;
  trigger: AdTriggerKind;
  sourceSummary: string;
  objective: AdObjective;
  hook: string;
  creativeValue: string;
  offerCopy: string;
  offerTerms: string;
  offerSourceReference: string;
  format: AdFormat;
  mediaSource: AdMediaSource;
  callToAction: string;
  visualMetaphor: AdVisualMetaphor;
  customVisualDirection: string;
  variantCount: 1 | 3 | 5;
  weekday: number;
  localTime: string;
  timezone: string;
  destinationProviders: AdDestinationProvider[];
  campaignName: string;
  destinationUrl: string;
};

type BuilderReadiness = "loading" | "ready" | "unavailable";
type TestResult = {
  tone: "success" | "pending" | "error";
  message: string;
  draftId: string | null;
  confirmed: boolean;
};

type CanvasStep = "trigger" | "brief" | "safety" | "draft" | "review" | "schedule" | "destination";

const DESTINATION_CHOICES: Array<Pick<AdDestination, "id" | "provider" | "label"> & { detail: string; mark: string }> = [
  { id: "meta-ads", provider: "meta_ads", label: "Meta Ads", detail: "Facebook och Instagram-kampanjer", mark: "M" },
  { id: "google-ads", provider: "google_ads", label: "Google Ads", detail: "Sök- och displayformat", mark: "G" },
  { id: "linkedin-ads", provider: "linkedin_ads", label: "LinkedIn Ads", detail: "B2B-kampanjer och sponsrade inlägg", mark: "in" },
];

const weekdayLabels: Record<number, string> = {
  0: "Söndag",
  1: "Måndag",
  2: "Tisdag",
  3: "Onsdag",
  4: "Torsdag",
  5: "Fredag",
  6: "Lördag",
};

const objectiveLabels: Record<AdObjective, string> = {
  awareness: "Bygga kännedom",
  traffic: "Driva trafik",
  leads: "Skapa leads",
  sales: "Driva försäljning",
};

const formatLabels: Record<AdFormat, string> = {
  short_form_video: "Kort annonsvideo",
  paid_social: "Sponsrat socialt inlägg",
  display: "Displayannons",
};

const mediaSourceLabels: Record<AdMediaSource, string> = {
  ai: "AI-bild",
  stock: "Stockfoto",
  owned: "Eget material",
  mixed: "Välj bästa mixen",
};

const triggerLabels: Record<AdTriggerKind, string> = {
  manual: "När jag själv startar",
  schedule: "På en återkommande tid",
  signal: "När ett utvalt erbjudande ändras",
};

const visualMetaphorLabels: Record<AdVisualMetaphor, string> = {
  calendar_turn: "Kalendern vänder",
  day_to_evening: "Från dag till kväll",
  tread_transition: "Dags att byta däck",
  prepared_shelf: "Allt är förberett",
};

const CANVAS_STEPS: ReadonlyArray<{ id: CanvasStep; title: string; detail: string; locked?: boolean }> = [
  { id: "trigger", title: "Start", detail: "Källa & trigger" },
  { id: "brief", title: "Brief", detail: "Mål, copy & bild" },
  { id: "safety", title: "Underlag", detail: "Erbjudande & villkor" },
  { id: "draft", title: "Privat utkast", detail: "Deterministisk brief" },
  { id: "review", title: "Granska", detail: "Människa först" },
  { id: "schedule", title: "Tid", detail: "Schema" },
  { id: "destination", title: "Leverans", detail: "Integration saknas", locked: true },
];

const CANVAS_TARGET_IDS: Record<CanvasStep, string> = {
  trigger: "ad-node-trigger",
  brief: "ad-node-brief",
  safety: "ad-node-safety",
  draft: "ad-node-draft",
  review: "ad-node-review",
  schedule: "ad-node-schedule",
  destination: "ad-node-destination",
};

/** Client-supplied offer fields are always unverified in the first release. */
export const OFFER_VERIFICATION_STATUS = {
  status: "unverified" as const,
  title: "Underlag sparat",
  detail: "Väntar på verifiering. Du kan spara källa och villkor, men bara en serverstyrd granskningsprocess får markera ett erbjudande som verifierat.",
} as const;

const VARIANT_INSTRUCTION = /\n{2}Skapa (1|3|5) tydligt skilda kreativa annonsvarianter\.\s*$/;

function initialForm(): AdAutomationForm {
  return {
    id: null,
    revision: null,
    name: "Ny annonsautomation",
    active: false,
    trigger: "schedule",
    sourceSummary: "Utgå från sparat kampanjunderlag och aktuellt erbjudande.",
    objective: "leads",
    hook: "Redo när det är dags?",
    creativeValue: "Lyft ett tydligt erbjudande, en konkret kundnytta och en enkel väg till nästa steg.",
    offerCopy: "Boka provkörning i Sätra innan helgen.",
    offerTerms: "Gäller utvalda tider. Kontakta oss för fullständiga villkor.",
    offerSourceReference: "Sparat kampanjunderlag",
    format: "paid_social",
    mediaSource: "mixed",
    callToAction: "Boka en provkörning",
    visualMetaphor: "prepared_shelf",
    customVisualDirection: "",
    variantCount: 3,
    weekday: 3,
    localTime: "09:00",
    timezone: "Europe/Stockholm",
    destinationProviders: ["meta_ads"],
    campaignName: "",
    destinationUrl: "",
  };
}

/**
 * The ad-automation service preserves the creative brief verbatim. The
 * requested number of variations is consequently written as a plain-language
 * production instruction rather than introduced as an unpersisted UI-only
 * setting.
 */
export function serializeCreativeValue(value: string, variantCount: AdAutomationForm["variantCount"]) {
  return `${value.trim().replace(VARIANT_INSTRUCTION, "")}\n\nSkapa ${variantCount} tydligt skilda kreativa annonsvarianter.`.trim();
}

export function splitCreativeValue(value: string): { value: string; variantCount: AdAutomationForm["variantCount"] } {
  const match = value.match(VARIANT_INSTRUCTION);
  const variantCount = match ? Number(match[1]) as AdAutomationForm["variantCount"] : 3;
  return { value: value.replace(VARIANT_INSTRUCTION, "").trim(), variantCount };
}

/**
 * Generate a UUID only in environments that provide a cryptographically safe
 * source. The API refuses weaker keys, so a missing key is surfaced to the
 * operator instead of silently falling back to a predictable identifier.
 */
export function createAdAutomationIdempotencyKey(): string | null {
  return typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto.randomUUID() : null;
}

/**
 * A retry must use the original key until the server has confirmed its durable
 * receipt. Callers own the map so React can retain it in a ref across renders.
 */
export function pendingAdAutomationIdempotencyKey(
  pendingKeys: Record<string, string>,
  scope: string,
  createKey: () => string | null = createAdAutomationIdempotencyKey,
): string | null {
  if (pendingKeys[scope]) return pendingKeys[scope];
  const key = createKey();
  if (!key) return null;
  pendingKeys[scope] = key;
  return key;
}

export function clearPendingAdAutomationIdempotencyKey(pendingKeys: Record<string, string>, scope: string) {
  delete pendingKeys[scope];
}

/** Maps an editable, simple builder document to the dedicated durable contract. */
export function adAutomationPayload(form: AdAutomationForm) {
  const isScheduled = form.trigger === "schedule";
  const destinations = form.destinationProviders.flatMap((provider) => {
    const choice = DESTINATION_CHOICES.find((item) => item.provider === provider);
    if (!choice) return [];
    return [{
      id: choice.id,
      provider: choice.provider,
      label: choice.label,
      ...(form.campaignName.trim() ? { campaignName: form.campaignName.trim() } : {}),
      ...(form.destinationUrl.trim() ? { destinationUrl: form.destinationUrl.trim() } : {}),
    }];
  });

  return {
    name: form.name.trim(),
    // Only the dedicated schedule path can be active. Its worker creates a
    // deterministic private creative-brief draft and never calls AI or a
    // provider, but this guard also protects against stale client state.
    active: isScheduled && form.active,
    workflow: {
      trigger: {
        kind: form.trigger,
        ...(form.sourceSummary.trim() ? { summary: form.sourceSummary.trim() } : {}),
      },
      creative: {
        objective: form.objective,
        mediaSource: form.mediaSource,
        creativeBrief: {
          format: form.format,
          hook: form.hook.trim(),
          value: serializeCreativeValue(form.creativeValue, form.variantCount),
          offer: {
            copy: form.offerCopy.trim(),
            terms: form.offerTerms.trim(),
            verification: {
              // V1 intentionally never treats client-supplied offer content as
              // verified. A server-controlled review process owns that status.
              status: OFFER_VERIFICATION_STATUS.status,
              sourceReference: form.offerSourceReference.trim(),
            },
          },
          callToAction: form.callToAction.trim(),
          visualMetaphor: form.visualMetaphor,
          // The guarded scheduled worker accepts only the standardised brief in
          // v1. Advisory visual direction is retained for manual flows only.
          ...(!isScheduled && form.customVisualDirection.trim() ? { customVisualDirection: form.customVisualDirection.trim() } : {}),
        },
      },
      review: { required: true as const },
      schedule: isScheduled
        ? {
          mode: "weekly_count" as const,
          timezone: form.timezone,
          weeklyCount: 1,
          weekdays: [form.weekday],
          localTimes: [form.localTime],
          cronExpression: null,
          startsOn: null,
          endsOn: null,
        }
        : {
          mode: "manual" as const,
          timezone: form.timezone,
          weeklyCount: null,
          weekdays: [],
          localTimes: [],
          cronExpression: null,
          startsOn: null,
          endsOn: null,
        },
      destinations,
    },
  };
}

export function adAutomationFormFromSaved(automation: SavedAdAutomation): AdAutomationForm {
  const workflow = automation.workflow;
  const creative = splitCreativeValue(workflow.creative.creativeBrief.value || "");
  const firstDestination = workflow.destinations[0];
  const weekdays = workflow.schedule.weekdays ?? [];
  const localTimes = workflow.schedule.localTimes ?? [];

  return {
    id: automation.id,
    revision: automation.revision,
    name: automation.name,
    active: automation.active && workflow.trigger.kind === "schedule",
    trigger: workflow.trigger.kind,
    sourceSummary: workflow.trigger.summary ?? "",
    objective: workflow.creative.objective,
    hook: workflow.creative.creativeBrief.hook,
    creativeValue: creative.value,
    offerCopy: workflow.creative.creativeBrief.offer.copy,
    offerTerms: workflow.creative.creativeBrief.offer.terms,
    offerSourceReference: workflow.creative.creativeBrief.offer.verification.sourceReference,
    format: workflow.creative.creativeBrief.format,
    mediaSource: workflow.creative.mediaSource,
    callToAction: workflow.creative.creativeBrief.callToAction,
    visualMetaphor: workflow.creative.creativeBrief.visualMetaphor,
    customVisualDirection: workflow.creative.creativeBrief.customVisualDirection ?? "",
    variantCount: creative.variantCount,
    weekday: weekdays[0] ?? 3,
    localTime: localTimes[0] ?? "09:00",
    timezone: workflow.schedule.timezone || "Europe/Stockholm",
    destinationProviders: workflow.destinations.map((destination) => destination.provider).filter(isDestinationProvider),
    campaignName: firstDestination?.campaignName ?? "",
    destinationUrl: firstDestination?.destinationUrl ?? "",
  };
}

export function adAutomationsFromPayload(value: unknown): SavedAdAutomation[] {
  const entries = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.automations)
      ? value.automations
      : isRecord(value) && Array.isArray(value.items)
        ? value.items
        : [];
  return entries.map(adAutomationFromUnknown).filter((entry): entry is SavedAdAutomation => Boolean(entry));
}

function adAutomationFromUnknown(value: unknown): SavedAdAutomation | null {
  if (!isRecord(value)) return null;
  const id = stringValue(value.id);
  const name = stringValue(value.name);
  const workflow = workflowFromUnknown(value.workflow);
  if (!id || !name || !workflow) return null;
  const returnedDestinations = destinationsFromUnknown(value.destinations);
  return {
    id,
    name,
    active: typeof value.active === "boolean" ? value.active : false,
    revision: revisionValue(value.revision),
    workflow: { ...workflow, destinations: returnedDestinations.length ? returnedDestinations : workflow.destinations },
    createdAt: stringValue(value.createdAt),
    updatedAt: stringValue(value.updatedAt),
    destinations: returnedDestinations,
  };
}

function workflowFromUnknown(value: unknown): AdAutomationWorkflow | null {
  if (!isRecord(value) || !isRecord(value.trigger) || !isRecord(value.creative) || !isRecord(value.creative.creativeBrief) || !isRecord(value.schedule)) return null;
  const kind = stringValue(value.trigger.kind);
  const objective = stringValue(value.creative.objective);
  const format = stringValue(value.creative.creativeBrief.format);
  const mediaSource = stringValue(value.creative.mediaSource);
  const scheduleMode = stringValue(value.schedule.mode);
  const creativeBrief = value.creative.creativeBrief;
  const offer = isRecord(creativeBrief.offer) ? creativeBrief.offer : null;
  const verification = offer && isRecord(offer.verification) ? offer.verification : null;
  const visualMetaphor = stringValue(creativeBrief.visualMetaphor);
  if (!isTriggerKind(kind) || !isObjective(objective) || !isFormat(format) || !isMediaSource(mediaSource) || !isScheduleMode(scheduleMode) || !isVisualMetaphor(visualMetaphor) || !offer || !verification) return null;
  const verificationStatus = stringValue(verification.status);
  if (verificationStatus !== "verified" && verificationStatus !== "unverified") return null;
  const weeklyCount = numberValue(value.schedule.weeklyCount);
  const weekdays = numberArray(value.schedule.weekdays);
  const localTimes = stringArray(value.schedule.localTimes);
  return {
    trigger: { kind, ...(stringValue(value.trigger.summary) ? { summary: stringValue(value.trigger.summary) } : {}) },
    creative: {
      objective,
      mediaSource,
      creativeBrief: {
        format,
        hook: stringValue(creativeBrief.hook),
        value: stringValue(creativeBrief.value),
        offer: {
          copy: stringValue(offer.copy),
          terms: stringValue(offer.terms),
          verification: {
            status: verificationStatus,
            sourceReference: stringValue(verification.sourceReference),
            ...(stringValue(verification.verifiedAt) ? { verifiedAt: stringValue(verification.verifiedAt) } : {}),
          },
        },
        callToAction: stringValue(creativeBrief.callToAction),
        visualMetaphor,
        ...(stringValue(creativeBrief.customVisualDirection) ? { customVisualDirection: stringValue(creativeBrief.customVisualDirection) } : {}),
      },
    },
    review: { required: true },
    schedule: {
      mode: scheduleMode,
      timezone: stringValue(value.schedule.timezone, "Europe/Stockholm"),
      ...(weeklyCount !== null ? { weeklyCount } : {}),
      ...(weekdays.length ? { weekdays } : {}),
      ...(localTimes.length ? { localTimes } : {}),
      ...(stringValue(value.schedule.cronExpression) ? { cronExpression: stringValue(value.schedule.cronExpression) } : {}),
      ...(stringValue(value.schedule.startsOn) ? { startsOn: stringValue(value.schedule.startsOn) } : {}),
      ...(stringValue(value.schedule.endsOn) ? { endsOn: stringValue(value.schedule.endsOn) } : {}),
    },
    destinations: destinationsFromUnknown(value.destinations),
  };
}

function destinationsFromUnknown(value: unknown): AdDestination[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const provider = stringValue(entry.provider);
    if (!isDestinationProvider(provider)) return [];
    const id = stringValue(entry.id);
    const label = stringValue(entry.label);
    if (!id || !label) return [];
    const execution = isRecord(entry.execution)
      ? {
        ...(stringValue(entry.execution.status) ? { status: stringValue(entry.execution.status) } : {}),
        ...(stringValue(entry.execution.message) ? { message: stringValue(entry.execution.message) } : {}),
      }
      : undefined;
    return [{
      id,
      provider,
      label,
      ...(stringValue(entry.campaignName) ? { campaignName: stringValue(entry.campaignName) } : {}),
      ...(stringValue(entry.destinationUrl) ? { destinationUrl: stringValue(entry.destinationUrl) } : {}),
      ...(execution ? { execution } : {}),
    }];
  });
}

export function builderValidationMessage(form: AdAutomationForm): string | null {
  if (form.name.trim().length < 2) return "Ge flödet ett namn med minst två tecken.";
  if (!form.sourceSummary.trim()) return "Beskriv vilket underlag annonsen ska utgå från.";
  if (!form.hook.trim()) return "Skriv en kort öppning som får annonsen att börja tydligt.";
  if (!form.creativeValue.trim()) return "Skriv den kreativa riktningen innan flödet sparas.";
  if (!form.offerCopy.trim()) return "Beskriv erbjudandet som ligger bakom annonsen.";
  if (!form.offerTerms.trim()) return "Skriv villkoren eller hur de kan kontrolleras.";
  if (!form.offerSourceReference.trim()) return "Ange var erbjudandet kommer ifrån så att det går att kontrollera.";
  if (!form.destinationProviders.length) return "Välj minst en destination för annonsformatet.";
  if (form.trigger === "schedule" && !isTime(form.localTime)) return "Ange en giltig tid för den återkommande körningen.";
  return null;
}

export function SagaAdAutomationBuilder() {
  const [form, setForm] = useState<AdAutomationForm>(initialForm);
  const [automations, setAutomations] = useState<SavedAdAutomation[]>([]);
  const [readiness, setReadiness] = useState<BuilderReadiness>("loading");
  const [configurationMessage, setConfigurationMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const pendingIdempotencyKeys = useRef<Record<string, string>>({});
  const [selectedCanvasStep, setSelectedCanvasStep] = useState<CanvasStep>("trigger");

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setReadiness("loading");
      setConfigurationMessage(null);
      try {
        const response = await fetch("/api/ad-automations", { signal: controller.signal, cache: "no-store" });
        const payload = await responseJson(response);
        if (!response.ok) {
          if (controller.signal.aborted) return;
          const message = responseMessage(payload, "Kunde inte läsa sparade annonsflöden.");
          setReadiness("unavailable");
          setConfigurationMessage(message);
          return;
        }
        if (controller.signal.aborted) return;
        setAutomations(adAutomationsFromPayload(payload));
        setReadiness("ready");
      } catch (reason) {
        if (controller.signal.aborted) return;
        setReadiness("unavailable");
        setConfigurationMessage(reason instanceof Error ? reason.message : "Kunde inte nå automationsmotorn.");
      }
    }
    void load();
    return () => controller.abort();
  }, []);

  const validationMessage = useMemo(() => builderValidationMessage(form), [form]);
  const saveDisabled = readiness !== "ready" || saving || Boolean(validationMessage);
  const testDisabled = readiness !== "ready" || testing || !form.id;
  const testButtonLabel = testing
    ? "Testar privat…"
    : testResult?.confirmed
      ? "Skapa nytt privat test"
      : "Testa privat utkast";
  const selectedAutomation = automations.find((automation) => automation.id === form.id) ?? null;
  const savedDestinationStatuses = selectedAutomation?.destinations?.length ? selectedAutomation.destinations : selectedAutomation?.workflow.destinations ?? [];

  function update<K extends keyof AdAutomationForm>(key: K, value: AdAutomationForm[K]) {
    setForm((current) => ({ ...current, [key]: value }));
    setError(null);
    setNotice(null);
  }

  function selectCanvasStep(step: CanvasStep) {
    setSelectedCanvasStep(step);
    const target = document.getElementById(CANVAS_TARGET_IDS[step]);
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    window.setTimeout(() => target.focus({ preventScroll: true }), 260);
  }

  function updateTrigger(trigger: AdTriggerKind) {
    setForm((current) => ({
      ...current,
      trigger,
      // Signal and manual starts have no attached worker in this version.
      active: trigger === "schedule" ? current.active : false,
    }));
    setError(null);
    setNotice(null);
  }

  function selectSaved(automation: SavedAdAutomation) {
    setForm(adAutomationFormFromSaved(automation));
    setError(null);
    setNotice(`Öppnade “${automation.name}”. Ändringar är inte sparade ännu.`);
    setTestResult(null);
  }

  function startNew() {
    setForm(initialForm());
    setError(null);
    setNotice("Nytt annonsflöde. Spara när riktningen stämmer.");
    setTestResult(null);
  }

  function toggleDestination(provider: AdDestinationProvider) {
    setForm((current) => ({
      ...current,
      destinationProviders: current.destinationProviders.includes(provider)
        ? current.destinationProviders.filter((item) => item !== provider)
        : [...current.destinationProviders, provider],
    }));
    setError(null);
  }

  async function save(event?: React.FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (validationMessage) {
      setError(validationMessage);
      return;
    }
    if (readiness !== "ready") {
      setError(configurationMessage ?? "SAGA kan inte bekräfta ett sparat automationsutrymme ännu.");
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const isCreate = !form.id;
      const method = isCreate ? "POST" : "PATCH";
      if (form.id && form.revision === null) throw new Error("SAGA kan inte ändra flödet säkert eftersom den sparade versionen saknar revisionsnummer. Ladda om flödet.");
      const path = form.id ? `/api/ad-automations/${encodeURIComponent(form.id)}` : "/api/ad-automations";
      const createIdempotencyKey = isCreate
        ? pendingAdAutomationIdempotencyKey(pendingIdempotencyKeys.current, "create")
        : null;
      if (isCreate && !createIdempotencyKey) throw new Error("Kunde inte skapa en säker sparnyckel. Ladda om sidan och försök igen.");
      const response = await fetch(path, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...adAutomationPayload(form),
          ...(form.id ? { expectedRevision: form.revision } : { createIdempotencyKey }),
        }),
      });
      const payload = await responseJson(response);
      if (!response.ok) throw new Error(responseMessage(payload, "Kunde inte spara annonsflödet."));
      const saved = isRecord(payload) ? adAutomationFromUnknown(payload.automation) ?? adAutomationFromUnknown(payload) : null;
      if (!saved) throw new Error("SAGA sparade flödet men kunde inte läsa tillbaka dess konfiguration.");
      // Only a confirmed create response may release this key. If the request
      // times out after the server writes, a retry safely reaches the same row.
      if (isCreate) clearPendingAdAutomationIdempotencyKey(pendingIdempotencyKeys.current, "create");
      setAutomations((current) => [saved, ...current.filter((automation) => automation.id !== saved.id)]);
      setForm(adAutomationFormFromSaved(saved));
      setNotice(saved.active
        ? "Annonsflödet är aktivt för privata, deterministiska creative-brief-utkast. Ingen AI eller extern annons körs."
        : "Annonsflödet är sparat som pausat. Testa när du vill skapa ett privat creative-brief-utkast — ingen extern annons körs.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Kunde inte spara annonsflödet.");
    } finally {
      setSaving(false);
    }
  }

  async function testAutomation({ fresh = false }: { fresh?: boolean } = {}) {
    if (!form.id) {
      setError("Spara flödet innan du testar. Testet behöver ett verkligt sparat flöde.");
      return;
    }
    const automationId = form.id;
    const testScope = `test:${automationId}`;
    if (fresh) clearPendingAdAutomationIdempotencyKey(pendingIdempotencyKeys.current, testScope);
    const idempotencyKey = pendingAdAutomationIdempotencyKey(pendingIdempotencyKeys.current, testScope);
    if (!idempotencyKey) {
      setError("Kunde inte skapa en säker testnyckel. Ladda om sidan och försök igen.");
      return;
    }
    setTesting(true);
    setError(null);
    setNotice(null);
    setTestResult(null);
    try {
      const response = await fetch(`/api/ad-automations/${encodeURIComponent(automationId)}/test`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idempotencyKey }),
      });
      const payload = await responseJson(response);
      if (!response.ok) throw new Error(responseMessage(payload, "Kunde inte starta ett privat testutkast."));
      const receipt = isRecord(payload) && isRecord(payload.receipt) ? payload.receipt : null;
      const receiptId = receipt ? stringValue(receipt.id) : "";
      if (!receiptId) throw new Error("SAGA kunde inte bekräfta testkvittot. Försök igen — samma privata test används vid retry.");
      const draft = isRecord(payload) && isRecord(payload.draft) ? payload.draft : null;
      const draftId = draft ? stringValue(draft.id) || null : receipt ? stringValue(receipt.draftId) || null : null;
      const status = isRecord(payload) ? stringValue(payload.status) : "";
      setTestResult({
        tone: draftId ? "success" : status === "private_draft_receipt" ? "pending" : "success",
        message: draftId
          ? "Ett privat, deterministiskt creative-brief-utkast är skapat. Ingen AI, annons-API eller extern publicering har körts."
          : "Ett privat testkvitto är sparat. Ingen AI, annons-API eller extern publicering har körts.",
        draftId,
        confirmed: true,
      });
      // A receipt confirms the request. The next deliberate test gets a new
      // key, while any ambiguous failure keeps its original key for retry.
      clearPendingAdAutomationIdempotencyKey(pendingIdempotencyKeys.current, testScope);
      const saved = isRecord(payload) ? adAutomationFromUnknown(payload.automation) : null;
      if (saved) {
        setAutomations((current) => [saved, ...current.filter((automation) => automation.id !== saved.id)]);
        setForm(adAutomationFormFromSaved(saved));
      }
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Kunde inte starta ett privat testutkast.";
      setError(message);
      setTestResult({ tone: "error", message, draftId: null, confirmed: false });
    } finally {
      setTesting(false);
    }
  }

  return (
    <section className={styles.builder} aria-labelledby="ad-automation-title">
      <header className={styles.topbar}>
        <div>
          <p className={styles.eyebrow}>AUTOMATIK / ANNONSER</p>
          <h1 className={styles.title} id="ad-automation-title">Bygg ett annonsflöde</h1>
          <p className={styles.intro}>Sätt samman en enkel, styrd kedja för annonsidéer. SAGA kan spara flödet och skapa privata utkast för kontroll — extern annonsering är aldrig underförstådd.</p>
        </div>
        <div className={styles.topActions}>
          <span className={form.active ? styles.statusReady : styles.statusPaused}>{form.active ? "Aktiv: privata briefs" : "Pausat"}</span>
          <button className={styles.buttonSecondary} type="button" disabled={testDisabled} onClick={() => void testAutomation({ fresh: Boolean(testResult?.confirmed) })}>{testButtonLabel}</button>
          <button className={styles.button} type="button" disabled={saveDisabled} onClick={() => void save()}>{saving ? "Sparar…" : "Spara flöde"}</button>
        </div>
      </header>

      <div className={styles.notices} aria-live="polite">
        {readiness === "unavailable" && configurationMessage ? <div className={styles.configurationNotice} role="status"><span aria-hidden="true">!</span><div><strong>Automationsmotorn är inte redo för sparning.</strong><br />{configurationMessage}</div></div> : null}
        {notice ? <div className={styles.successNotice} role="status"><span aria-hidden="true">✓</span><div>{notice}</div></div> : null}
        {error ? <div className={styles.errorNotice} role="alert"><span aria-hidden="true">!</span><div>{error}</div></div> : null}
        {testResult ? <div className={testResult.tone === "error" ? styles.errorNotice : styles.testNotice} role={testResult.tone === "error" ? "alert" : "status"}><span aria-hidden="true">{testResult.tone === "error" ? "!" : "◌"}</span><div>{testResult.message}</div></div> : null}
      </div>

      <nav className={styles.canvas} aria-labelledby="ad-canvas-title">
        <div className={styles.canvasHead}>
          <div>
            <p className={styles.nodeOverline}>FLÖDESKARTA</p>
            <h2 id="ad-canvas-title">En fast kedja, tydlig kontroll</h2>
            <p>Välj ett steg för att hoppa till dess inställningar. Ordningen är medvetet fast i v1 — det här är en styrd annonsprocess, inte en fri publiceringsyta.</p>
          </div>
          <span className={styles.nodeType}>7 steg</span>
        </div>
        <ol className={styles.canvasNodes} aria-label="Annonsflödets fasta steg">
          {CANVAS_STEPS.map((step, index) => <li className={`${styles.canvasNode} ${step.locked ? styles.canvasNodeLocked : ""}`} key={step.id}>
            <button
              type="button"
              className={styles.canvasButton}
              aria-current={selectedCanvasStep === step.id ? "step" : undefined}
              aria-controls={CANVAS_TARGET_IDS[step.id]}
              onClick={() => selectCanvasStep(step.id)}
            >
              <span className={styles.canvasIndex} aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
              <span><strong>{step.title}</strong><small>{step.detail}</small></span>
              {step.locked ? <span className={styles.canvasLock}>Låst</span> : null}
            </button>
          </li>)}
        </ol>
      </nav>

      <div className={styles.workspace}>
        <form className={styles.workflow} onSubmit={save} noValidate>
          <header className={styles.workflowHead}>
            <div>
              <h2>Din styrda annonskedja</h2>
              <p>Varje steg säger vad SAGA får göra. Du kan öppna ett sparat flöde, ändra det och testa ett privat utkast när du vill.</p>
            </div>
            <span className={styles.nodeType}>7 steg</span>
          </header>

          {readiness === "loading" ? <div className={styles.loadingNodes} aria-label="Läser sparade annonsflöden" aria-busy="true"><div className={styles.loadingNode} /><div className={styles.loadingNode} /><div className={styles.loadingNode} /></div> : <ol className={styles.flow} aria-label="Annonsflödets steg">
            <li className={`${styles.node} ${styles.nodeTrigger} ${selectedCanvasStep === "trigger" ? styles.nodeSelected : ""}`}>
              <span className={styles.nodeMark} aria-hidden="true">01</span>
              <fieldset className={styles.nodeCard} id="ad-node-trigger" tabIndex={-1}>
                <legend className={styles.srOnly}>Start och källa</legend>
                <div className={styles.stepHeader}>
                  <div><p className={styles.nodeOverline}>START</p><h3>Vad sätter flödet i rörelse?</h3><p>Välj en enkel startpunkt och tala om vilket underlag SAGA ska läsa innan den skriver.</p></div>
                  <span className={styles.nodeType}>Trigger</span>
                </div>
                <div className={styles.fieldGrid}>
                  <div className={styles.field}>
                    <label htmlFor="ad-flow-name">Flödets namn</label>
                    <input id="ad-flow-name" value={form.name} onChange={(event) => update("name", event.target.value)} maxLength={160} />
                  </div>
                  <div className={styles.field}>
                    <label htmlFor="ad-trigger">Starta</label>
                    <select id="ad-trigger" value={form.trigger} onChange={(event) => updateTrigger(event.target.value as AdTriggerKind)}>
                      <option value="schedule">På en återkommande tid</option>
                      <option value="signal">När ett utvalt erbjudande ändras</option>
                      <option value="manual">Bara när jag själv startar</option>
                    </select>
                  </div>
                  <div className={`${styles.field} ${styles.fieldFull}`}>
                    <label htmlFor="ad-source">Underlag som får användas</label>
                    <textarea id="ad-source" value={form.sourceSummary} onChange={(event) => update("sourceSummary", event.target.value)} maxLength={1_200} />
                    <small>Beskriv brief, erbjudande, produktnyhet eller andra godkända källor. SAGA hämtar inte nya externa uppgifter här.</small>
                  </div>
                </div>
              </fieldset>
            </li>

            <li className={`${styles.node} ${styles.nodeCreative} ${selectedCanvasStep === "brief" || selectedCanvasStep === "safety" ? styles.nodeSelected : ""}`}>
              <span className={styles.nodeMark} aria-hidden="true">02</span>
              <fieldset className={styles.nodeCard} id="ad-node-brief" tabIndex={-1}>
                <legend className={styles.srOnly}>Kreativt recept</legend>
                <div className={styles.stepHeader}>
                  <div><p className={styles.nodeOverline}>KREATIVT RECEPT</p><h3>Vad ska annonsen göra?</h3><p>Bestäm mål, budskap, bildkälla och hur många tydliga variationer som ska beskrivas. I v1 sparas detta som ett granskningsbart creative brief.</p></div>
                  <span className={styles.variantCount}>{form.variantCount} varianter</span>
                </div>
                <div className={styles.fieldGrid}>
                  <div className={styles.field}>
                    <label htmlFor="ad-objective">Mål</label>
                    <select id="ad-objective" value={form.objective} onChange={(event) => update("objective", event.target.value as AdObjective)}>
                      {Object.entries(objectiveLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                  </div>
                  <div className={styles.field}>
                    <label htmlFor="ad-format">Format</label>
                    <select id="ad-format" value={form.format} onChange={(event) => update("format", event.target.value as AdFormat)}>
                      {Object.entries(formatLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                  </div>
                  <div className={styles.field}>
                    <label htmlFor="ad-hook">Öppning / hook</label>
                    <input id="ad-hook" value={form.hook} onChange={(event) => update("hook", event.target.value)} maxLength={240} placeholder="Till exempel: Redo när det är dags?" />
                  </div>
                  <div className={styles.field}>
                    <label htmlFor="ad-cta">Call to action</label>
                    <input id="ad-cta" value={form.callToAction} onChange={(event) => update("callToAction", event.target.value)} maxLength={200} placeholder="Till exempel: Boka en provkörning" />
                  </div>
                  <div className={`${styles.field} ${styles.fieldFull}`} id="ad-node-safety" tabIndex={-1}>
                    <label htmlFor="ad-value">Huvudbudskap</label>
                    <textarea id="ad-value" value={form.creativeValue} onChange={(event) => update("creativeValue", event.target.value)} maxLength={10_000} placeholder="Till exempel: lyft trygg provkörning, ett begränsat erbjudande och ett mänskligt språk." />
                  </div>
                  <div className={styles.field}>
                    <label htmlFor="ad-media-source">Bild- och mediekälla</label>
                    <select id="ad-media-source" value={form.mediaSource} onChange={(event) => update("mediaSource", event.target.value as AdMediaSource)}>
                      {Object.entries(mediaSourceLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                  </div>
                  <div className={styles.field}>
                    <label htmlFor="ad-visual-metaphor">Visuell idé</label>
                    <select id="ad-visual-metaphor" value={form.visualMetaphor} onChange={(event) => update("visualMetaphor", event.target.value as AdVisualMetaphor)}>
                      {Object.entries(visualMetaphorLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                  </div>
                  <div className={`${styles.field} ${styles.fieldFull}`}>
                    <label htmlFor="ad-custom-visual">Egen bildriktning <small>(valfritt, manuellt flöde)</small></label>
                    <input id="ad-custom-visual" value={form.trigger === "schedule" ? "" : form.customVisualDirection} disabled={form.trigger === "schedule"} onChange={(event) => update("customVisualDirection", event.target.value)} maxLength={1_000} placeholder="Till exempel: varm verkstadsmiljö, riktiga människor och tydliga produktdetaljer." />
                    <small>{form.trigger === "schedule" ? "Schemalagda flöden använder en standardiserad brief i v1. Egen bildriktning sparas inte där, och ingen bild skapas eller klareras automatiskt." : "Bildriktningen sparas som underlag och granskas vid test. Den innebär inte automatisk klarering eller extern leverans."}</small>
                  </div>
                  <div className={`${styles.field} ${styles.fieldFull}`}>
                    <label htmlFor="ad-offer-copy">Erbjudande</label>
                    <textarea id="ad-offer-copy" value={form.offerCopy} onChange={(event) => update("offerCopy", event.target.value)} maxLength={2_000} placeholder="Till exempel: Boka provkörning i Sätra innan helgen." />
                  </div>
                  <div className={styles.field}>
                    <label htmlFor="ad-offer-terms">Villkor / reservation</label>
                    <input id="ad-offer-terms" value={form.offerTerms} onChange={(event) => update("offerTerms", event.target.value)} maxLength={2_000} placeholder="Hur erbjudandet får uttryckas" />
                  </div>
                  <div className={styles.field}>
                    <label htmlFor="ad-offer-source">Källa för erbjudandet</label>
                    <input id="ad-offer-source" value={form.offerSourceReference} onChange={(event) => update("offerSourceReference", event.target.value)} maxLength={500} placeholder="Till exempel: intern kampanjbrief eller villkorsunderlag" />
                  </div>
                  <div className={`${styles.field} ${styles.fieldFull}`}>
                    <span>Verifieringsläge</span>
                    <div className={styles.lockNotice}>
                      <span aria-hidden="true">◌</span>
                      <div><strong>{OFFER_VERIFICATION_STATUS.title}</strong><p>{OFFER_VERIFICATION_STATUS.detail}</p></div>
                    </div>
                  </div>
                  <div className={`${styles.field} ${styles.fieldFull}`}>
                    <span>Antal kreativa varianter</span>
                    <div className={styles.variantGrid} role="radiogroup" aria-label="Antal kreativa varianter">
                      {([1, 3, 5] as const).map((count) => <label className={styles.variantOption} key={count}><input type="radio" name="variants" value={count} checked={form.variantCount === count} onChange={() => update("variantCount", count)} /><strong>{count} {count === 1 ? "version" : "versioner"}</strong><span className={styles.choiceDescription}>{count === 1 ? "En fokuserad riktning" : count === 3 ? "Tre tydliga vinklar" : "Bredare kreativt test"}</span></label>)}
                    </div>
                    <small>Antalet läggs som en tydlig instruktion i den kreativa briefen när flödet sparas.</small>
                  </div>
                </div>
              </fieldset>
            </li>

            <li className={`${styles.node} ${styles.nodeLocked} ${selectedCanvasStep === "draft" ? styles.nodeSelected : ""}`}>
              <span className={styles.nodeMark} aria-hidden="true">03</span>
              <section className={styles.nodeCard} id="ad-node-draft" tabIndex={-1} aria-labelledby="ad-ai-copy-title">
                <div className={styles.stepHeader}>
                  <div><p className={styles.nodeOverline}>PRIVAT UTKAST</p><h3 id="ad-ai-copy-title">Skapa ett granskningsbart brief</h3><p>Test och schemaläggning kan bara skapa ett privat, deterministiskt creative brief. Ingen modell, bildgenerator eller annonsplattform anropas här.</p></div>
                  <span className={styles.statusBlocked}>Endast privat</span>
                </div>
                <div className={styles.lockNotice}><span aria-hidden="true">⌁</span><div><strong>AI-copy är låst</strong><p>Kommer efter policy-aware AI-output validation. En egen bildriktning är underlag för granskning, inte en automatisk klarering.</p></div></div>
              </section>
            </li>

            <li className={`${styles.node} ${styles.nodeReview} ${selectedCanvasStep === "review" ? styles.nodeSelected : ""}`}>
              <span className={styles.nodeMark} aria-hidden="true">04</span>
              <fieldset className={styles.nodeCard} id="ad-node-review" tabIndex={-1}>
                <legend className={styles.srOnly}>Granskningsspärr</legend>
                <div className={styles.stepHeader}>
                  <div><p className={styles.nodeOverline}>GRANSKNING</p><h3>Stoppa före extern leverans</h3><p>Varje test och körning skapar ett privat utkast först. Den här vyn kräver ett granskningssteg; extern leverans är fortfarande låst.</p></div>
                  <span className={styles.statusReady}>Krävs</span>
                </div>
                <div className={styles.reviewControl}>
                  <div><strong>Alltid mänsklig kontroll</strong><p>Kontrollera copy, bild, målgrupp och kanal innan något får lämna Studio.</p></div>
                  <label className={styles.switch}><input type="checkbox" checked readOnly aria-label="Alltid mänsklig kontroll är aktiverad" /><span className={styles.srOnly}>Alltid mänsklig kontroll</span></label>
                </div>
              </fieldset>
            </li>

            <li className={`${styles.node} ${styles.nodeSchedule} ${selectedCanvasStep === "schedule" ? styles.nodeSelected : ""}`}>
              <span className={styles.nodeMark} aria-hidden="true">05</span>
              <fieldset className={styles.nodeCard} id="ad-node-schedule" tabIndex={-1} disabled={form.trigger !== "schedule"}>
                <legend className={styles.srOnly}>Tid</legend>
                <div className={styles.stepHeader}>
                  <div><p className={styles.nodeOverline}>TID</p><h3>När ska ett nytt utkast få skapas?</h3><p>{form.trigger === "schedule" ? "En återkommande tid kan skapa ett privat, deterministiskt creative-brief-utkast efter säkerhetskontroll. Den skickar ingen annons och använder ingen modell." : `Din valda start är “${triggerLabels[form.trigger].toLowerCase()}”, så tid är inte en del av körningen.`}</p></div>
                  <span className={styles.nodeType}>{form.trigger === "schedule" ? "Veckovis" : "Inte aktiv"}</span>
                </div>
                <div className={styles.fieldGrid}>
                  <div className={styles.field}>
                    <label htmlFor="ad-weekday">Veckodag</label>
                    <select id="ad-weekday" value={form.weekday} onChange={(event) => update("weekday", Number(event.target.value))}>
                      {Object.entries(weekdayLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                  </div>
                  <div className={styles.field}>
                    <label htmlFor="ad-local-time">Klockslag</label>
                    <input id="ad-local-time" type="time" value={form.localTime} onChange={(event) => update("localTime", event.target.value)} />
                  </div>
                  <div className={`${styles.field} ${styles.fieldFull}`}>
                    <label htmlFor="ad-timezone">Tidszon</label>
                    <select id="ad-timezone" value={form.timezone} onChange={(event) => update("timezone", event.target.value)}><option value="Europe/Stockholm">Europe/Stockholm</option></select>
                  </div>
                </div>
              </fieldset>
            </li>

            <li className={`${styles.node} ${styles.nodeDestination} ${selectedCanvasStep === "destination" ? styles.nodeSelected : ""}`}>
              <span className={styles.nodeMark} aria-hidden="true">06</span>
              <fieldset className={styles.nodeCard} id="ad-node-destination" tabIndex={-1}>
                <legend className={styles.srOnly}>Destinationer</legend>
                <div className={styles.stepHeader}>
                  <div><p className={styles.nodeOverline}>DESTINATIONER</p><h3>Vilka annonsformat ska förberedas?</h3><p>Välj mål redan nu. SAGA sparar dem med flödet, men visar ärligt att externa annonskonton ännu inte körs från den här motorn.</p></div>
                  <span className={styles.publicationPill}>Extern körning saknas</span>
                </div>
                <div className={styles.destinationList}>
                  {DESTINATION_CHOICES.map((choice) => <label className={styles.destinationOption} key={choice.provider}><input type="checkbox" checked={form.destinationProviders.includes(choice.provider)} onChange={() => toggleDestination(choice.provider)} /><span className={styles.destinationMark} aria-hidden="true">{choice.mark}</span><span><strong>{choice.label}</strong><span className={styles.destinationDescription}>{choice.detail}</span></span><span className={styles.destinationState}>Inte ansluten</span></label>)}
                </div>
                <div className={styles.fieldGrid}>
                  <div className={styles.field}>
                    <label htmlFor="ad-campaign-name">Kampanjnamn <small>(valfritt)</small></label>
                    <input id="ad-campaign-name" value={form.campaignName} onChange={(event) => update("campaignName", event.target.value)} maxLength={160} placeholder="Till exempel: Höstkampanj 2026" />
                  </div>
                  <div className={styles.field}>
                    <label htmlFor="ad-destination-url">Landningssida <small>(valfritt)</small></label>
                    <input id="ad-destination-url" type="url" value={form.destinationUrl} onChange={(event) => update("destinationUrl", event.target.value)} maxLength={2_000} placeholder="https://…" />
                  </div>
                </div>
              </fieldset>
            </li>

            <li className={`${styles.node} ${styles.nodeReview}`}>
              <span className={styles.nodeMark} aria-hidden="true">07</span>
              <fieldset className={styles.nodeCard}>
                <legend className={styles.srOnly}>Spara och aktivera</legend>
                <div className={styles.stepHeader}>
                  <div><p className={styles.nodeOverline}>SPARA OCH TESTA</p><h3>Aktivera privata draft briefs</h3><p>Endast ett schemalagt flöde kan aktiveras. Då skapas en privat, deterministisk creative brief efter säkerhetskontroll — aldrig AI-copy, ett annonsköp eller extern publicering.</p></div>
                  <span className={form.id ? styles.statusReady : styles.statusPill}>{form.id ? "Sparat flöde" : "Ej sparat"}</span>
                </div>
                <div className={styles.reviewControl}>
                  <div><strong>{form.trigger === "schedule" ? form.active ? "Privata draft briefs är aktiva" : "Privata draft briefs är pausade" : "Välj en schemalagd trigger för aktivering"}</strong><p>{form.trigger === "schedule" ? form.active ? "SAGA får skapa en privat, deterministisk brief vid din valda tid. Inga AI- eller leverantörsanrop görs." : "Spara och slå på när du vill att SAGA ska skapa privata briefs enligt ditt schema." : "Manuella och signalbaserade triggers kan sparas och testas, men får inte köras automatiskt ännu."}</p></div>
                  <label className={styles.switch}><input type="checkbox" checked={form.active} disabled={form.trigger !== "schedule"} onChange={(event) => update("active", event.target.checked)} aria-label="Aktivera detta flöde för privata, deterministiska creative-brief-utkast" /><span className={styles.srOnly}>Aktivera privata draft briefs</span></label>
                </div>
              </fieldset>
            </li>
          </ol>}

          <footer className={styles.formFooter}>
            <p className={styles.footerDetail}>Spara konfigurationen först. Testa därefter för att skapa ett privat, deterministiskt creative-brief-utkast i Studio. SAGA använder ingen modell eller extern annonsplattform i detta flöde och påstår aldrig att en annons är publicerad.</p>
            <div className={styles.formActions}>
              <button className={styles.buttonQuiet} type="button" onClick={startNew}>Nytt flöde</button>
              <button className={styles.buttonSecondary} type="button" disabled={testDisabled} onClick={() => void testAutomation({ fresh: Boolean(testResult?.confirmed) })}>{testButtonLabel}</button>
              <button className={styles.button} type="submit" disabled={saveDisabled}>{saving ? "Sparar…" : "Spara flöde"}</button>
            </div>
          </footer>
        </form>

        <aside className={styles.summary} aria-labelledby="ad-flow-summary-title">
          <header className={styles.summaryHeader}>
            <p className={styles.summaryEyebrow}>SÅ HÄR KÖRS DET</p>
            <h2 id="ad-flow-summary-title">Flödesöversikt</h2>
            <p>En snabb, läsbar kontroll före du sparar eller testar.</p>
          </header>
          <ol className={styles.summaryFlow}>
            <li><span className={styles.summaryIndex}>1</span><div><strong>{triggerLabels[form.trigger]}</strong><span>{truncate(form.sourceSummary, 78) || "Välj vilket underlag som ska användas."}</span></div></li>
            <li><span className={styles.summaryIndex}>2</span><div><strong>{objectiveLabels[form.objective]} · {formatLabels[form.format]}</strong><span>{form.variantCount} {form.variantCount === 1 ? "kreativ version" : "kreativa versioner"} med {mediaSourceLabels[form.mediaSource].toLowerCase()}.</span></div></li>
            <li><span className={styles.summaryIndex}>3</span><div><strong>AI-copy är låst</strong><span>Kommer efter policy-aware AI-output validation.</span></div></li>
            <li><span className={styles.summaryIndex}>4</span><div><strong>Privat granskning krävs</strong><span>Inget lämnar Studio utan ett granskningssteg.</span></div></li>
            <li><span className={styles.summaryIndex}>5</span><div><strong>{form.trigger === "schedule" ? `${weekdayLabels[form.weekday]} ${form.localTime}` : "Ingen automatisk tid"}</strong><span>{form.trigger === "schedule" ? form.active ? `${form.timezone} · privata briefs är aktiva` : `${form.timezone} · schemat är pausat` : "Startas endast med Testa privat utkast i den här versionen."}</span></div></li>
            <li><span className={styles.summaryIndex}>6</span><div><strong>{destinationSummary(form.destinationProviders)}</strong><span>{form.campaignName.trim() ? `Kampanj: ${form.campaignName.trim()}` : "Ingen extern leverans är ansluten."}</span></div></li>
          </ol>
          <section className={styles.publicationStatus} aria-label="Extern leveransstatus">
            <strong>Extern leverans: inte tillgänglig</strong>
            <p>{savedDestinationStatuses.length ? savedDestinationStatuses.map((destination) => `${destination.label}: ${destination.execution?.message || "annonskontot är inte anslutet"}`).join(" · ") : "SAGA kan spara mål och skapa privata utkast. Meta, Google och LinkedIn får inga annonsköp eller publiceringar från detta flöde ännu."}</p>
          </section>
          <section className={styles.testSummary} aria-label="Senaste testresultat">
            <div><strong>{testResult ? testResult.tone === "error" ? "Testet behöver åtgärd" : "Senaste testet" : "Inget test ännu"}</strong><span>{testResult ? testResult.message : form.id ? "Testa när du vill skapa ett privat utkast." : "Spara flödet för att kunna testa det."}</span></div>
            {testResult?.draftId ? <Link className={styles.testLink} href={`/studio/content/${encodeURIComponent(testResult.draftId)}`}>Öppna utkast →</Link> : null}
          </section>
        </aside>
      </div>

      <section className={styles.saved} aria-labelledby="saved-ad-flows-title">
        <header className={styles.savedHeader}>
          <div><p className={styles.savedEyebrow}>SPARADE FLÖDEN</p><h2 id="saved-ad-flows-title">Fortsätt där du slutade</h2><p>Öppna ett sparat flöde för att ändra, spara och testa privat. Ett aktivt schema får bara skapa deterministiska private briefs.</p></div>
          <button className={styles.buttonSecondary} type="button" onClick={startNew}>Skapa nytt</button>
        </header>
        {readiness === "loading" ? <div className={styles.loadingNodes} aria-busy="true"><div className={styles.loadingNode} /></div> : automations.length ? <ul className={styles.savedList}>{automations.map((automation) => <li key={automation.id}><button className={styles.savedItem} type="button" aria-pressed={form.id === automation.id} onClick={() => selectSaved(automation)}><span><strong className={styles.savedItemName}>{automation.name}</strong><span className={styles.savedItemMeta}><span className={automation.active ? styles.statusReady : styles.statusPaused}>{automation.active ? "Privata briefs aktiva" : "Pausat"}</span><span>{automation.workflow.destinations.length} {automation.workflow.destinations.length === 1 ? "destination" : "destinationer"}</span><span>{automation.workflow.review.required ? "Granskning krävs" : "Granskning saknas"}</span></span></span><span className={styles.savedItemActions}><span>Öppna</span><span aria-hidden="true">→</span></span></button></li>)}</ul> : <div className={styles.emptySaved}><strong>Inga sparade annonsflöden ännu.</strong><span>Fyll i stegen ovan, spara och testa sedan i privat läge.</span></div>}
      </section>
    </section>
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function revisionValue(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 2_147_483_647 ? value : null;
}

function numberArray(value: unknown) {
  return Array.isArray(value) ? value.filter((entry): entry is number => typeof entry === "number" && Number.isInteger(entry) && entry >= 0 && entry <= 6) : [];
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0) : [];
}

function isTriggerKind(value: string): value is AdTriggerKind {
  return value === "manual" || value === "schedule" || value === "signal";
}

function isObjective(value: string): value is AdObjective {
  return value === "awareness" || value === "traffic" || value === "leads" || value === "sales";
}

function isFormat(value: string): value is AdFormat {
  return value === "short_form_video" || value === "paid_social" || value === "display";
}

function isMediaSource(value: string): value is AdMediaSource {
  return value === "ai" || value === "stock" || value === "owned" || value === "mixed";
}

function isVisualMetaphor(value: string): value is AdVisualMetaphor {
  return value === "calendar_turn" || value === "day_to_evening" || value === "tread_transition" || value === "prepared_shelf";
}

function isScheduleMode(value: string): value is AdAutomationWorkflow["schedule"]["mode"] {
  return value === "manual" || value === "weekly_count" || value === "cron";
}

function isDestinationProvider(value: string): value is AdDestinationProvider {
  return DESTINATION_CHOICES.some((choice) => choice.provider === value) || value === "facebook_page" || value === "instagram" || value === "linkedin" || value === "newsletter" || value === "rss";
}

function isTime(value: string) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function truncate(value: string, limit: number) {
  const normalized = value.trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1).trimEnd()}…` : normalized;
}

function destinationSummary(providers: AdDestinationProvider[]) {
  const labels = providers.flatMap((provider) => DESTINATION_CHOICES.filter((choice) => choice.provider === provider).map((choice) => choice.label));
  if (!labels.length) return "Ingen destination vald";
  return labels.join(" · ");
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json() as unknown;
  } catch {
    return null;
  }
}

function responseMessage(value: unknown, fallback: string) {
  if (!isRecord(value)) return fallback;
  return stringValue(value.message) || stringValue(value.error) || fallback;
}
