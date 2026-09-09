"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import styles from "@/components/saga-brand-onboarding.module.css";
import {
  brandOnboardingDecisionSupportFromForm,
  brandOnboardingValidationMessage,
  readBrandOnboardingStatus,
  requestBrandOnboardingAdvice,
  saveBrandOnboarding,
  type BrandOnboardingAdvice,
  type BrandOnboardingApiStatus,
  type BrandOnboardingDraft,
} from "@/lib/client/saga-brand-onboarding";
import type { SagaBrandOnboardingDecisionSupport } from "@/lib/domain/saga-brand-onboarding";

export type OnboardingStepId = "brand" | "market" | "goals" | "plan" | "review";
type SaveState = "idle" | "saving_draft" | "saving_complete" | "saved_draft" | "saved_complete" | "error";
type AdviceState = "idle" | "checking" | "ready" | "error";

type PlanAllocation = {
  id: string;
  label: string;
  share: number;
  amountSek: number;
  reason: string;
};

type QuarterlyActivity = {
  quarter: "Q1" | "Q2" | "Q3" | "Q4";
  label: string;
  intent: string;
  share: number;
};

export type AnnualPlanScenario = {
  available: boolean;
  validationMessage: string | null;
  budgetSek: number;
  allocatableSek: number;
  allocations: PlanAllocation[];
  quarters: QuarterlyActivity[];
  facts: string[];
  assumptions: string[];
  unknowns: string[];
};

const steps: Array<{ id: OnboardingStepId; number: string; label: string; detail: string }> = [
  { id: "brand", number: "01", label: "Erbjudande", detail: "Varför någon ska bry sig" },
  { id: "market", number: "02", label: "Marknad", detail: "Efterfrågan, målgrupp, timing" },
  { id: "goals", number: "03", label: "Mål & ramar", detail: "Beslut, kapacitet, gränser" },
  { id: "plan", number: "04", label: "Årsplan", detail: "Budget, takt och lärande" },
  { id: "review", number: "05", label: "Granska", detail: "Spara eller aktivera medvetet" },
];

export const EMPTY_BRAND_ONBOARDING_DRAFT: BrandOnboardingDraft = {
  brandName: "",
  organizationName: "",
  website: "",
  offer: "",
  customerProblem: "",
  difference: "",
  productReadiness: "not_ready",
  audience: "",
  operatingModel: "unknown",
  marketScope: "unknown",
  audienceSizeEvidence: "unknown",
  demandEvidence: "unknown",
  historicalPerformance: "none",
  competition: "unknown",
  competitiveContext: "unknown",
  timing: "unknown",
  timingConfidence: "unknown",
  timingNote: "",
  seasonStartMonth: "",
  seasonEndMonth: "",
  seasonImportance: "primary",
  annualGoal: "unknown",
  goalDetail: "",
  measurementMetric: "",
  measurementUnit: "count",
  measurementBaseline: "",
  measurementTarget: "",
  measurementProvenance: "unknown",
  salesCycle: "unknown",
  conversionMeasurement: "none",
  teamCapacity: "unknown",
  channels: [],
  channelFocus: "",
  constraints: "",
  planYear: "2026",
  alwaysOn: true,
  campaignBurstsPerYear: "4",
  contentPiecesPerMonth: "4",
  reviewCadence: "monthly",
  annualBudgetSek: "",
  fixedCommitmentsSek: "",
  budgetStatus: "unknown",
  allocationIntent: "balanced",
};

const scopeLabels: Record<BrandOnboardingDraft["marketScope"], string> = {
  local: "Lokal marknad",
  regional: "Regional marknad",
  national: "Nationell marknad",
  international: "Flera marknader/länder",
  unknown: "Inte klarlagt ännu",
};

const operatingModelLabels: Record<BrandOnboardingDraft["operatingModel"], string> = {
  in_house_b2b_team: "Internt B2B-team",
  agency_consultancy: "Byrå eller konsultverksamhet",
  commercial_b2c: "Kommersiell B2C-verksamhet",
  public_nonprofit: "Offentlig eller idéburen verksamhet",
  other: "Annat arbetssätt",
  unknown: "Välj arbetssätt",
};

const demandLabels: Record<BrandOnboardingDraft["demandEvidence"], string> = {
  unknown: "Vi har inte underlag ännu",
  early: "Tidiga signaler, inte bevisat",
  steady: "Stabil återkommande efterfrågan",
  seasonal: "Tydligt säsongsberoende",
};

const competitionLabels: Record<BrandOnboardingDraft["competition"], string> = {
  unknown: "Inte kartlagt ännu",
  low: "Få relevanta alternativ",
  medium: "Flera jämförbara alternativ",
  high: "Många etablerade alternativ",
};

const timingLabels: Record<BrandOnboardingDraft["timing"], string> = {
  always_on: "Jämn närvaro över året",
  seasonal: "Säsong eller återkommande perioder",
  launch: "Lansering eller tydlig deadline",
  unknown: "Inte beslutat ännu",
};

const goalLabels: Record<BrandOnboardingDraft["annualGoal"], string> = {
  awareness: "Bygga kännedom",
  demand: "Skapa relevant efterfrågan",
  sales: "Driva kvalificerade affärer",
  retention: "Behålla och utveckla relationer",
  unknown: "Inte prioriterat ännu",
};

const salesCycleLabels: Record<BrandOnboardingDraft["salesCycle"], string> = {
  short: "Kort beslut (dagar/veckor)",
  considered: "Övervägt beslut (veckor/månader)",
  long: "Långt beslut (månader/år)",
  unknown: "Inte känt ännu",
};

const capacityLabels: Record<BrandOnboardingDraft["teamCapacity"], string> = {
  light: "Liten kapacitet, få parallella insatser",
  steady: "Jämn kapacitet varje månad",
  dedicated: "Dedikerad marknads- eller säljkapacitet",
  unknown: "Inte klarlagt ännu",
};

const productReadinessLabels: Record<BrandOnboardingDraft["productReadiness"], string> = {
  not_ready: "Inte redo att marknadsföra brett",
  early: "Tidigt erbjudande, behöver läras",
  ready: "Redo för en kontrollerad marknadstest",
  proven: "Etablerat erbjudande med stöd",
};

const audienceEvidenceLabels: Record<BrandOnboardingDraft["audienceSizeEvidence"], string> = {
  unknown: "Storleken är okänd",
  estimated: "En uppskattning finns",
  measured: "Det finns uppmätt underlag",
};

