/**
 * Strict browser adapter for the Vercel/Neon quarterly-planning boundary.
 *
 * This file is intentionally the only place a client component names the
 * quarterly endpoints. Unknown response fields are dropped by the canonical
 * Zod contracts, and no client state is ever used as a substitute for a
 * saved plan, private draft, or human review decision.
 */

import {
  deriveSagaQuarterlyActivityPlanSlots,
  sagaQuarterlyActivityPlanSchema,
  sagaQuarterlyActivityPlanInputSchema,
  sagaQuarterlyActivityPlanSummarySchema,
  sagaQuarterlyBatchSchema,
  type SagaQuarterlyActivityPlan,
  type SagaQuarterlyActivityPlanInput,
  type SagaQuarterlyActivityPlanSlot,
  type SagaQuarterlyBatch,
  type SagaQuarterlyBatchItem,
  type SagaQuarterlyChannelPlan,
  type SagaQuarterlyContentTheme,
} from "@/lib/domain/saga-quarterly-planning";

export const SAGA_QUARTERLY_PLANS_API = "/api/saga/quarterly-plans";
export const SAGA_ACTIVITY_CHANNELS = ["facebook_page", "instagram", "linkedin", "newsletter"] as const;
export type SagaActivityChannel = (typeof SAGA_ACTIVITY_CHANNELS)[number];
export type SagaWeekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** Browser-safe draft URL; external URLs never become navigation targets. */
export type SagaQuarterlyBatchItemView = Omit<SagaQuarterlyBatchItem, "draftHref" | "slot"> & {
  draftHref: string | null;
  slot: Omit<SagaQuarterlyActivityPlanSlot, "draftHref"> & { draftHref: string | null };
};

export type SagaQuarterlyBatchView = Omit<SagaQuarterlyBatch, "items"> & { items: SagaQuarterlyBatchItemView[] };
export type SagaQuarterlyPlanWorkspace = { plan: SagaQuarterlyActivityPlan | null; batches: SagaQuarterlyBatchView[]; message: string | null };
export type SagaQuarterlyPlanOverview = ReturnType<typeof sagaQuarterlyActivityPlanSummarySchema.parse>;
export type SagaQuarterlyBrandOption = { brandProfileId: string; brandName: string; brandActive: boolean; completionState: "completed" };

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function boolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function safeMessage(payload: unknown, fallback: string) {
  const body = record(payload);
  return text(body?.error) ?? text(body?.message) ?? fallback;
}

function safeDraftHref(value: string | null): string | null {
  return value && /^\/studio\/content\/[0-9a-f-]+\?edit=1$/i.test(value) ? value : null;
}

function viewBatch(value: unknown): SagaQuarterlyBatchView | null {
  const parsed = sagaQuarterlyBatchSchema.safeParse(value);
  if (!parsed.success) return null;
  return {
    ...parsed.data,
    items: parsed.data.items.map((item) => ({
      ...item,
      draftHref: safeDraftHref(item.draftHref),
      slot: { ...item.slot, draftHref: safeDraftHref(item.slot.draftHref) },
    })),
  };
}

export function sagaQuarterlyPlanWorkspaceFromPayload(payload: unknown): SagaQuarterlyPlanWorkspace {
  const body = record(payload);
  const parsedPlan = sagaQuarterlyActivityPlanSchema.safeParse(body?.plan);
  const plan = parsedPlan.success ? parsedPlan.data : null;
  const batches = Array.isArray(body?.batches)
    ? body.batches.flatMap((entry) => {
      const batch = viewBatch(entry);
      return batch ? [batch] : [];
    })
    : [];
  return { plan, batches, message: null };
}

