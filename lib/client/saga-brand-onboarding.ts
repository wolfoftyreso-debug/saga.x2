/**
 * Browser-safe adapter for the canonical brand-onboarding contract.
 *
 * This module deliberately has no local persistence. A form may be useful as
 * an in-memory planning worksheet, but a brand only exists after the
 * actor-scoped endpoint confirms the canonical document.
 */

import {
  calculateSagaBrandOnboardingDecisionSupport,
  sagaBrandOnboardingDecisionSupportSchema,
  sagaBrandOnboardingDraftSchema,
  type SagaBrandOnboardingAdviceRequest,
  type SagaBrandOnboardingAnnualPlan,
  type SagaBrandOnboardingDecisionSupport,
  type SagaBrandOnboardingDraftInput,
  type SagaBrandOperatingModel,
} from "@/lib/domain/saga-brand-onboarding";

type PlanChannel = SagaBrandOnboardingAnnualPlan["channels"][number];
type ObjectiveKind = SagaBrandOnboardingAnnualPlan["primaryObjective"];
type MeasurementUnit = SagaBrandOnboardingAnnualPlan["objectives"][number]["measurement"]["unit"];
type MeasurementProvenance = SagaBrandOnboardingAnnualPlan["objectives"][number]["measurement"]["provenance"];

export type BrandOnboardingDraft = {
  brandName: string;
  organizationName: string;
  website: string;
  offer: string;
  customerProblem: string;
  difference: string;
  productReadiness: "not_ready" | "early" | "ready" | "proven";
  audience: string;
  operatingModel: SagaBrandOperatingModel;
  marketScope: "local" | "regional" | "national" | "international" | "unknown";
  audienceSizeEvidence: "unknown" | "estimated" | "measured";
  demandEvidence: "unknown" | "early" | "steady" | "seasonal";
  historicalPerformance: "none" | "partial" | "reliable";
  competition: "unknown" | "low" | "medium" | "high";
  competitiveContext: "unknown" | "working_assumption" | "researched";
  timing: "always_on" | "seasonal" | "launch" | "unknown";
  timingConfidence: "unknown" | "working_assumption" | "researched";
  timingNote: string;
  seasonStartMonth: string;
  seasonEndMonth: string;
  seasonImportance: "supporting" | "primary";
  annualGoal: "awareness" | "demand" | "sales" | "retention" | "unknown";
  goalDetail: string;
  measurementMetric: string;
  measurementUnit: MeasurementUnit;
  measurementBaseline: string;
  measurementTarget: string;
  measurementProvenance: MeasurementProvenance;
  salesCycle: "short" | "considered" | "long" | "unknown";
  conversionMeasurement: "none" | "basic" | "reliable";
  teamCapacity: "light" | "steady" | "dedicated" | "unknown";
  channels: PlanChannel[];
  channelFocus: string;
  constraints: string;
  planYear: string;
  alwaysOn: boolean;
  campaignBurstsPerYear: string;
  contentPiecesPerMonth: string;
  reviewCadence: "monthly" | "quarterly";
  annualBudgetSek: string;
  fixedCommitmentsSek: string;
  budgetStatus: "unknown" | "provisional" | "confirmed";
  allocationIntent: "balanced" | "learning_first" | "demand_capture" | "reach_building";
};

export type BrandOnboardingApiStatus = {
  available: boolean;
  advisor: "available" | "unavailable" | "unknown";
  message: string | null;
};

export type BrandOnboardingSaved = {
  brandId: string | null;
  brandName: string | null;
  completionState: "in_progress" | "completed" | null;
  reused: boolean;
  decisionSupport: SagaBrandOnboardingDecisionSupport | null;
};

export type BrandOnboardingAdvice = {
  summary: string;
  considerations: Array<{ label: string; detail: string; kind: "assumption" | "unknown" }>;
};

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function responseMessage(payload: unknown, fallback: string): string {
  const body = record(payload);
  return text(body?.error) ?? text(body?.message) ?? fallback;
}

