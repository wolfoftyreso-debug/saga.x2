"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import styles from "@/components/saga-quarterly-plan.module.css";
import {
  abandonSagaQuarterlyBatch,
  activeSagaQuarterlyBatch,
  createSagaQuarterlyBatch,
  createSagaQuarterlyPlanIdempotencyKey,
  deriveSagaQuarterlyPlanPreview,
  materializeSagaQuarterlyBatch,
  mondayForSagaRollingQuarter,
  readSagaQuarterlyBrandOptions,
  readSagaQuarterlyPlan,
  readSagaQuarterlyPlanOverviews,
  resubmitSagaQuarterlyBatchItem,
  reviewSagaQuarterlyBatchItem,
  saveSagaQuarterlyPlan,
  titleForSagaActivityChannel,
  validateSagaQuarterlyPlan,
  type SagaActivityChannel,
  type SagaQuarterlyBatchItemView,
  type SagaQuarterlyBatchView,
  type SagaQuarterlyBrandOption,
  type SagaQuarterlyContentTheme,
  type SagaQuarterlyPlan,
  type SagaQuarterlyPlanInput,
  type SagaQuarterlyPlanWorkspace,
  type SagaWeekday,
} from "@/lib/client/saga-quarterly-plan";

type LoadState = "loading" | "ready" | "error";
type ActionState = "idle" | "saving" | "creating_batch" | "resuming_batch" | "retrying_batch" | "abandoning_batch" | "reviewing" | "resubmitting";
type CadenceDraft =
  | { unit: "weekly"; count: number; weekdayIds: SagaWeekday[]; localTime: string }
  | { unit: "monthly"; count: number; dayOfMonth: number[]; localTime: string };
type ChannelDraft = {
  id: string;
  channel: SagaActivityChannel;
  enabled: boolean;
  objective: string;
  cadence: CadenceDraft;
  theme: SagaQuarterlyContentTheme;
  desiredCallToAction: string;
  imageDirection: string;
  targetLength: "short" | "medium" | "long";
};
type PlannerForm = { name: string; horizonStartDate: string; timezone: string; channels: ChannelDraft[] };

const CHANNELS: Array<{ channel: SagaActivityChannel; detail: string }> = [
  { channel: "facebook_page", detail: "Inlägg i din Facebook-plan." },
  { channel: "instagram", detail: "Inlägg eller karusell i din Instagram-plan." },
  { channel: "linkedin", detail: "Perspektiv, erfarenhet eller tydlig insikt." },
  { channel: "newsletter", detail: "Ett sammanhållet utskick till egna läsare." },
];

const WEEKDAYS: Array<{ id: SagaWeekday; short: string; label: string }> = [
  { id: 1, short: "Mån", label: "Måndag" },
  { id: 2, short: "Tis", label: "Tisdag" },
  { id: 3, short: "Ons", label: "Onsdag" },
  { id: 4, short: "Tor", label: "Torsdag" },
  { id: 5, short: "Fre", label: "Fredag" },
  { id: 6, short: "Lör", label: "Lördag" },
  { id: 0, short: "Sön", label: "Söndag" },
];

function blankTheme(channel: SagaActivityChannel): SagaQuarterlyContentTheme {
  return {
    id: `${channel.replace("_", "-")}-huvudtema`,
    title: "",
    intent: "",
    contentDirection: "",
    approved: true,
  };
}

function blankChannel(channel: SagaActivityChannel): ChannelDraft {
  return {
    id: `${channel.replace("_", "-")}-plan`,
    channel,
    enabled: false,
    objective: "",
    cadence: { unit: "weekly", count: 1, weekdayIds: [1], localTime: "09:30" },
    theme: blankTheme(channel),
    desiredCallToAction: "",
    imageDirection: "",
    targetLength: "medium",
  };
}

function blankForm(): PlannerForm {
  return { name: "Rullande 13-veckorsplan", horizonStartDate: mondayForSagaRollingQuarter(), timezone: "Europe/Stockholm", channels: CHANNELS.map(({ channel }) => blankChannel(channel)) };
}

function formFromPlan(plan: SagaQuarterlyPlan): PlannerForm {
  const current = new Map(plan.plan.channelPlans.map((entry) => [entry.channel, entry]));
  return {
    name: plan.plan.name,
    horizonStartDate: plan.plan.horizonStartDate,
    timezone: plan.plan.timezone,
    channels: CHANNELS.map(({ channel }) => {
      const source = current.get(channel);
      if (!source) return blankChannel(channel);
      const theme = source.themes[0] ?? blankTheme(channel);
      return {
        id: source.id,
        channel,
        enabled: true,
        objective: source.objective,
        cadence: source.cadence.unit === "weekly"
          ? { unit: "weekly", count: source.cadence.count, weekdayIds: [...source.cadence.weekdayIds] as SagaWeekday[], localTime: source.cadence.localTimes[0] ?? "09:30" }
          : { unit: "monthly", count: source.cadence.count, dayOfMonth: [...source.cadence.dayOfMonth], localTime: source.cadence.localTimes[0] ?? "09:30" },
        theme: { ...theme },
        desiredCallToAction: source.desiredCallToAction,
        imageDirection: source.imageDirection,
        targetLength: source.targetLength,
      };
    }),
  };
}

function canonicalPlan(form: PlannerForm): SagaQuarterlyPlanInput {
  return {
    name: form.name.trim() || "Rullande 13-veckorsplan",
    horizonStartDate: form.horizonStartDate,
    timezone: form.timezone,
    channelPlans: form.channels.filter((channel) => channel.enabled).map((channel) => ({
      id: channel.id,
      channel: channel.channel,
      contentType: channel.channel === "newsletter" ? "newsletter" : "social_post",
      objective: channel.objective,
      cadence: channel.cadence.unit === "weekly"
        ? { unit: "weekly" as const, count: channel.cadence.count, weekdayIds: channel.cadence.weekdayIds, localTimes: [channel.cadence.localTime] }
        : { unit: "monthly" as const, count: channel.cadence.count, dayOfMonth: channel.cadence.dayOfMonth, localTimes: [channel.cadence.localTime] },
      themes: [{ ...channel.theme, approved: true as const }],
      desiredCallToAction: channel.desiredCallToAction,
      imageDirection: channel.imageDirection,
      targetLength: channel.targetLength,
    })),
  };
}

function queryBrandProfileId() {
  if (typeof window === "undefined") return null;
  const value = new URLSearchParams(window.location.search).get("brand");
  return value && /^[0-9a-f-]{36}$/i.test(value) ? value : null;
}

/**
 * A materialization key is a retry receipt, not plan data. Keeping it for the
 * current browser session lets a queued request be safely resumed after a
 * transient network failure without inventing a second production command.
 */
function materializeReceiptStorageKey(batchId: string) {
  return `saga-quarterly-materialize:${batchId}`;
}

function readMaterializeReceipt(batchId: string) {
  if (typeof window === "undefined") return null;
  try { return window.sessionStorage.getItem(materializeReceiptStorageKey(batchId)); } catch { return null; }
}

function writeMaterializeReceipt(batchId: string, key: string) {
  if (typeof window === "undefined") return;
  try { window.sessionStorage.setItem(materializeReceiptStorageKey(batchId), key); } catch { /* A running tab can still retry from memory. */ }
}