export function sagaQuarterlyPlanOverviewsFromPayload(payload: unknown): SagaQuarterlyPlanOverview[] {
  const body = record(payload);
  if (!Array.isArray(body?.plans)) return [];
  return body.plans.flatMap((entry) => {
    const parsed = sagaQuarterlyActivityPlanSummarySchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

export function sagaQuarterlyBrandOptionsFromPayload(payload: unknown): SagaQuarterlyBrandOption[] {
  const body = record(payload);
  if (!Array.isArray(body?.onboardings)) return [];
  return body.onboardings.flatMap((entry) => {
    const item = record(entry);
    const brandProfileId = text(item?.brandProfileId);
    const brandName = text(item?.brandName);
    const brandActive = boolean(item?.brandActive);
    if (!brandProfileId || !brandName || brandActive === null || item?.completionState !== "completed") return [];
    return [{ brandProfileId, brandName, brandActive, completionState: "completed" as const }];
  });
}

export function validateSagaQuarterlyPlan(value: SagaQuarterlyActivityPlanInput): string | null {
  const parsed = sagaQuarterlyActivityPlanInputSchema.safeParse(value);
  if (parsed.success) return null;
  const issue = parsed.error.issues[0];
  const path = issue?.path.map(String).join(".") ?? "";
  if (path.includes("horizonStartDate")) return "Horisonten måste börja på en måndag med ett verkligt datum.";
  if (path.includes("themes")) return "Varje vald kanal behöver minst ett godkänt tema, ett syfte och en innehållsriktning.";
  if (path.includes("weekdayIds")) return "Välj en dag för varje inlägg per vecka.";
  if (path.includes("dayOfMonth")) return "Välj en datumdag (1–28) för varje utskick per månad.";
  if (path.includes("objective")) return "Beskriv kanalens mål med minst en tydlig mening.";
  return "Kontrollera kanalernas takt, teman, tider och planeringshorisont innan du sparar.";
}

export function deriveSagaQuarterlyPlanPreview(value: SagaQuarterlyActivityPlanInput): { ok: true; slots: ReturnType<typeof deriveSagaQuarterlyActivityPlanSlots> } | { ok: false; message: string } {
  const parsed = sagaQuarterlyActivityPlanInputSchema.safeParse(value);
  if (!parsed.success) return { ok: false, message: validateSagaQuarterlyPlan(value) ?? "Planen kan inte förhandsvisas ännu." };
  try {
    return { ok: true, slots: deriveSagaQuarterlyActivityPlanSlots(parsed.data) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Planen kunde inte härleda 13 veckor säkert." };
  }
}

async function json(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { return null; }
}

export async function readSagaQuarterlyPlanOverviews(apiPath = SAGA_QUARTERLY_PLANS_API): Promise<{ ok: true; value: SagaQuarterlyPlanOverview[] } | { ok: false; message: string }> {
  try {
    const response = await fetch(apiPath, { credentials: "same-origin", cache: "no-store" });
    const payload = await json(response);
    if (!response.ok) return { ok: false, message: safeMessage(payload, "Kunde inte läsa sparade aktivitetsplaner.") };
    return { ok: true, value: sagaQuarterlyPlanOverviewsFromPayload(payload) };
  } catch {
    return { ok: false, message: "Kunde inte nå arbetsytan. Ingen sparad aktivitetsplan visas." };
  }
}

export async function readSagaQuarterlyBrandOptions(apiPath = "/api/saga/brand-onboarding"): Promise<{ ok: true; value: SagaQuarterlyBrandOption[] } | { ok: false; message: string }> {
  try {
    const response = await fetch(apiPath, { credentials: "same-origin", cache: "no-store" });
    const payload = await json(response);
    if (!response.ok) return { ok: false, message: safeMessage(payload, "Kunde inte läsa färdiga varumärkesonboardingar.") };
    return { ok: true, value: sagaQuarterlyBrandOptionsFromPayload(payload) };
  } catch {
    return { ok: false, message: "Kunde inte nå arbetsytan. Inga färdiga varumärken visas." };
  }
}

export async function readSagaQuarterlyPlan(brandProfileId: string, apiPath = SAGA_QUARTERLY_PLANS_API): Promise<{ ok: true; value: SagaQuarterlyPlanWorkspace } | { ok: false; message: string }> {
  try {
    const response = await fetch(`${apiPath}/${encodeURIComponent(brandProfileId)}`, { credentials: "same-origin", cache: "no-store" });
    const payload = await json(response);
    if (response.status === 404) return { ok: true, value: { plan: null, batches: [], message: "Ingen sparad 13-veckorsplan finns för varumärket ännu." } };
    if (!response.ok) return { ok: false, message: safeMessage(payload, "Kunde inte läsa den sparade aktivitetsplanen.") };
    const value = sagaQuarterlyPlanWorkspaceFromPayload(payload);
    if (!value.plan) return { ok: false, message: "Aktivitetsplanen kunde inte läsas säkert. Inget är ändrat." };
    return { ok: true, value };
  } catch {
    return { ok: false, message: "Kunde inte nå arbetsytan. Inga sparade planeringsdata visas." };
  }
}

export function createSagaQuarterlyPlanIdempotencyKey(): string | null {
  return typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto.randomUUID() : null;
}

export async function saveSagaQuarterlyPlan(input: {
  brandProfileId: string;
  plan: SagaQuarterlyActivityPlanInput;
  existingRevision: number | null;
  createIdempotencyKey: string | null;
  apiPath?: string;
}): Promise<{ ok: true; value: SagaQuarterlyActivityPlan } | { ok: false; message: string }> {
  const validationMessage = validateSagaQuarterlyPlan(input.plan);
  if (validationMessage) return { ok: false, message: validationMessage };
  const apiPath = input.apiPath ?? SAGA_QUARTERLY_PLANS_API;
  const creating = input.existingRevision === null;
  if (creating && !input.createIdempotencyKey) return { ok: false, message: "Kunde inte skapa ett säkert spar-kvitto. Ladda om sidan och försök igen." };
  try {
    const response = await fetch(creating ? apiPath : `${apiPath}/${encodeURIComponent(input.brandProfileId)}`, {
      method: creating ? "POST" : "PATCH",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(creating
        ? { createIdempotencyKey: input.createIdempotencyKey, brandProfileId: input.brandProfileId, plan: input.plan }
        : { expectedRevision: input.existingRevision, plan: input.plan }),
    });
    const payload = await json(response);
    if (!response.ok) return { ok: false, message: safeMessage(payload, "Aktivitetsplanen kunde inte sparas. Inga nya utkast eller tider har skapats.") };
    const plan = sagaQuarterlyActivityPlanSchema.safeParse(record(payload)?.plan);
    return plan.success ? { ok: true, value: plan.data } : { ok: false, message: "Servern bekräftade ingen läsbar aktivitetsplan. Kontrollera status innan du fortsätter." };
  } catch {
    return { ok: false, message: "Kunde inte nå arbetsytan. Aktivitetsplanen har inte sparats." };
  }
}

export async function createSagaQuarterlyBatch(input: {
  brandProfileId: string;
  expectedPlanRevision: number;
  planItemIds: string[];
  idempotencyKey: string | null;
  apiPath?: string;
}): Promise<{ ok: true; value: SagaQuarterlyBatchView } | { ok: false; message: string }> {
  if (!input.idempotencyKey) return { ok: false, message: "Kunde inte skapa ett säkert körningskvitto. Ladda om sidan och försök igen." };
  if (!input.planItemIds.length || input.planItemIds.length > 10) return { ok: false, message: "Välj mellan 1 och 10 planerade innehållstillfällen för en granskningsbatch." };
  const apiPath = input.apiPath ?? SAGA_QUARTERLY_PLANS_API;
  try {
    const response = await fetch(`${apiPath}/${encodeURIComponent(input.brandProfileId)}/batches`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: input.idempotencyKey, expectedPlanRevision: input.expectedPlanRevision, planItemIds: input.planItemIds }),
    });
    const payload = await json(response);
    if (!response.ok) return { ok: false, message: safeMessage(payload, "Granskningsbatchen kunde inte skapas. Inga privata utkast har skapats.") };
    const batch = viewBatch(record(payload)?.batch);
    return batch ? { ok: true, value: batch } : { ok: false, message: "Servern bekräftade ingen läsbar granskningsbatch." };
  } catch {
    return { ok: false, message: "Kunde inte nå arbetsytan. Ingen granskningsbatch har skapats." };
  }
}

export async function materializeSagaQuarterlyBatch(input: {
  brandProfileId: string;
  batchId: string;
  expectedPlanRevision: number;
  expectedBatchRevision: number;
  idempotencyKey: string | null;
  retryFailed?: boolean;
  apiPath?: string;
}): Promise<{ ok: true; value: SagaQuarterlyBatchView } | { ok: false; message: string }> {
  if (!input.idempotencyKey) return { ok: false, message: "Kunde inte skapa ett säkert körningskvitto. Ladda om sidan och försök igen." };
  const apiPath = input.apiPath ?? SAGA_QUARTERLY_PLANS_API;
  try {
    const response = await fetch(`${apiPath}/${encodeURIComponent(input.brandProfileId)}/batches/${encodeURIComponent(input.batchId)}/materialize`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: input.idempotencyKey, expectedPlanRevision: input.expectedPlanRevision, expectedBatchRevision: input.expectedBatchRevision, retryFailed: input.retryFailed === true }),
    });
    const payload = await json(response);
    if (!response.ok) return { ok: false, message: safeMessage(payload, "Privata utkast kunde inte skapas från batchen. Inget har publicerats.") };
    const batch = viewBatch(record(payload)?.batch);
    return batch ? { ok: true, value: batch } : { ok: false, message: "Servern bekräftade inte den privata produktionen." };
  } catch {
    return { ok: false, message: "Kunde inte nå arbetsytan. Inga privata utkast har skapats." };
  }
}