function integer(value: string, fallback = 0) {
  const parsed = Number(value.replace(/[^0-9-]/g, ""));
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

function decimalOrNull(value: string) {
  const normalized = value.trim().replace(/\s/g, "").replace(",", ".");
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function minorFromSek(value: string) {
  const normalized = value.trim().replace(/\s/g, "").replace(",", ".");
  if (!normalized) return 0;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * 100) : 0;
}

function slug(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("sv-SE")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function objectiveKind(goal: BrandOnboardingDraft["annualGoal"]): ObjectiveKind {
  if (goal === "awareness") return "awareness";
  if (goal === "demand") return "demand_creation";
  if (goal === "sales") return "conversion";
  if (goal === "retention") return "retention";
  // The form blocks a save while the goal is unknown. This value only keeps
  // the transport object typed before Zod returns its explicit issue.
  return "positioning";
}

function demandEvidence(value: BrandOnboardingDraft["demandEvidence"]): SagaBrandOnboardingAnnualPlan["marketContext"]["demandEvidence"] {
  if (value === "early") return "hypothesis";
  if (value === "steady") return "repeatable_demand";
  if (value === "seasonal") return "customer_signal";
  return "unknown";
}

function geography(value: BrandOnboardingDraft["marketScope"]) {
  if (value === "local") return "Lokal marknad";
  if (value === "regional") return "Regional marknad";
  if (value === "national") return "Nationell marknad";
  if (value === "international") return "Flera marknader eller länder";
  return "";
}

function inputIssue(value: ReturnType<typeof sagaBrandOnboardingDraftSchema.safeParse>) {
  if (value.success) return null;
  const issue = value.error.issues[0];
  const path = issue?.path.map(String).join(".") ?? "";
  if (path.startsWith("brand.name") || path.startsWith("brand.slug")) return "Ange ett varumärkesnamn med minst två tecken.";
  if (path.startsWith("annualPlan.audience")) return "Beskriv målgruppen med minst en konkret mening.";
  if (path.startsWith("annualPlan.objectiveStatement") || path.startsWith("annualPlan.objectives")) return "Välj ett årsmål och beskriv vad som ska vara annorlunda om tolv månader.";
  if (path.startsWith("annualPlan.channels")) return "Välj minst en kanal som planen faktiskt ska bedöma.";
  if (path.startsWith("annualPlan.budget")) return "Ange en giltig årsbudget och kontrollera att fasta åtaganden inte är större än budgeten.";
  if (path.startsWith("annualPlan.activity")) return "Kontrollera aktivitetstakten och eventuella säsongsperioder.";
  return "Fyll i erbjudande, målgrupp, mål, mått, kanal och budget innan planen kan beräknas.";
}

/** Builds exactly the server-owned draft shape; no local profile types leak into the API. */
export function brandOnboardingInputFromForm(
  form: BrandOnboardingDraft,
  completionState: "in_progress" | "completed",
  makeDefaultOnCompletion: boolean,
): SagaBrandOnboardingDraftInput {
  const kind = objectiveKind(form.annualGoal);
  const seasonalWindow = form.timing === "seasonal" && form.seasonStartMonth && form.seasonEndMonth && form.timingNote.trim()
    ? [{
      label: form.timingNote.trim().slice(0, 120),
      startMonth: integer(form.seasonStartMonth),
      endMonth: integer(form.seasonEndMonth),
      importance: form.seasonImportance,
      rationale: form.timingNote.trim(),
    }]
    : [];
  const metric = form.measurementMetric.trim();
  const measurement = {
    metric,
    unit: form.measurementUnit,
    baseline: decimalOrNull(form.measurementBaseline),
    target: decimalOrNull(form.measurementTarget),
    provenance: form.measurementProvenance,
  } as const;
  const positioning = [form.offer.trim(), form.difference.trim()].filter(Boolean).join(". ");
  const summary = [form.offer.trim(), form.customerProblem.trim(), form.difference.trim()].filter(Boolean).join(" ");
  return {
    completionState,
    makeDefaultOnCompletion,
    brand: {
      slug: slug(form.brandName),
      name: form.brandName.trim(),
      organizationName: form.organizationName.trim(),
      summary,
      defaultLanguage: "sv",
      voice: {
        positioning,
        audience: form.audience.trim(),
        toneTraits: [],
        vocabulary: [],
        avoidPhrases: [],
        writingSamples: [],
      },
      profileConfig: {
        onboardingContext: {
          operatingModel: form.operatingModel,
          ...(form.website.trim() ? { website: form.website.trim() } : {}),
          competition: form.competition,
          timing: form.timing,
          ...(form.timingNote.trim() ? { timingNote: form.timingNote.trim() } : {}),
          salesCycle: form.salesCycle,
          teamCapacity: form.teamCapacity,
          ...(form.channelFocus.trim() ? { channelNote: form.channelFocus.trim() } : {}),
          ...(form.constraints.trim() ? { constraints: form.constraints.trim() } : {}),
        },
      },
    },
    annualPlan: {
      planYear: integer(form.planYear),
      primaryObjective: kind,
      objectiveStatement: form.goalDetail.trim(),
      objectives: [{
        id: `annual-${kind.replace(/_/g, "-")}`,
        kind,
        statement: form.goalDetail.trim(),
        measurement,
      }],
      audience: {
        description: form.audience.trim(),
        geography: geography(form.marketScope),
        sizeEvidence: form.audienceSizeEvidence,
      },
      marketContext: {
        productReadiness: form.productReadiness,
        demandEvidence: demandEvidence(form.demandEvidence),
        historicalPerformance: form.historicalPerformance,
        conversionMeasurement: form.conversionMeasurement,
        competitiveContext: form.competitiveContext,
        timingConfidence: form.timingConfidence,
      },
      channels: form.channels,
      activity: {
        alwaysOn: form.alwaysOn,
        campaignBurstsPerYear: integer(form.campaignBurstsPerYear),
        contentPiecesPerMonth: integer(form.contentPiecesPerMonth),
        reviewCadence: form.reviewCadence,
        seasonalWindows: seasonalWindow,
      },
      budget: {
        currency: "SEK",
        status: form.budgetStatus,
        annualBudgetMinor: minorFromSek(form.annualBudgetSek),
        fixedCommitmentsMinor: minorFromSek(form.fixedCommitmentsSek),
        allocationIntent: form.allocationIntent,
      },
    },
  };
}

export function brandOnboardingValidationMessage(
  form: BrandOnboardingDraft,
  completionState: "in_progress" | "completed",
  makeDefaultOnCompletion: boolean,
) {
  return inputIssue(sagaBrandOnboardingDraftSchema.safeParse(brandOnboardingInputFromForm(form, completionState, makeDefaultOnCompletion)));
}

export function brandOnboardingDecisionSupportFromForm(form: BrandOnboardingDraft): SagaBrandOnboardingDecisionSupport | null {
  const input = brandOnboardingInputFromForm(form, "in_progress", false);
  const parsed = sagaBrandOnboardingDraftSchema.safeParse(input);
  return parsed.success ? calculateSagaBrandOnboardingDecisionSupport(parsed.data) : null;
}

export async function readBrandOnboardingStatus(apiPath = "/api/saga/brand-onboarding"): Promise<BrandOnboardingApiStatus> {
  try {
    const response = await fetch(apiPath, { credentials: "same-origin", cache: "no-store" });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) return { available: false, advisor: "unavailable", message: responseMessage(payload, "Varumärkesonboardingen kan inte ansluta till arbetsytan just nu.") };
    // The overview endpoint intentionally reports saved onboarding summaries
    // only. Gateway availability is checked only when the user asks for advice.
    return { available: true, advisor: "unknown", message: null };
  } catch {
    return { available: false, advisor: "unavailable", message: "Varumärkesonboardingen kan inte ansluta till arbetsytan just nu." };
  }
}

export async function saveBrandOnboarding(
  form: BrandOnboardingDraft,
  options: { completionState: "in_progress" | "completed"; makeDefaultOnCompletion: boolean; createIdempotencyKey: string; apiPath?: string },
): Promise<{ ok: true; value: BrandOnboardingSaved } | { ok: false; message: string }> {
  const draft = brandOnboardingInputFromForm(form, options.completionState, options.makeDefaultOnCompletion);
  const parsed = sagaBrandOnboardingDraftSchema.safeParse(draft);
  const validationMessage = inputIssue(parsed);
  if (validationMessage || !parsed.success) return { ok: false, message: validationMessage ?? "Kontrollera onboardingunderlaget innan du sparar." };

  try {
    const response = await fetch(options.apiPath ?? "/api/saga/brand-onboarding", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ createIdempotencyKey: options.createIdempotencyKey, ...parsed.data }),
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) return { ok: false, message: responseMessage(payload, "Varumärket kunde inte sparas. Inget är aktiverat.") };
    const body = record(payload);
    const onboarding = record(body?.onboarding);
    const brandProfile = record(onboarding?.brandProfile);
    return {
      ok: true,
      value: {
        brandId: text(onboarding?.brandProfileId),
        brandName: text(brandProfile?.name),
        completionState: onboarding?.completionState === "in_progress" || onboarding?.completionState === "completed" ? onboarding.completionState : null,
        reused: body?.reused === true,
        decisionSupport: decisionSupportFromUnknown(onboarding?.decisionSupport),
      },
    };
  } catch {
    return { ok: false, message: "Arbetsytan kan inte nås. Inget varumärke eller någon plan har sparats." };
  }
}

