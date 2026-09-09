"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import Link from "next/link";
import {
  SAGA_AD_CREATIVE_OBJECTIVES,
  SAGA_AD_CREATIVE_PRESETS,
  sagaAdCreativeVariantInputFromProject,
  type SagaAdCreativeGeometry,
  type SagaAdCreativeMedium,
  type SagaAdCreativeObjective,
  type SagaAdCreativeProject,
  type SagaAdCreativeUnit,
  type SagaAdCreativeVariantInput,
  type SagaAdCreativeVariantStatus,
} from "@/lib/domain/saga-ad-creative";
import {
  createSagaAdCreativeProject,
  deleteSagaAdCreativeProject,
  listSagaAdCreativeProjects,
  updateSagaAdCreativeProject,
} from "@/lib/client/saga-ad-creative-projects";
import styles from "./saga-ad-creative-studio.module.css";

type LoadState = "loading" | "ready" | "unavailable";
type SaveState = "idle" | "saving" | "error" | "success";
type CustomFormatDraft = {
  label: string;
  medium: SagaAdCreativeMedium;
  width: string;
  height: string;
  unit: SagaAdCreativeUnit;
  dpi: string;
  bleed: string;
  safeZone: string;
};

const emptyBrief = {
  objective: "awareness" as SagaAdCreativeObjective,
  audience: "",
  message: "",
  callToAction: "",
  sourceReference: "",
};

const emptyCustom: CustomFormatDraft = {
  label: "",
  medium: "custom",
  width: "",
  height: "",
  unit: "px",
  dpi: "",
  bleed: "0",
  safeZone: "0",
};

const mediumLabels: Record<SagaAdCreativeMedium, string> = {
  social: "Sociala medier",
  display: "Display",
  search: "Sök",
  email: "E-post",
  direct_mail: "Postutskick",
  newspaper: "Tidning",
  poster: "Affisch",
  custom: "Eget",
};

const statusLabels: Record<SagaAdCreativeVariantStatus, string> = {
  private_draft: "Privat arbetsmaterial",
  in_review: "Klar för granskning",
  approved: "Format granskat",
};

function freshId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `00000000-0000-4000-8000-${Date.now().toString().padStart(12, "0").slice(-12)}`;
}

