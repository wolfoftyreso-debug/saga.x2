"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { ContentEngineSourceKind } from "@/lib/domain/content-engine";
import type {
  SagaEditorialLens,
  SagaEditorialLensInput,
  SagaEditorialSourceSelection,
} from "@/lib/domain/saga-editorial-lens";
import styles from "@/components/saga-editorial-lens-workspace.module.css";

type LensLoadState = "loading" | "ready" | "unavailable";
type LensSaveState = "idle" | "saving" | "saved" | "error";

export type LensSourceOption = {
  id: string;
  name: string;
  sourceKind: ContentEngineSourceKind;
};

const sourceKindOptions: Array<{ id: ContentEngineSourceKind; label: string }> = [
  { id: "website", label: "Webbplats" },
  { id: "rss", label: "RSS" },
  { id: "document", label: "Dokument" },
  { id: "manual", label: "Eget underlag" },
  { id: "social_profile", label: "Social profil" },
];

type LensForm = {
  id: string | null;
  brandProfileId: string | null;
  sourceSelections: SagaEditorialSourceSelection[];
  name: string;
  mission: string;
  strategicPerspective: string;
  industry: string;
  audience: string;
  themes: string;
  forbiddenThemes: string;
  directness: number;
  warmth: number;
  formality: number;
  technicalDepth: number;
  pointOfView: "neutral" | "we" | "you";
  avoidJargon: boolean;
  preferredWords: string;
  avoidedWords: string;
  openingStyle: "direct" | "evidence_first" | "situation" | "question";
  paragraphStyle: "short" | "mixed" | "long";
  callToAction: "none" | "soft" | "direct";
  useHeadings: boolean;
  maxParagraphs: number;
  maxSentencesPerParagraph: number;
  includeSourceNotes: boolean;
  evidenceThreshold: "one_allowed_source" | "one_primary_or_two_independent" | "two_independent_sources" | "primary_source_required";
  requireAllowedSources: boolean;
  requireCitations: boolean;
  minimumUniqueSources: number;
  allowedSourceKinds: ContentEngineSourceKind[];
  blockedDomains: string;
  allowUnsupportedInference: boolean;
  controlMode: "advisory" | "review_required" | "strict";
  active: boolean;
};

const defaultForm: LensForm = {
  id: null,
  brandProfileId: null,
  sourceSelections: [],
  name: "SAGA Editorial Lens",
  mission: "",
  strategicPerspective: "",
  industry: "",
  audience: "",
  themes: "",
  forbiddenThemes: "",
  directness: 4,
  warmth: 3,
  formality: 2,
  technicalDepth: 3,
  pointOfView: "neutral",
  avoidJargon: true,
  preferredWords: "",
  avoidedWords: "",
  openingStyle: "direct",
  paragraphStyle: "short",
  callToAction: "soft",
  useHeadings: true,
  maxParagraphs: 5,
  maxSentencesPerParagraph: 3,
  includeSourceNotes: true,
  evidenceThreshold: "one_primary_or_two_independent",
  requireAllowedSources: true,
  requireCitations: true,
  minimumUniqueSources: 2,
  allowedSourceKinds: ["website", "rss", "document", "manual"],
  blockedDomains: "",
  allowUnsupportedInference: false,
  controlMode: "review_required",
  active: true,
};