function clearMaterializeReceipt(batchId: string) {
  if (typeof window === "undefined") return;
  try { window.sessionStorage.removeItem(materializeReceiptStorageKey(batchId)); } catch { /* Nothing to clear. */ }
}

function plural(value: number, singular: string, pluralValue: string) {
  return `${value} ${value === 1 ? singular : pluralValue}`;
}

function dateLabel(value: string) {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.valueOf())) return "Okänt datum";
  return new Intl.DateTimeFormat("sv-SE", { day: "numeric", month: "short", timeZone: "UTC" }).format(date);
}

function addDays(value: string, days: number) {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.valueOf())) return null;
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function weekRange(start: string, weekIndex: number) {
  const first = addDays(start, (weekIndex - 1) * 7);
  const last = first ? addDays(first, 6) : null;
  return first && last ? `${dateLabel(first)}–${dateLabel(last)}` : "Datum saknas";
}

function batchStateLabel(batch: SagaQuarterlyBatchView) {
  return {
    queued: "Privat produktion är köad",
    generating: "Skapar privata utkast",
    ready_for_review: "Redo för mänsklig granskning",
    rework_required: "Ett utkast behöver ändras",
    resolved: "Batchen är beslutad",
    failed: "Produktionen behöver åtgärd",
    stale: "Planen har ändrats — läs in igen",
  }[batch.state];
}

function reviewLabel(item: SagaQuarterlyBatchItemView) {
  if (item.reviewResolution === "approved") return "Godkänt";
  if (item.reviewResolution === "returned") return "Ändring krävs";
  if (item.reviewResolution === "rejected") return "Avvisat";
  return "Väntar på beslut";
}