const historicalLabels: Record<BrandOnboardingDraft["historicalPerformance"], string> = {
  none: "Ingen användbar historik",
  partial: "Delvis historik",
  reliable: "Tillförlitlig historik",
};

const confidenceLabels: Record<BrandOnboardingDraft["competitiveContext"], string> = {
  unknown: "Inte undersökt ännu",
  working_assumption: "En arbetsbedömning",
  researched: "Undersökt och dokumenterat",
};

const timingConfidenceLabels: Record<BrandOnboardingDraft["timingConfidence"], string> = {
  unknown: "Inte undersökt ännu",
  working_assumption: "En arbetsbedömning",
  researched: "Undersökt och dokumenterat",
};

const conversionMeasurementLabels: Record<BrandOnboardingDraft["conversionMeasurement"], string> = {
  none: "Ingen spårning ännu",
  basic: "Grundläggande spårning",
  reliable: "Tillförlitlig spårning",
};

const budgetStatusLabels: Record<BrandOnboardingDraft["budgetStatus"], string> = {
  unknown: "Inte beslutad — spara endast som pågående",
  provisional: "Preliminär budget",
  confirmed: "Bekräftad budget",
};

const allocationIntentLabels: Record<BrandOnboardingDraft["allocationIntent"], string> = {
  balanced: "Balanserad fördelning",
  learning_first: "Lärande före förstärkning",
  demand_capture: "Fånga befintlig efterfrågan",
  reach_building: "Bygga relevant räckvidd",
};

const measurementUnitLabels: Record<BrandOnboardingDraft["measurementUnit"], string> = {
  count: "Antal",
  percent: "Procent",
  currency: "Valuta",
  index: "Index",
  custom: "Eget mått",
};

const measurementProvenanceLabels: Record<BrandOnboardingDraft["measurementProvenance"], string> = {
  historical_measurement: "Historisk mätning",
  user_estimate: "Egen uppskattning",
  unknown: "Inte känt ännu",
};

const channelOptions: Array<{ value: BrandOnboardingDraft["channels"][number]; label: string }> = [
  { value: "website", label: "Webbplats" },
  { value: "organic_social", label: "Organiskt socialt" },
  { value: "paid_social", label: "Betalt socialt" },
  { value: "search", label: "Sök" },
  { value: "email", label: "E-post" },
  { value: "partners", label: "Partners" },
  { value: "events", label: "Event" },
  { value: "direct_mail", label: "Direktutskick" },
  { value: "print", label: "Tryck" },
];

function signedPercent(value: number) {
  return `${Math.round(value * 100)} %`;
}

export function annualPlanScenario(draft: BrandOnboardingDraft): AnnualPlanScenario {
  const support = brandOnboardingDecisionSupportFromForm(draft);
  if (!support) return {
    available: false,
    validationMessage: brandOnboardingValidationMessage(draft, "in_progress", false),
    budgetSek: 0,
    allocatableSek: 0,
    allocations: [],
    quarters: [],
    facts: [],
    assumptions: [],
    unknowns: [],
  };
  return annualPlanScenarioFromDecisionSupport(support);
}

function annualPlanScenarioFromDecisionSupport(support: SagaBrandOnboardingDecisionSupport): AnnualPlanScenario {
  return {
    available: true,
    validationMessage: null,
    budgetSek: support.budget.annualBudgetMinor / 100,
    allocatableSek: support.budget.allocatableMinor / 100,
    allocations: support.allocation.map((allocation) => ({
      id: allocation.bucket,
      label: allocationLabel(allocation.bucket),
      share: allocation.shareBasisPoints / 10_000,
      amountSek: allocation.amountMinor / 100,
      reason: allocation.purpose,
    })),
    quarters: support.quarterlyCadence.map((quarter) => ({
      quarter: `Q${quarter.quarter}` as QuarterlyActivity["quarter"],
      label: quarter.campaignFocus ? "Prioriterad aktivitet" : "Kontrollerad närvaro",
      intent: quarter.campaignFocus
        ? "En kampanjperiod är markerad i det underlag du har valt. Utvärdera innan nästa förstärkning."
        : "Håll takt, mät och gör ett mänskligt beslut innan nästa kvartal.",
      share: support.budget.allocatableMinor > 0 ? quarter.allocationMinor / support.budget.allocatableMinor : 0,
    })),
    facts: support.suppliedFacts.map((fact) => `${fact.field}: ${fact.value}`),
    assumptions: support.assumptions,
    unknowns: support.unknowns,
  };
}

function allocationLabel(bucket: string) {
  return {
    production: "Produktion",
    distribution: "Distribution",
    experimentation: "Experiment & test",
    measurement: "Mätning",
    reserve: "Reserv",
  }[bucket] ?? bucket;
}

function sek(value: number) {
  return new Intl.NumberFormat("sv-SE", { style: "currency", currency: "SEK", maximumFractionDigits: 0 }).format(value);
}

function labelFor<K extends keyof BrandOnboardingDraft>(key: K, value: BrandOnboardingDraft[K]) {
  if (key === "operatingModel") return operatingModelLabels[value as BrandOnboardingDraft["operatingModel"]];
  if (key === "marketScope") return scopeLabels[value as BrandOnboardingDraft["marketScope"]];
  if (key === "demandEvidence") return demandLabels[value as BrandOnboardingDraft["demandEvidence"]];
  if (key === "competition") return competitionLabels[value as BrandOnboardingDraft["competition"]];
  if (key === "timing") return timingLabels[value as BrandOnboardingDraft["timing"]];
  if (key === "annualGoal") return goalLabels[value as BrandOnboardingDraft["annualGoal"]];
  if (key === "salesCycle") return salesCycleLabels[value as BrandOnboardingDraft["salesCycle"]];
  if (key === "teamCapacity") return capacityLabels[value as BrandOnboardingDraft["teamCapacity"]];
  return String(value);
}

function positiveSek(value: string) {
  const normalized = value.trim().replace(/\s/g, "").replace(",", ".");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed > 0;
}

export function isOnboardingStepComplete(step: OnboardingStepId, draft: BrandOnboardingDraft) {
  if (step === "brand") return Boolean(draft.brandName.trim().length >= 2 && draft.offer.trim() && draft.customerProblem.trim());
  if (step === "market") return draft.audience.trim().length >= 12 && draft.operatingModel !== "unknown";
  if (step === "goals") return draft.annualGoal !== "unknown"
    && draft.teamCapacity !== "unknown"
    && draft.goalDetail.trim().length >= 12
    && draft.measurementMetric.trim().length >= 2
    && draft.channels.length > 0;
  if (step === "plan") return draft.budgetStatus !== "unknown" && positiveSek(draft.annualBudgetSek);
  return false;
}