/** Pure, exported mapping so the editable doctrine has a regression boundary. */
export function editorialLensForm(lens: SagaEditorialLens | null): LensForm {
  if (!lens) return { ...defaultForm };
  return {
    id: lens.id,
    brandProfileId: lens.brandProfileId,
    // The Lens picker edits only actor-scoped source assignments and must never
    // silently remove assignments that were saved earlier.
    sourceSelections: lens.sourceSelections.map((selection) => ({ ...selection })),
    name: lens.name,
    mission: lens.mission,
    strategicPerspective: lens.strategicPerspective,
    industry: lens.industry,
    audience: lens.audience,
    themes: lens.themes.join(", "),
    forbiddenThemes: lens.forbiddenThemes.join(", "),
    directness: lens.tone.directness,
    warmth: lens.tone.warmth,
    formality: lens.tone.formality,
    technicalDepth: lens.tone.technicalDepth,
    pointOfView: lens.tone.pointOfView,
    avoidJargon: lens.tone.avoidJargon,
    preferredWords: lens.tone.preferredWords.join(", "),
    avoidedWords: lens.tone.avoidedWords.join(", "),
    openingStyle: lens.construction.openingStyle,
    paragraphStyle: lens.construction.paragraphStyle,
    callToAction: lens.construction.callToAction,
    useHeadings: lens.construction.useHeadings,
    maxParagraphs: lens.construction.maxParagraphs,
    maxSentencesPerParagraph: lens.construction.maxSentencesPerParagraph,
    includeSourceNotes: lens.construction.includeSourceNotes,
    evidenceThreshold: lens.evidenceThreshold,
    requireAllowedSources: lens.sourceRules.requireAllowedSources,
    requireCitations: lens.sourceRules.requireCitations,
    minimumUniqueSources: lens.sourceRules.minimumUniqueSources,
    allowedSourceKinds: [...lens.sourceRules.allowedSourceKinds],
    blockedDomains: lens.sourceRules.blockedDomains.join("\n"),
    allowUnsupportedInference: lens.sourceRules.allowUnsupportedInference,
    controlMode: lens.controlMode,
    active: lens.active,
  };
}

export function editorialLensInput(form: LensForm): SagaEditorialLensInput {
  const themes = list(form.themes);
  const forbiddenThemes = list(form.forbiddenThemes);
  return {
    brandProfileId: form.brandProfileId,
    name: form.name.trim() || defaultForm.name,
    mission: form.mission.trim(),
    strategicPerspective: form.strategicPerspective.trim(),
    industry: form.industry.trim(),
    audience: form.audience.trim(),
    themes,
    forbiddenThemes,
    tone: {
      directness: form.directness,
      warmth: form.warmth,
      formality: form.formality,
      technicalDepth: form.technicalDepth,
      pointOfView: form.pointOfView,
      avoidJargon: form.avoidJargon,
      preferredWords: list(form.preferredWords),
      avoidedWords: list(form.avoidedWords),
    },
    construction: {
      openingStyle: form.openingStyle,
      paragraphStyle: form.paragraphStyle,
      callToAction: form.callToAction,
      useHeadings: form.useHeadings,
      maxParagraphs: form.maxParagraphs,
      maxSentencesPerParagraph: form.maxSentencesPerParagraph,
      includeSourceNotes: form.includeSourceNotes,
    },
    evidenceThreshold: form.evidenceThreshold,
    sourceRules: {
      requireAllowedSources: form.requireAllowedSources,
      requireCitations: form.requireCitations,
      minimumUniqueSources: form.minimumUniqueSources,
      allowedSourceKinds: form.allowedSourceKinds,
      blockedDomains: list(form.blockedDomains),
      allowUnsupportedInference: form.allowUnsupportedInference,
    },
    // The Lens picker can only select actor-scoped Content Engine source IDs.
    // Preserve saved assignments rather than inventing or clearing IDs.
    sourceSelections: form.sourceSelections,
    controlMode: form.controlMode,
    active: form.active,
  };
}