export function SagaQuarterlyPlan() {
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [apiAvailable, setApiAvailable] = useState(false);
  const [brands, setBrands] = useState<SagaQuarterlyBrandOption[]>([]);
  const [selectedBrandProfileId, setSelectedBrandProfileId] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<SagaQuarterlyPlanWorkspace>({ plan: null, batches: [], message: null });
  const [form, setForm] = useState<PlannerForm>(blankForm);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionState, setActionState] = useState<ActionState>("idle");
  const [batchSize, setBatchSize] = useState(10);
  const [returningItemId, setReturningItemId] = useState<string | null>(null);
  const [returnNote, setReturnNote] = useState("");
  const [abandoningBatchId, setAbandoningBatchId] = useState<string | null>(null);
  const [abandonNote, setAbandonNote] = useState("");
  const createPlanKey = useRef<string | null>(null);
  const materializeReceipts = useRef(new Map<string, string>());

  const selectedBrand = brands.find((brand) => brand.brandProfileId === selectedBrandProfileId) ?? null;
  const planInput = useMemo(() => canonicalPlan(form), [form]);
  const planValidation = validateSagaQuarterlyPlan(planInput);
  const localPreview = useMemo(() => deriveSagaQuarterlyPlanPreview(planInput), [planInput]);
  const savedPlan = workspace.plan;
  const planIsDirty = Boolean(savedPlan && JSON.stringify(planInput) !== JSON.stringify(savedPlan.plan));
  const previewIsLocal = !savedPlan || planIsDirty;
  const visibleSlots = useMemo(() => previewIsLocal
    ? localPreview.ok ? localPreview.slots : []
    : savedPlan?.slots ?? [], [localPreview, previewIsLocal, savedPlan]);
  const planStart = previewIsLocal ? form.horizonStartDate : savedPlan?.plan.horizonStartDate ?? form.horizonStartDate;
  const activeBatch = activeSagaQuarterlyBatch(workspace.batches);
  const latestBatch = activeBatch ?? workspace.batches[0] ?? null;
  const savedCandidateSlots = savedPlan?.slots.filter((slot) => slot.state === "planned") ?? [];
  const canCreateBatch = Boolean(apiAvailable && selectedBrand && savedPlan?.canRequestBatch && !planIsDirty && !activeBatch && savedCandidateSlots.length);
  const slotsByWeek = useMemo(() => Array.from({ length: 13 }, (_, index) => {
    const weekIndex = index + 1;
    return { weekIndex, slots: visibleSlots.filter((slot) => slot.weekIndex === weekIndex) };
  }), [visibleSlots]);

  const loadSelectedBrand = useCallback(async (brandProfileId: string, preserveForm = false) => {
    setLoadState("loading");
    setError(null);
    const result = await readSagaQuarterlyPlan(brandProfileId);
    if (!result.ok) {
      setApiAvailable(false);
      setLoadState("error");
      setError(result.message);
      return;
    }
    setApiAvailable(true);
    setWorkspace(result.value);
    result.value.batches.forEach((batch) => {
      if (!["queued", "generating"].includes(batch.state)) {
        materializeReceipts.current.delete(batch.id);
        clearMaterializeReceipt(batch.id);
      }
    });
    if (result.value.plan && !preserveForm) setForm(formFromPlan(result.value.plan));
    if (!result.value.plan && !preserveForm) setForm(blankForm());
    if (result.value.message) setNotice(result.value.message);
    setLoadState("ready");
  }, []);

  useEffect(() => {
    let active = true;
    void Promise.all([readSagaQuarterlyBrandOptions(), readSagaQuarterlyPlanOverviews()]).then(([brandResult, planResult]) => {
      if (!active) return;
      if (!brandResult.ok) {
        setLoadState("error");
        setError(brandResult.message);
        return;
      }
      setBrands(brandResult.value);
      if (!planResult.ok) {
        setApiAvailable(false);
        setNotice(planResult.message);
      } else {
        setApiAvailable(true);
      }
      const requested = queryBrandProfileId();
      const plannedBrand = planResult.ok ? planResult.value.find((plan) => plan.brandProfileId === requested) ?? planResult.value[0] : null;
      const preferredBrand = requested && brandResult.value.some((brand) => brand.brandProfileId === requested) ? requested : plannedBrand?.brandProfileId ?? brandResult.value[0]?.brandProfileId ?? null;
      setSelectedBrandProfileId(preferredBrand);
      if (!preferredBrand) setLoadState("ready");
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!selectedBrandProfileId) return;
    // Defer the read one task so this effect stays a subscription boundary,
    // rather than synchronously cascading state updates during render commit.
    const task = window.setTimeout(() => { void loadSelectedBrand(selectedBrandProfileId); }, 0);
    return () => window.clearTimeout(task);
  }, [loadSelectedBrand, selectedBrandProfileId]);

  // This only rereads server receipts while the server has a queued/generating
  // batch. The browser never advances a job or creates content itself.
  useEffect(() => {
    if (!selectedBrandProfileId || !activeBatch || !["queued", "generating"].includes(activeBatch.state)) return;
    const timer = window.setInterval(() => { void loadSelectedBrand(selectedBrandProfileId, true); }, 5000);
    return () => window.clearInterval(timer);
  }, [activeBatch, loadSelectedBrand, selectedBrandProfileId]);

  function selectBrand(value: string) {
    createPlanKey.current = null;
    setSelectedBrandProfileId(value || null);
    setWorkspace({ plan: null, batches: [], message: null });
    setNotice(null);
    setError(null);
    setReturningItemId(null);
    setAbandoningBatchId(null);
    setAbandonNote("");
  }

  function updateChannel(id: string, update: Partial<ChannelDraft>) {
    createPlanKey.current = null;
    setNotice(null);
    setError(null);
    setForm((current) => ({ ...current, channels: current.channels.map((channel) => channel.id === id ? { ...channel, ...update, theme: update.theme ?? channel.theme, cadence: update.cadence ?? channel.cadence } : channel) }));
  }

  function updatePlanMeta(update: Partial<Pick<PlannerForm, "name" | "horizonStartDate" | "timezone">>) {
    createPlanKey.current = null;
    setNotice(null);
    setError(null);
    setForm((current) => ({ ...current, ...update }));
  }

  function rememberMaterializeReceipt(batchId: string, key: string) {
    materializeReceipts.current.set(batchId, key);
    writeMaterializeReceipt(batchId, key);
  }

  function materializeReceiptFor(batchId: string) {
    const existing = materializeReceipts.current.get(batchId) ?? readMaterializeReceipt(batchId);
    if (existing) materializeReceipts.current.set(batchId, existing);
    return existing;
  }

  function updateWeeklyDays(channel: ChannelDraft, weekday: SagaWeekday) {
    if (channel.cadence.unit !== "weekly") return;
    const selected = channel.cadence.weekdayIds.includes(weekday);
    const next = selected ? channel.cadence.weekdayIds.filter((entry) => entry !== weekday) : [...channel.cadence.weekdayIds, weekday].sort((left, right) => left - right);
    updateChannel(channel.id, { cadence: { ...channel.cadence, weekdayIds: next.length ? next : [weekday], count: next.length || 1 } });
  }

  async function savePlan() {
    if (!selectedBrand || !apiAvailable || actionState !== "idle") return;
    if (planValidation) {
      setError(planValidation);
      return;
    }
    setActionState("saving");
    setError(null);
    setNotice(null);
    if (!savedPlan) createPlanKey.current = createPlanKey.current ?? createSagaQuarterlyPlanIdempotencyKey();
    const result = await saveSagaQuarterlyPlan({ brandProfileId: selectedBrand.brandProfileId, plan: planInput, existingRevision: savedPlan?.revision ?? null, createIdempotencyKey: createPlanKey.current });
    setActionState("idle");
    if (!result.ok) {
      setError(result.message);
      return;
    }
    createPlanKey.current = null;
    setWorkspace((current) => ({ ...current, plan: result.value }));
    setForm(formFromPlan(result.value));
    setNotice("13-veckorsplanen är sparad. Planerade aktiviteter kan visas skrivskyddat i kalendern, men inga schemalagda eller publicerade poster, privata utkast eller publiceringar har skapats.");
  }

  async function createAndStartBatch() {
    if (!selectedBrand || !savedPlan || !canCreateBatch || actionState !== "idle") return;
    setActionState("creating_batch");
    setError(null);
    setNotice(null);
    const batchRequestKey = createSagaQuarterlyPlanIdempotencyKey();
    const materializeKey = createSagaQuarterlyPlanIdempotencyKey();
    if (!batchRequestKey || !materializeKey) {
      setActionState("idle");
      setError("Kunde inte skapa säkra körningskvitton. Ladda om sidan innan du startar en batch.");
      return;
    }
    const selectedSlots = savedCandidateSlots.slice(0, Math.max(1, Math.min(10, batchSize))).map((slot) => slot.id);
    const batchResult = await createSagaQuarterlyBatch({ brandProfileId: selectedBrand.brandProfileId, expectedPlanRevision: savedPlan.revision, planItemIds: selectedSlots, idempotencyKey: batchRequestKey });
    if (!batchResult.ok) {
      setActionState("idle");
      setError(batchResult.message);
      return;
    }
    // The one explicit action “Skapa nästa” both creates the durable request
    // and asks the server to begin private, quality-gated production. The UI
    // never offers a pre-draft approval stage.
    rememberMaterializeReceipt(batchResult.value.id, materializeKey);
    const materialized = await materializeSagaQuarterlyBatch({
      brandProfileId: selectedBrand.brandProfileId,
      batchId: batchResult.value.id,
      expectedPlanRevision: savedPlan.revision,
      expectedBatchRevision: batchResult.value.revision,
      idempotencyKey: materializeKey,
      retryFailed: false,
    });
    setActionState("idle");
    if (!materialized.ok) {
      setError(materialized.message);
      await loadSelectedBrand(selectedBrand.brandProfileId, true);
      return;
    }
    setNotice("Privat produktion är startad. SAGA visar granskningsknappar först när riktiga privata utkast har passerat kvalitetskontrollen.");
    await loadSelectedBrand(selectedBrand.brandProfileId, true);
  }

  async function startQueuedBatch(batch: SagaQuarterlyBatchView) {
    if (!selectedBrand || !savedPlan || actionState !== "idle" || batch.state !== "queued" || !batch.canMaterialize) return;
    const materializeKey = materializeReceiptFor(batch.id) ?? createSagaQuarterlyPlanIdempotencyKey();
    if (!materializeKey) {
      setError("Kunde inte skapa ett säkert körningskvitto för den köade batchen. Ladda om sidan och försök igen.");
      return;
    }
    rememberMaterializeReceipt(batch.id, materializeKey);
    setActionState("resuming_batch");
    setError(null);
    const result = await materializeSagaQuarterlyBatch({
      brandProfileId: selectedBrand.brandProfileId,
      batchId: batch.id,
      expectedPlanRevision: savedPlan.revision,
      expectedBatchRevision: batch.revision,
      idempotencyKey: materializeKey,
      retryFailed: false,
    });
    setActionState("idle");
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setNotice("Den köade privata produktionen är startad. Ingen extern publicering sker.");
    await loadSelectedBrand(selectedBrand.brandProfileId, true);
  }

  async function retryBatch(batch: SagaQuarterlyBatchView) {
    if (!selectedBrand || !savedPlan || actionState !== "idle" || batch.state !== "failed" || !batch.canRetry) return;
    setActionState("retrying_batch");
    setError(null);
    const result = await materializeSagaQuarterlyBatch({ brandProfileId: selectedBrand.brandProfileId, batchId: batch.id, expectedPlanRevision: savedPlan.revision, expectedBatchRevision: batch.revision, idempotencyKey: createSagaQuarterlyPlanIdempotencyKey(), retryFailed: true });
    setActionState("idle");
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setNotice("Ett nytt privat produktionsförsök är registrerat. Inga externa publiceringar sker.");
    await loadSelectedBrand(selectedBrand.brandProfileId, true);
  }

  async function abandonFailedBatch(batch: SagaQuarterlyBatchView) {
    if (!selectedBrand || !savedPlan || actionState !== "idle" || batch.state !== "failed" || !batch.canAbandon) return;
    if (abandonNote.trim().length < 3) {
      setError("Skriv kort varför den misslyckade batchen ska avslutas.");
      return;
    }
    setActionState("abandoning_batch");
    setError(null);
    const result = await abandonSagaQuarterlyBatch({
      brandProfileId: selectedBrand.brandProfileId,
      batchId: batch.id,
      idempotencyKey: createSagaQuarterlyPlanIdempotencyKey(),
      expectedPlanRevision: savedPlan.revision,
      expectedBatchRevision: batch.revision,
      note: abandonNote,
    });
    setActionState("idle");
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setAbandoningBatchId(null);
    setAbandonNote("");
    setNotice("Den misslyckade batchen är avslutad. Ofärdigt arbete är avbrutet, befintliga privata utkast finns kvar för granskning och inget har schemalagts eller publicerats.");
    await loadSelectedBrand(selectedBrand.brandProfileId, true);
  }

  async function resubmitBatchItem(batch: SagaQuarterlyBatchView, item: SagaQuarterlyBatchItemView) {
    if (!selectedBrand || !savedPlan || actionState !== "idle" || batch.state !== "rework_required" || item.state !== "returned" || !item.draftId || !item.draftRevision) return;
    if (item.returnedDraftRevision === null || item.draftRevision <= item.returnedDraftRevision) {
      setError("Redigera och spara det privata utkastet innan du skickar tillbaka det till granskning.");
      return;
    }
    setActionState("resubmitting");
    setError(null);
    const result = await resubmitSagaQuarterlyBatchItem({
      brandProfileId: selectedBrand.brandProfileId,
      batchId: batch.id,
      itemId: item.id,
      idempotencyKey: createSagaQuarterlyPlanIdempotencyKey(),
      expectedPlanRevision: savedPlan.revision,
      expectedBatchRevision: batch.revision,
      expectedItemRevision: item.revision,
      expectedDraftRevision: item.draftRevision,
    });
    setActionState("idle");
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setNotice("Det redigerade privata utkastet är tillbaka i samma granskningsbatch. Det har inte skapats på nytt och inget har publicerats.");
    await loadSelectedBrand(selectedBrand.brandProfileId, true);
  }

  async function resolveBatchItem(batch: SagaQuarterlyBatchView, item: SagaQuarterlyBatchItemView, resolution: "approved" | "returned" | "rejected", note?: string) {
    if (!selectedBrand || !savedPlan || actionState !== "idle" || batch.state !== "ready_for_review" || !item.draftId || !item.draftRevision) return;
    if (resolution === "returned" && !note?.trim()) {
      setReturningItemId(item.id);
      setError("Beskriv kort vad som ska ändras innan du skickar tillbaka utkastet.");
      return;
    }
    setActionState("reviewing");
    setError(null);
    const result = await reviewSagaQuarterlyBatchItem({
      brandProfileId: selectedBrand.brandProfileId,
      batchId: batch.id,
      itemId: item.id,
      idempotencyKey: createSagaQuarterlyPlanIdempotencyKey(),
      expectedPlanRevision: savedPlan.revision,
      expectedBatchRevision: batch.revision,
      expectedItemRevision: item.revision,
      expectedDraftRevision: item.draftRevision,
      resolution,
      note,
    });
    setActionState("idle");
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setReturningItemId(null);
    setReturnNote("");
    setNotice("Beslutet är sparat. Ingen tid eller extern publicering har ändrats.");
    await loadSelectedBrand(selectedBrand.brandProfileId, true);
  }

  const completeQuarter = Boolean(visibleSlots.some((slot) => slot.weekIndex === 13));
  const activeChannelCount = planInput.channelPlans.length;

  return <section className={styles.planner} aria-labelledby="quarterly-plan-title">
    <header className={styles.header}>
      <div className={styles.headerCopy}>
        <Link href="/studio" className={styles.backLink}>← Studio</Link>
        <p className={styles.eyebrow}>AKTIVITETSPLAN · 13 VECKOR</p>
        <h1 id="quarterly-plan-title">Bestäm takten först. Skapa nästa tio först när de föregående är beslutade.</h1>
        <p className={styles.intro}>Här bestämmer du vad varje kanal ska göra, hur ofta och när. Vyn är en planeringsyta — inte publiceringskalendern. En batch blir verkliga privata utkast först efter kvalitetskontroll.</p>
      </div>
      <WorkspaceState loadState={loadState} available={apiAvailable} message={error ?? workspace.message} />
    </header>

    <div className={styles.boundary}>
      <span>13 veckor är en planeringssnapshot, inte automatisk publicering.</span>
      <span>Privata utkast behöver media separat när det behövs; planen lovar inga färdiga bilder.</span>
    </div>
    {notice ? <p className={styles.notice} role="status">{notice}</p> : null}
    {error ? <p className={styles.error} role="alert">{error}</p> : null}

    {!brands.length && loadState !== "loading" ? <section className={styles.setupCard} aria-labelledby="planner-onboarding-title"><p className={styles.sectionEyebrow}>FÖRST VARUMÄRKET</p><h2 id="planner-onboarding-title">En aktivitetsplan behöver ett färdigt varumärke.</h2><p>Slutför onboarding med mål, målgrupp och budgetram först. Det skapar inget innehåll, men ger planeringen ett ansvarigt sammanhang.</p><div className={styles.setupCardActions}><Link className={styles.primaryButton} href="/studio/brands/new">Öppna varumärkesonboarding <span aria-hidden="true">→</span></Link></div></section> : null}

    {brands.length || loadState === "loading" ? <>
      <section className={styles.overviewGrid} aria-label="Överblick av 13-veckorsplanen">
        <article className={styles.overviewCard}>
          <div className={styles.overviewCardTop}>
            <div><p className={styles.cardEyebrow}>PLANERINGSOMFATTNING</p><h2>{selectedBrand ? `${selectedBrand.brandName}: nästa 13 veckor` : "Välj ett varumärke"}</h2><p>{savedPlan && !planIsDirty ? "Det här är den senast sparade planeringssnapshoten. Fyll nästa kvartal uttryckligen när du har granskat vad som fungerade." : "Välj omfattningen nedan. Förhandsvisningen är lokal tills du sparar den till arbetsytan."}</p></div>
            <label className={styles.brandSelect}><span>Varumärke</span><select value={selectedBrandProfileId ?? ""} disabled={loadState === "loading" || !brands.length} onChange={(event) => selectBrand(event.target.value)}><option value="">Välj varumärke</option>{brands.map((brand) => <option key={brand.brandProfileId} value={brand.brandProfileId}>{brand.brandName}</option>)}</select></label>
          </div>
          <ul className={styles.planMetrics}>
            <li><span>Horisont</span><strong>13 veckor</strong><small>{savedPlan && !planIsDirty ? `Start ${dateLabel(savedPlan.plan.horizonStartDate)}` : `Förhandsvisar från ${dateLabel(form.horizonStartDate)}`}</small></li>
            <li><span>Aktiva kanaler</span><strong>{activeChannelCount}</strong><small>Med tydlig takt</small></li>
            <li><span>Planerade aktiviteter</span><strong>{visibleSlots.length}</strong><small>{previewIsLocal ? "Lokal förhandsvisning" : "Serverbekräftade"}</small></li>
            <li><span>Nästa batch</span><strong>{activeBatch ? plural(activeBatch.requestedCount, "utkast", "utkast") : "Max 10"}</strong><small>{activeBatch ? batchStateLabel(activeBatch) : "Mänsklig granskning"}</small></li>
          </ul>
        </article>
        <article className={styles.readinessCard}>
          <div className={styles.readinessTop}><div><p className={styles.cardEyebrow}>KVARTALSKOLL</p><h2>{completeQuarter ? "Horisonten når vecka 13." : "Horisonten behöver fyllas."}</h2></div><span className={`${styles.readinessBadge} ${completeQuarter ? "" : styles.readinessBadgeAttention}`}>{completeQuarter ? "13/13" : "0/13"}</span></div>
          <p>{completeQuarter ? "Detta är en 13-veckorssnapshot. Fyll på nästa period uttryckligen efter att du har granskat utfallet." : "Spara kanaltakten för att få en serverbekräftad 13-veckorsplan. Den kan visas skrivskyddat som planerade aktiviteter i kalendern, men skapar inga schemalagda eller publicerade poster och inga utkast."}</p>
          <div className={styles.meter} aria-label={completeQuarter ? "13 av 13 veckor är planerade" : "Ingen bekräftad 13-veckorsplan ännu"}><span style={{ width: completeQuarter ? "100%" : "0%" }} /></div><div className={styles.readinessLegend}><span>Planerad aktivitet</span><span>Aldrig publiceringslöfte</span></div>
        </article>
      </section>

      <div className={styles.workbench}>
        <section className={styles.scopeCard} aria-labelledby="channel-scope-title">
          <header className={styles.sectionHeader}><div><p className={styles.sectionEyebrow}>KANALTAKT & INNEHÅLL</p><h2 id="channel-scope-title">Vad ska varje kanal göra — och när?</h2></div><p>Välj bara takt som någon kan granska. Teman och mål styr vad batchen ber systemet försöka skapa, inte vad som publiceras.</p></header>
          <p className={styles.scopeIntro}>Facebook, Instagram, LinkedIn och nyhetsbrev är de kanaler Studio kan göra till privata utkast i den här versionen. Webbplatsen är inte ett batchmål här.</p>
          <div className={styles.horizonControls}>
            <label className={styles.field}><span>Första måndagen i 13 veckor</span><input type="date" value={form.horizonStartDate} disabled={Boolean(activeBatch)} onChange={(event) => updatePlanMeta({ horizonStartDate: event.target.value })} /><small>{activeBatch ? "Horisonten är låst medan en batch är öppen." : "Planen börjar på en måndag. Att flytta startdatum ersätter hela planeringssnapshoten när du sparar."}</small></label>
            <label className={styles.field}><span>Tidszon för önskade tider</span><select value={form.timezone} disabled={Boolean(activeBatch)} onChange={(event) => updatePlanMeta({ timezone: event.target.value })}><option value="Europe/Stockholm">Europe/Stockholm</option><option value="Europe/Oslo">Europe/Oslo</option><option value="Europe/London">Europe/London</option><option value="UTC">UTC</option><option value="America/New_York">America/New_York</option></select><small>Varje önskad dag och tid tolkas i denna tidszon. Det här bokar inget utskick.</small></label>
          </div>
          <ul className={styles.channelList}>{form.channels.map((channel) => <ChannelScopeCard channel={channel} key={channel.id} onUpdate={updateChannel} onToggleWeekday={updateWeeklyDays} />)}</ul>
          <div className={styles.saveBar}><p><strong>{savedPlan ? planIsDirty ? "Förhandsvisningen har osparade ändringar." : "Ändring kräver nytt sparbeslut." : "Inget är sparat ännu."}</strong><br />Spara planeringen innan du lägger en batch i den privata produktionskön.</p><button className={styles.primaryButton} type="button" disabled={!selectedBrand || !apiAvailable || loadState === "loading" || actionState !== "idle" || Boolean(activeBatch)} onClick={() => void savePlan()}>{actionState === "saving" ? "Sparar…" : savedPlan ? "Spara ändringar" : "Spara 13-veckorsplan"}</button></div>
        </section>

        <section className={styles.quarterCard} aria-labelledby="quarter-grid-title">
          <p className={styles.sectionEyebrow}>PLANERAD AKTIVITET</p><h2 id="quarter-grid-title">13 veckor i taget.</h2><p>{previewIsLocal ? localPreview.ok ? "Lokal förhandsvisning. Spara först för den kanoniska serverplanen." : localPreview.message : "Serverbekräftade planerade aktiviteter med önskad lokal tid. De är inte bokade sändningar och har inte publicerats."}</p>
          <ol className={styles.quarterTimeline}>{slotsByWeek.map((week) => <li className={`${styles.weekCard} ${week.weekIndex === 1 ? styles.weekCardCurrent : ""}`} key={week.weekIndex}><span className={styles.weekNumber}>v{week.weekIndex}</span><div className={styles.weekBody}><div><strong>{weekRange(planStart, week.weekIndex)}</strong><time dateTime={week.slots[0]?.plannedLocalDate}>{week.slots.length ? plural(week.slots.length, "aktivitet", "aktiviteter") : "Ingen takt"}</time></div>{week.slots.length ? <div className={styles.slotLine}>{week.slots.slice(0, 4).map((slot) => <span className={"state" in slot && slot.state !== "planned" ? `${styles.slot} ${styles.slotMuted}` : styles.slot} key={slot.slotKey}>{titleForSagaActivityChannel(slot.channel as SagaActivityChannel)} · {slot.plannedLocalTime}</span>)}{week.slots.length > 4 ? <span className={`${styles.slot} ${styles.slotMuted}`}>+{week.slots.length - 4}</span> : null}</div> : <p className={styles.weekEmpty}>Ingen planerad aktivitet.</p>}</div></li>)}</ol>
        </section>
      </div>

      <BatchWorkbench batch={latestBatch} savedPlan={savedPlan} apiAvailable={apiAvailable} batchSize={batchSize} maxAvailable={savedCandidateSlots.length} canCreateBatch={canCreateBatch} actionState={actionState} returningItemId={returningItemId} returnNote={returnNote} abandoningBatchId={abandoningBatchId} abandonNote={abandonNote} onBatchSize={setBatchSize} onCreate={() => void createAndStartBatch()} onStartQueued={(batch) => void startQueuedBatch(batch)} onRetry={(batch) => void retryBatch(batch)} onAbandon={(batch) => void abandonFailedBatch(batch)} onAbandonStart={(batch) => { setAbandoningBatchId(batch.id); setAbandonNote(""); setError(null); }} onAbandonCancel={() => { setAbandoningBatchId(null); setAbandonNote(""); setError(null); }} onAbandonNote={setAbandonNote} onResolve={(batch, item, resolution, note) => void resolveBatchItem(batch, item, resolution, note)} onResubmit={(batch, item) => void resubmitBatchItem(batch, item)} onReturnStart={(item) => { setReturningItemId(item.id); setReturnNote(""); setError(null); }} onReturnCancel={() => { setReturningItemId(null); setReturnNote(""); setError(null); }} onReturnNote={setReturnNote} />
    </> : null}
  </section>;
}