export async function reviewSagaQuarterlyBatchItem(input: {
  brandProfileId: string;
  batchId: string;
  itemId: string;
  expectedPlanRevision: number;
  expectedBatchRevision: number;
  expectedItemRevision: number;
  expectedDraftRevision: number;
  idempotencyKey: string | null;
  resolution: "approved" | "returned" | "rejected";
  note?: string;
  apiPath?: string;
}): Promise<{ ok: true; value: SagaQuarterlyBatchView } | { ok: false; message: string }> {
  if (!input.idempotencyKey) return { ok: false, message: "Kunde inte skapa ett säkert granskningskvitto. Ladda om sidan och försök igen." };
  if (input.resolution === "returned" && !input.note?.trim()) return { ok: false, message: "Beskriv vad som behöver ändras innan du skickar tillbaka utkastet." };
  const apiPath = input.apiPath ?? SAGA_QUARTERLY_PLANS_API;
  try {
    const response = await fetch(`${apiPath}/${encodeURIComponent(input.brandProfileId)}/batches/${encodeURIComponent(input.batchId)}/items/${encodeURIComponent(input.itemId)}/review`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: input.idempotencyKey,
        expectedPlanRevision: input.expectedPlanRevision,
        expectedBatchRevision: input.expectedBatchRevision,
        expectedItemRevision: input.expectedItemRevision,
        expectedDraftRevision: input.expectedDraftRevision,
        resolution: input.resolution,
        note: input.note?.trim() ?? "",
      }),
    });
    const payload = await json(response);
    if (!response.ok) return { ok: false, message: safeMessage(payload, "Granskningsbeslutet kunde inte sparas. Utkastet är inte ändrat.") };
    const batch = viewBatch(record(payload)?.batch);
    return batch ? { ok: true, value: batch } : { ok: false, message: "Servern bekräftade inte granskningsbeslutet." };
  } catch {
    return { ok: false, message: "Kunde inte nå arbetsytan. Granskningsbeslutet har inte sparats." };
  }
}