export function SagaEditorialLensWorkspace({ brandProfileId }: { brandProfileId?: string } = {}) {
  const lensApiPath = `/api/content-engine/editorial-lens${brandProfileId ? `?brandProfileId=${encodeURIComponent(brandProfileId)}` : ""}`;
  const [state, setState] = useState<LensLoadState>("loading");
  const [sourceState, setSourceState] = useState<LensLoadState>("loading");
  const [sourceOptions, setSourceOptions] = useState<LensSourceOption[]>([]);
  const [sourceMessage, setSourceMessage] = useState<string | null>(null);
  const [form, setForm] = useState<LensForm>(() => ({ ...defaultForm }));
  const [message, setMessage] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<LensSaveState>("idle");

  const lensSummary = useMemo(() => lensSummaryFromForm(form), [form]);
  const unavailableLensSourceCount = sourceState === "ready"
    ? form.sourceSelections.filter((selection) => !sourceOptions.some((source) => source.id === selection.sourceId && form.allowedSourceKinds.includes(source.sourceKind))).length
    : 0;
  const canAddLensSource = form.sourceSelections.length < 50;
  const selectableSourceOptions = sourceOptions.filter((source) => form.allowedSourceKinds.includes(source.sourceKind));

  async function load(signal?: AbortSignal) {
    setState("loading");
    setSourceState("loading");
    setSourceMessage(null);
    setMessage(null);
    try {
      const [response, sourceResponse] = await Promise.all([
        fetch(lensApiPath, { credentials: "same-origin", cache: "no-store", signal }),
        fetch("/api/content-engine", { credentials: "same-origin", cache: "no-store", signal }),
      ]);
      const [payload, sourcePayload] = await Promise.all([
        response.json().catch(() => null),
        sourceResponse.json().catch(() => null),
      ]);
      if (!response.ok) {
        setState("unavailable");
        setMessage(productFailureMessage(response.status, "Din redaktionella riktning kan inte läsas just nu."));
        return;
      }
      const lens = lensFromPayload(payload);
      setForm({ ...editorialLensForm(lens), brandProfileId: brandProfileId ?? lens?.brandProfileId ?? null });
      setState("ready");
      setMessage(lens
        ? lens.active
          ? "Din redaktionella riktning är aktiv och följer med varje AI-labbkörning."
          : "Din Lens är sparad men vilande. Aktivera den innan AI-labbet ska använda riktningen."
        : "Sätt riktningen en gång. SAGA använder den sedan i varje AI-labbkörning.");

      if (!sourceResponse.ok) {
        setSourceOptions([]);
        setSourceState("unavailable");
        setSourceMessage(productFailureMessage(sourceResponse.status, "Källistan kan inte läsas just nu. Befintliga Lens-urval bevaras oförändrade."));
        return;
      }
      setSourceOptions(lensSourceOptionsFromPayload(sourcePayload));
      setSourceState("ready");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setState("unavailable");
      setSourceState("unavailable");
      setSourceOptions([]);
      setSourceMessage("Källistan kan inte nås just nu. Befintliga Lens-urval bevaras oförändrade.");
      setMessage("Din redaktionella riktning kan inte nås just nu.");
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(() => load(controller.signal));
    return () => controller.abort();
    // The endpoint is fixed and the request controls its own lifecycle.
  }, []);

  function set<K extends keyof LensForm>(key: K, value: LensForm[K]) {
    setForm((current) => ({ ...current, [key]: value }));
    if (saveState === "saved") setSaveState("idle");
  }

  function toggleSourceKind(kind: ContentEngineSourceKind) {
    setForm((current) => {
      const selected = current.allowedSourceKinds.includes(kind);
      if (selected && current.allowedSourceKinds.length === 1) return current;
      return {
        ...current,
        allowedSourceKinds: selected
          ? current.allowedSourceKinds.filter((candidate) => candidate !== kind)
          : [...current.allowedSourceKinds, kind],
      };
    });
    if (saveState === "saved") setSaveState("idle");
  }

  function addSource(sourceId: string) {
    set("sourceSelections", addLensSourceSelection(form.sourceSelections, sourceId));
  }

  function removeSource(sourceId: string) {
    set("sourceSelections", removeLensSourceSelection(form.sourceSelections, sourceId));
  }

  function setSourceRole(sourceId: string, role: SagaEditorialSourceSelection["role"]) {
    set("sourceSelections", setLensSourceSelectionRole(form.sourceSelections, sourceId, role));
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state !== "ready") return;
    if (!form.mission.trim() || !form.strategicPerspective.trim()) {
      setSaveState("error");
      setMessage("Skriv både mission och strategiskt perspektiv innan du sparar Lens.");
      return;
    }
    if (!form.allowedSourceKinds.length) {
      setSaveState("error");
      setMessage("Välj minst en tillåten källtyp innan du sparar Lens.");
      return;
    }
    setSaveState("saving");
    setMessage(null);
    try {
      const response = await fetch(lensApiPath, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(editorialLensInput(form)),
      });
      const payload: unknown = await response.json().catch(() => null);
      const saved = lensFromPayload(payload);
      if (!response.ok || !saved) {
        setSaveState("error");
        setMessage(productFailureMessage(response.status, "SAGA kunde inte spara den redaktionella riktningen."));
        return;
      }
      setForm(editorialLensForm(saved));
      setSaveState("saved");
      setMessage("Editorial Lens är sparad. Nästa AI-labbkörning använder den här riktningen.");
    } catch {
      setSaveState("error");
      setMessage("SAGA kunde inte nå arbetsytan. Riktningen är inte bekräftat sparad.");
    }
  }

  async function reset() {
    if (!form.id || state !== "ready" || !window.confirm("Återställ Editorial Lens? Den sparade redaktionella riktningen tas bort.")) return;
    setSaveState("saving");
    setMessage(null);
    try {
      const response = await fetch(lensApiPath, { method: "DELETE", credentials: "same-origin" });
      if (!response.ok) {
        setSaveState("error");
        setMessage(productFailureMessage(response.status, "Editorial Lens kunde inte återställas."));
        return;
      }
      setForm({ ...defaultForm });
      setSaveState("idle");
      setMessage("Den sparade Lens är borttagen. Inget AI-flöde har publicerats eller ändrats.");
    } catch {
      setSaveState("error");
      setMessage("SAGA kunde inte nå arbetsytan. Lens är inte bekräftat återställd.");
    }
  }

  return (
    <section className={styles.workspace} aria-labelledby="lens-title">
      <header className={styles.header}>
        <Link href="/studio" className={styles.back}>← Studio</Link>
        <div className={styles.heading}>
          <div>
            <p className={styles.eyebrow}>SAGA / EDITORIAL LENS</p>
            <h1 id="lens-title">Gör SAGA till er redaktion — inte bara en skrivmotor.</h1>
            <p>Här sätter ni den mänskliga riktningen. Missionen, perspektivet och evidenskraven följer sedan med när SAGA jämför AI-utkast.</p>
          </div>
          <aside className={styles.doctrine} aria-label="SAGA:s redaktionella princip">
            <span aria-hidden="true">✦</span>
            <strong>Signal → vår tanke → förtroende</strong>
            <p>Inget polemiskt brus. Inga svaga påståenden. Alltid ett konstruktivt nästa steg.</p>
          </aside>
        </div>
      </header>

      {state === "loading" && <section className={styles.notice} aria-live="polite"><strong>Hämtar Editorial Lens…</strong><p>Vi läser bara sparad riktning från din egen arbetsyta.</p></section>}
      {state === "unavailable" && <section className={`${styles.notice} ${styles.noticeError}`} role="alert"><strong>Lens kan inte öppnas ännu</strong><p>{message || "Din arbetsyta kan inte bekräfta den här redaktionella riktningen."}</p><div><button type="button" onClick={() => void load()}>Försök igen</button><Link href="/studio">Till Studio</Link></div></section>}

      {state === "ready" && <form className={styles.form} onSubmit={save}>
        <div className={styles.summary}>
          <div><span>MISSION</span><strong>{lensSummary.mission}</strong></div>
          <div><span>RÖST</span><strong>{lensSummary.tone}</strong></div>
          <div><span>KONTROLL</span><strong>{lensSummary.control}</strong></div>
          <div><span>EVIDENS</span><strong>{lensSummary.evidence}</strong></div>
        </div>

        <div className={styles.columns}>
          <div className={styles.primaryColumn}>
            <LensSection number="01" title="Vår tanke" description="Det här är ramen som gör att samma nyhet får ett eget, relevant perspektiv för just er verksamhet.">
              <label className={styles.field}><span>Namn på Lens</span><input value={form.name} onChange={(event) => set("name", event.target.value)} maxLength={160} /></label>
              <label className={styles.field}><span>Vår mission</span><textarea value={form.mission} onChange={(event) => set("mission", event.target.value)} rows={4} required placeholder="Vilken nytta ska människor få av att vi finns?" /><small>Detta är inte en slogan. Skriv vilken friktion ni minskar eller vilket värde ni bygger.</small></label>
              <label className={styles.field}><span>Vårt strategiska perspektiv</span><textarea value={form.strategicPerspective} onChange={(event) => set("strategicPerspective", event.target.value)} rows={4} required placeholder="Hur tolkar ni förändring i branschen på ett konstruktivt sätt?" /><small>SAGA använder detta för ”our take”, aldrig för att hitta på ett ställningstagande.</small></label>
              <div className={styles.twoColumns}>
                <label className={styles.field}><span>Bransch</span><input value={form.industry} onChange={(event) => set("industry", event.target.value)} placeholder="Till exempel lokal bilservice" /></label>
                <label className={styles.field}><span>Vem skriver ni för?</span><input value={form.audience} onChange={(event) => set("audience", event.target.value)} placeholder="Till exempel bilägare i Västsverige" /></label>
              </div>
              <div className={styles.twoColumns}>
                <label className={styles.field}><span>Teman vi vill driva</span><textarea value={form.themes} onChange={(event) => set("themes", event.target.value)} rows={3} placeholder="Trygg service, enklare vardag, hållbara val" /><small>Separera med kommatecken.</small></label>
                <label className={styles.field}><span>Teman vi aldrig driver</span><textarea value={form.forbiddenThemes} onChange={(event) => set("forbiddenThemes", event.target.value)} rows={3} placeholder="Skrämsel, konflikter, spekulation" /><small>Separera med kommatecken.</small></label>
              </div>
            </LensSection>

            <LensSection number="02" title="Röst och form" description="Sätt en tydlig editorial-grade grund. SAGA skriver inte som en specifik verklig person — den översätter era val till skrivdrag.">
              <div className={styles.sliders}>
                <RangeField label="Rakhet" value={form.directness} onChange={(value) => set("directness", value)} low="Varsam" high="Direkt" />
                <RangeField label="Värme" value={form.warmth} onChange={(value) => set("warmth", value)} low="Saklig" high="Varm" />
                <RangeField label="Formalitet" value={form.formality} onChange={(value) => set("formality", value)} low="Nära" high="Formell" />
                <RangeField label="Sakdjup" value={form.technicalDepth} onChange={(value) => set("technicalDepth", value)} low="Enkelt" high="Fördjupat" />
              </div>
              <div className={styles.twoColumns}>
                <label className={styles.field}><span>Perspektiv</span><select value={form.pointOfView} onChange={(event) => set("pointOfView", event.target.value as LensForm["pointOfView"])}><option value="neutral">Neutralt</option><option value="we">Vi</option><option value="you">Du</option></select></label>
                <label className={styles.check}><input type="checkbox" checked={form.avoidJargon} onChange={(event) => set("avoidJargon", event.target.checked)} /><span><strong>Undvik jargong</strong><small>Förklara hellre än att imponera.</small></span></label>
              </div>
              <div className={styles.twoColumns}>
                <label className={styles.field}><span>Ord vi gärna använder</span><input value={form.preferredWords} onChange={(event) => set("preferredWords", event.target.value)} placeholder="trygg, konkret, nästa steg" /></label>
                <label className={styles.field}><span>Ord vi undviker</span><input value={form.avoidedWords} onChange={(event) => set("avoidedWords", event.target.value)} placeholder="revolutionerande, billigast" /></label>
              </div>
              <div className={styles.threeColumns}>
                <label className={styles.field}><span>Öppning</span><select value={form.openingStyle} onChange={(event) => set("openingStyle", event.target.value as LensForm["openingStyle"])}><option value="direct">Direkt poäng</option><option value="evidence_first">Fakta först</option><option value="situation">Situation</option><option value="question">Fråga</option></select></label>
                <label className={styles.field}><span>Stycken</span><select value={form.paragraphStyle} onChange={(event) => set("paragraphStyle", event.target.value as LensForm["paragraphStyle"])}><option value="short">Korta</option><option value="mixed">Blandade</option><option value="long">Längre</option></select></label>
                <label className={styles.field}><span>Call-to-action</span><select value={form.callToAction} onChange={(event) => set("callToAction", event.target.value as LensForm["callToAction"])}><option value="none">Ingen</option><option value="soft">Mjuk</option><option value="direct">Tydlig</option></select></label>
              </div>
            </LensSection>
          </div>

          <aside className={styles.sideColumn}>
            <LensSection number="03" title="Evidens och kontroll" description="SAGA får gärna vara snabb. Den får aldrig låtsas veta mer än underlaget visar.">
              <label className={styles.field}><span>Bekräftelse innan ett ämne kvalar in</span><select value={form.evidenceThreshold} onChange={(event) => set("evidenceThreshold", event.target.value as LensForm["evidenceThreshold"])}><option value="one_allowed_source">En godkänd källa</option><option value="one_primary_or_two_independent">Primärkälla eller två oberoende</option><option value="two_independent_sources">Två oberoende källor</option><option value="primary_source_required">Primärkälla krävs</option></select></label>
              <RangeField label="Minst så många unika källor" value={form.minimumUniqueSources} onChange={(value) => set("minimumUniqueSources", value)} low="1" high="5" min={1} max={5} />
              <label className={styles.check}><input type="checkbox" checked={form.requireAllowedSources} onChange={(event) => set("requireAllowedSources", event.target.checked)} /><span><strong>Endast godkända källor</strong><small>Underlag utanför urvalet ska inte bli fakta.</small></span></label>
              <label className={styles.check}><input type="checkbox" checked={form.requireCitations} onChange={(event) => set("requireCitations", event.target.checked)} /><span><strong>Kräv tydligt underlag</strong><small>SAGA ber AI-utkastet att hålla påståenden nära det valda underlaget.</small></span></label>
              <label className={styles.check}><input type="checkbox" checked={form.allowUnsupportedInference} onChange={(event) => set("allowUnsupportedInference", event.target.checked)} /><span><strong>Tillåt försiktig hypotes</strong><small>Endast som tydligt markerad tolkning, aldrig som faktapåstående.</small></span></label>
              <label className={styles.field}><span>Kontrollnivå</span><select value={form.controlMode} onChange={(event) => set("controlMode", event.target.value as LensForm["controlMode"])}><option value="advisory">Rådgivande — märk osäkerhet</option><option value="review_required">Granskning krävs</option><option value="strict">Strikt — källor och granskning</option></select></label>
              <label className={styles.check}><input type="checkbox" checked={form.active} onChange={(event) => set("active", event.target.checked)} /><span><strong>Aktivera denna Lens</strong><small>Endast en aktiv Lens begränsar AI-labbets källor och ger dess redaktionella riktning.</small></span></label>

              <div className={styles.sourceRuleControls}>
                <strong>Tillåtna källtyper</strong>
                <div className={styles.sourceKindList} role="group" aria-label="Tillåtna källtyper">
                  {sourceKindOptions.map((kind) => {
                    const selected = form.allowedSourceKinds.includes(kind.id);
                    return <label key={kind.id} className={styles.sourceKind}><input type="checkbox" checked={selected} disabled={selected && form.allowedSourceKinds.length === 1} onChange={() => toggleSourceKind(kind.id)} />{kind.label}</label>;
                  })}
                </div>
                <small>Minst en källtyp måste vara tillåten.</small>
              </div>
              <label className={styles.field}><span>Domäner som inte får användas</span><textarea value={form.blockedDomains} onChange={(event) => set("blockedDomains", event.target.value)} rows={2} placeholder="exempel.se\nannan-domän.se" /><small>En domän per rad. Skriv utan https:// eller sökväg.</small></label>

              <div className={styles.sourceBridge}>
                <strong>Lens-källurval</strong>
                <p>Välj vilka av receptets redan tillåtna faktakällor som Lens får begränsa AI-labbet till. Ett tomt urval låter receptets källor styra precis som vanligt.</p>
                {sourceState === "loading" && <p className={styles.sourcePickerStatus}>Hämtar dina säkra källnamn…</p>}
                {sourceState === "unavailable" && <p className={styles.sourcePickerStatus}>{sourceMessage}</p>}
                {sourceState === "ready" && <div className={styles.sourcePicker}>
                  {!selectableSourceOptions.length && <p className={styles.sourcePickerStatus}>Inga aktiva, godkända faktakällor matchar de tillåtna källtyperna ännu.</p>}
                  {selectableSourceOptions.map((source) => {
                    const selection = form.sourceSelections.find((candidate) => candidate.sourceId === source.id) ?? null;
                    return <div key={source.id} className={styles.sourcePickerRow}>
                      <span><strong>{source.name}</strong><small>{sourceKindLabel(source.sourceKind)}</small></span>
                      {selection ? <span className={styles.sourcePickerControls}>
                        <select aria-label={`Roll för ${source.name}`} value={selection.role} onChange={(event) => setSourceRole(source.id, event.target.value as SagaEditorialSourceSelection["role"])}><option value="required">Krävs</option><option value="preferred">Föredras</option></select>
                        <button type="button" onClick={() => removeSource(source.id)}>Ta bort</button>
                      </span> : <button type="button" onClick={() => addSource(source.id)} disabled={!canAddLensSource}>Ta med</button>}
                    </div>;
                  })}
                  {form.sourceSelections.filter((selection) => !selectableSourceOptions.some((source) => source.id === selection.sourceId)).map((selection) => {
                    const source = sourceOptions.find((candidate) => candidate.id === selection.sourceId);
                    return <div key={selection.sourceId} className={styles.sourcePickerRow}>
                      <span><strong>{source?.name || "Sparad källa"}</strong><small>{source ? "Inte tillåten av aktuell källtypsregel" : "Inte längre aktiv eller godkänd"}</small></span>
                      <button type="button" onClick={() => removeSource(selection.sourceId)}>Ta bort</button>
                    </div>;
                  })}
                  {unavailableLensSourceCount > 0 && <p className={styles.sourcePickerStatus}>{unavailableLensSourceCount} sparad Lens-källa är inte längre aktiv, godkänd eller tillåten av din aktuella källtypsregel. Ta bort den eller ändra regeln innan du sparar.</p>}
                  {!canAddLensSource && <p className={styles.sourcePickerStatus}>Lens kan ha högst 50 valda källor.</p>}
                </div>}
                <Link href="/studio/engine#engine-voice">Hantera faktakällor →</Link>
              </div>
            </LensSection>

            <div className={styles.safetyCard}><span aria-hidden="true">✓</span><div><strong>Alltid mänsklig kontroll</strong><p>Lens styr riktningen för AI-utkast. Den ersätter inte faktagranskning och den publicerar, mejlar eller schemalägger aldrig något på egen hand.</p></div></div>
          </aside>
        </div>

        {message && <div className={`${styles.message} ${saveState === "error" ? styles.messageError : ""}`} role={saveState === "error" ? "alert" : "status"}>{message}</div>}
        <footer className={styles.actions}>
          <div><span className={styles.liveDot} data-active={form.active} />{form.id ? form.active ? "Sparad och aktiv Lens" : "Sparad men vilande Lens" : "Inte sparad ännu"}</div>
          <div><button type="button" className={styles.secondary} onClick={() => void reset()} disabled={!form.id || saveState === "saving"}>Återställ Lens</button><button type="submit" className={styles.primary} disabled={saveState === "saving"}>{saveState === "saving" ? "Sparar…" : "Spara Editorial Lens"}</button></div>
        </footer>
      </form>}
    </section>
  );
}

