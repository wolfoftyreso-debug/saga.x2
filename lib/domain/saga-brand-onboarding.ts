import { z } from "zod";
import {
  contentEngineBrandProfileInputSchema,
  contentEngineBrandProfileSchema,
} from "@/lib/domain/content-engine";

/**
 * A versioned, deterministic planning aid. It allocates a stated budget; it
 * never estimates impressions, sales, CAC, ROAS, or any other outcome.
 */
export const SAGA_BRAND_ONBOARDING_CALCULATION_VERSION = "saga-brand-plan-v1" as const;

export const SAGA_BRAND_ONBOARDING_COMPLETION_STATES = ["in_progress", "completed"] as const;
export const SAGA_BRAND_OBJECTIVE_KINDS = [
  "awareness",
  "demand_creation",
  "demand_capture",
  "conversion",
  "retention",
  "positioning",
] as const;
export const SAGA_BRAND_PLAN_CHANNELS = [
  "organic_social",
  "paid_social",
  "search",
  "email",
  "website",
  "direct_mail",
  "print",
  "events",
  "partners",
] as const;
export const SAGA_BRAND_OPERATING_MODELS = [
  "in_house_b2b_team",
  "agency_consultancy",
  "commercial_b2c",
  "public_nonprofit",
  "other",
  "unknown",
] as const;
export type SagaBrandOperatingModel = (typeof SAGA_BRAND_OPERATING_MODELS)[number];

const objectiveIdSchema = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,78}$/);
const currencySchema = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/);
const finiteNumberSchema = z.number().finite();
const nonNegativeMinorSchema = z.number().int().min(0).max(9_000_000_000_000_000);
const sagaBrandOperatingModelSchema = z.enum(SAGA_BRAND_OPERATING_MODELS);

const operatingModelLabels: Record<SagaBrandOperatingModel, string> = {
  in_house_b2b_team: "Internt B2B-team",
  agency_consultancy: "Byrå eller konsultverksamhet",
  commercial_b2c: "Kommersiell B2C-verksamhet",
  public_nonprofit: "Offentlig eller idéburen verksamhet",
  other: "Annat arbetssätt",
  unknown: "Inte klarlagt ännu",
};

/** The canonical Content Engine identity without lifecycle controls. */
export const sagaBrandOnboardingBrandInputSchema = contentEngineBrandProfileInputSchema
  .omit({ active: true, isDefault: true })
  .strict();
export type SagaBrandOnboardingBrandInput = z.infer<typeof sagaBrandOnboardingBrandInputSchema>;

export const sagaBrandOnboardingObjectiveSchema = z.object({
  id: objectiveIdSchema,
  kind: z.enum(SAGA_BRAND_OBJECTIVE_KINDS),
  statement: z.string().trim().min(12).max(600),
  measurement: z.object({
    metric: z.string().trim().min(2).max(160),
    unit: z.enum(["count", "percent", "currency", "index", "custom"]),
    baseline: finiteNumberSchema.nullable().default(null),
    target: finiteNumberSchema.nullable().default(null),
    provenance: z.enum(["historical_measurement", "user_estimate", "unknown"]),
  }).strict(),
}).strict().superRefine((value, context) => {
  if (value.measurement.provenance === "unknown" && (value.measurement.baseline !== null || value.measurement.target !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["measurement", "provenance"],
      message: "Välj en källa när en baslinje eller ett mål anges.",
    });
  }
});