function WorkspaceState({ loadState, available, message }: { loadState: LoadState; available: boolean; message: string | null }) {
  if (loadState === "loading") return <div className={styles.workspaceState}><i /><span><strong>Kontrollerar arbetsyta</strong><small>Planer och batchar läses först från servern.</small></span></div>;
  if (!available) return <div className={`${styles.workspaceState} ${styles.workspaceStateAttention}`}><i /><span><strong>Planeringsmotorn är inte tillgänglig</strong><small>{message || "Inget kan sparas, produceras eller godkännas förrän anslutningen fungerar."}</small></span></div>;
  return <div className={styles.workspaceState}><i /><span><strong>Privat arbetsyta är tillgänglig</strong><small>Planen, köerna och besluten kommer från sparad serverdata.</small></span></div>;
}

function ChannelScopeCard({ channel, onUpdate, onToggleWeekday }: { channel: ChannelDraft; onUpdate: (id: string, update: Partial<ChannelDraft>) => void; onToggleWeekday: (channel: ChannelDraft, weekday: SagaWeekday) => void }) {
  const spec = CHANNELS.find((entry) => entry.channel === channel.channel);
  const isWeekly = channel.cadence.unit === "weekly";
  const dateDays = channel.cadence.unit === "monthly" ? channel.cadence.dayOfMonth.join(", ") : "";
  return <li className={channel.enabled ? "" : styles.channelCardDisabled}><div className={styles.channelCard}>
    <label className={styles.channelToggle}><input type="checkbox" checked={channel.enabled} aria-label={`Aktivera ${titleForSagaActivityChannel(channel.channel)} i planen`} onChange={(event) => onUpdate(channel.id, { enabled: event.target.checked })} /></label>
    <div className={styles.channelBody}>
      <div className={styles.channelHeader}><div><h3>{titleForSagaActivityChannel(channel.channel)}</h3><p>{spec?.detail}</p></div><span className={channel.enabled ? styles.channelActivePill : styles.channelQuietPill}>{channel.enabled ? "Planerad takt" : "Inte vald"}</span></div>
      <div className={styles.channelFields}>
        <label className={styles.field}><span>Omfattning</span><div className={styles.cadenceInput}><input type="number" min="1" max={isWeekly ? 7 : 8} value={channel.cadence.count} disabled={!channel.enabled} onChange={(event) => {
          const count = Number(event.target.value);
          if (!Number.isInteger(count)) return;
          if (channel.cadence.unit === "weekly") {
            const weekdayIds = channel.cadence.weekdayIds.slice(0, Math.max(1, Math.min(7, count)));
            onUpdate(channel.id, { cadence: { ...channel.cadence, count: Math.max(1, Math.min(7, count)), weekdayIds: weekdayIds.length ? weekdayIds : [1] } });
          } else {
            const dayOfMonth = channel.cadence.dayOfMonth.slice(0, Math.max(1, Math.min(8, count)));
            onUpdate(channel.id, { cadence: { ...channel.cadence, count: Math.max(1, Math.min(8, count)), dayOfMonth: dayOfMonth.length ? dayOfMonth : [1] } });
          }
        }} /><select value={channel.cadence.unit} disabled={!channel.enabled} onChange={(event) => onUpdate(channel.id, { cadence: event.target.value === "monthly" ? { unit: "monthly", count: 1, dayOfMonth: [1], localTime: channel.cadence.localTime } : { unit: "weekly", count: 1, weekdayIds: [1], localTime: channel.cadence.localTime } })}><option value="weekly">per vecka</option><option value="monthly">per månad</option></select></div></label>
        <label className={styles.field}><span>Önskad tid</span><input type="time" value={channel.cadence.localTime} disabled={!channel.enabled} onChange={(event) => onUpdate(channel.id, { cadence: { ...channel.cadence, localTime: event.target.value || "09:30" } })} /><small>Planeringspreferens, inte sändningsbeslut.</small></label>
        <label className={styles.field}><span>Mål med kanalen</span><input value={channel.objective} disabled={!channel.enabled} placeholder="Gör nästa steg tydligt…" onChange={(event) => onUpdate(channel.id, { objective: event.target.value })} /><small>En tydlig mening, inte ett tomt KPI.</small></label>
        <label className={styles.field}><span>Längd</span><select value={channel.targetLength} disabled={!channel.enabled} onChange={(event) => onUpdate(channel.id, { targetLength: event.target.value as ChannelDraft["targetLength"] })}><option value="short">Kort</option><option value="medium">Mellan</option><option value="long">Längre</option></select></label>
      </div>
      {isWeekly ? <div className={styles.weekdayGroup} aria-label={`Önskade dagar för ${titleForSagaActivityChannel(channel.channel)}`}>{WEEKDAYS.map((weekday) => <button className={`${styles.weekdayOption} ${channel.cadence.unit === "weekly" && channel.cadence.weekdayIds.includes(weekday.id) ? styles.weekdayOptionSelected : ""}`} type="button" disabled={!channel.enabled} aria-pressed={channel.cadence.unit === "weekly" && channel.cadence.weekdayIds.includes(weekday.id)} key={weekday.id} onClick={() => onToggleWeekday(channel, weekday.id)}>{weekday.short}</button>)}</div> : <label className={`${styles.field} ${styles.themeField}`}><span>Datumdagar varje månad</span><input value={dateDays} disabled={!channel.enabled} placeholder="1, 15" onChange={(event) => {
        const parsed = Array.from(new Set(event.target.value.split(",").map((value) => Number(value.trim())).filter((value) => Number.isInteger(value) && value >= 1 && value <= 28))).slice(0, 8);
        if (channel.cadence.unit === "monthly") onUpdate(channel.id, { cadence: { ...channel.cadence, count: Math.max(1, parsed.length), dayOfMonth: parsed.length ? parsed : [1] } });
      }} /><small>1–28. En datumdag för varje planerat utskick.</small></label>}
      <div className={styles.channelFields}>
        <label className={styles.field}><span>Innehållstema</span><input value={channel.theme.title} disabled={!channel.enabled} placeholder="System som frigör tid" onChange={(event) => onUpdate(channel.id, { theme: { ...channel.theme, title: event.target.value } })} /></label>
        <label className={styles.field}><span>Vad ska läsaren förstå?</span><input value={channel.theme.intent} disabled={!channel.enabled} placeholder="Varför detta spelar roll…" onChange={(event) => onUpdate(channel.id, { theme: { ...channel.theme, intent: event.target.value } })} /></label>
        <label className={styles.field}><span>Vinkel / innehållsriktning</span><input value={channel.theme.contentDirection} disabled={!channel.enabled} placeholder="Ett konkret vardagsexempel…" onChange={(event) => onUpdate(channel.id, { theme: { ...channel.theme, contentDirection: event.target.value } })} /></label>
        <label className={styles.field}><span>Önskad uppmaning</span><input value={channel.desiredCallToAction} disabled={!channel.enabled} placeholder="Valfritt" onChange={(event) => onUpdate(channel.id, { desiredCallToAction: event.target.value })} /></label>
      </div>
      <label className={`${styles.field} ${styles.themeField}`}><span>Bildriktning</span><input value={channel.imageDirection} disabled={!channel.enabled} placeholder="Valfritt – sätt riktning när bilden behövs" onChange={(event) => onUpdate(channel.id, { imageDirection: event.target.value })} /><small>Detta är en kreativ riktning, inte ett löfte om att bilden genereras i batchen.</small></label>
    </div>
  </div></li>;
}