function LensSection({ number, title, description, children }: { number: string; title: string; description: string; children: React.ReactNode }) {
  return <section className={styles.section}><header><span>{number}</span><div><h2>{title}</h2><p>{description}</p></div></header><div className={styles.sectionBody}>{children}</div></section>;
}

function RangeField({ label, value, onChange, low, high, min = 1, max = 5 }: { label: string; value: number; onChange: (value: number) => void; low: string; high: string; min?: number; max?: number }) {
  return <label className={styles.range}><span><strong>{label}</strong><output>{value}</output></span><input type="range" min={min} max={max} value={value} onChange={(event) => onChange(Number(event.target.value))} /><small><i>{low}</i><i>{high}</i></small></label>;
}

function list(value: string): string[] {
  return Array.from(new Set(value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean)));
}

/** Pure source-picker transitions: no source metadata or credentials enter Lens state. */
export function addLensSourceSelection(
  selections: readonly SagaEditorialSourceSelection[],
  sourceId: string,
): SagaEditorialSourceSelection[] {
  if (selections.some((selection) => selection.sourceId === sourceId) || selections.length >= 50) {
    return normalizeLensSourceSelections(selections);
  }
  return normalizeLensSourceSelections([...selections, { sourceId, role: "preferred", priority: Number.MAX_SAFE_INTEGER }]);
}