function numberValue(value: string): number | null {
  const parsed = Number(value.replace(",", "."));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function insets(value: number) {
  return { top: value, right: value, bottom: value, left: value };
}

function variantFromPreset(presetId: (typeof SAGA_AD_CREATIVE_PRESETS)[number]["id"]): SagaAdCreativeVariantInput {
  const preset = SAGA_AD_CREATIVE_PRESETS.find((candidate) => candidate.id === presetId);
  if (!preset) throw new Error("Formatet hittades inte.");
  return {
    id: freshId(),
    label: preset.label,
    status: "private_draft",
    format: { kind: "preset", presetId },
    copy: { headline: "", primaryText: "", description: "", callToAction: "", destinationUrl: null, legalText: "" },
    assetDirection: "",
  };
}

function geometryDescription(geometry: SagaAdCreativeGeometry | null): string {
  if (!geometry) return "Text- eller mediespec krävs";
  const dpi = geometry.dpi ? ` · ${geometry.dpi} DPI` : "";
  return `${geometry.width} × ${geometry.height} ${geometry.unit}${dpi}`;
}

function variantGeometry(variant: SagaAdCreativeVariantInput): SagaAdCreativeGeometry | null {
  const format = variant.format;
  if (!("presetId" in format)) return format.geometry;
  return SAGA_AD_CREATIVE_PRESETS.find((preset) => preset.id === format.presetId)?.geometry ?? null;
}

function variantMedium(variant: SagaAdCreativeVariantInput): SagaAdCreativeMedium {
  const format = variant.format;
  if (!("presetId" in format)) return format.medium;
  return SAGA_AD_CREATIVE_PRESETS.find((preset) => preset.id === format.presetId)?.medium ?? "custom";
}

function initialForm(project?: SagaAdCreativeProject | null) {
  if (!project) return { name: "", masterBrief: emptyBrief, variants: [] as SagaAdCreativeVariantInput[] };
  return {
    name: project.name,
    masterBrief: { ...project.masterBrief },
    variants: project.variants.map(sagaAdCreativeVariantInputFromProject),
  };
}

/**
 * A private production canvas: it prepares material for review, not an ad
 * account, buy, export or external delivery.
 */
export function SagaAdCreativeStudio() {
  const nameId = useId();
  const audienceId = useId();
  const messageId = useId();
  const ctaId = useId();
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadMessage, setLoadMessage] = useState("");
  const [projects, setProjects] = useState<SagaAdCreativeProject[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [form, setForm] = useState(() => initialForm());
  const [custom, setCustom] = useState<CustomFormatDraft>(emptyCustom);
  const [customError, setCustomError] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveMessage, setSaveMessage] = useState("");
  const createKey = useRef<string | null>(null);

  const activeProject = useMemo(
    () => projects.find((project) => project.id === activeProjectId) ?? null,
    [activeProjectId, projects],
  );
  const selectedVariant = form.variants[0] ?? null;
  const canSave = loadState === "ready" && saveState !== "saving" && form.name.trim().length >= 2
    && form.masterBrief.audience.trim().length >= 2 && form.masterBrief.message.trim().length >= 2
    && form.masterBrief.callToAction.trim().length >= 2 && form.variants.length > 0;

  const loadProjects = useCallback(async () => {
    setLoadState("loading");
    setLoadMessage("");
    try {
      const next = await listSagaAdCreativeProjects();
      setProjects(next);
      setLoadState("ready");
    } catch (error) {
      setLoadState("unavailable");
      setLoadMessage(error instanceof Error ? error.message : "Annonsstudion kunde inte öppnas just nu.");
    }
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => { void loadProjects(); });
    return () => window.cancelAnimationFrame(frame);
  }, [loadProjects]);

  function openProject(project: SagaAdCreativeProject) {
    setActiveProjectId(project.id);
    setForm(initialForm(project));
    setCustomError("");
    setSaveState("idle");
    setSaveMessage("");
  }

  function startProject() {
    setActiveProjectId(null);
    setForm(initialForm());
    createKey.current = null;
    setCustomError("");
    setSaveState("idle");
    setSaveMessage("");
  }

  function addPreset(presetId: (typeof SAGA_AD_CREATIVE_PRESETS)[number]["id"]) {
    setForm((current) => ({ ...current, variants: [...current.variants, variantFromPreset(presetId)] }));
    setCustomError("");
  }

  function addCustomFormat() {
    const width = numberValue(custom.width);
    const height = numberValue(custom.height);
    const dpi = custom.unit === "px" ? null : numberValue(custom.dpi);
    const bleed = numberValue(custom.bleed);
    const safeZone = numberValue(custom.safeZone);
    if (custom.label.trim().length < 2 || width === null || width < 1 || height === null || height < 1 || bleed === null || safeZone === null) {
      setCustomError("Ge formatet ett namn samt giltig bredd, höjd, utfall och säker marginal.");
      return;
    }
    if (custom.unit !== "px" && (dpi === null || dpi < 36 || dpi > 1200)) {
      setCustomError("Tryckformat i mm eller tum behöver DPI mellan 36 och 1200.");
      return;
    }
    if (safeZone * 2 >= Math.min(width, height)) {
      setCustomError("Säker marginal måste lämna en synlig arbetsyta.");
      return;
    }
    const geometry: SagaAdCreativeGeometry = { width, height, unit: custom.unit, dpi: custom.unit === "px" ? null : dpi, bleed: insets(bleed), safeZone: insets(safeZone) };
    const label = custom.label.trim();
    setForm((current) => ({
      ...current,
      variants: [...current.variants, {
        id: freshId(), label, status: "private_draft",
        format: { kind: "custom", label, medium: custom.medium, geometry },
        copy: { headline: "", primaryText: "", description: "", callToAction: "", destinationUrl: null, legalText: "" },
        assetDirection: "",
      }],
    }));
    setCustom(emptyCustom);
    setCustomError("");
  }

  function updateVariant(id: string, patch: Partial<SagaAdCreativeVariantInput>) {
    setForm((current) => ({ ...current, variants: current.variants.map((variant) => variant.id === id ? { ...variant, ...patch } : variant) }));
  }

  function updateVariantCopy(id: string, key: keyof SagaAdCreativeVariantInput["copy"], value: string) {
    setForm((current) => ({
      ...current,
      variants: current.variants.map((variant) => variant.id === id
        ? { ...variant, copy: { ...variant.copy, [key]: key === "destinationUrl" ? (value.trim() || null) : value } }
        : variant),
    }));
  }

  async function saveProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSave) {
      setSaveState("error");
      setSaveMessage("Fyll i namn, målgrupp, huvudbudskap, handling och minst en formatvariant innan du sparar.");
      return;
    }
    setSaveState("saving");
    setSaveMessage("");
    try {
      const project = activeProject
        ? await updateSagaAdCreativeProject(activeProject.id, {
          expectedRevision: activeProject.revision,
          name: form.name.trim(), masterBrief: form.masterBrief, variants: form.variants,
        })
        : await createSagaAdCreativeProject({
          createIdempotencyKey: createKey.current ?? (createKey.current = freshId()),
          name: form.name.trim(), masterBrief: form.masterBrief, variants: form.variants,
        });
      setProjects((current) => [project, ...current.filter((entry) => entry.id !== project.id)]);
      setActiveProjectId(project.id);
      setForm(initialForm(project));
      createKey.current = null;
      setSaveState("success");
      setSaveMessage(activeProject ? "Ändringarna är sparade som privat arbetsmaterial." : "Det privata annonsprojektet är sparat. Ingen annons har skapats i ett externt konto.");
    } catch (error) {
      setSaveState("error");
      setSaveMessage(error instanceof Error ? error.message : "Kunde inte spara annonsprojektet.");
    }
  }

  async function removeProject() {
    if (!activeProject || saveState === "saving") return;
    const confirmed = window.confirm(`Ta bort “${activeProject.name}”? Det privata projektet och dess formatvarianter kan inte återställas.`);
    if (!confirmed) return;
    setSaveState("saving");
    try {
      await deleteSagaAdCreativeProject(activeProject.id, activeProject.revision);
      setProjects((current) => current.filter((project) => project.id !== activeProject.id));
      startProject();
      setSaveState("success");
      setSaveMessage("Det privata annonsprojektet är borttaget.");
    } catch (error) {
      setSaveState("error");
      setSaveMessage(error instanceof Error ? error.message : "Kunde inte ta bort annonsprojektet.");
    }
  }

  const previewGeometry = selectedVariant ? variantGeometry(selectedVariant) : null;
  const previewStyle: CSSProperties = previewGeometry
    ? { aspectRatio: `${previewGeometry.width} / ${previewGeometry.height}` }
    : { aspectRatio: "16 / 9" };

  return (
    <section className={styles.workspace} aria-labelledby="ad-studio-title">
      <header className={styles.hero}>
        <div>
          <p className={styles.eyebrow}>ANNONSSTUDIO · PRIVAT PRODUKTION</p>
          <h1 id="ad-studio-title">En idé. Rätt material för varje format.</h1>
          <p>Bygg en huvudriktning, gör kanal- och tryckversioner och fintrimma dem innan något kopplas till ett annonskonto.</p>
        </div>
        <aside className={styles.truth} aria-label="Annonsstudiens leveransstatus">
          <span aria-hidden="true">✓</span>
          <div><strong>Material, inte medieköp</strong><small>Ingen annons skickas, köps eller publiceras här.</small></div>
        </aside>
      </header>

      <ol className={styles.flow} aria-label="Annonsstudiens arbetsflöde">
        <li><span>01</span><div><strong>Huvudbrief</strong><small>En idé att hålla ihop</small></div></li>
        <li><span>02</span><div><strong>Formatpaket</strong><small>Rätt storlek per medium</small></div></li>
        <li><span>03</span><div><strong>Fintrimma</strong><small>Copy och bildriktning</small></div></li>
        <li><span>04</span><div><strong>Granska</strong><small>Innan extern leverans</small></div></li>
      </ol>

      {loadState === "unavailable" && <section className={styles.unavailable} role="status">
        <span aria-hidden="true">!</span><div><strong>Annonsstudion är inte redo att spara än.</strong><p>{loadMessage}</p></div>
        <button type="button" onClick={() => void loadProjects()}>Försök igen</button>
      </section>}

      <div className={styles.layout}>
        <aside className={styles.library} aria-labelledby="format-library-title">
          <header><p>FORMATBIBLIOTEK</p><h2 id="format-library-title">Börja med ett standardformat</h2><span>Varje format blir en egen variant.</span></header>
          <div className={styles.presetGroups}>
            {(["social", "display", "search", "email", "direct_mail", "newspaper", "poster"] as const).map((medium) => {
              const presets = SAGA_AD_CREATIVE_PRESETS.filter((preset) => preset.medium === medium);
              if (presets.length === 0) return null;
              return <section key={medium} className={styles.presetGroup} aria-label={mediumLabels[medium]}>
                <h3>{mediumLabels[medium]}</h3>
                {presets.map((preset) => <button key={preset.id} type="button" className={styles.presetButton} onClick={() => addPreset(preset.id)} disabled={loadState !== "ready" || saveState === "saving"}>
                  <span className={styles.presetIcon} aria-hidden="true">{preset.geometry ? "□" : "T"}</span>
                  <span><strong>{preset.label}</strong><small>{geometryDescription(preset.geometry)}</small></span>
                  <i aria-hidden="true">+</i>
                </button>)}
              </section>;
            })}
          </div>

          <section className={styles.customPanel} aria-labelledby="custom-format-title">
            <p>EGET FORMAT</p><h2 id="custom-format-title">När mediet har egna mått</h2>
            <label><span>Namn</span><input value={custom.label} maxLength={120} onChange={(event) => setCustom((current) => ({ ...current, label: event.target.value }))} placeholder="Exempel: Dagens Nyheter helsida" disabled={loadState !== "ready"} /></label>
            <div className={styles.customGrid}>
              <label><span>Medium</span><select value={custom.medium} onChange={(event) => setCustom((current) => ({ ...current, medium: event.target.value as SagaAdCreativeMedium }))} disabled={loadState !== "ready"}>{Object.entries(mediumLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              <label><span>Enhet</span><select value={custom.unit} onChange={(event) => setCustom((current) => ({ ...current, unit: event.target.value as SagaAdCreativeUnit }))} disabled={loadState !== "ready"}><option value="px">px</option><option value="mm">mm</option><option value="in">tum</option></select></label>
              <label><span>Bredd</span><input inputMode="decimal" value={custom.width} onChange={(event) => setCustom((current) => ({ ...current, width: event.target.value }))} disabled={loadState !== "ready"} /></label>
              <label><span>Höjd</span><input inputMode="decimal" value={custom.height} onChange={(event) => setCustom((current) => ({ ...current, height: event.target.value }))} disabled={loadState !== "ready"} /></label>
              {custom.unit !== "px" && <label><span>DPI</span><input inputMode="numeric" value={custom.dpi} onChange={(event) => setCustom((current) => ({ ...current, dpi: event.target.value }))} placeholder="300" disabled={loadState !== "ready"} /></label>}
              <label><span>Utfall</span><input inputMode="decimal" value={custom.bleed} onChange={(event) => setCustom((current) => ({ ...current, bleed: event.target.value }))} disabled={loadState !== "ready"} /></label>
              <label><span>Säker marginal</span><input inputMode="decimal" value={custom.safeZone} onChange={(event) => setCustom((current) => ({ ...current, safeZone: event.target.value }))} disabled={loadState !== "ready"} /></label>
            </div>
            {customError && <p className={styles.fieldError}>{customError}</p>}
            <button type="button" className={styles.secondaryButton} onClick={addCustomFormat} disabled={loadState !== "ready" || saveState === "saving"}>+ Lägg till eget format</button>
            <small>Tidningsmått, utfall och färgprofil bekräftas alltid med utgivaren innan export.</small>
          </section>
        </aside>

        <form className={styles.editor} onSubmit={saveProject}>
          <header className={styles.editorHeader}>
            <div><p>{activeProject ? `PROJEKT · REVISION ${activeProject.revision}` : "NYTT PRIVAT PROJEKT"}</p><h2>{activeProject ? activeProject.name : "Bygg ditt formatpaket"}</h2></div>
            <div className={styles.editorActions}><button type="button" className={styles.ghostButton} onClick={startProject} disabled={saveState === "saving"}>Nytt projekt</button>{activeProject && <button type="button" className={styles.dangerButton} onClick={() => void removeProject()} disabled={saveState === "saving"}>Ta bort</button>}</div>
          </header>

          <section className={styles.brief} aria-labelledby="master-brief-title">
            <div className={styles.sectionHeading}><span>01</span><div><p>MASTERBRIEF</p><h3 id="master-brief-title">Samma kärna i varje kanalversion</h3></div></div>
            <div className={styles.briefGrid}>
              <label htmlFor={nameId}><span>Projektnamn</span><input id={nameId} value={form.name} maxLength={160} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} placeholder="Exempel: System som frigör tid" disabled={loadState !== "ready" || saveState === "saving"} /></label>
              <label><span>Syfte</span><select value={form.masterBrief.objective} onChange={(event) => setForm((current) => ({ ...current, masterBrief: { ...current.masterBrief, objective: event.target.value as SagaAdCreativeObjective } }))} disabled={loadState !== "ready" || saveState === "saving"}>{SAGA_AD_CREATIVE_OBJECTIVES.map((objective) => <option key={objective} value={objective}>{({ awareness: "Kännedom", traffic: "Trafik", leads: "Leads", sales: "Försäljning", retention: "Behålla kunder", recruitment: "Rekrytering" } as Record<SagaAdCreativeObjective, string>)[objective]}</option>)}</select></label>
              <label htmlFor={audienceId}><span>För vem?</span><input id={audienceId} value={form.masterBrief.audience} maxLength={300} onChange={(event) => setForm((current) => ({ ...current, masterBrief: { ...current.masterBrief, audience: event.target.value } }))} placeholder="Människor som bygger verksamheter" disabled={loadState !== "ready" || saveState === "saving"} /></label>
              <label htmlFor={ctaId}><span>Önskad handling</span><input id={ctaId} value={form.masterBrief.callToAction} maxLength={300} onChange={(event) => setForm((current) => ({ ...current, masterBrief: { ...current.masterBrief, callToAction: event.target.value } }))} placeholder="Boka ett samtal" disabled={loadState !== "ready" || saveState === "saving"} /></label>
              <label className={styles.fullField} htmlFor={messageId}><span>Huvudbudskap</span><textarea id={messageId} value={form.masterBrief.message} rows={3} maxLength={3000} onChange={(event) => setForm((current) => ({ ...current, masterBrief: { ...current.masterBrief, message: event.target.value } }))} placeholder="Vad ska mottagaren förstå, känna eller göra?" disabled={loadState !== "ready" || saveState === "saving"} /></label>
              <label className={styles.fullField}><span>Frivillig källnotering</span><input value={form.masterBrief.sourceReference} maxLength={500} onChange={(event) => setForm((current) => ({ ...current, masterBrief: { ...current.masterBrief, sourceReference: event.target.value } }))} placeholder="Till exempel intern kampanjbrief eller sparad Series-referens" disabled={loadState !== "ready" || saveState === "saving"} /></label>
            </div>
          </section>

          <section className={styles.variants} aria-labelledby="variant-title">
            <div className={styles.sectionHeading}><span>02</span><div><p>FORMATVARIANTER</p><h3 id="variant-title">Gör varje material specifikt</h3></div><small>{form.variants.length}/24 format</small></div>
            {form.variants.length === 0 && <div className={styles.emptyVariants}><strong>Välj ett format i biblioteket.</strong><p>Du kan kombinera digitala format, tryck och helt egna mått i samma projekt.</p></div>}
            <div className={styles.variantList}>{form.variants.map((variant, index) => {
              const geometry = variantGeometry(variant);
              const medium = variantMedium(variant);
              return <article className={styles.variantCard} key={variant.id}>
                <header><span className={styles.variantIndex}>{String(index + 1).padStart(2, "0")}</span><div><p>{mediumLabels[medium]} · {geometryDescription(geometry)}</p><input aria-label={`Namn på formatvariant ${index + 1}`} value={variant.label} maxLength={160} onChange={(event) => updateVariant(variant.id, { label: event.target.value })} disabled={loadState !== "ready" || saveState === "saving"} /></div><button type="button" className={styles.removeVariant} onClick={() => setForm((current) => ({ ...current, variants: current.variants.filter((item) => item.id !== variant.id) }))} disabled={loadState !== "ready" || saveState === "saving"} aria-label={`Ta bort ${variant.label}`}>×</button></header>
                <div className={styles.variantFields}>
                  <label><span>Rubrik i materialet</span><input value={variant.copy.headline} maxLength={240} onChange={(event) => updateVariantCopy(variant.id, "headline", event.target.value)} placeholder="Kort, visuellt budskap" disabled={loadState !== "ready" || saveState === "saving"} /></label>
                  <label><span>Handling</span><input value={variant.copy.callToAction} maxLength={300} onChange={(event) => updateVariantCopy(variant.id, "callToAction", event.target.value)} placeholder={form.masterBrief.callToAction || "Vad ska nästa steg vara?"} disabled={loadState !== "ready" || saveState === "saving"} /></label>
                  <label className={styles.variantWide}><span>Copy / innehåll</span><textarea rows={3} value={variant.copy.primaryText} maxLength={3000} onChange={(event) => updateVariantCopy(variant.id, "primaryText", event.target.value)} placeholder="Anpassa budskapet till just detta format." disabled={loadState !== "ready" || saveState === "saving"} /></label>
                  <label className={styles.variantWide}><span>Bild- eller produktionsriktning</span><textarea rows={2} value={variant.assetDirection} maxLength={1500} onChange={(event) => updateVariant(variant.id, { assetDirection: event.target.value })} placeholder="Exempel: natur, dokumentär känsla, ett litet spår i sanden som knyter an till budskapet." disabled={loadState !== "ready" || saveState === "saving"} /></label>
                  <label><span>Måladress (valfri)</span><input value={variant.copy.destinationUrl ?? ""} onChange={(event) => updateVariantCopy(variant.id, "destinationUrl", event.target.value)} placeholder="https://…" disabled={loadState !== "ready" || saveState === "saving"} /></label>
                  <label><span>Granskningsläge</span><select value={variant.status} onChange={(event) => updateVariant(variant.id, { status: event.target.value as SagaAdCreativeVariantStatus })} disabled={loadState !== "ready" || saveState === "saving"}>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                  <label className={styles.variantWide}><span>Juridisk text (valfri)</span><textarea rows={2} value={variant.copy.legalText} maxLength={2000} onChange={(event) => updateVariantCopy(variant.id, "legalText", event.target.value)} placeholder="Villkor och verifierade förbehåll — inte ett erbjudande som systemet hittar på." disabled={loadState !== "ready" || saveState === "saving"} /></label>
                </div>
                <footer><span>{variant.format.kind === "preset" ? "Versionsstyrt standardformat" : "Eget format"}</span><span>{geometry ? `Utfall ${geometry.bleed.top} ${geometry.unit} · säker marginal ${geometry.safeZone.top} ${geometry.unit}` : "Ingen bildyta i detta format"}</span><strong>{statusLabels[variant.status]}</strong></footer>
              </article>;
            })}</div>
          </section>

          <footer className={styles.saveBar}>
            <div><strong>Privat produktionsyta</strong><p>”Format granskat” betyder inte köpt, exporterat eller publicerat. Konton och externa leveranser är inte anslutna här.</p></div>
            <button type="submit" className={styles.primaryButton} disabled={!canSave}>{saveState === "saving" ? "Sparar…" : activeProject ? "Spara ändringar" : "Spara privat projekt"}</button>
          </footer>
          {saveMessage && <p className={saveState === "error" ? styles.saveError : styles.saveMessage} role="status" aria-live="polite">{saveMessage}</p>}
        </form>

        <aside className={styles.inspector} aria-label="Formatinspektör">
          <section className={styles.canvasPanel}>
            <header><p>FOKUSFORMAT</p><span>{selectedVariant ? mediumLabels[variantMedium(selectedVariant)] : "Välj format"}</span></header>
            <div className={styles.canvas} style={previewStyle}>
              <span className={styles.canvasBleed} aria-hidden="true" />
              <div className={styles.canvasContent}><strong>{selectedVariant?.copy.headline || form.masterBrief.message || "Ditt huvudbudskap"}</strong><p>{selectedVariant?.copy.callToAction || form.masterBrief.callToAction || "Din handling"}</p></div>
            </div>
            <div className={styles.canvasMeta}><strong>{selectedVariant ? selectedVariant.label : "Inget format valt"}</strong><span>{selectedVariant ? geometryDescription(previewGeometry) : "Lägg till ett standard- eller eget format"}</span></div>
          </section>
          <section className={styles.inspectorCard}>
            <p>FÖRE EXTERN LEVERANS</p><h2>Kontrollera varje version i rätt kanal.</h2>
            <ul><li>Kanalspecifikation och aktuella placeringar</li><li>Tryckeriets utfall, färgprofil och PDF-krav</li><li>Påståenden, erbjudanden och juridisk text</li><li>Bild, copy och destination i den faktiska annonseringen</li></ul>
            <Link href="/studio/automations?view=ads">Öppna annonsflöden <span aria-hidden="true">→</span></Link>
          </section>
          <section className={styles.savedProjects} aria-labelledby="saved-projects-title">
            <header><p>SPARADE PROJEKT</p><h2 id="saved-projects-title">Privata material</h2></header>
            {loadState === "loading" && <div className={styles.skeletons} aria-label="Hämtar projekt"><i /><i /><i /></div>}
            {loadState === "ready" && projects.length === 0 && <p className={styles.noProjects}>Inga privata annonsprojekt ännu.</p>}
            {projects.length > 0 && <ul>{projects.map((project) => <li key={project.id}><button type="button" onClick={() => openProject(project)} aria-pressed={activeProjectId === project.id}><span><strong>{project.name}</strong><small>{project.variants.length} format · revision {project.revision}</small></span><i aria-hidden="true">→</i></button></li>)}</ul>}
          </section>
        </aside>
      </div>
    </section>
  );
}