export const sagaBrandOnboardingAnnualPlanSchema = z.object({
  planYear: z.number().int().min(2024).max(2100),
  primaryObjective: z.enum(SAGA_BRAND_OBJECTIVE_KINDS),
  objectiveStatement: z.string().trim().min(12).max(1_200),
  objectives: z.array(sagaBrandOnboardingObjectiveSchema).min(1).max(4),
  audience: z.object({
    description: z.string().trim().min(12).max(2_000),
    geography: z.string().trim().max(240).default(""),
    sizeEvidence: z.enum(["unknown", "estimated", "measured"]),
  }).strict(),
  marketContext: z.object({
    productReadiness: z.enum(["not_ready", "early", "ready", "proven"]),
    demandEvidence: z.enum(["unknown", "hypothesis", "customer_signal", "repeatable_demand"]),
    historicalPerformance: z.enum(["none", "partial", "reliable"]),
    conversionMeasurement: z.enum(["none", "basic", "reliable"]),
    competitiveContext: z.enum(["unknown", "working_assumption", "researched"]),
    timingConfidence: z.enum(["unknown", "working_assumption", "researched"]),
  }).strict(),
  channels: z.array(z.enum(SAGA_BRAND_PLAN_CHANNELS)).min(1).max(SAGA_BRAND_PLAN_CHANNELS.length),
  activity: z.object({
    alwaysOn: z.boolean().default(true),
    campaignBurstsPerYear: z.number().int().min(0).max(12).default(4),
    contentPiecesPerMonth: z.number().int().min(0).max(120).default(4),
    reviewCadence: z.enum(["monthly", "quarterly"]),
    seasonalWindows: z.array(z.object({
      label: z.string().trim().min(2).max(120),
      startMonth: z.number().int().min(1).max(12),
      endMonth: z.number().int().min(1).max(12),
      importance: z.enum(["supporting", "primary"]),
      rationale: z.string().trim().min(4).max(600),
    }).strict().superRefine((window, context) => {
      if (window.endMonth < window.startMonth) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["endMonth"], message: "Slutmånaden behöver ligga efter startmånaden." });
      }
    })).max(12).default([]),
  }).strict(),
  budget: z.object({
    currency: currencySchema.default("SEK"),
    status: z.enum(["unknown", "provisional", "confirmed"]),
    annualBudgetMinor: nonNegativeMinorSchema.default(0),
    fixedCommitmentsMinor: nonNegativeMinorSchema.default(0),
    allocationIntent: z.enum(["balanced", "learning_first", "demand_capture", "reach_building"]),
  }).strict(),
}).strict().superRefine((value, context) => {
  if (!value.objectives.some((objective) => objective.kind === value.primaryObjective)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["primaryObjective"],
      message: "Huvudmålet behöver finnas bland årets konkreta mål.",
    });
  }
  if (new Set(value.objectives.map((objective) => objective.id)).size !== value.objectives.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["objectives"], message: "Varje mål behöver ett eget id." });
  }
  if (new Set(value.channels).size !== value.channels.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["channels"], message: "En kanal får bara väljas en gång." });
  }
  if (value.budget.fixedCommitmentsMinor > value.budget.annualBudgetMinor) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["budget", "fixedCommitmentsMinor"], message: "Fasta åtaganden kan inte överstiga årsbudgeten." });
  }
  if (value.budget.status === "unknown" && (value.budget.annualBudgetMinor !== 0 || value.budget.fixedCommitmentsMinor !== 0)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["budget", "status"], message: "Okänd budget får inte innehålla ett belopp. Välj preliminär eller bekräftad budget." });
  }
  const usedSeasonMonths = new Set<number>();
  for (const [index, window] of value.activity.seasonalWindows.entries()) {
    for (const month of includedMonths(window.startMonth, window.endMonth)) {
      if (usedSeasonMonths.has(month)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["activity", "seasonalWindows", index],
          message: "Säsongsfönster får inte överlappa. Slå ihop perioden eller välj separata månader.",
        });
        break;
      }
      usedSeasonMonths.add(month);
    }
  }
});
export type SagaBrandOnboardingAnnualPlan = z.infer<typeof sagaBrandOnboardingAnnualPlanSchema>;

const onboardingDraftObjectSchema = z.object({
  completionState: z.enum(SAGA_BRAND_ONBOARDING_COMPLETION_STATES).default("in_progress"),
  makeDefaultOnCompletion: z.boolean().default(true),
  brand: sagaBrandOnboardingBrandInputSchema,
  annualPlan: sagaBrandOnboardingAnnualPlanSchema,
}).strict();

function lifecycleValidation(
  value: z.infer<typeof onboardingDraftObjectSchema>,
  context: z.RefinementCtx,
): void {
  if (value.completionState === "completed" && value.annualPlan.budget.status === "unknown") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["annualPlan", "budget", "status"],
      message: "En slutförd onboarding behöver en preliminär eller bekräftad årsbudget. Spara som pågående om budgeten ännu är okänd.",
    });
  }
}