/**
 * A returned draft is edited in Studio first, then explicitly returned to the
 * same batch for another human decision. This never asks the worker to create
 * a replacement draft and never changes a calendar or delivery state.
 */
export async function resubmitSagaQuarterlyBatchItem(input: {
  brandProfileId: string;
  batchId: string;
  itemId: string;
  expectedPlanRevision: number;
  expectedBatchRevision: number;
  expectedItemRevision: number;
  expectedDraftRevision: number;
  idempotencyKey: string | null;
  apiPath?: string;
}): Promise<{ ok: true; value: SagaQuarterlyBatchView } | { ok: false; message: string }> {
  if (!input.idempotencyKey) return { ok: false, message: "Kunde inte skapa ett säkert granskningskvitto. Ladda om sidan och försök igen." };
  const apiPath = input.apiPath ?? SAGA_QUARTERLY_PLANS_API;
  try {
    const response = await fetch(`${apiPath}/${encodeURIComponent(input.brandProfileId)}/batches/${encodeURIComponent(input.batchId)}/items/${encodeURIComponent(input.itemId)}/resubmit`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: input.idempotencyKey,
        expectedPlanRevision: input.expectedPlanRevision,
        expectedBatchRevision: input.expectedBatchRevision,
        expectedItemRevision: input.expectedItemRevision,
        expectedDraftRevision: input.expectedDraftRevision,
      }),
    });
    const payload = await json(response);
    if (!response.ok) return { ok: false, message: safeMessage(payload, "Utkastet kunde inte skickas tillbaka till granskning. Det privata utkastet är oförändrat.") };
    const batch = viewBatch(record(payload)?.batch);
    return batch ? { ok: true, value: batch } : { ok: false, message: "Servern bekräftade inte att utkastet återgick till granskning." };
  } catch {
    return { ok: false, message: "Kunde inte nå arbetsytan. Utkastet har inte skickats tillbaka till granskning." };
  }
}