function BatchWorkbench({ batch, savedPlan, apiAvailable, batchSize, maxAvailable, canCreateBatch, actionState, returningItemId, returnNote, abandoningBatchId, abandonNote, onBatchSize, onCreate, onStartQueued, onRetry, onAbandon, onAbandonStart, onAbandonCancel, onAbandonNote, onResolve, onResubmit, onReturnStart, onReturnCancel, onReturnNote }: {
  batch: SagaQuarterlyBatchView | null;
  savedPlan: SagaQuarterlyPlan | null;
  apiAvailable: boolean;
  batchSize: number;
  maxAvailable: number;
  canCreateBatch: boolean;
  actionState: ActionState;
  returningItemId: string | null;
  returnNote: string;
  abandoningBatchId: string | null;
  abandonNote: string;
  onBatchSize: (value: number) => void;
  onCreate: () => void;
  onStartQueued: (batch: SagaQuarterlyBatchView) => void;
  onRetry: (batch: SagaQuarterlyBatchView) => void;
  onAbandon: (batch: SagaQuarterlyBatchView) => void;
  onAbandonStart: (batch: SagaQuarterlyBatchView) => void;
  onAbandonCancel: () => void;
  onAbandonNote: (value: string) => void;
  onResolve: (batch: SagaQuarterlyBatchView, item: SagaQuarterlyBatchItemView, resolution: "approved" | "returned" | "rejected", note?: string) => void;
  onResubmit: (batch: SagaQuarterlyBatchView, item: SagaQuarterlyBatchItemView) => void;
  onReturnStart: (item: SagaQuarterlyBatchItemView) => void;
  onReturnCancel: () => void;
  onReturnNote: (value: string) => void;
}) {
  const reviewable = batch?.state === "ready_for_review";
  const reworkRequired = batch?.state === "rework_required";
  const resolved = batch?.state === "resolved" && batch.canRequestNextBatch;
  const attention = batch?.state === "failed" || batch?.state === "stale" || batch?.state === "rework_required";
  return <section className={styles.batchCard} aria-labelledby="batch-title">
    <header className={styles.batchHeader}><div><p className={styles.sectionEyebrow}>PRIVAT PRODUKTIONSKÖ</p><h2 id="batch-title">En batch åt gången. Högst tio riktiga utkast.</h2><p>Skapa nästa batch begär kvalitetssäkrad privat produktion. Först när riktiga privata utkast finns går det att öppna, redigera och fatta beslut om dem.</p></div><label className={styles.batchSizeControl}>Nästa batch<input type="number" min="1" max="10" value={batchSize} disabled={Boolean(batch && batch.state !== "resolved")} onChange={(event) => { const value = Number(event.target.value); onBatchSize(Number.isInteger(value) ? Math.max(1, Math.min(10, value)) : 1); }} /></label></header>
    <div className={styles.batchGuidance}><p><strong>{savedPlan ? `${maxAvailable} planerade aktiviteter kan gå vidare.` : "Spara planen innan en batch kan väljas."}</strong> Gränsen på tio finns för att varje färdigt privat utkast ska få ett mänskligt beslut.</p>{batch ? <span className={`${styles.batchPill} ${attention ? styles.batchPillAttention : batch.state === "resolved" ? styles.batchPillQuiet : ""}`}>{batchStateLabel(batch)}</span> : <span className={`${styles.batchPill} ${styles.batchPillQuiet}`}>Ingen öppen batch</span>}</div>
    {!batch ? <BatchStart disabled={!apiAvailable || !canCreateBatch || actionState !== "idle"} label={actionState === "creating_batch" ? "Startar privat produktion…" : `Skapa nästa ${Math.min(batchSize, maxAvailable || batchSize)} privata utkast`} onClick={onCreate} /> : null}
    {batch?.state === "queued" ? <div className={styles.batchEmpty}><h3>Privat produktion är köad.</h3><p>Inga utkast granskas ännu. Du kan tryggt starta just den här sparade batchen även efter ett nätverksavbrott. SAGA använder samma körningskvitto när det finns, annars skapar servern ett nytt för den köade batchen — aldrig en andra batch.</p>{batch.canMaterialize ? <div className={styles.batchEmptyActions}><button type="button" className={styles.primaryButton} disabled={actionState !== "idle"} onClick={() => onStartQueued(batch)}>{actionState === "resuming_batch" ? "Startar…" : "Starta privat produktion"}</button></div> : null}</div> : null}
    {batch?.state === "generating" ? <div className={styles.batchEmpty}><h3>Privata utkast produceras.</h3><p>Systemet kör sin kvalitetskontroll. Granskningsknappar visas först när riktiga privata Studio-utkast med länkar finns. Körningen pågår redan, så SAGA startar inte en parallell produktionsbegäran.</p></div> : null}
    {batch?.state === "failed" ? <div className={styles.batchEmpty}>
      <h3>Produktionen stannade före granskning.</h3>
      <p>{batch.failureMessage || "Systemet bekräftade inga riktiga privata utkast. Nästa batch är låst tills detta är hanterat."}</p>
      {batch.canRetry ? <div className={styles.batchEmptyActions}>
        <button type="button" className={styles.primaryButton} disabled={actionState !== "idle"} onClick={() => onRetry(batch)}>{actionState === "retrying_batch" ? "Försöker igen…" : "Försök privat produktion igen"}</button>
        {batch.canAbandon && abandoningBatchId !== batch.id ? <button type="button" className={styles.textButton} disabled={actionState !== "idle"} onClick={() => onAbandonStart(batch)}>Avsluta batchen i stället</button> : null}
      </div> : null}
      {batch.canAbandon && (!batch.canRetry || abandoningBatchId === batch.id) ? <div className={styles.recoveryPanel}>
        <h4>{batch.retryExhausted ? "Försöken är slut." : "Avsluta batchen i stället."}</h4>
        <p>{batch.retryExhausted
          ? "Avsluta batchen först om du vill ändra planen eller fortsätta med återstående planerade aktiviteter."
          : "Du kan välja att avsluta den här batchen utan ett nytt produktionsförsök."} Ofärdigt arbete avbryts; redan skapade privata utkast behålls för revision. Det schemaläggs eller publiceras inte.</p>
        {abandoningBatchId === batch.id ? <label className={styles.field}><span>Varför avslutar du den här batchen?</span><textarea value={abandonNote} placeholder="Till exempel: underlaget behöver skrivas om före nästa försök." onChange={(event) => onAbandonNote(event.target.value)} /><small>Minst tre tecken. Detta blir återställningens mänskliga anledning.</small></label> : null}
        {abandoningBatchId === batch.id ? <div className={styles.batchEmptyActions}><button type="button" className={styles.dangerButton} disabled={actionState !== "idle" || abandonNote.trim().length < 3} onClick={() => onAbandon(batch)}>{actionState === "abandoning_batch" ? "Avslutar…" : "Bekräfta och avsluta batch"}</button><button type="button" className={styles.textButton} disabled={actionState !== "idle"} onClick={onAbandonCancel}>Behåll batchen</button></div> : null}
      </div> : null}
      {!batch.canRetry && !batch.canAbandon ? <div className={styles.recoveryPanel}><h4>Återhämtning pågår.</h4><p>Servern avslutar fortfarande den senaste körningen. Ladda om om en stund för att se om ett nytt försök eller ett säkert avslut är möjligt. Inget har schemalagts eller publicerats.</p></div> : null}
    </div> : null}
    {batch?.state === "stale" ? <div className={styles.batchEmpty}><h3>Batchen är avslutad eller inaktuell.</h3><p>{batch.failureMessage || "Den här batchen kan inte längre köras. Den ligger kvar som spårbar historik och blockerar inte nya planeringsbeslut."}</p>{canCreateBatch ? <div className={styles.batchEmptyActions}><button type="button" className={styles.primaryButton} disabled={actionState !== "idle"} onClick={onCreate}>{actionState === "creating_batch" ? "Startar…" : `Skapa nästa ${Math.min(batchSize, maxAvailable || batchSize)}`}</button></div> : null}</div> : null}
    {reviewable ? <ReviewList batch={batch} mode="review" actionState={actionState} returningItemId={returningItemId} returnNote={returnNote} onResolve={onResolve} onResubmit={onResubmit} onReturnStart={onReturnStart} onReturnCancel={onReturnCancel} onReturnNote={onReturnNote} /> : null}
    {reworkRequired ? <><div className={styles.batchEmpty}><h3>Ett privat utkast behöver ändras.</h3><p>Öppna det returnerade utkastet, gör ändringen och spara i Studio. Skicka sedan tillbaka samma utkast till granskning här. Det skapas inte på nytt och nästa batch förblir låst tills servern har ett nytt beslut.</p></div><ReviewList batch={batch} mode="rework" actionState={actionState} returningItemId={returningItemId} returnNote={returnNote} onResolve={onResolve} onResubmit={onResubmit} onReturnStart={onReturnStart} onReturnCancel={onReturnCancel} onReturnNote={onReturnNote} /></> : null}
    {batch?.state === "resolved" ? <div className={styles.batchEmpty}><h3>{resolved ? "Batchen är beslutad." : "Batchen är stängd."}</h3><p>{resolved ? "Servern har bekräftat ett terminalt mänskligt beslut för varje privat utkast. Du kan nu skapa nästa högst tio planerade aktiviteter." : "Nästa batch är inte upplåst av servern ännu."}</p>{resolved ? <div className={styles.batchEmptyActions}><button type="button" className={styles.primaryButton} disabled={!canCreateBatch || actionState !== "idle"} onClick={onCreate}>{actionState === "creating_batch" ? "Startar…" : `Skapa nästa ${Math.min(batchSize, maxAvailable || batchSize)}`}</button></div> : null}</div> : null}
  </section>;
}