export function removeLensSourceSelection(
  selections: readonly SagaEditorialSourceSelection[],
  sourceId: string,
): SagaEditorialSourceSelection[] {
  return normalizeLensSourceSelections(selections.filter((selection) => selection.sourceId !== sourceId));
}

export function setLensSourceSelectionRole(
  selections: readonly SagaEditorialSourceSelection[],
  sourceId: string,
  role: SagaEditorialSourceSelection["role"],
): SagaEditorialSourceSelection[] {
  return normalizeLensSourceSelections(selections.map((selection) => selection.sourceId === sourceId ? { ...selection, role } : { ...selection }));
}

function normalizeLensSourceSelections(selections: readonly SagaEditorialSourceSelection[]): SagaEditorialSourceSelection[] {
  return selections
    .map((selection) => ({ ...selection }))
    .sort((left, right) => left.priority - right.priority || left.sourceId.localeCompare(right.sourceId))
    .map((selection, index) => ({ ...selection, priority: index + 1 }));
}

/** Extract only the actor-scoped source fields needed by the Lens picker. */
export function lensSourceOptionsFromPayload(value: unknown): LensSourceOption[] {
  const record = asRecord(value);
  const data = record ? (asRecord(record.data) ?? record) : null;
  const sources = data && Array.isArray(data.sources) ? data.sources : [];
  return sources.flatMap((candidate) => {
    const source = asRecord(candidate);
    const id = source && typeof source.id === "string" ? source.id.trim() : "";
    const name = source && typeof source.name === "string" ? source.name.trim() : "";
    const sourceKind = source && typeof source.sourceKind === "string" ? source.sourceKind : "";
    if (!id || !name || !isContentEngineSourceKind(sourceKind) || source?.active !== true || source?.isAllowed !== true) return [];
    return [{ id, name, sourceKind }];
  });
}