/**
 * Terminal human recovery for an exhausted failed batch. The server cancels
 * unfinished private work, keeps any real drafts auditable, and explicitly
 * returns `noPublication: true`; this client never interprets it as delivery.
 */
export async function abandonSagaQuarterlyBatch(input: {
  brandProfileId: string;
  batchId: string;
  expectedPlanRevision: number;
  expectedBatchRevision: number;
  idempotencyKey: string | null;
  note: string;
  apiPath?: string;
}): Promise<{ ok: true; value: SagaQuarterlyBatchView } | { ok: false; message: string }> {
  if (!input.idempotencyKey) return { ok: false, message: "Kunde inte skapa ett säkert återställningskvitto. Ladda om sidan och försök igen." };
  if (input.note.trim().length < 3) return { ok: false, message: "Skriv kort varför den misslyckade batchen ska avslutas." };
  const apiPath = input.apiPath ?? SAGA_QUARTERLY_PLANS_API;
  try {
    const response = await fetch(`${apiPath}/${encodeURIComponent(input.brandProfileId)}/batches/${encodeURIComponent(input.batchId)}/abandon`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: input.idempotencyKey,
        expectedPlanRevision: input.expectedPlanRevision,
        expectedBatchRevision: input.expectedBatchRevision,
        note: input.note.trim(),
      }),
    });
    const payload = await json(response);
    if (!response.ok) return { ok: false, message: safeMessage(payload, "Den misslyckade batchen kunde inte avslutas. Inget har ändrats.") };
    const body = record(payload);
    if (body?.noPublication !== true) return { ok: false, message: "Servern bekräftade inte den säkra återställningen. Läs in status innan du fortsätter." };
    const batch = viewBatch(body.batch);
    return batch ? { ok: true, value: batch } : { ok: false, message: "Servern bekräftade ingen läsbar avslutad batch." };
  } catch {
    return { ok: false, message: "Kunde inte nå arbetsytan. Den misslyckade batchen har inte avslutats." };
  }
}

export function activeSagaQuarterlyBatch(batches: SagaQuarterlyBatchView[]) {
  return batches.find((batch) => ["queued", "generating", "ready_for_review", "rework_required", "failed"].includes(batch.state)) ?? null;
}

export function titleForSagaActivityChannel(channel: SagaActivityChannel) {
  return { facebook_page: "Facebook", instagram: "Instagram", linkedin: "LinkedIn", newsletter: "Nyhetsbrev" }[channel];
}

export function mondayForSagaRollingQuarter(value = new Date()): string {
  const date = new Date(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()));
  const day = date.getUTCDay();
  date.setUTCDate(date.getUTCDate() + (day === 0 ? -6 : 1 - day));
  return date.toISOString().slice(0, 10);
}

export type {
  SagaQuarterlyActivityPlan as SagaQuarterlyPlan,
  SagaQuarterlyActivityPlanInput as SagaQuarterlyPlanInput,
  SagaQuarterlyActivityPlanSlot as SagaQuarterlyPlanItem,
  SagaQuarterlyChannelPlan,
  SagaQuarterlyContentTheme,
};