function idempotencyKey() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `brand-onboarding-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function SagaBrandOnboarding({
  apiPath = "/api/saga/brand-onboarding",
  adviceApiPath = "/api/saga/brand-onboarding/advice",
}: {
  apiPath?: string;
  adviceApiPath?: string;
}) {
  const [draft, setDraft] = useState<BrandOnboardingDraft>(EMPTY_BRAND_ONBOARDING_DRAFT);
  const [step, setStep] = useState<OnboardingStepId>("brand");
  const [apiStatus, setApiStatus] = useState<BrandOnboardingApiStatus>({ available: false, advisor: "unknown", message: null });
  const [statusState, setStatusState] = useState<"checking" | "ready">("checking");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [completedBrandId, setCompletedBrandId] = useState<string | null>(null);
  const [adviceState, setAdviceState] = useState<AdviceState>("idle");
  const [adviceMessage, setAdviceMessage] = useState<string | null>(null);
  const [advice, setAdvice] = useState<BrandOnboardingAdvice | null>(null);
  const [defaultOnCompletion, setDefaultOnCompletion] = useState(false);
  const [activationConfirmed, setActivationConfirmed] = useState(false);
  const [persistedDecisionSupport, setPersistedDecisionSupport] = useState<SagaBrandOnboardingDecisionSupport | null>(null);
  const submissionKey = useRef<string | null>(null);
  const scenario = useMemo(
    () => persistedDecisionSupport ? annualPlanScenarioFromDecisionSupport(persistedDecisionSupport) : annualPlanScenario(draft),
    [draft, persistedDecisionSupport],
  );
  const activeIndex = steps.findIndex((item) => item.id === step);
  const activeStep = steps[activeIndex];

  useEffect(() => {
    let current = true;
    void readBrandOnboardingStatus(apiPath).then((nextStatus) => {
      if (!current) return;
      setApiStatus(nextStatus);
      setStatusState("ready");
    });
    return () => { current = false; };
  }, [apiPath]);

  function update<K extends keyof BrandOnboardingDraft>(key: K, value: BrandOnboardingDraft[K]) {
    submissionKey.current = null;
    setSaveState("idle");
    setSaveMessage(null);
    setCompletedBrandId(null);
    setAdvice(null);
    setAdviceState("idle");
    setAdviceMessage(null);
    setPersistedDecisionSupport(null);
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function nextStep() {
    if (!isOnboardingStepComplete(step, draft)) {
      setSaveMessage("Fyll i de markerade besluten innan du går vidare. Det är bättre att lämna något som okänt än att gissa.");
      return;
    }
    const next = steps[activeIndex + 1];
    if (next) setStep(next.id);
  }

  function previousStep() {
    const previous = steps[activeIndex - 1];
    if (previous) setStep(previous.id);
  }

  function selectStep(next: OnboardingStepId) {
    const nextIndex = steps.findIndex((item) => item.id === next);
    if (nextIndex > activeIndex && !isOnboardingStepComplete(step, draft)) {
      setSaveMessage("Gör klart det pågående steget först, eller välj det som faktiskt är okänt.");
      return;
    }
    setStep(next);
  }

  async function persist(completionState: "in_progress" | "completed") {
    if (completionState === "completed" && !activationConfirmed) {
      setSaveState("error");
      setSaveMessage("Bekräfta att du vill göra varumärket tillgängligt i Studio. Kalender och automationer startas inte av detta.");
      return;
    }
    if (!apiStatus.available) {
      setSaveState("error");
      setSaveMessage(apiStatus.message || "Arbetsytan är inte tillgänglig. Inget har sparats.");
      return;
    }
    const key = submissionKey.current ?? idempotencyKey();
    submissionKey.current = key;
    setSaveState(completionState === "completed" ? "saving_complete" : "saving_draft");
    setSaveMessage(null);
    const result = await saveBrandOnboarding(draft, {
      completionState,
      makeDefaultOnCompletion: defaultOnCompletion,
      createIdempotencyKey: key,
      apiPath,
    });
    if (!result.ok) {
      setSaveState("error");
      setSaveMessage(result.message);
      return;
    }
    if (result.value.decisionSupport) setPersistedDecisionSupport(result.value.decisionSupport);
    setSaveState(completionState === "completed" ? "saved_complete" : "saved_draft");
    setCompletedBrandId(completionState === "completed" && result.value.completionState === "completed" ? result.value.brandId : null);
    setSaveMessage(completionState === "completed"
      ? `Varumärket${result.value.brandName ? ` ${result.value.brandName}` : ""} är sparat och tillgängligt i Studio. Inget har lagts i kalendern och ingen automation har aktiverats.`
      : "Onboardingen är sparad som pågående. Varumärket är inte aktiverat och planen har inte startat något flöde.");
  }

  async function askAdvisor() {
    if (!apiStatus.available || adviceState === "checking") return;
    setAdviceState("checking");
    setAdvice(null);
    setAdviceMessage(null);
    const result = await requestBrandOnboardingAdvice(draft, {
      completionState: "in_progress",
      makeDefaultOnCompletion: defaultOnCompletion,
      apiPath: adviceApiPath,
    });
    if (!result.ok) {
      setAdviceState("error");
      setAdviceMessage(result.message);
      return;
    }
    setAdviceState("ready");
    setAdvice(result.value);
  }

  const canSaveDraft = !brandOnboardingValidationMessage(draft, "in_progress", false)
    && apiStatus.available && saveState !== "saving_draft" && saveState !== "saving_complete";
  const canComplete = !brandOnboardingValidationMessage(draft, "completed", defaultOnCompletion);

  return (
    <section className={styles.onboarding} aria-labelledby="brand-onboarding-title">
      <header className={styles.header}>
        <div className={styles.headerCopy}>
          <Link href="/studio" className={styles.backLink}><ArrowIcon /> Studio</Link>
          <p className={styles.eyebrow}>NYTT VARUMÄRKE · ÅRSPLAN</p>
          <h1 id="brand-onboarding-title">Sätt riktning före innehåll, budget och automation.</h1>
          <p>Onboardingen gör ett varumärke användbart för SAGA. Du sätter underlaget, systemet räknar en försiktig årsplan och AI:n får endast ge råd när du ber om det.</p>
        </div>
        <WorkspaceState state={statusState} status={apiStatus} />
      </header>

      <div className={styles.boundary}>
        <span><ShieldIcon /> Ingen kalenderpost, automation eller extern publicering skapas här.</span>
        <span><DotIcon /> Underlaget stannar i formuläret tills du väljer att spara eller uttryckligen ber AI-rådgivaren om granskning.</span>
      </div>

      <div className={styles.layout}>
        <nav className={styles.steps} aria-label="Steg i varumärkesonboardingen">
          <ol>
            {steps.map((item, index) => {
              const current = item.id === step;
              const complete = isOnboardingStepComplete(item.id, draft);
              return <li key={item.id}>
                <button
                  type="button"
                  className={`${styles.stepButton} ${current ? styles.stepButtonCurrent : ""}`}
                  aria-current={current ? "step" : undefined}
                  onClick={() => selectStep(item.id)}
                >
                  <span className={complete ? styles.stepNumberComplete : styles.stepNumber}>{complete ? "✓" : item.number}</span>
                  <span><strong>{item.label}</strong><small>{item.detail}</small></span>
                  {index < activeIndex ? <b aria-hidden="true">›</b> : null}
                </button>
              </li>;
            })}
          </ol>
          <section className={styles.saveRail} aria-label="Sparstatus">
            <span className={styles.railLabel}>SPARSTATUS</span>
            <strong>{saveState === "saved_complete" ? "Tillgängligt i Studio" : saveState === "saved_draft" ? "Pågående onboarding" : "Inte sparat"}</strong>
            <p>{saveState === "saved_complete" ? "Planen är sparad. Flöden och kalender är fortfarande manuella beslut." : "Du kan lämna okända svar tomma. Vi låtsas inte att de är fakta."}</p>
          </section>
        </nav>

        <div className={styles.workbench}>
          <section className={styles.editor} aria-labelledby={`step-${step}`}>
            <div className={styles.editorTopline}>
              <span>{activeStep.number} / 05</span>
              <span>Planeringsunderlag</span>
            </div>
            {step === "brand" ? <BrandStep draft={draft} update={update} /> : null}
            {step === "market" ? <MarketStep draft={draft} update={update} /> : null}
            {step === "goals" ? <GoalsStep draft={draft} update={update} /> : null}
            {step === "plan" ? <PlanStep draft={draft} update={update} scenario={scenario} /> : null}
            {step === "review" ? <ReviewStep draft={draft} scenario={scenario} defaultOnCompletion={defaultOnCompletion} setDefaultOnCompletion={setDefaultOnCompletion} activationConfirmed={activationConfirmed} setActivationConfirmed={setActivationConfirmed} /> : null}

            {saveMessage ? <p className={saveState === "error" ? styles.errorNotice : styles.statusNotice} role={saveState === "error" ? "alert" : "status"}>{saveMessage}{saveState === "saved_complete" && completedBrandId ? <Link className={styles.statusAction} href={`/studio/plan?brand=${encodeURIComponent(completedBrandId)}`}>Planera nästa 13 veckor <span aria-hidden="true">→</span></Link> : null}</p> : null}

            <footer className={styles.editorFooter}>
              <div>
                {activeIndex > 0 ? <button type="button" className={styles.backButton} onClick={previousStep}>← Tillbaka</button> : null}
                {activeIndex < steps.length - 1 ? <button type="button" className={styles.nextButton} onClick={nextStep}>Fortsätt <span aria-hidden="true">→</span></button> : null}
              </div>
              {step !== "review" ? <button type="button" className={styles.saveDraftButton} disabled={!canSaveDraft} onClick={() => void persist("in_progress")}>{saveState === "saving_draft" ? "Sparar…" : "Spara som pågående"}</button> : null}
              {step === "review" ? <button type="button" className={styles.completeButton} disabled={!canComplete || !activationConfirmed || !apiStatus.available || saveState === "saving_complete"} onClick={() => void persist("completed")}>{saveState === "saving_complete" ? "Sparar…" : "Spara och gör tillgängligt i Studio"}</button> : null}
            </footer>
          </section>

          <aside className={styles.inspector} aria-label="Beslutsstöd och årsplan">
            <PlanInspector draft={draft} scenario={scenario} />
            <AdvisorPanel status={apiStatus} state={adviceState} message={adviceMessage} advice={advice} onAsk={askAdvisor} />
          </aside>
        </div>
      </div>
    </section>
  );
}

function BrandStep({ draft, update }: { draft: BrandOnboardingDraft; update: <K extends keyof BrandOnboardingDraft>(key: K, value: BrandOnboardingDraft[K]) => void }) {
  return <div className={styles.stepContent}>
    <p className={styles.stepEyebrow}>VARUMÄRKE & PRODUKT</p>
    <h2 id="step-brand">Vad ska bli lättare, bättre eller mer värdefullt för rätt person?</h2>
    <p className={styles.stepIntro}>Börja med produkten och problemet. En stark plan kan inte ersätta ett erbjudande som är oklart eller oviktigt.</p>
    <div className={styles.formGrid}>
      <TextField label="Varumärkesnamn" value={draft.brandName} required placeholder="Till exempel Nordkust Verkstad" onChange={(value) => update("brandName", value)} />
      <TextField label="Juridiskt bolag eller verksamhet" value={draft.organizationName} placeholder="Valfritt" onChange={(value) => update("organizationName", value)} />
      <TextField label="Webbplats" value={draft.website} hint="Används som referens, inte som automatisk faktakälla." placeholder="https://…" onChange={(value) => update("website", value)} />
      <TextField label="Erbjudandet" value={draft.offer} required placeholder="Vad köper eller väljer kunden?" onChange={(value) => update("offer", value)} />
      <SelectField label="Erbjudandets mognad" value={draft.productReadiness} options={productReadinessLabels} onChange={(value) => update("productReadiness", value as BrandOnboardingDraft["productReadiness"])} />
    </div>
    <TextAreaField label="Kundens problem eller situation" value={draft.customerProblem} required placeholder="Vad försöker personen lösa, undvika eller uppnå?" onChange={(value) => update("customerProblem", value)} />
    <TextAreaField label="Relevant skillnad" value={draft.difference} hint="Inte en slogan. Beskriv vad ni gör annorlunda eller bättre när det går att belägga." placeholder="Vad gör er rimligen värda att välja?" onChange={(value) => update("difference", value)} />
    <EvidenceCallout tone="input" title="Ditt underlag">SAGA använder bara det du skriver här som grund för den första varumärkesprofilen. Det blir inte ett påstående om marknaden förrän ni kan styrka det.</EvidenceCallout>
  </div>;
}

export function MarketStep({ draft, update }: { draft: BrandOnboardingDraft; update: <K extends keyof BrandOnboardingDraft>(key: K, value: BrandOnboardingDraft[K]) => void }) {
  return <div className={styles.stepContent}>
    <p className={styles.stepEyebrow}>MARKNAD & EFTERFRÅGAN</p>
    <h2 id="step-market">Vem ska uppskatta att ni tar deras tid?</h2>
    <p className={styles.stepIntro}>Räckvidd är bara värdefull när den möter människor för vilka erbjudandet kan vara relevant. Beskriv vad ni vet och markera resten som okänt.</p>
    <SelectField label="Arbetsmodell" value={draft.operatingModel} options={operatingModelLabels} required onChange={(value) => update("operatingModel", value as BrandOnboardingDraft["operatingModel"])} />
    <p className={styles.stepIntro}>Arbetsmodellen sparas som ett deklarerat underlag i beslutsstödet. Den ändrar inte automatiskt budget, innehåll, kalender eller andra åtgärder.</p>
    <TextAreaField label="Primär målgrupp" value={draft.audience} required hint="Minst en konkret mening. Beskriv situation, behov, var de finns och varför erbjudandet kan vara relevant." placeholder="Beskriv situation, behov, var de finns och varför erbjudandet kan vara relevant." onChange={(value) => update("audience", value)} />
    <div className={styles.formGrid}>
      <SelectField label="Marknadens omfattning" value={draft.marketScope} options={scopeLabels} onChange={(value) => update("marketScope", value as BrandOnboardingDraft["marketScope"])} />
      <SelectField label="Underlag om målgruppens storlek" value={draft.audienceSizeEvidence} options={audienceEvidenceLabels} onChange={(value) => update("audienceSizeEvidence", value as BrandOnboardingDraft["audienceSizeEvidence"])} />
      <SelectField label="Vad vet ni om efterfrågan?" value={draft.demandEvidence} options={demandLabels} onChange={(value) => update("demandEvidence", value as BrandOnboardingDraft["demandEvidence"])} />
      <SelectField label="Tidigare resultat" value={draft.historicalPerformance} options={historicalLabels} onChange={(value) => update("historicalPerformance", value as BrandOnboardingDraft["historicalPerformance"])} />
      <SelectField label="Konkurrensbild" value={draft.competition} options={competitionLabels} onChange={(value) => update("competition", value as BrandOnboardingDraft["competition"])} />
      <SelectField label="Stöd för konkurrensbedömningen" value={draft.competitiveContext} options={confidenceLabels} onChange={(value) => update("competitiveContext", value as BrandOnboardingDraft["competitiveContext"])} />
      <SelectField label="Timing" value={draft.timing} options={timingLabels} onChange={(value) => update("timing", value as BrandOnboardingDraft["timing"])} />
      <SelectField label="Stöd för timing" value={draft.timingConfidence} options={timingConfidenceLabels} onChange={(value) => update("timingConfidence", value as BrandOnboardingDraft["timingConfidence"])} />
    </div>
    <TextAreaField label="Timing, säsong eller händelser" value={draft.timingNote} hint="Exempel: semesterperiod, branschmässa, däckskifte, flytt, budgetfönster. Lämna tomt om det är okänt." placeholder="Vilka perioder spelar roll — och varför?" onChange={(value) => update("timingNote", value)} />
    {draft.timing === "seasonal" ? <div className={styles.formGrid}>
      <SelectField label="Säsongen börjar" value={draft.seasonStartMonth} options={monthOptions("Välj månad")} onChange={(value) => update("seasonStartMonth", value)} />
      <SelectField label="Säsongen slutar" value={draft.seasonEndMonth} options={monthOptions("Välj månad")} onChange={(value) => update("seasonEndMonth", value)} />
      <SelectField label="Säsongens betydelse" value={draft.seasonImportance} options={{ supporting: "Stödjande", primary: "Primär" }} onChange={(value) => update("seasonImportance", value as BrandOnboardingDraft["seasonImportance"])} />
    </div> : null}
    <EvidenceCallout tone="unknown" title="Behöver mätas">Målgruppens faktiska storlek, respons och kostnad kan inte utläsas av en beskrivning. Årsplanen reserverar därför tid och budget för att lära innan ni förstärker.</EvidenceCallout>
  </div>;
}

function GoalsStep({ draft, update }: { draft: BrandOnboardingDraft; update: <K extends keyof BrandOnboardingDraft>(key: K, value: BrandOnboardingDraft[K]) => void }) {
  return <div className={styles.stepContent}>
    <p className={styles.stepEyebrow}>MÅL & RAMAR</p>
    <h2 id="step-goals">Vilket beslut ska marknadsföringen hjälpa till att förtjäna?</h2>
    <p className={styles.stepIntro}>Målet hjälper planeringen att välja takt. Det är inte en prognos, och SAGA lovar aldrig räckvidd, ROAS eller försäljning innan underlaget finns.</p>
    <div className={styles.formGrid}>
      <SelectField label="Primärt mål för året" value={draft.annualGoal} options={goalLabels} onChange={(value) => update("annualGoal", value as BrandOnboardingDraft["annualGoal"])} required />
      <SelectField label="Kundens beslutscykel" value={draft.salesCycle} options={salesCycleLabels} onChange={(value) => update("salesCycle", value as BrandOnboardingDraft["salesCycle"])} />
      <SelectField label="Tillgänglig kapacitet" value={draft.teamCapacity} options={capacityLabels} onChange={(value) => update("teamCapacity", value as BrandOnboardingDraft["teamCapacity"])} required />
      <SelectField label="Mätning av nästa steg" value={draft.conversionMeasurement} options={conversionMeasurementLabels} onChange={(value) => update("conversionMeasurement", value as BrandOnboardingDraft["conversionMeasurement"])} />
    </div>
    <TextAreaField label="Vad ska vara annorlunda om tolv månader?" value={draft.goalDetail} required hint="Minst en konkret mening. Sätt inga siffror du inte kan följa upp." placeholder="Beskriv önskat läge eller beslut." onChange={(value) => update("goalDetail", value)} />
    <section className={styles.measurementPanel} aria-labelledby="measurement-title">
      <header><p>UPPFÖLJNING</p><h3 id="measurement-title">Vad kan ni faktiskt följa?</h3></header>
      <div className={styles.formGrid}>
        <TextField label="Mått" value={draft.measurementMetric} required placeholder="Till exempel kvalificerade förfrågningar" onChange={(value) => update("measurementMetric", value)} />
        <SelectField label="Enhet" value={draft.measurementUnit} options={measurementUnitLabels} onChange={(value) => update("measurementUnit", value as BrandOnboardingDraft["measurementUnit"])} />
        <TextField label="Baslinje" value={draft.measurementBaseline} inputMode="numeric" placeholder="Valfritt" onChange={(value) => update("measurementBaseline", value)} />
        <TextField label="Målnivå" value={draft.measurementTarget} inputMode="numeric" placeholder="Valfritt" onChange={(value) => update("measurementTarget", value)} />
        <SelectField label="Var kommer värdet ifrån?" value={draft.measurementProvenance} options={measurementProvenanceLabels} onChange={(value) => update("measurementProvenance", value as BrandOnboardingDraft["measurementProvenance"])} />
      </div>
      <p>Om baslinje eller målnivå saknas: välj <em>Inte känt ännu</em>. SAGA gör då ingen utfallsprognos.</p>
    </section>
    <ChannelPicker selected={draft.channels} onChange={(channels) => update("channels", channels)} />
    <TextField label="Notering om kanalval" value={draft.channelFocus} placeholder="Till exempel lokal räckvidd först, inga köpta kanaler före test" onChange={(value) => update("channelFocus", value)} />
    <TextAreaField label="Ramar som planen ska respektera" value={draft.constraints} hint="Exempel: juridik, säsong, teamets tid, godkännandeprocess, erbjudanden som inte får göras." placeholder="Vad får inte kompromissas bort?" onChange={(value) => update("constraints", value)} />
    <EvidenceCallout tone="assumption" title="Planeringsantagande">En plan med färre parallella initiativ är ofta rimligare än en bred kanalplan när teamets kapacitet eller efterfrågans bevisläge är osäkert.</EvidenceCallout>
  </div>;
}

function PlanStep({ draft, update, scenario }: { draft: BrandOnboardingDraft; update: <K extends keyof BrandOnboardingDraft>(key: K, value: BrandOnboardingDraft[K]) => void; scenario: AnnualPlanScenario }) {
  return <div className={styles.stepContent}>
    <p className={styles.stepEyebrow}>ÅRLIG AKTIVITETSPLAN</p>
    <h2 id="step-plan">Fördela en budget för att kunna lära, inte för att simulera visshet.</h2>
    <p className={styles.stepIntro}>Ange den totala budgeten för produktion, distribution och uppföljning. SAGA visar en enkel fördelning som du kan granska — inte en utfallsprognos.</p>
    <div className={styles.formGrid}>
      <TextField label="Planår" value={draft.planYear} required inputMode="numeric" placeholder="2026" onChange={(value) => update("planYear", value)} />
      <SelectField label="Budgetstatus" value={draft.budgetStatus} options={budgetStatusLabels} onChange={(value) => update("budgetStatus", value as BrandOnboardingDraft["budgetStatus"])} required />
      <SelectField label="Planeringsinriktning" value={draft.allocationIntent} options={allocationIntentLabels} onChange={(value) => update("allocationIntent", value as BrandOnboardingDraft["allocationIntent"])} />
    </div>
    <div className={styles.budgetInputRow}>
      <TextField label="Årsbudget" value={draft.annualBudgetSek} required inputMode="numeric" prefix="SEK" placeholder="Till exempel 240000" onChange={(value) => update("annualBudgetSek", value)} />
      <TextField label="Redan bundet" value={draft.fixedCommitmentsSek} inputMode="numeric" prefix="SEK" hint="Valfritt, men får inte överstiga årsbudgeten." placeholder="Till exempel 60000" onChange={(value) => update("fixedCommitmentsSek", value)} />
      <div className={styles.budgetContext}><span>Budgettyp</span><strong>Total marknadsbudget</strong><p>Inkluderar innehåll, distribution, mätning och reserv.</p></div>
    </div>
    <ActivityPlan draft={draft} update={update} />
    {scenario.available && scenario.budgetSek ? <section className={styles.planTable} aria-labelledby="budget-breakdown-title">
      <header><div><p>PLANERINGSFÖRDELNING</p><h3 id="budget-breakdown-title">{sek(scenario.allocatableSek)} att fördela</h3></div><span>Inte sparad</span></header>
      <ul>{scenario.allocations.map((allocation) => <li key={allocation.id}><div><strong>{allocation.label}</strong><small>{allocation.reason}</small></div><span>{signedPercent(allocation.share)}</span><b>{sek(allocation.amountSek)}</b></li>)}</ul>
    </section> : <EvidenceCallout tone="unknown" title="Underlag behövs">{scenario.validationMessage || "Lägg in en preliminär eller bekräftad årsbudget för att se en planeringsfördelning."}</EvidenceCallout>}
    {scenario.available ? <section className={styles.quarterPreview} aria-labelledby="quarter-preview-title">
      <div><p>ÅRSTAKT</p><h3 id="quarter-preview-title">Fyra beslutspunkter, inte fyra löften.</h3></div>
      <ol>{scenario.quarters.map((quarter) => <li key={quarter.quarter}><span>{quarter.quarter}</span><div><strong>{quarter.label}</strong><p>{quarter.intent}</p></div><b>{signedPercent(quarter.share)}</b></li>)}</ol>
    </section> : null}
  </div>;
}

function ActivityPlan({ draft, update }: { draft: BrandOnboardingDraft; update: <K extends keyof BrandOnboardingDraft>(key: K, value: BrandOnboardingDraft[K]) => void }) {
  return <section className={styles.activityPlan} aria-labelledby="activity-plan-title">
    <header><div><p>AKTIVITET & KONTROLL</p><h3 id="activity-plan-title">Välj en takt som någon faktiskt kan äga.</h3></div></header>
    <label className={styles.toggleLine}><input type="checkbox" checked={draft.alwaysOn} onChange={(event) => update("alwaysOn", event.target.checked)} /><span><strong>Jämn närvaro mellan kampanjperioder</strong><small>Avmarkera om all aktivitet ska koncentreras till valda perioder.</small></span></label>
    <div className={styles.formGrid}>
      <TextField label="Kampanjperioder per år" value={draft.campaignBurstsPerYear} inputMode="numeric" placeholder="4" onChange={(value) => update("campaignBurstsPerYear", value)} />
      <TextField label="Innehåll per månad" value={draft.contentPiecesPerMonth} inputMode="numeric" placeholder="4" onChange={(value) => update("contentPiecesPerMonth", value)} />
      <SelectField label="Beslutsrytm" value={draft.reviewCadence} options={{ monthly: "Månatlig genomgång", quarterly: "Kvartalsvis genomgång" }} onChange={(value) => update("reviewCadence", value as BrandOnboardingDraft["reviewCadence"])} />
    </div>
    <p>Detta styr bara planeringskadenser. Det skapar varken Cron-jobb, publiceringar eller annonser.</p>
  </section>;
}

function ChannelPicker({ selected, onChange }: { selected: BrandOnboardingDraft["channels"]; onChange: (channels: BrandOnboardingDraft["channels"]) => void }) {
  function toggle(channel: BrandOnboardingDraft["channels"][number], checked: boolean) {
    onChange(checked ? [...selected, channel] : selected.filter((item) => item !== channel));
  }
  return <fieldset className={styles.channelPicker}>
    <legend>Kanaler för årsplanen <b aria-label="Obligatoriskt">*</b></legend>
    <p>Välj bara kanaler som ni faktiskt vill bedöma. Det här kopplar inte något konto och startar ingen distribution.</p>
    <div>{channelOptions.map((channel) => <label key={channel.value}><input type="checkbox" checked={selected.includes(channel.value)} onChange={(event) => toggle(channel.value, event.target.checked)} /><span>{channel.label}</span></label>)}</div>
  </fieldset>;
}

function ReviewStep({ draft, scenario, defaultOnCompletion, setDefaultOnCompletion, activationConfirmed, setActivationConfirmed }: {
  draft: BrandOnboardingDraft;
  scenario: AnnualPlanScenario;
  defaultOnCompletion: boolean;
  setDefaultOnCompletion: (value: boolean) => void;
  activationConfirmed: boolean;
  setActivationConfirmed: (value: boolean) => void;
}) {
  const inputs = scenario.available ? scenario.facts : inputLedger(draft);
  return <div className={styles.stepContent}>
    <p className={styles.stepEyebrow}>GRANSKA & BESLUTA</p>
    <h2 id="step-review">Det här blir ett planeringsunderlag — inte en autopilot.</h2>
    <p className={styles.stepIntro}>Läs skillnaden mellan det du har sagt, det systemet har antagit och det som behöver mätas. Ändra innan du sparar om något är fel.</p>
    <EvidenceLedger title="Ditt underlag" tone="input" rows={inputs} empty="Inget underlag är ifyllt ännu." />
    <EvidenceLedger title="Planeringsantaganden" tone="assumption" rows={scenario.assumptions} empty={scenario.validationMessage || "Gör klart planunderlaget för att se serverns planeringsantaganden."} />
    <EvidenceLedger title="Behöver mätas" tone="unknown" rows={scenario.unknowns} empty="Inga tydliga luckor är identifierade. Kontrollera ändå en faktisk baslinje innan ni förstärker." />
    <div className={styles.confirmations}>
      <label><input type="checkbox" checked={defaultOnCompletion} onChange={(event) => setDefaultOnCompletion(event.target.checked)} /><span><strong>Gör detta till standardvarumärke</strong><small>Valfritt. Påverkar vilken varumärkesprofil Studio väljer först, men startar inget innehåll.</small></span></label>
      <label><input type="checkbox" checked={activationConfirmed} onChange={(event) => setActivationConfirmed(event.target.checked)} /><span><strong>Jag vill göra varumärket tillgängligt i Studio</strong><small>Årsplanen sparas. Kalender, extern publicering och automationer förblir avstängda tills jag väljer dem separat.</small></span></label>
    </div>
  </div>;
}

function PlanInspector({ draft, scenario }: { draft: BrandOnboardingDraft; scenario: AnnualPlanScenario }) {
  const known = inputLedger(draft).slice(0, 5);
  return <>
    <section className={styles.inspectorPlan} aria-labelledby="inspector-plan-title">
      <div className={styles.inspectorHeader}><div><p>ÅRSPLAN</p><h2 id="inspector-plan-title">{scenario.available && scenario.budgetSek ? sek(scenario.budgetSek) : "Underlag behövs"}</h2></div><span>{scenario.available ? "Preliminär" : "Inte beräknad"}</span></div>
      <p className={styles.inspectorIntro}>{scenario.available ? "En transparent fördelning från samma beräkning som sparas på servern." : scenario.validationMessage || "Fyll i planeringsunderlaget för att se en serverlik planeringsfördelning."}</p>
      {scenario.available ? <dl className={styles.allocationList}>{scenario.allocations.map((allocation) => <div key={allocation.id}><dt>{allocation.label}</dt><dd>{sek(allocation.amountSek)}</dd></div>)}</dl> : null}
      <ul className={styles.sourceLegend} aria-label="Kategorier i beslutsstödet">
        <li><span className={styles.inputMark} /><div><strong>Ditt underlag</strong><small>Det du själv har angett.</small></div></li>
        <li><span className={styles.assumptionMark} /><div><strong>Planeringsantaganden</strong><small>Synliga, regelstyrda fördelningar.</small></div></li>
        <li><span className={styles.unknownMark} /><div><strong>Behöver mätas</strong><small>Det systemet inte kan veta ännu.</small></div></li>
      </ul>
      <Link href="#step-plan" className={styles.inspectorLink}>Granska årsplanen <span aria-hidden="true">→</span></Link>
    </section>
    <section className={styles.evidenceSummary} aria-labelledby="evidence-summary-title">
      <p>SPÅRBARHET</p>
      <h2 id="evidence-summary-title">Vad planen bygger på.</h2>
      <ul>
        <li><span className={styles.inputMark} /> <strong>{scenario.available ? scenario.facts.length : known.length}</strong> uppgifter från dig</li>
        <li><span className={styles.assumptionMark} /> <strong>{scenario.assumptions.length}</strong> planeringsantaganden</li>
        <li><span className={styles.unknownMark} /> <strong>{scenario.unknowns.length}</strong> saker att mäta</li>
      </ul>
    </section>
  </>;
}

function AdvisorPanel({ status, state, message, advice, onAsk }: {
  status: BrandOnboardingApiStatus;
  state: AdviceState;
  message: string | null;
  advice: BrandOnboardingAdvice | null;
  onAsk: () => void;
}) {
  const unavailable = !status.available || status.advisor === "unavailable";
  return <section className={styles.advisor} aria-labelledby="advisor-title">
    <div className={styles.advisorHeader}><span><AdvisorIcon /></span><div><p>AI-RÅDGIVARE</p><h2 id="advisor-title">En extra granskning när du ber om den.</h2></div></div>
    <p>Rådgivaren kan förklara planens rimlighet och osäkerhet. Den kan inte spara, godkänna, lova utfall eller sätta igång ett flöde.</p>
    <button type="button" disabled={unavailable || state === "checking"} onClick={onAsk}>{state === "checking" ? "Granskar…" : unavailable ? "Rådgivaren är inte tillgänglig" : "Be rådgivaren granska planen"}</button>
    <p className={styles.advisorDisclosure}>När du väljer granskning skickas just detta planunderlag till den konfigurerade AI-modellen via Vercel AI Gateway. Svaret är tillfälligt, sparar inget och skapar ingen publicering.</p>
    {message ? <p className={styles.advisorError} role="status">{message}</p> : null}
    {advice ? <div className={styles.adviceResult}><strong>{advice.summary}</strong>{advice.considerations.length ? <ul>{advice.considerations.map((item, index) => <li key={`${item.label}-${index}`}><span className={item.kind === "assumption" ? styles.assumptionMark : styles.unknownMark} /><div><b>{item.label}</b><p>{item.detail}</p></div></li>)}</ul> : null}<small>Rådet är tillfälligt och ändrar inte planens sparade data.</small></div> : null}
  </section>;
}

function WorkspaceState({ state, status }: { state: "checking" | "ready"; status: BrandOnboardingApiStatus }) {
  if (state === "checking") return <div className={styles.workspaceState}><i /><span><strong>Kontrollerar arbetsyta</strong><small>Sparning öppnas först efter serverkontroll.</small></span></div>;
  if (!status.available) return <div className={`${styles.workspaceState} ${styles.workspaceStateAttention}`}><i /><span><strong>Arbetsytan är inte redo</strong><small>{status.message || "Du kan fylla i underlaget, men inget kan sparas."}</small></span></div>;
  return <div className={styles.workspaceState}><i /><span><strong>Arbetsyta tillgänglig</strong><small>Du väljer själv när du sparar eller aktiverar.</small></span></div>;
}

function EvidenceLedger({ title, tone, rows, empty }: { title: string; tone: "input" | "assumption" | "unknown"; rows: string[]; empty: string }) {
  return <section className={`${styles.ledger} ${styles[`ledger${capitalize(tone)}`]}`}>
    <header><span className={tone === "input" ? styles.inputMark : tone === "assumption" ? styles.assumptionMark : styles.unknownMark} /><h3>{title}</h3></header>
    {rows.length ? <ul>{rows.map((row, index) => <li key={`${row}-${index}`}>{row}</li>)}</ul> : <p>{empty}</p>}
  </section>;
}

function EvidenceCallout({ tone, title, children }: { tone: "input" | "assumption" | "unknown"; title: string; children: React.ReactNode }) {
  return <aside className={`${styles.callout} ${styles[`callout${capitalize(tone)}`]}`}><span className={tone === "input" ? styles.inputMark : tone === "assumption" ? styles.assumptionMark : styles.unknownMark} /><div><strong>{title}</strong><p>{children}</p></div></aside>;
}

function TextField({ label, value, onChange, required, placeholder, hint, prefix, inputMode = "text" }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  placeholder?: string;
  hint?: string;
  prefix?: string;
  inputMode?: "text" | "numeric" | "url";
}) {
  return <label className={styles.field}><span>{label}{required ? <b aria-label="Obligatoriskt">*</b> : null}</span><div className={prefix ? styles.inputWithPrefix : undefined}>{prefix ? <i>{prefix}</i> : null}<input value={value} required={required} inputMode={inputMode} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} /></div>{hint ? <small>{hint}</small> : null}</label>;
}

function TextAreaField({ label, value, onChange, required, placeholder, hint }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  placeholder?: string;
  hint?: string;
}) {
  return <label className={`${styles.field} ${styles.textareaField}`}><span>{label}{required ? <b aria-label="Obligatoriskt">*</b> : null}</span><textarea value={value} required={required} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />{hint ? <small>{hint}</small> : null}</label>;
}

function SelectField({ label, value, options, onChange, required }: { label: string; value: string; options: Record<string, string>; onChange: (value: string) => void; required?: boolean }) {
  return <label className={styles.field}><span>{label}{required ? <b aria-label="Obligatoriskt">*</b> : null}</span><select value={value} required={required} onChange={(event) => onChange(event.target.value)}>{Object.entries(options).map(([option, optionLabel]) => <option value={option} key={option}>{optionLabel}</option>)}</select></label>;
}

function monthOptions(placeholder: string): Record<string, string> {
  const names = ["Januari", "Februari", "Mars", "April", "Maj", "Juni", "Juli", "Augusti", "September", "Oktober", "November", "December"];
  return Object.fromEntries([["", placeholder], ...names.map((name, index) => [String(index + 1), name])]);
}

function inputLedger(draft: BrandOnboardingDraft) {
  const values = [
    draft.brandName ? `Varumärke: ${draft.brandName}` : "",
    draft.offer ? `Erbjudande: ${draft.offer}` : "",
    draft.customerProblem ? `Kundsituation: ${draft.customerProblem}` : "",
    draft.audience ? `Målgrupp: ${draft.audience}` : "",
    draft.operatingModel !== "unknown" ? `Arbetsmodell: ${labelFor("operatingModel", draft.operatingModel)}` : "",
    draft.marketScope !== "unknown" ? `Omfattning: ${labelFor("marketScope", draft.marketScope)}` : "",
    draft.demandEvidence !== "unknown" ? `Efterfrågan: ${labelFor("demandEvidence", draft.demandEvidence)}` : "",
    draft.annualGoal !== "unknown" ? `Årsmål: ${labelFor("annualGoal", draft.annualGoal)}` : "",
    positiveSek(draft.annualBudgetSek) ? `Årsbudget: ${draft.annualBudgetSek.trim()} SEK (${draft.budgetStatus})` : "",
  ];
  return values.filter(Boolean);
}

function capitalize(value: string) {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function ArrowIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m10.5 4.5-5 5 5 5M5.8 9.5h8.7" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" /></svg>; }
function ShieldIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.9 16 5v4.2c0 3.9-2.4 6.8-6 8-3.6-1.2-6-4.1-6-8V5l6-2.1Z" fill="none" stroke="currentColor" strokeLinejoin="round" /><path d="m7.3 10 1.7 1.7 3.8-4" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" /></svg>; }
function AdvisorIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.8 11.5 7 15.8 8.5 11.5 10 10 14.2 8.5 10 4.2 8.5 8.5 7 10 2.8ZM15.2 12.4l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7.7-1.9Z" fill="currentColor" /></svg>; }
function DotIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="3" fill="currentColor" /></svg>; }