function BatchStart({ disabled, label, onClick }: { disabled: boolean; label: string; onClick: () => void }) {
  return <div className={styles.batchEmpty}><h3>Skapa en granskningsbar mängd.</h3><p>Högst tio åt gången är en medveten gräns: varje privat utkast ska kunna öppnas, läsas och få ett mänskligt beslut. Detta skriver inget sändningsbeslut och publicerar inget.</p><div className={styles.batchEmptyActions}><button type="button" className={styles.primaryButton} disabled={disabled} onClick={onClick}>{label}</button></div></div>;
}

function ReviewList({ batch, mode, actionState, returningItemId, returnNote, onResolve, onResubmit, onReturnStart, onReturnCancel, onReturnNote }: {
  batch: SagaQuarterlyBatchView;
  mode: "review" | "rework";
  actionState: ActionState;
  returningItemId: string | null;
  returnNote: string;
  onResolve: (batch: SagaQuarterlyBatchView, item: SagaQuarterlyBatchItemView, resolution: "approved" | "returned" | "rejected", note?: string) => void;
  onResubmit: (batch: SagaQuarterlyBatchView, item: SagaQuarterlyBatchItemView) => void;
  onReturnStart: (item: SagaQuarterlyBatchItemView) => void;
  onReturnCancel: () => void;
  onReturnNote: (value: string) => void;
}) {
  const pending = batch.items.filter((item) => item.reviewResolution === null).length;
  const reworkMode = mode === "rework";
  return <><ol className={styles.reviewList}>{batch.items.map((item, index) => {
    const returning = returningItemId === item.id;
    const reviewable = Boolean(item.state === "ready_for_review" && item.draftId && item.draftRevision && item.draftHref);
    const returnedForEdit = reworkMode && item.state === "returned";
    const canResubmit = Boolean(returnedForEdit && item.draftId && item.draftHref && item.returnedDraftRevision !== null && (item.draftRevision ?? 0) > item.returnedDraftRevision);
    return <li key={item.id}><article className={styles.reviewCard}><span className={styles.reviewIndex}>{String(index + 1).padStart(2, "0")}</span><div className={styles.reviewMain}><div className={styles.reviewTop}><strong>{item.slot.planningLabel}</strong><span className={item.reviewResolution === "approved" ? `${styles.itemPill} ${styles.itemPillApproved}` : item.reviewResolution === "returned" ? `${styles.itemPill} ${styles.itemPillReturned}` : item.reviewResolution === "rejected" ? `${styles.itemPill} ${styles.itemPillRejected}` : styles.itemPill}>{reviewLabel(item)}</span></div><p>{item.slot.contentDirection}</p><div className={styles.reviewMeta}><span>{titleForSagaActivityChannel(item.slot.channel as SagaActivityChannel)}</span><span>{dateLabel(item.slot.plannedLocalDate)} · {item.slot.plannedLocalTime}</span><span>{item.draftId ? "Privat utkast finns" : "Väntar på privat utkast"}</span></div>{returning ? <label className={styles.field}><span>Vad ska ändras?</span><textarea value={returnNote} placeholder="Beskriv den konkreta förbättringen." onChange={(event) => onReturnNote(event.target.value)} /><small>Detta skickas som ett redaktionellt ändringskrav, aldrig som en publicering.</small></label> : null}</div><div className={styles.reviewActions}>{item.draftHref ? <Link className={styles.rowLink} href={item.draftHref}>Öppna & redigera</Link> : null}{returnedForEdit ? canResubmit ? <button type="button" className={styles.secondaryButton} disabled={actionState !== "idle"} onClick={() => onResubmit(batch, item)}>{actionState === "resubmitting" ? "Skickar…" : "Skicka tillbaka till granskning"}</button> : <span className={styles.reworkHint}>Redigera och spara utkastet först.</span> : null}{reviewable && item.reviewResolution === null ? <><button type="button" className={styles.secondaryButton} disabled={actionState !== "idle"} onClick={() => onResolve(batch, item, "approved")}>Godkänn</button>{returning ? <><button type="button" className={styles.dangerButton} disabled={actionState !== "idle" || !returnNote.trim()} onClick={() => onResolve(batch, item, "returned", returnNote)}>Skicka tillbaka</button><button type="button" className={styles.textButton} disabled={actionState !== "idle"} onClick={onReturnCancel}>Avbryt</button></> : <button type="button" className={styles.dangerButton} disabled={actionState !== "idle"} onClick={() => onReturnStart(item)}>Ändring krävs</button>}<button type="button" className={styles.textButton} disabled={actionState !== "idle"} onClick={() => onResolve(batch, item, "rejected")}>Avvisa</button></> : null}</div></article></li>;
  })}</ol><footer className={styles.reviewFooter}><p>{reworkMode ? "Batchen är låst tills det returnerade privata utkastet har redigerats, sparats och skickats tillbaka till granskning." : pending ? `${plural(pending, "utkast väntar", "utkast väntar")} på ett mänskligt beslut. Nästa batch låses upp först när servern har registrerat ett terminalt beslut för varje utkast.` : "Alla synliga beslut är sparade. Servern avgör när nästa batch faktiskt kan öppnas."}</p></footer></>;
}