export async function requestBrandOnboardingAdvice(
  form: BrandOnboardingDraft,
  options: { completionState: "in_progress" | "completed"; makeDefaultOnCompletion: boolean; apiPath?: string },
): Promise<{ ok: true; value: BrandOnboardingAdvice } | { ok: false; message: string }> {
  const draft = brandOnboardingInputFromForm(form, options.completionState, options.makeDefaultOnCompletion);
  const parsed = sagaBrandOnboardingDraftSchema.safeParse(draft);
  const validationMessage = inputIssue(parsed);
  if (validationMessage || !parsed.success) return { ok: false, message: validationMessage ?? "Gör klart planeringsunderlaget innan du ber om råd." };

  try {
    const body: SagaBrandOnboardingAdviceRequest = { draft: parsed.data };
    const response = await fetch(options.apiPath ?? "/api/saga/brand-onboarding/advice", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) return { ok: false, message: responseMessage(payload, "Rådgivaren kan inte granska planen just nu.") };
    const advice = record(record(payload)?.advice);
    const summary = text(advice?.summary);
    if (!summary) return { ok: false, message: "Rådgivaren skickade inget granskningsunderlag. Planen är inte ändrad." };
    const recommendations = Array.isArray(advice?.recommendations)
      ? advice.recommendations.flatMap((entry) => {
        const item = record(entry);
        const area = text(item?.area);
        const recommendation = text(item?.recommendation);
        const rationale = text(item?.rationale);
        if (!area || !recommendation || !rationale) return [];
        return [{ label: area, detail: `${recommendation} ${rationale}`, kind: "assumption" as const }];
      })
      : [];
    const questions = Array.isArray(advice?.questions)
      ? advice.questions.flatMap((entry) => {
        const question = text(entry);
        return question ? [{ label: "Behöver klargöras", detail: question, kind: "unknown" as const }] : [];
      })
      : [];
    return { ok: true, value: { summary, considerations: [...recommendations, ...questions] } };
  } catch {
    return { ok: false, message: "Rådgivaren kan inte nås. Planen är inte ändrad eller sparad." };
  }
}

function decisionSupportFromUnknown(value: unknown): SagaBrandOnboardingDecisionSupport | null {
  // The server calculation is the source of truth after a successful save.
  // Parse the full contractual response before rendering it. A partial or
  // changed server payload must not quietly become a second client-side
  // planning model.
  const parsed = sagaBrandOnboardingDecisionSupportSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