function isContentEngineSourceKind(value: string): value is ContentEngineSourceKind {
  return sourceKindOptions.some((option) => option.id === value);
}

function sourceKindLabel(value: ContentEngineSourceKind): string {
  return sourceKindOptions.find((option) => option.id === value)?.label ?? value;
}

function lensSummaryFromForm(form: LensForm) {
  return {
    mission: form.mission.trim() || "Sätt mission",
    tone: `${form.directness}/5 direkt · ${form.warmth}/5 varm`,
    control: form.controlMode === "strict" ? "Strikt" : form.controlMode === "review_required" ? "Granska alltid" : "Rådgivande",
    evidence: form.evidenceThreshold === "primary_source_required" ? "Primärkälla" : `${form.minimumUniqueSources}+ källor`,
  };
}

function lensFromPayload(value: unknown): SagaEditorialLens | null {
  const record = asRecord(value);
  const data = record ? asRecord(record.data) : null;
  return data && typeof data.id === "string" && typeof data.mission === "string" ? data as unknown as SagaEditorialLens : null;
}

export function productFailureMessage(status: number, fallback: string): string {
  if (status === 401) return "Logga in för att öppna din redaktionella riktning.";
  if (status === 403) return "Du har inte behörighet att ändra den här redaktionella riktningen.";
  return fallback;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