/** A safe, complete document for an in-progress or completed brand onboarding. */
export const sagaBrandOnboardingDraftSchema = onboardingDraftObjectSchema.superRefine(lifecycleValidation);
export type SagaBrandOnboardingDraftInput = z.infer<typeof sagaBrandOnboardingDraftSchema>;

export const sagaBrandOnboardingCreateSchema = onboardingDraftObjectSchema.extend({
  createIdempotencyKey: z.string().uuid(),
}).strict().superRefine(lifecycleValidation);
export type SagaBrandOnboardingCreateInput = z.infer<typeof sagaBrandOnboardingCreateSchema>;

export const sagaBrandOnboardingUpdateSchema = onboardingDraftObjectSchema.extend({
  expectedRevision: z.number().int().min(1).max(2_147_483_647),
}).strict().superRefine(lifecycleValidation);
export type SagaBrandOnboardingUpdateInput = z.infer<typeof sagaBrandOnboardingUpdateSchema>;

export const sagaBrandOnboardingBudgetBucketSchema = z.object({
  bucket: z.enum(["production", "distribution", "experimentation", "measurement", "reserve"]),
  shareBasisPoints: z.number().int().min(0).max(10_000),
  amountMinor: nonNegativeMinorSchema,
  purpose: z.string().min(1).max(500),
}).strict();

export const sagaBrandOnboardingDecisionSupportSchema = z.object({
  calculationVersion: z.literal(SAGA_BRAND_ONBOARDING_CALCULATION_VERSION),
  scope: z.literal("scenario_allocation_not_outcome_forecast"),
  suppliedFacts: z.array(z.object({
    field: z.string().min(1).max(160),
    value: z.string().min(1).max(2_000),
    provenance: z.literal("user_declared"),
  }).strict()).max(24),
  inputProvenance: z.object({
    externalMarketDataUsed: z.literal(false),
    historicalPerformance: z.enum(["none", "partial", "reliable"]),
    audienceSizeEvidence: z.enum(["unknown", "estimated", "measured"]),
    conversionMeasurement: z.enum(["none", "basic", "reliable"]),
  }).strict(),
  assumptions: z.array(z.string().min(1).max(600)).max(16),
  unknowns: z.array(z.string().min(1).max(600)).max(16),
  decisionReadiness: z.enum(["foundation_needed", "directional", "evidence_informed"]),
  decisionFlags: z.array(z.object({
    id: z.string().min(1).max(120),
    level: z.enum(["blocking", "attention", "ready"]),
    message: z.string().min(1).max(600),
    nextStep: z.string().min(1).max(600),
  }).strict()).max(16),
  budget: z.object({
    currency: currencySchema,
    status: z.enum(["unknown", "provisional", "confirmed"]),
    annualBudgetMinor: nonNegativeMinorSchema,
    fixedCommitmentsMinor: nonNegativeMinorSchema,
    allocatableMinor: nonNegativeMinorSchema,
  }).strict(),
  allocation: z.array(sagaBrandOnboardingBudgetBucketSchema).length(5),
  quarterlyCadence: z.array(z.object({
    quarter: z.number().int().min(1).max(4),
    allocationMinor: nonNegativeMinorSchema,
    campaignFocus: z.boolean(),
  }).strict()).length(4),
  monthlyCadence: z.array(z.object({
    month: z.number().int().min(1).max(12),
    allocationMinor: nonNegativeMinorSchema,
    contentPieces: z.number().int().min(0).max(132),
    campaignFocus: z.boolean(),
  }).strict()).length(12),
  outcomeForecast: z.object({
    available: z.literal(false),
    reason: z.literal("no_historical_outcome_data_or_external_market_model"),
  }).strict(),
}).strict();
export type SagaBrandOnboardingDecisionSupport = z.infer<typeof sagaBrandOnboardingDecisionSupportSchema>;

export const sagaBrandOnboardingSchema = z.object({
  id: z.string().uuid(),
  brandProfileId: z.string().uuid(),
  brandProfile: contentEngineBrandProfileSchema,
  completionState: z.enum(SAGA_BRAND_ONBOARDING_COMPLETION_STATES),
  makeDefaultOnCompletion: z.boolean(),
  annualPlan: sagaBrandOnboardingAnnualPlanSchema,
  decisionSupport: sagaBrandOnboardingDecisionSupportSchema,
  revision: z.number().int().min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  completedAt: z.string().min(1).nullable(),
}).strict();
export type SagaBrandOnboarding = z.infer<typeof sagaBrandOnboardingSchema>;

export const sagaBrandOnboardingOverviewSchema = z.object({
  brandProfileId: z.string().uuid(),
  brandName: z.string().min(2).max(160),
  brandSlug: z.string().min(2).max(80),
  brandActive: z.boolean(),
  completionState: z.enum(SAGA_BRAND_ONBOARDING_COMPLETION_STATES),
  planYear: z.number().int().min(2024).max(2100),
  budget: z.object({
    currency: currencySchema,
    status: z.enum(["unknown", "provisional", "confirmed"]),
    annualBudgetMinor: nonNegativeMinorSchema,
  }).strict(),
  decisionReadiness: z.enum(["foundation_needed", "directional", "evidence_informed"]),
  revision: z.number().int().min(1),
  updatedAt: z.string().min(1),
}).strict();
export type SagaBrandOnboardingOverview = z.infer<typeof sagaBrandOnboardingOverviewSchema>;

export const sagaBrandOnboardingAdvisorModelOutputSchema = z.object({
  summary: z.string().trim().min(1).max(900),
  recommendations: z.array(z.object({
    area: z.enum(["objective", "audience", "timing", "channels", "activity", "budget", "measurement"]),
    recommendation: z.string().trim().min(1).max(700),
    rationale: z.string().trim().min(1).max(700),
  }).strict()).max(6),
  questions: z.array(z.string().trim().min(1).max(400)).max(6),
}).strict();
export type SagaBrandOnboardingAdvisorModelOutput = z.infer<typeof sagaBrandOnboardingAdvisorModelOutputSchema>;

export const sagaBrandOnboardingAdviceRequestSchema = z.object({
  draft: sagaBrandOnboardingDraftSchema,
}).strict();
export type SagaBrandOnboardingAdviceRequest = z.infer<typeof sagaBrandOnboardingAdviceRequestSchema>;

type AllocationBucket = z.infer<typeof sagaBrandOnboardingBudgetBucketSchema>["bucket"];
type AllocationWeights = Record<AllocationBucket, number>;

const BASE_WEIGHTS: Record<SagaBrandOnboardingAnnualPlan["budget"]["allocationIntent"], AllocationWeights> = {
  balanced: { production: 3_000, distribution: 3_500, experimentation: 1_500, measurement: 800, reserve: 1_200 },
  learning_first: { production: 2_600, distribution: 2_500, experimentation: 2_700, measurement: 1_000, reserve: 1_200 },
  demand_capture: { production: 2_200, distribution: 4_700, experimentation: 1_100, measurement: 1_000, reserve: 1_000 },
  reach_building: { production: 3_300, distribution: 3_700, experimentation: 1_200, measurement: 800, reserve: 1_000 },
};

const BUCKET_PURPOSES: Record<AllocationBucket, string> = {
  production: "Budskap, format, landningsyta och material som måste vara tydliga före större distribution.",
  distribution: "Planerad räckvidd och kanalaktivering inom valda kanaler; inte en prognos för utfall.",
  experimentation: "Avgränsade tester av budskap, målgrupp, erbjudande eller kanal före uppskalning.",
  measurement: "Mätning, instrumentering och återkommande beslut om vad som ska fortsätta, ändras eller stoppas.",
  reserve: "Medveten reserv för osäkerhet, timingförändringar och nya bevis — inte oplanerad konsumtion.",
};

function moveWeight(weights: AllocationWeights, from: AllocationBucket, to: AllocationBucket, basisPoints: number): void {
  const moved = Math.min(Math.max(0, basisPoints), weights[from]);
  weights[from] -= moved;
  weights[to] += moved;
}

function allocateMinor(total: number, weights: readonly number[]): number[] {
  if (total <= 0) return weights.map(() => 0);
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
  if (weightTotal <= 0) return weights.map(() => 0);
  // Minor units are bounded below Number.MAX_SAFE_INTEGER, but multiplying a
  // valid annual budget by basis points can exceed it. BigInt preserves the
  // exact amount that the Neon invariant later verifies.
  const totalMinor = BigInt(total);
  const totalWeight = BigInt(weightTotal);
  const resultMinor = weights.map((weight) => (totalMinor * BigInt(weight)) / totalWeight);
  let remainder = totalMinor - resultMinor.reduce((sum, amount) => sum + amount, 0n);
  for (let index = 0; remainder > 0n; index = (index + 1) % resultMinor.length) {
    resultMinor[index] = (resultMinor[index] ?? 0n) + 1n;
    remainder -= 1n;
  }
  return resultMinor.map((amount) => Number(amount));
}

function includedMonths(startMonth: number, endMonth: number): number[] {
  const months: number[] = [];
  for (let month = startMonth; month <= endMonth; month += 1) months.push(month);
  return months;
}

function operatingModelFromProfileConfig(profileConfig: Record<string, unknown>): SagaBrandOperatingModel | null {
  const context = profileConfig.onboardingContext;
  if (!context || typeof context !== "object" || Array.isArray(context)) return null;
  const value = (context as Record<string, unknown>).operatingModel;
  const parsed = sagaBrandOperatingModelSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function stableFacts(input: SagaBrandOnboardingDraftInput): SagaBrandOnboardingDecisionSupport["suppliedFacts"] {
  const operatingModel = operatingModelFromProfileConfig(input.brand.profileConfig);
  return [
    { field: "brand.name", value: input.brand.name, provenance: "user_declared" },
    ...(operatingModel ? [{
      field: "brand.profileConfig.onboardingContext.operatingModel",
      value: operatingModelLabels[operatingModel],
      provenance: "user_declared" as const,
    }] : []),
    { field: "annualPlan.planYear", value: String(input.annualPlan.planYear), provenance: "user_declared" },
    { field: "annualPlan.primaryObjective", value: input.annualPlan.primaryObjective, provenance: "user_declared" },
    { field: "annualPlan.audience", value: input.annualPlan.audience.description, provenance: "user_declared" },
    { field: "annualPlan.channels", value: input.annualPlan.channels.join(", "), provenance: "user_declared" },
    { field: "annualPlan.budget.status", value: input.annualPlan.budget.status, provenance: "user_declared" },
    { field: "annualPlan.budget.annualBudgetMinor", value: String(input.annualPlan.budget.annualBudgetMinor), provenance: "user_declared" },
  ];
}

/**
 * Produces an explainable allocation and cadence from values the user gave
 * SAGA. This is intentionally deterministic so a revision can always be
 * recreated and audited without replaying an AI model.
 */
export function calculateSagaBrandOnboardingDecisionSupport(
  value: SagaBrandOnboardingDraftInput,
): SagaBrandOnboardingDecisionSupport {
  const input = sagaBrandOnboardingDraftSchema.parse(value);
  const { annualPlan } = input;
  const { budget, marketContext } = annualPlan;
  const weights = { ...BASE_WEIGHTS[budget.allocationIntent] };
  const assumptions = [
    "Fördelningen är en intern planeringsheuristik för en deklarerad årsbudget, inte en marknadsprognos.",
    "All distribution behöver fortsatt mänsklig kanal- och målgruppskontroll innan pengar eller publicering används.",
    `Budgeten fördelas efter den valda inriktningen ”${budget.allocationIntent}” och justeras av angiven produkt-, efterfråge- och mätmognad.`,
  ];
  const unknowns: string[] = [];
  const flags: SagaBrandOnboardingDecisionSupport["decisionFlags"] = [];

  if (marketContext.productReadiness === "not_ready" || marketContext.productReadiness === "early") {
    moveWeight(weights, "distribution", "production", 500);
    flags.push({
      id: "product_readiness",
      level: "attention",
      message: "Produkten är inte fullt etablerad enligt underlaget; mer utrymme hålls för budskap, erbjudande och material före större distribution.",
      nextStep: "Bekräfta erbjudande, kapacitet och landningsyta innan en större kanalinsats skalas upp.",
    });
  }
  if (marketContext.demandEvidence === "unknown" || marketContext.demandEvidence === "hypothesis") {
    moveWeight(weights, "distribution", "experimentation", 500);
    moveWeight(weights, "distribution", "reserve", 300);
    unknowns.push("Efterfrågan är ännu inte validerad med återkommande kundsignaler.");
    flags.push({
      id: "demand_evidence",
      level: "attention",
      message: "Planen prioriterar test och reserv eftersom efterfrågan är osäker eller en hypotes.",
      nextStep: "Definiera en liten testcykel och vilket kundbeteende som räknas som en tillräcklig signal.",
    });
  }
  if (marketContext.conversionMeasurement === "none" || marketContext.conversionMeasurement === "basic") {
    moveWeight(weights, "production", "measurement", 200);
    unknowns.push("Mätningen av vägen från uppmärksamhet till nästa steg är inte fullt tillförlitlig.");
    flags.push({
      id: "measurement_readiness",
      level: "attention",
      message: "En större del av den flexibla budgeten hålls för mätning eftersom beslutsunderlaget är begränsat.",
      nextStep: "Bestäm minst en spårbar handling per mål innan ni jämför kanaler eller kreativa format.",
    });
  }
  if (annualPlan.audience.sizeEvidence === "unknown") {
    unknowns.push("Målgruppens storlek är inte angiven som uppskattad eller uppmätt.");
  }
  if (marketContext.historicalPerformance === "none") {
    unknowns.push("Det finns ingen historisk resultatdata att använda för utfallsbedömning.");
  }
  if (marketContext.competitiveContext === "unknown") {
    unknowns.push("Konkurrensbilden är okänd i underlaget.");
  }
  if (marketContext.timingConfidence === "unknown") {
    unknowns.push("Timing bygger inte på ett dokumenterat underlag ännu.");
  }
  if (annualPlan.objectives.some((objective) => objective.measurement.baseline === null || objective.measurement.target === null)) {
    unknowns.push("Minst ett mål saknar baslinje eller målvärde och kan därför inte följas som ett utfall ännu.");
  }
  if (budget.status === "unknown") {
    unknowns.push("Årsbudgeten är inte beslutad; beloppsfördelningen är därför noll tills en preliminär eller bekräftad budget anges.");
    flags.push({
      id: "budget_required",
      level: "blocking",
      message: "Årsbudgeten är okänd. SAGA kan visa struktur men inte fördela faktiska belopp.",
      nextStep: "Ange en preliminär eller bekräftad årsbudget och fasta åtaganden.",
    });
  }

  const allocatableMinor = Math.max(0, budget.annualBudgetMinor - budget.fixedCommitmentsMinor);
  if (allocatableMinor === 0 && budget.status !== "unknown") {
    flags.push({
      id: "no_flexible_budget",
      level: "attention",
      message: "Det finns ingen flexibel budget kvar efter fasta åtaganden.",
      nextStep: "Bekräfta att aktivitet kan genomföras med befintliga resurser eller avsätt en flexibel test- och mätreserv.",
    });
  }

  const orderedBuckets: AllocationBucket[] = ["production", "distribution", "experimentation", "measurement", "reserve"];
  const amounts = allocateMinor(allocatableMinor, orderedBuckets.map((bucket) => weights[bucket]));
  const allocation = orderedBuckets.map((bucket, index) => ({
    bucket,
    shareBasisPoints: weights[bucket],
    amountMinor: amounts[index] ?? 0,
    purpose: BUCKET_PURPOSES[bucket],
  }));

  const monthWeights = Array.from({ length: 12 }, () => 100);
  const primaryMonths = new Set<number>();
  for (const window of annualPlan.activity.seasonalWindows) {
    for (const month of includedMonths(window.startMonth, window.endMonth)) {
      monthWeights[month - 1] = (monthWeights[month - 1] ?? 100) + (window.importance === "primary" ? 100 : 50);
      if (window.importance === "primary") primaryMonths.add(month);
    }
  }
  const campaignMonths = [...primaryMonths];
  for (let month = 1; campaignMonths.length < annualPlan.activity.campaignBurstsPerYear && month <= 12; month += 1) {
    if (!campaignMonths.includes(month)) campaignMonths.push(month);
  }
  const campaignMonthSet = new Set(campaignMonths.slice(0, annualPlan.activity.campaignBurstsPerYear));
  const monthlyAmounts = allocateMinor(allocatableMinor, monthWeights);
  const monthlyCadence = monthlyAmounts.map((amountMinor, index) => ({
    month: index + 1,
    allocationMinor: amountMinor,
    contentPieces: annualPlan.activity.contentPiecesPerMonth + (campaignMonthSet.has(index + 1) ? 1 : 0),
    campaignFocus: campaignMonthSet.has(index + 1),
  }));
  const quarterlyCadence = [1, 2, 3, 4].map((quarter) => {
    const monthly = monthlyCadence.slice((quarter - 1) * 3, quarter * 3);
    return {
      quarter,
      allocationMinor: monthly.reduce((sum, month) => sum + month.allocationMinor, 0),
      campaignFocus: monthly.some((month) => month.campaignFocus),
    };
  });

  const evidenceInformed = marketContext.demandEvidence === "repeatable_demand"
    && annualPlan.audience.sizeEvidence === "measured"
    && marketContext.historicalPerformance === "reliable"
    && marketContext.conversionMeasurement === "reliable";
  const decisionReadiness = evidenceInformed
    ? "evidence_informed"
    : unknowns.length >= 4 || budget.status === "unknown"
      ? "foundation_needed"
      : "directional";
  if (!flags.some((flag) => flag.level === "blocking")) {
    flags.push({
      id: "human_review",
      level: "ready",
      message: "Planen är en beslutsstruktur. Belopp, kanalval och aktivitet behöver godkännas av en ansvarig person före användning.",
      nextStep: "Gå igenom antaganden och välj vad som ska testas, mätas och följas upp i första kvartalet.",
    });
  }

  return sagaBrandOnboardingDecisionSupportSchema.parse({
    calculationVersion: SAGA_BRAND_ONBOARDING_CALCULATION_VERSION,
    scope: "scenario_allocation_not_outcome_forecast",
    suppliedFacts: stableFacts(input),
    inputProvenance: {
      externalMarketDataUsed: false,
      historicalPerformance: marketContext.historicalPerformance,
      audienceSizeEvidence: annualPlan.audience.sizeEvidence,
      conversionMeasurement: marketContext.conversionMeasurement,
    },
    assumptions,
    unknowns,
    decisionReadiness,
    decisionFlags: flags,
    budget: {
      currency: budget.currency,
      status: budget.status,
      annualBudgetMinor: budget.annualBudgetMinor,
      fixedCommitmentsMinor: budget.fixedCommitmentsMinor,
      allocatableMinor,
    },
    allocation,
    quarterlyCadence,
    monthlyCadence,
    outcomeForecast: {
      available: false,
      reason: "no_historical_outcome_data_or_external_market_model",
    },
  });
}

export const SAGA_BRAND_ONBOARDING_API_CONTRACT = {
  overview: { method: "GET", path: "/api/saga/brand-onboarding", response: "{ onboardings: SagaBrandOnboardingOverview[], calculationVersion }" },
  create: { method: "POST", path: "/api/saga/brand-onboarding", body: "SagaBrandOnboardingCreateInput", response: "{ onboarding: SagaBrandOnboarding, reused: boolean }" },
  read: { method: "GET", path: "/api/saga/brand-onboarding/:brandProfileId", response: "{ onboarding: SagaBrandOnboarding }" },
  update: { method: "PATCH", path: "/api/saga/brand-onboarding/:brandProfileId", body: "SagaBrandOnboardingUpdateInput", response: "{ onboarding: SagaBrandOnboarding }" },
  advice: { method: "POST", path: "/api/saga/brand-onboarding/advice", body: "{ draft: SagaBrandOnboardingDraftInput }", response: "{ advice: transient, saved: false }" },
} as const;
