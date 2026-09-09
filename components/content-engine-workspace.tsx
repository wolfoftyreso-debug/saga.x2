"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import styles from "@/components/content-engine-workspace.module.css";
import { sagaSeriesFromPayload, type SagaSeries, type SagaSeriesTone } from "@/components/saga-series-workspace";

/**
 * Read-only client contract for the Content Engine. The durable data comes
 * from the Vercel/Neon endpoint; this component deliberately has no local
 * storage or optimistic persistence path.
 */
export type EngineWorkspaceEntity = {
  id?: string;
  name?: string;
  label?: string;
  title?: string;
  description?: string;
  instructions?: string;
  summary?: string;
  kind?: string;
  type?: string;
  provider?: string;
  model?: string;
  url?: string;
  templateId?: string | null;
  active?: boolean;
  enabled?: boolean;
  [key: string]: unknown;
};

export type EngineWorkspaceData = {
  brandProfiles: EngineWorkspaceEntity[];
  sources: EngineWorkspaceEntity[];
  modelPresets: EngineWorkspaceEntity[];
  modelPolicies: EngineWorkspaceEntity[];
  recipes: EngineWorkspaceEntity[];
  destinations: EngineWorkspaceEntity[];
  distributionRules: EngineWorkspaceEntity[];
  /** Available server-confirmed channel records used by the destination form. */
  availableDestinations?: { socialConnections: EngineWorkspaceEntity[]; newsletterAudiences: EngineWorkspaceEntity[] };
};

type ContentEngineWorkspaceProps = {
  /** Optional server-provided data. When omitted, the component reads the safe API route. */
  data?: EngineWorkspaceData | null;
  apiPath?: string;
  /**
   * Opaque Series Reference selector from /studio/series. The browser never
   * receives or submits a reference snapshot; it confirms the active series
   * through the actor-scoped Series endpoint before a lab request can use it.
   */
  seriesId?: string | null;
  /** Test seam only. Production reads the actor-scoped Series endpoint. */
  seriesApiPath?: string;
};

type EngineLoadState = "loading" | "ready" | "unavailable";
type EngineStageId = "voice" | "recipe" | "lab" | "distribution";
type LabProvider = "openai" | "anthropic" | "google" | "xai";
type EngineEditorKind = "brandProfile" | "source" | "recipe" | "modelPreset" | "modelPolicy" | "destination" | "distributionRule";

type LabVariation = {
  id: string;
  label: string;
  provider: string;
  model: string;
  draft: {
    title: string;
    headline: string;
    subject: string;
    previewText: string;
    body: string;
    excerpt: string;
    callToAction: string;
    hashtags: string;
    imagePrompt: string;
    altText: string;
  };
};

type LabSeriesReference = Pick<SagaSeries, "id" | "name" | "controls"> & {
  reference: Pick<SagaSeries["reference"], "title" | "channels" | "capturedAt">;
};

type SeriesReferenceLoadState = "idle" | "loading" | "ready" | "unavailable" | "not_available";

/**
 * Narrow a browser response to the tiny display contract needed by AI Lab.
 * The active check is intentionally repeated in the server route; this only
 * protects the UI from accidentally sending a stale or inactive selector.
 */
export function activeLabSeriesReferenceFromPayload(payload: unknown, seriesId: string | null | undefined): LabSeriesReference | null {
  if (!seriesId) return null;
  const series = sagaSeriesFromPayload(payload)?.find((entry) => entry.id === seriesId && entry.active && entry.controls);
  if (!series || !series.controls) return null;
  return {
    id: series.id,
    name: series.name,
    controls: series.controls,
    reference: {
      title: series.reference.title,
      channels: series.reference.channels,
      capturedAt: series.reference.capturedAt,
    },
  };
}

const stageCopy: Record<EngineStageId, { number: string; label: string; short: string }> = {
  voice: { number: "01", label: "Sätt riktning", short: "Röst" },
  recipe: { number: "02", label: "Bygg format", short: "Recept" },
  lab: { number: "03", label: "Skapa & jämför", short: "Test" },
  distribution: { number: "04", label: "Gör klart", short: "Nästa steg" },
};

const defaultProviders: Array<{ id: LabProvider; label: string; detail: string }> = [
  { id: "openai", label: "OpenAI", detail: "Idé & struktur" },
  { id: "anthropic", label: "Claude", detail: "Resonemang & ton" },
  { id: "google", label: "Gemini", detail: "Bredd & sammanhang" },
  { id: "xai", label: "Grok", detail: "Aktuella vinklar" },
];

export function ContentEngineWorkspace({
  data: initialData,
  apiPath = "/api/content-engine",
  seriesId = null,
  seriesApiPath = "/api/saga/series",
}: ContentEngineWorkspaceProps) {
  const [workspace, setWorkspace] = useState<EngineWorkspaceData | null>(initialData ?? null);
  const [loadState, setLoadState] = useState<EngineLoadState>(initialData ? "ready" : "loading");
  const [loadMessage, setLoadMessage] = useState<string | null>(null);
  const [activeStage, setActiveStage] = useState<EngineStageId>("voice");
  const [selectedRecipeId, setSelectedRecipeId] = useState<string | null>(null);
  const [selectedPersonaId, setSelectedPersonaId] = useState<string | null>(null);
  const [topic, setTopic] = useState("");
  const [selectedProviders, setSelectedProviders] = useState<LabProvider[]>(["openai", "anthropic", "google"]);
  const [labState, setLabState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [labMessage, setLabMessage] = useState<string | null>(null);
  const [variations, setVariations] = useState<LabVariation[]>([]);
  const [selectedVariationId, setSelectedVariationId] = useState<string | null>(null);
  const [editorKind, setEditorKind] = useState<EngineEditorKind | null>(null);
  const [editorEntity, setEditorEntity] = useState<EngineWorkspaceEntity | null>(null);
  const [editorState, setEditorState] = useState<"idle" | "saving" | "error">("idle");
  const [editorMessage, setEditorMessage] = useState<string | null>(null);
  const [operationMessage, setOperationMessage] = useState<string | null>(null);
  const [seriesReference, setSeriesReference] = useState<LabSeriesReference | null>(null);
  const [seriesReferenceState, setSeriesReferenceState] = useState<SeriesReferenceLoadState>(seriesId ? "loading" : "idle");
  const [seriesReferenceMessage, setSeriesReferenceMessage] = useState<string | null>(null);

  const reload = async (signal?: AbortSignal): Promise<boolean> => {
    setLoadState("loading");
    setLoadMessage(null);

    try {
      const response = await fetch(apiPath, { credentials: "same-origin", cache: "no-store", signal });
      const payload: unknown = await response.json().catch(() => null);
      const nextData = workspaceFromPayload(payload);

      if (!response.ok || !nextData) {
        setWorkspace(null);
        setLoadState("unavailable");
        setLoadMessage(messageFromPayload(payload) || "Skaparytan kan inte läsas just nu.");
        return false;
      }

      setWorkspace(nextData);
      setLoadState("ready");
      return true;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return false;
      setWorkspace(null);
      setLoadState("unavailable");
      setLoadMessage("Skaparytan kan inte nås. Kontrollera Vercel-konfigurationen och försök igen.");
      return false;
    }
  };

  useEffect(() => {
    if (initialData) return;
    const controller = new AbortController();
    // Start after the effect has committed. The request owns all subsequent
    // state changes, rather than synchronously cascading a render from here.
    void Promise.resolve().then(() => reload(controller.signal));
    return () => controller.abort();
    // apiPath is a documented input. `reload` is intentionally recreated only
    // to keep the request lifecycle local to this client surface.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiPath, initialData]);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(async () => {
      if (!seriesId) {
        if (!controller.signal.aborted) {
          setSeriesReference(null);
          setSeriesReferenceState("idle");
          setSeriesReferenceMessage(null);
        }
        return;
      }

      setSeriesReference(null);
      setSeriesReferenceState("loading");
      setSeriesReferenceMessage(null);
      try {
        const response = await fetch(seriesApiPath, {
          credentials: "same-origin",
          cache: "no-store",
          signal: controller.signal,
        });
        const payload: unknown = await response.json().catch(() => null);
        if (!response.ok) {
          if (!controller.signal.aborted) {
            setSeriesReferenceState("unavailable");
            setSeriesReferenceMessage(messageFromPayload(payload) || "Referensserien kan inte läsas just nu.");
          }
          return;
        }

        const resolved = activeLabSeriesReferenceFromPayload(payload, seriesId);
        if (!resolved) {
          if (!controller.signal.aborted) {
            setSeriesReferenceState("not_available");
            // Do not distinguish a missing, inactive, stale or other-workspace
            // selector. The server will make the same actor-scoped check.
            setSeriesReferenceMessage("Den valda serien är inte aktiv och tillgänglig i den här arbetsytan.");
          }
          return;
        }

        if (!controller.signal.aborted) {
          setSeriesReference(resolved);
          setSeriesReferenceState("ready");
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (!controller.signal.aborted) {
          setSeriesReferenceState("unavailable");
          setSeriesReferenceMessage("Referensserien kan inte nås just nu. AI-labbet kör inte utan en bekräftad referens.");
        }
      }
    });

    return () => controller.abort();
  }, [seriesApiPath, seriesId]);

  const model = useMemo(() => engineViewModel(workspace), [workspace]);
  const selectedRecipe = model.recipes.find((recipe) => recipe.id === selectedRecipeId) ?? model.recipes[0] ?? null;
  const selectedPersona = model.personas.find((profile) => profile.id === selectedPersonaId) ?? model.personas[0] ?? null;
  const selectedVariation = variations.find((variation) => variation.id === selectedVariationId) ?? variations[0] ?? null;
  const selectedRecipeRecord = workspace?.recipes.find((recipe) => String(recipe.id) === selectedRecipe?.id) ?? null;
  const selectedRecipePolicyId = text(selectedRecipeRecord ?? {}, ["modelPolicyId"]);
  const selectedRecipePolicy = workspace?.modelPolicies.find((policy) => String(policy.id) === selectedRecipePolicyId) ?? null;
  const selectedPolicyModels = policyComparisonModels(selectedRecipePolicy, workspace?.modelPresets ?? []);
  const recipeUsesSavedPolicy = Boolean(selectedRecipePolicyId);
  const selectedRecipePolicyIsWriting = text(selectedRecipePolicy ?? {}, ["taskKind"]) === "writing";
  const effectiveComparisonCount = recipeUsesSavedPolicy && selectedRecipePolicyIsWriting ? Math.min(selectedPolicyModels.length, 3) : recipeUsesSavedPolicy ? 0 : selectedProviders.length;
  const hasFoundation = Boolean(selectedRecipe && selectedPersona);
  const editingAvailable = loadState === "ready";
  // A client-side search-param transition can preserve component state for a
  // moment. Never let the previous series ID bleed into the next lab run.
  const confirmedSeriesReference = seriesId && seriesReference?.id === seriesId ? seriesReference : null;
  const effectiveSeriesReferenceState: SeriesReferenceLoadState = !seriesId
    ? "idle"
    : !confirmedSeriesReference && seriesReferenceState === "ready"
      ? "loading"
      : seriesReferenceState;
  // An engine opened from a Series handoff must wait for the server-confirmed
  // active reference. A regular lab still keeps its legacy no-series flow.
  const seriesSelectionReady = !seriesId || (effectiveSeriesReferenceState === "ready" && Boolean(confirmedSeriesReference));
  const canRunLab = loadState === "ready"
    && hasFoundation
    && seriesSelectionReady
    && topic.trim().length >= 6
    && (recipeUsesSavedPolicy ? selectedRecipePolicyIsWriting && selectedPolicyModels.length >= 2 : selectedProviders.length >= 2);

  const stageStatus: Record<EngineStageId, "complete" | "ready" | "waiting"> = {
    voice: model.personas.length && model.sources.length ? "complete" : "waiting",
    recipe: model.recipes.length ? "complete" : "waiting",
    lab: variations.length ? "complete" : hasFoundation ? "ready" : "waiting",
    // A rule can prepare private drafts, but a saved destination is not proof
    // that a delivery provider is live. Keep the final stage honest until a
    // publisher/receiver has explicitly been activated.
    distribution: model.destinations.length && model.rules.length ? "ready" : "waiting",
  };

  function selectStage(stage: EngineStageId) {
    setActiveStage(stage);
    document.getElementById(`engine-${stage}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function toggleProvider(provider: LabProvider) {
    setSelectedProviders((current) => {
      if (current.includes(provider)) {
        return current.length <= 2 ? current : current.filter((item) => item !== provider);
      }
      return [...current, provider].slice(0, 3);
    });
  }

  function openEditor(kind: EngineEditorKind, entity?: EngineWorkspaceEntity | null) {
    if (!editingAvailable) return;
    setEditorKind(kind);
    setEditorEntity(entity ?? null);
    setEditorState("idle");
    setEditorMessage(null);
  }

  function closeEditor() {
    if (editorState === "saving") return;
    setEditorKind(null);
    setEditorEntity(null);
    setEditorMessage(null);
  }

  async function saveEntity(kind: EngineEditorKind, input: Record<string, unknown>, id?: string | null) {
    setEditorState("saving");
    setEditorMessage(null);
    try {
      const response = await fetch(apiPath, {
        method: id ? "PATCH" : "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(id ? { entity: kind, id, input } : { entity: kind, input }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        setEditorState("error");
        setEditorMessage(messageFromPayload(payload) || "Det gick inte att spara ändringen.");
        return;
      }
      const refreshed = await reload();
      if (!refreshed) {
        setEditorState("error");
        setEditorMessage("Sparat svar kunde inte läsas tillbaka från arbetsytan. Kontrollera anslutningen.");
        return;
      }
      setEditorState("idle");
      setEditorKind(null);
      setEditorEntity(null);
    } catch {
      setEditorState("error");
      setEditorMessage("Arbetsytan kunde inte nås. Inget lokalt utkast har sparats.");
    }
  }

  async function deleteEntity(kind: EngineEditorKind, id: string) {
    if (!editingAvailable) return;
    const confirmed = window.confirm("Ta bort den här resursen från arbetsytan? Åtgärden går inte att ångra.");
    if (!confirmed) return;
    setOperationMessage(null);
    try {
      const response = await fetch(apiPath, { method: "DELETE", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ entity: kind, id }) });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        setOperationMessage(messageFromPayload(payload) || "Resursen kunde inte tas bort.");
        return;
      }
      await reload();
      setOperationMessage("Resursen är borttagen från arbetsytan.");
    } catch {
      setOperationMessage("Arbetsytan kunde inte nås. Resursen är inte bekräftat borttagen.");
    }
  }

  function entity(kind: EngineEditorKind, id: string) {
    const data = workspace;
    if (!data) return null;
    const key: Record<EngineEditorKind, Exclude<keyof EngineWorkspaceData, "availableDestinations">> = { brandProfile: "brandProfiles", source: "sources", recipe: "recipes", modelPreset: "modelPresets", modelPolicy: "modelPolicies", destination: "destinations", distributionRule: "distributionRules" };
    return data[key[kind]].find((item) => String(item.id) === id) ?? null;
  }

  async function runLab(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canRunLab || !selectedRecipe || !selectedPersona) return;

    setLabState("running");
    setLabMessage(null);
    setVariations([]);
    setSelectedVariationId(null);

    try {
      const response = await fetch("/api/content/ai-lab/generate", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          topic: topic.trim(),
          // The selected item belongs to Content Engine, not the older Studio
          // template catalogue. Send its explicit identity so a UUID collision
          // can never make a lab run use the wrong recipe.
          recipe: { templateId: null, engineRecipeId: selectedRecipe.id, label: selectedRecipe.label },
          persona: { id: selectedPersona.id, label: selectedPersona.label, instructions: selectedPersona.detail },
          models: selectedProviders,
          // Only send an ID the browser has just resolved from its own
          // actor-scoped endpoint. The API loads the frozen snapshot itself.
          ...(confirmedSeriesReference ? { seriesId: confirmedSeriesReference.id } : {}),
        }),
      });
      const payload: unknown = await response.json().catch(() => null);
      const nextVariations = labVariationsFromPayload(payload);

      if (!response.ok || !nextVariations.length) {
        setLabState("error");
        setLabMessage(messageFromPayload(payload) || "AI-labbet kunde inte skapa några variationer.");
        return;
      }

      setVariations(nextVariations);
      setSelectedVariationId(nextVariations[0].id);
      setLabState("done");
      setLabMessage("Klart. Variationerna är bara provkörningar — inget är sparat, schemalagt eller publicerat.");
    } catch {
      setLabState("error");
      setLabMessage("AI-labbet kan inte nås just nu. Försök igen när AI Gateway är tillgänglig.");
    }
  }

  return (
    <section className={styles.engine} aria-labelledby="engine-title">
      <header className={styles.topbar}>
        <div className={styles.topbarLinks}>
          <Link className={styles.backLink} href="/studio">
            <EngineIcon name="arrow" />
            Studio
          </Link>
          <Link className={styles.lensLink} href="/studio/lens">
            <EngineIcon name="spark" />
            Editorial Lens
          </Link>
          <Link className={styles.lensLink} href="/studio/avatar">
            <EngineIcon name="shield" />
            Privat bildreferens
          </Link>
          <Link className={styles.lensLink} href="/studio/series">
            <EngineIcon name="recipe" />
            Innehållsserier
          </Link>
        </div>
        <div className={styles.topbarStatus} aria-live="polite">
          <span className={`${styles.statusDot} ${loadState === "ready" ? styles.statusDotReady : ""}`} />
          {loadState === "ready" ? "SAGA-arbetsyta" : loadState === "loading" ? "Hämtar arbetsyta" : "Arbetsyta kräver åtgärd"}
        </div>
      </header>

      <div className={styles.hero}>
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}>SKAPA FLÖDE</p>
          <h1 id="engine-title">Bygg ett innehållsflöde som låter som er.</h1>
          <p>Välj riktning, bygg formatet och jämför riktiga utkast. När uttrycket sitter väljer ni bara nästa steg — granska, planera eller koppla en kanal.</p>
        </div>
        <aside className={styles.heroControl} aria-label="Så fungerar skapandet">
          <span className={styles.controlKicker}>ARBETA I UTKAST</span>
          <strong>Skapa först. Bestäm sedan.</strong>
          <p>Prova flera riktningar utan att något skickas, schemaläggs eller publiceras.</p>
          <div className={styles.controlFacts}>
            <span><i />AI Gateway</span>
            <span><i />Vercel + Neon</span>
          </div>
        </aside>
      </div>

      <nav className={styles.flowNav} aria-label="Content Engine-flöde">
        {(Object.keys(stageCopy) as EngineStageId[]).map((stage) => (
          <button
            type="button"
            className={`${styles.flowStep} ${activeStage === stage ? styles.flowStepActive : ""}`}
            onClick={() => selectStage(stage)}
            key={stage}
            aria-current={activeStage === stage ? "step" : undefined}
          >
            <span className={styles.flowNumber}>{stageCopy[stage].number}</span>
            <span className={styles.flowCopy}><strong>{stageCopy[stage].label}</strong><small>{stageCopy[stage].short}</small></span>
            <span className={`${styles.flowState} ${styles[`flowState${capitalize(stageStatus[stage])}`]}`} aria-label={stageStatusLabel(stageStatus[stage])} />
          </button>
        ))}
      </nav>

      {loadState !== "ready" && <section className={`${styles.workspaceNotice} ${loadState === "loading" ? styles.workspaceNoticeLoading : ""}`} aria-live="polite">
        <span className={styles.noticeIcon}><EngineIcon name={loadState === "loading" ? "spinner" : "warning"} /></span>
        <div>
          <strong>{loadState === "loading" ? "Förbereder din skaparyta" : "Vi visar aldrig påhittade flöden"}</strong>
          <p>{loadState === "loading" ? "Vi hämtar sparad röst, format, källurval och modellval från din Vercel-arbetsyta." : loadMessage || "Koppla Vercel-arbetsytan innan du bygger ett flöde."}</p>
        </div>
        {loadState === "unavailable" ? <div className={styles.noticeActions}><button type="button" onClick={() => void reload()}>Försök igen</button><Link href="/settings">Öppna Vercel-inställningar</Link></div> : null}
      </section>}
      {operationMessage && <p className={styles.operationNotice} role="status">{operationMessage}</p>}

      {loadState === "ready" && <div className={styles.workspaceGrid}>
        <div className={styles.mainColumn}>
          <EngineSection
            id="engine-voice"
            number="01"
            eyebrow="GRUNDEN"
            title="Röst och källor"
            description="Lär motorn hur ert företag tänker, pratar och väljer fakta. Det här är er redaktionella grund — inte en generisk prompt."
            tone={stageStatus.voice}
          >
            <div className={styles.voiceGrid}>
              <div className={styles.voiceProfile}>
                <div className={styles.subsectionHeader}>
                  <span className={styles.subsectionIcon}><EngineIcon name="voice" /></span>
                  <div><strong>Er skrivpersona</strong><small>Ton, ordval och redaktionella gränser</small></div>
                  <Link className={styles.inlineAction} href="/studio/brands/new">Nytt varumärke</Link>
                </div>
                {model.personas.length ? <div className={styles.profileList} role="listbox" aria-label="Välj skrivpersona">
                  {model.personas.slice(0, 3).map((profile) => <div className={styles.entityOptionRow} key={profile.id}><button
                    type="button"
                    className={`${styles.profileOption} ${selectedPersona?.id === profile.id ? styles.profileOptionSelected : ""}`}
                    onClick={() => setSelectedPersonaId(profile.id)}
                    role="option"
                    aria-selected={selectedPersona?.id === profile.id}
                  >
                    <span>{profile.initial}</span>
                    <span><strong>{profile.label}</strong><small>{profile.detail || "Redaktionell persona"}</small></span>
                    {selectedPersona?.id === profile.id && <i aria-hidden="true">✓</i>}
                  </button><EntityActions kind="brandProfile" id={profile.id} disabled={!editingAvailable} onEdit={(kind, id) => openEditor(kind, entity(kind, id))} onDelete={deleteEntity} /></div>)}
                </div> : <EmptyState icon="voice" title="Inget varumärke ännu" detail="Börja med onboarding och årsplan. Först därefter blir varumärkets röst tillgänglig för recept och AI-labb." linkHref="/studio/brands/new" linkLabel="Påbörja onboarding" />}
                {selectedPersona && <div className={styles.voiceRule}><span>RÖSTREGEL</span><p>{selectedPersona.detail || "Den här personan har ännu ingen synlig instruktion."}</p></div>}
              </div>
              <div className={styles.sourcePanel}>
                <div className={styles.subsectionHeader}>
                  <span className={styles.subsectionIcon}><EngineIcon name="source" /></span>
                  <div><strong>Faktakällor</strong><small>Det AI:n får luta sig mot</small></div>
                  <span className={styles.countChip}>{model.sources.length}</span>
                  <button type="button" className={styles.inlineAction} onClick={() => openEditor("source")} disabled={!editingAvailable}>Lägg till</button>
                </div>
                {model.sources.length ? <ul className={styles.sourceList}>
                  {model.sources.slice(0, 4).map((source) => <li key={source.id}><span className={styles.sourceMark}>{source.type}</span><span><strong>{source.label}</strong><small>{source.detail || "Källa utan beskrivning"}</small></span><EntityActions kind="source" id={source.id} disabled={!editingAvailable} onEdit={(kind, id) => openEditor(kind, entity(kind, id))} onDelete={deleteEntity} /></li>)}
                </ul> : <EmptyState icon="source" title="Inga källor är valda" detail="Lägg till webbplatser, RSS, kunskapsbank eller egna dokument innan ni låter motorn skriva på fakta." linkHref="/studio/research" linkLabel="Öppna research" />}
                <p className={styles.sourceBoundary}><EngineIcon name="shield" />Källor är ett urval — inte ett påstående om att AI:n har läst hela internet.</p>
              </div>
            </div>
            <div className={styles.modelManagement}>
              <div><span className={styles.subsectionIcon}><EngineIcon name="spark" /></span><span><strong>AI-policy och modellval</strong><small>{model.models.length} sparade modellprofiler · {workspace?.modelPolicies.length ?? 0} policies</small></span></div>
              <p>När en sparad skrivpolicy kopplas till ett recept styr den AI-labbets Gateway-modeller. Utan policy använder labbet dina tillfälliga jämförelseval.</p>
              <span className={styles.modelManagementActions}><button type="button" className={styles.secondaryButton} onClick={() => openEditor("modelPreset")} disabled={!editingAvailable}>Ny modellprofil</button><button type="button" className={styles.secondaryButton} onClick={() => openEditor("modelPolicy")} disabled={!editingAvailable}>Ny AI-policy</button></span>
            </div>
            {(model.models.length || workspace?.modelPolicies.length) ? <div className={styles.entityManageList}>
              {model.models.slice(0, 5).map((item) => <div key={item.id}><span><strong>{item.label}</strong><small>{item.detail || "Modellprofil"}</small></span><EntityActions kind="modelPreset" id={item.id} disabled={!editingAvailable} onEdit={(kind, id) => openEditor(kind, entity(kind, id))} onDelete={deleteEntity} /></div>)}
              {(workspace?.modelPolicies ?? []).slice(0, 5).map((item) => <div key={String(item.id)}><span><strong>{text(item, ["name", "label", "title"])}</strong><small>AI-policy · {text(item, ["taskKind"])}</small></span><EntityActions kind="modelPolicy" id={String(item.id)} disabled={!editingAvailable} onEdit={(kind, id) => openEditor(kind, entity(kind, id))} onDelete={deleteEntity} /></div>)}
            </div> : null}
          </EngineSection>

          <EngineSection
            id="engine-recipe"
            number="02"
            eyebrow="FORMEN"
            title="Receptet gör jobbet repeterbart"
            description="Ett recept binder ihop avsikt, format, bildriktning och kvalitetsgränser. Du provar det först — sedan kan det användas av en automation."
            tone={stageStatus.recipe}
          >
            <div className={styles.actionRow}><span className={styles.actionHint}>Sparade recept blir återanvändbara i AI-labbet och automationer.</span><button type="button" className={styles.secondaryButton} onClick={() => openEditor("recipe")} disabled={!editingAvailable}>+ Nytt recept</button></div>
            {model.recipes.length ? <div className={styles.recipeList} role="listbox" aria-label="Välj recept">
              {model.recipes.map((recipe) => <div className={styles.entityOptionRow} key={recipe.id}><button
                type="button"
                className={`${styles.recipeOption} ${selectedRecipe?.id === recipe.id ? styles.recipeOptionSelected : ""}`}
                onClick={() => setSelectedRecipeId(recipe.id)}
                role="option"
                aria-selected={selectedRecipe?.id === recipe.id}
              >
                <span className={styles.recipeNumber}>{recipe.position}</span>
                <span className={styles.recipeCopy}><strong>{recipe.label}</strong><small>{recipe.detail || "Mål, struktur och bildriktning"}</small><em>{recipe.type}</em></span>
                <span className={styles.recipeArrow} aria-hidden="true">→</span>
              </button><EntityActions kind="recipe" id={recipe.id} disabled={!editingAvailable} onEdit={(kind, id) => openEditor(kind, entity(kind, id))} onDelete={deleteEntity} /></div>)}
            </div> : <EmptyState icon="recipe" title="Börja med ett recept" detail="Välj ett format och skriv vilken nytta, längd och bildstil som ska återkomma. Mallen blir sedan basen för test och automation." linkHref="/studio/templates" linkLabel="Öppna mallar" />}
            {selectedRecipe && <div className={styles.recipeSummary}>
              <span><EngineIcon name="spark" /></span>
              <div><small>VALT RECEPT</small><strong>{selectedRecipe.label}</strong><p>{selectedRecipe.detail || "Receptet är klart att provköra i AI-labbet."}</p></div>
              <button type="button" onClick={() => selectStage("lab")}>Testa i labbet <span aria-hidden="true">→</span></button>
            </div>}
          </EngineSection>

          <EngineSection
            id="engine-lab"
            number="03"
            eyebrow="AI-LABBET"
            title="Kör tre riktiga förslag innan något blir ett utkast"
            description={recipeUsesSavedPolicy
              ? "Receptets sparade AI-policy väljer Gateway-modellerna. Här jämför du rösten, strukturen och ämnesvinkeln — utan att skriva till kalendern eller en kanal."
              : "AI Gateway väljer bara de modeller du har kryssat i. Här jämför du rösten, strukturen och ämnesvinkeln — utan att skriva till kalendern eller en kanal."}
            tone={stageStatus.lab}
          >
            <form className={styles.labForm} onSubmit={runLab}>
              <div className={styles.labInputRow}>
                <label>
                  <span>Ämne att prova</span>
                  <textarea value={topic} onChange={(event) => setTopic(event.target.value)} placeholder="Till exempel: Så hjälper vår verkstad kunderna när bilen inte startar en kall måndag." rows={3} disabled={loadState !== "ready"} />
                  <small>Skriv en riktig ingång. Provkörningen sparar ingenting.</small>
                </label>
                <div className={styles.labContext}>
                  <span>PROVKÖRNING MED</span>
                  <strong>{selectedPersona?.label || "Välj persona"}</strong>
                  <small>{selectedRecipe?.label || "Välj recept"}</small>
                  <div><i />Inget publiceras här</div>
                </div>
              </div>

              <aside className={styles.labSeriesReference} aria-live="polite" aria-label="Seriesreferens för AI-labbet">
                {effectiveSeriesReferenceState === "loading" && <>
                  <span className={styles.labSeriesMark}><EngineIcon name="spinner" /></span>
                  <div><small>SERIESREFERENS</small><strong>Kontrollerar den valda referensen</strong><p>AI-labbet väntar tills arbetsytan har bekräftat en aktiv, fryst referenspost.</p></div>
                </>}
                {effectiveSeriesReferenceState === "ready" && confirmedSeriesReference && <>
                  <span className={styles.labSeriesMark}><EngineIcon name="recipe" /></span>
                  <div>
                    <small>AKTIV SERIESREFERENS</small>
                    <strong>{confirmedSeriesReference.name}</strong>
                    <p>Referenspost: {confirmedSeriesReference.reference.title}</p>
                    <ul aria-label="Aktiva serieskontroller">
                      <li>{seriesToneLabel(confirmedSeriesReference.controls?.tone)}</li>
                      <li>{confirmedSeriesReference.controls?.audience}</li>
                      <li>Granskning krävs</li>
                    </ul>
                  </div>
                  <Link href="/studio/series">Visa serie <span aria-hidden="true">→</span></Link>
                </>}
                {effectiveSeriesReferenceState === "idle" && <>
                  <span className={styles.labSeriesMark}><EngineIcon name="recipe" /></span>
                  <div><small>INGEN SERIESREFERENS VALD</small><strong>Det här är ett fristående labbtest.</strong><p>Skapa och aktivera en referenspost om provet ska jämföras mot en sparad serieram.</p></div>
                  <Link href="/studio/series">Öppna serier <span aria-hidden="true">→</span></Link>
                </>}
                {(effectiveSeriesReferenceState === "unavailable" || effectiveSeriesReferenceState === "not_available") && <>
                  <span className={`${styles.labSeriesMark} ${styles.labSeriesMarkWarning}`}><EngineIcon name="warning" /></span>
                  <div><small>SERIESREFERENS KAN INTE ANVÄNDAS</small><strong>AI-labbet fortsätter inte med den här länken.</strong><p>{seriesReferenceMessage}</p></div>
                  <Link href="/studio/series">Öppna serier <span aria-hidden="true">→</span></Link>
                </>}
              </aside>

              <fieldset className={styles.modelPicker} disabled={loadState !== "ready" || labState === "running"}>
                <legend>{recipeUsesSavedPolicy ? `Receptets AI-policy: ${text(selectedRecipePolicy ?? {}, ["name", "label"]) || "Sparad policy"}` : "Välj två eller tre perspektiv"}</legend>
                {recipeUsesSavedPolicy ? <div className={styles.policyModelSummary} aria-live="polite">
                  {selectedPolicyModels.slice(0, 3).map((model) => <div key={model.id}>
                    <span className={styles.modelLogo}>{model.label.slice(0, 1)}</span>
                    <span><strong>{model.label}</strong><small>{model.modelId}</small></span>
                    <i aria-hidden="true">✓</i>
                  </div>)}
                  {!selectedPolicyModels.length && <p>Policyn saknar aktiva skrivmodeller. Redigera policyn innan du kör labbet.</p>}
                </div> : <div>
                  {availableProviders(model.models).map((provider) => <label key={provider.id} className={selectedProviders.includes(provider.id) ? styles.modelSelected : undefined}>
                    <input type="checkbox" checked={selectedProviders.includes(provider.id)} onChange={() => toggleProvider(provider.id)} />
                    <span className={styles.modelLogo}>{provider.label.slice(0, 1)}</span>
                    <span><strong>{provider.label}</strong><small>{provider.detail}</small></span>
                    <i aria-hidden="true">✓</i>
                  </label>)}
                </div>}
              </fieldset>

              <div className={styles.labActions}>
                <button type="submit" className={styles.primaryButton} disabled={!canRunLab || labState === "running"}>
                  {labState === "running" ? <><EngineIcon name="spinner" />Skapar variationer</> : <><EngineIcon name="spark" />Skapa {effectiveComparisonCount || 0} variationer</>}
                </button>
                {!hasFoundation && <p>Välj en skrivpersona och ett recept först.</p>}
                {hasFoundation && topic.trim().length < 6 && <p>Skriv ett ämne med minst några ord.</p>}
                {hasFoundation && recipeUsesSavedPolicy && !selectedRecipePolicy && <p>Receptets AI-policy finns inte längre i arbetsytan.</p>}
                {hasFoundation && recipeUsesSavedPolicy && selectedRecipePolicy && !selectedRecipePolicyIsWriting && <p>Receptets AI-policy är inte en skrivpolicy. Välj en skrivpolicy innan du kör labbet.</p>}
                {hasFoundation && recipeUsesSavedPolicy && selectedRecipePolicyIsWriting && selectedPolicyModels.length < 2 && <p>AI-policyn behöver minst två aktiva skrivmodeller för en jämförelse.</p>}
                {hasFoundation && !recipeUsesSavedPolicy && selectedProviders.length < 2 && <p>Välj minst två modeller för en jämförelse.</p>}
                {hasFoundation && seriesId && effectiveSeriesReferenceState === "loading" && <p>Kontrollerar den valda seriesreferensen innan testet kan köras.</p>}
                {hasFoundation && seriesId && effectiveSeriesReferenceState === "not_available" && <p>Aktivera referensen i Serier eller välj en annan aktiv serie.</p>}
                {hasFoundation && seriesId && effectiveSeriesReferenceState === "unavailable" && <p>Seriesreferensen behöver kunna läsas innan testet kan köras.</p>}
              </div>
            </form>

            {labMessage && <div className={`${styles.labNotice} ${labState === "error" ? styles.labNoticeError : ""}`} role={labState === "error" ? "alert" : "status"}>
              <EngineIcon name={labState === "error" ? "warning" : "check"} />
              <p>{labMessage}</p>
            </div>}

            {variations.length ? <div className={styles.variationLayout}>
              <div className={styles.variationList} role="listbox" aria-label="AI-variationer">
                {variations.map((variation, index) => <button type="button" key={variation.id} onClick={() => setSelectedVariationId(variation.id)} className={selectedVariation?.id === variation.id ? styles.variationSelected : ""} role="option" aria-selected={selectedVariation?.id === variation.id}>
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <span><strong>{variation.label || `Variation ${index + 1}`}</strong><small>{variation.provider} · {variation.model}</small></span>
                  <i aria-hidden="true">→</i>
                </button>)}
              </div>
              {selectedVariation && <article className={styles.variationPreview} aria-label="Vald AI-variation">
                <header><span>{selectedVariation.provider}</span><small>{selectedVariation.model}</small></header>
                <p className={styles.previewSubject}>{selectedVariation.draft.subject || selectedVariation.draft.title}</p>
                <h3>{selectedVariation.draft.headline || selectedVariation.draft.title}</h3>
                <p>{selectedVariation.draft.previewText || selectedVariation.draft.excerpt}</p>
                <footer><span>{selectedVariation.draft.callToAction || "Ingen uppmaning angiven"}</span><button type="button" onClick={() => selectStage("distribution")}>Välj nästa steg <span aria-hidden="true">→</span></button></footer>
              </article>}
            </div> : <div className={styles.labPlaceholder}><span><EngineIcon name="spark" /></span><div><strong>Här visas dina variationer</strong><p>Jämför sedan rubrik, öppning, text och bildriktning. Den här ytan är en provbänk, inte en publiceringskö.</p></div></div>}
          </EngineSection>

          <EngineSection
            id="engine-distribution"
            number="04"
            eyebrow="DRIFT"
            title="Godkänn, välj frekvens och förbered"
            description="När ett recept fungerar bestämmer du när det får köras och vilken destination som ska förberedas. Ett tydligt sista beslut skiljer prov, utkast och faktisk leverans åt."
            tone={stageStatus.distribution}
          >
            <div className={styles.distributionGrid}>
              <div className={styles.approvalCard}>
                <span className={styles.approvalIcon}><EngineIcon name="check" /></span>
                <div><small>GODKÄNNANDE</small><strong>Alltid ett sista redaktionellt steg</strong><p>Automationer kan skapa privata utkast. De får inte publicera förbi ditt uttryckliga beslut.</p></div>
                <Link href="/studio/automations">Öppna flöden <span aria-hidden="true">→</span></Link>
              </div>
              <div className={styles.destinationCard}>
                <div className={styles.subsectionHeader}>
                  <span className={styles.subsectionIcon}><EngineIcon name="send" /></span>
                  <div><strong>Destinationer</strong><small>Konton, listor och måladresser som är verifierade eller konfigurerade</small></div>
                  <span className={styles.countChip}>{model.destinations.length}</span>
                  <button type="button" className={styles.inlineAction} onClick={() => openEditor("destination")} disabled={!editingAvailable}>Ny destination</button>
                </div>
                {model.destinations.length ? <ul>
                  {model.destinations.slice(0, 5).map((destination) => <li key={destination.id}><span>{destination.initial}</span><strong>{destination.label}</strong><small>{destinationDeliveryDetail(destination)}</small><EntityActions kind="destination" id={destination.id} disabled={!editingAvailable} onEdit={(kind, id) => openEditor(kind, entity(kind, id))} onDelete={deleteEntity} /></li>)}
                </ul> : <EmptyState icon="send" title="Inga destinationer är konfigurerade" detail="Koppla först en nyhetsbrevslista, RSS-måladress eller social kanal. Skaparytan visar bara destinationer som kan bekräftas." linkHref="/studio/channels" linkLabel="Öppna kanaler" />}
              </div>
            </div>
            <p className={styles.sourceBoundary}><EngineIcon name="shield" />En destination sparar vart ett godkänt utkast ska gå. Den aktiverar aldrig utskick eller publicering på egen hand.</p>
            <div className={styles.ruleStrip}>
              <div><span className={styles.ruleIcon}><EngineIcon name="clock" /></span><span><small>SPARADE REGLER</small><strong>{model.rules.length ? `${model.rules.length} distributionsregler` : "Inga tider eller kanaler är satta"}</strong></span></div>
              {model.rules.length ? <div className={styles.ruleManageList}>{model.rules.slice(0, 4).map((rule) => <span key={rule.id}><strong>{rule.label}</strong><EntityActions kind="distributionRule" id={rule.id} disabled={!editingAvailable} onEdit={(kind, id) => openEditor(kind, entity(kind, id))} onDelete={deleteEntity} /></span>)}</div> : <p>Skapa först ett recept som fungerar. Därefter väljer du frekvens, tid, kanal och om godkännande krävs.</p>}
              <button type="button" className={styles.secondaryButton} onClick={() => openEditor("distributionRule")} disabled={!editingAvailable}>+ Ny regel</button>
              <Link href="/studio/automations">Hantera regler <span aria-hidden="true">→</span></Link>
            </div>
          </EngineSection>
        </div>

        <aside className={styles.sideColumn}>
          <section className={styles.controlPanel} aria-labelledby="engine-control-title">
            <p className={styles.eyebrow}>KONTROLLPANEL</p>
            <h2 id="engine-control-title">Vad återstår?</h2>
            <ol>
              <ControlRow number="01" label="Röst" complete={Boolean(model.personas.length)} detail={model.personas.length ? "Persona finns" : "Beskriv företaget"} onClick={() => selectStage("voice")} />
              <ControlRow number="02" label="Recept" complete={Boolean(model.recipes.length)} detail={model.recipes.length ? "Format valt" : "Bygg ett format"} onClick={() => selectStage("recipe")} />
              <ControlRow number="03" label="Test" complete={Boolean(variations.length)} detail={variations.length ? "Variationer klara" : "Prova med AI"} onClick={() => selectStage("lab")} />
              <ControlRow number="04" label="Drift" complete={false} detail={model.destinations.length && model.rules.length ? "Utkastsflöde konfigurerat" : model.destinations.length ? "Lägg till en regel" : "Konfigurera destination"} onClick={() => selectStage("distribution")} />
            </ol>
            <footer><EngineIcon name="shield" />Visar endast verklig Vercel-data. Inga testvärden skrivs tillbaka här.</footer>
          </section>

          <section className={styles.mediaCard} aria-labelledby="engine-media-title">
            <div className={styles.mediaVisual} aria-hidden="true"><span /><span /><i /></div>
            <div className={styles.mediaBody}>
              <p className={styles.eyebrow}>BILDRIKTNING</p>
              <h2 id="engine-media-title">Egna bilder, licensierat eller AI — alltid med kontroll.</h2>
              <p>Bildmotorn kan få en riktning från receptet. Filer stannar privata i Vercel Blob tills de godkänns i ett riktigt utkast.</p>
              <Link href="/studio/content/new?edit=1">Öppna bildflödet <span aria-hidden="true">→</span></Link>
            </div>
          </section>

          <section className={styles.boundaryCard}>
            <span><EngineIcon name="shield" /></span>
            <div><strong>En motor, flera format.</strong><p>Din röst och dina fakta kan delas. Regler, mottagare och publicering är alltid separata per destination.</p></div>
          </section>
        </aside>
      </div>}
      {editorKind && <EngineEntityEditor
        kind={editorKind}
        data={workspace}
        entity={editorEntity}
        state={editorState}
        message={editorMessage}
        onClose={closeEditor}
        onSave={(input) => void saveEntity(editorKind, input, editorEntity?.id)}
      />}
    </section>
  );
}

function EngineSection({ id, number, eyebrow, title, description, tone, children }: { id: string; number: string; eyebrow: string; title: string; description: string; tone: "complete" | "ready" | "waiting"; children: React.ReactNode }) {
  return <section className={`${styles.section} ${styles[`section${capitalize(tone)}`]}`} id={id} aria-labelledby={`${id}-title`}>
    <header className={styles.sectionHeader}>
      <span className={styles.sectionNumber}>{number}</span>
      <div><p className={styles.eyebrow}>{eyebrow}</p><h2 id={`${id}-title`}>{title}</h2><p>{description}</p></div>
      <span className={`${styles.sectionStatus} ${styles[`sectionStatus${capitalize(tone)}`]}`}>{stageStatusLabel(tone)}</span>
    </header>
    <div className={styles.sectionBody}>{children}</div>
  </section>;
}

function EmptyState({ icon, title, detail, linkHref, linkLabel }: { icon: IconName; title: string; detail: string; linkHref: string; linkLabel: string }) {
  return <div className={styles.emptyState}>
    <span><EngineIcon name={icon} /></span>
    <div><strong>{title}</strong><p>{detail}</p><Link href={linkHref}>{linkLabel} <span aria-hidden="true">→</span></Link></div>
  </div>;
}

type EditorProps = {
  kind: EngineEditorKind;
  data: EngineWorkspaceData | null;
  entity: EngineWorkspaceEntity | null;
  state: "idle" | "saving" | "error";
  message: string | null;
  onClose: () => void;
  onSave: (input: Record<string, unknown>) => void;
};

const editorCopy: Record<EngineEditorKind, { title: string; eyebrow: string; description: string }> = {
  brandProfile: { title: "Ny skrivpersona", eyebrow: "RÖST", description: "Beskriv företaget, målgruppen och hur ni faktiskt vill låta." },
  source: { title: "Ny faktakälla", eyebrow: "KÄLLA", description: "Lägg till en HTTPS-källa eller ett eget referensunderlag." },
  recipe: { title: "Nytt innehållsrecept", eyebrow: "RECEPT", description: "Sätt formatet och instruktionen som ska återkomma i varje körning." },
  modelPreset: { title: "Ny modellprofil", eyebrow: "AI GATEWAY", description: "Tillåt en modell via Vercel AI Gateway. Spara inga API-nycklar här." },
  modelPolicy: { title: "Ny AI-policy", eyebrow: "MODELLVAL", description: "Bestäm ordning och fallback för en framtida generator- eller automatiseringskörning." },
  destination: { title: "Ny destination", eyebrow: "KANAL", description: "Välj en kanal som finns ansluten i din Vercel-arbetsyta." },
  distributionRule: { title: "Ny distributionsregel", eyebrow: "AUTOMATION", description: "Koppla recept och destination med manuell eller schemalagd utkastsgenerering." },
};

function EngineEntityEditor({ kind, data, entity, state, message, onClose, onSave }: EditorProps) {
  const [form, setForm] = useState<Record<string, string>>(() => editorFormDefaults(kind, entity));
  const [formError, setFormError] = useState<string | null>(null);
  const copy = editorCopy[kind];
  const editing = Boolean(entity?.id);
  const set = (name: string, value: string) => { setFormError(null); setForm((current) => ({ ...current, [name]: value })); };
  const toggle = (name: string) => set(name, form[name] === "true" ? "false" : "true");
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      setFormError(null);
      onSave(buildEditorInput(kind, form, data));
    } catch (error) {
      // Validation stays local to the draft; nothing is closed or persisted.
      setFormError(error instanceof Error ? error.message : "Kontrollera formuläret.");
    }
  };
  const presets = data?.modelPresets ?? [];
  const profiles = data?.brandProfiles ?? [];
  const recipes = data?.recipes ?? [];
  const destinations = data?.destinations ?? [];
  const sources = data?.sources ?? [];
  const policies = data?.modelPolicies ?? [];
  const writingPolicies = policies.filter((policy) => text(policy, ["taskKind"]) === "writing" || String(policy.id) === form.modelPolicyId);
  const socialConnections = data?.availableDestinations?.socialConnections ?? [];
  const newsletterAudiences = data?.availableDestinations?.newsletterAudiences ?? [];

  return <div className={styles.editorBackdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className={styles.editorDialog} role="dialog" aria-modal="true" aria-labelledby="engine-editor-title">
      <header className={styles.editorHeader}><div><p className={styles.eyebrow}>{copy.eyebrow}</p><h2 id="engine-editor-title">{editing ? `Redigera ${copy.title.toLocaleLowerCase("sv-SE").replace(/^ny /, "")}` : copy.title}</h2><p>{copy.description}</p></div><button type="button" className={styles.editorClose} onClick={onClose} aria-label="Stäng">×</button></header>
      <form className={styles.editorForm} onSubmit={submit}>
        {(kind === "brandProfile" || kind === "source" || kind === "recipe" || kind === "modelPreset" || kind === "modelPolicy" || kind === "destination" || kind === "distributionRule") && <div className={styles.formGrid}><Field label="Namn" value={form.name} onChange={(value) => set("name", value)} required placeholder="Till exempel Vår röst" /><Field label="Slug" value={form.slug} onChange={(value) => set("slug", value)} required placeholder="var-rost" hint="Små bokstäver, siffror och bindestreck." /></div>}

        {kind === "brandProfile" && <>
          <div className={styles.formGrid}><Field label="Företag" value={form.organizationName} onChange={(value) => set("organizationName", value)} /><Field label="Språk" value={form.defaultLanguage} onChange={(value) => set("defaultLanguage", value)} placeholder="sv" /></div>
          <Field label="Vad ska läsaren förstå?" value={form.positioning} onChange={(value) => set("positioning", value)} multiline required placeholder="Vi hjälper småföretag att ..." />
          <div className={styles.formGrid}><Field label="Målgrupp" value={form.audience} onChange={(value) => set("audience", value)} multiline /><Field label="Tonord (en per rad)" value={form.toneTraits} onChange={(value) => set("toneTraits", value)} multiline placeholder="Rak\nVarm\nSaklig" /></div>
          <div className={styles.formGrid}><Field label="Ord att använda" value={form.vocabulary} onChange={(value) => set("vocabulary", value)} multiline /><Field label="Ord att undvika" value={form.avoidPhrases} onChange={(value) => set("avoidPhrases", value)} multiline /></div>
          <Field label="Exempel på er text (valfritt)" value={form.writingSamples} onChange={(value) => set("writingSamples", value)} multiline placeholder="Klistra in ett kort exempel..." />
        </>}

        {kind === "source" && <>
          <div className={styles.formGrid}><label className={styles.field}><span>Typ</span><select value={form.sourceKind} onChange={(event) => set("sourceKind", event.target.value)}><option value="website">Webbplats</option><option value="rss">RSS</option><option value="document">Dokument</option><option value="manual">Manuell referens</option><option value="social_profile">Social profil</option></select></label><Field label="HTTPS-adress" value={form.sourceUrl} onChange={(value) => set("sourceUrl", value)} placeholder="https://..." /></div>
          <Field label="Referensunderlag" value={form.referenceText} onChange={(value) => set("referenceText", value)} multiline placeholder="Egen fakta, produktbeskrivning eller redaktionell grund..." />
          <div className={styles.formGrid}><Field label="Beskrivning" value={form.description} onChange={(value) => set("description", value)} /><Field label="Taggar (en per rad)" value={form.tags} onChange={(value) => set("tags", value)} multiline /></div>
        </>}

        {kind === "recipe" && <>
          <div className={styles.formGrid}><label className={styles.field}><span>Format</span><select value={form.contentType} onChange={(event) => set("contentType", event.target.value)}><option value="newsletter">Nyhetsbrev</option><option value="social_post">Socialt inlägg</option><option value="article">Artikel</option><option value="campaign">Kampanj</option></select></label><label className={styles.field}><span>Skrivpersona</span><select value={form.brandProfileId} onChange={(event) => set("brandProfileId", event.target.value)}><option value="">Ingen vald</option>{profiles.map((item) => <option key={String(item.id)} value={String(item.id)}>{text(item, ["name", "label", "title"])}</option>)}</select></label></div>
          <label className={styles.field}><span>AI-policy</span><select value={form.modelPolicyId} onChange={(event) => set("modelPolicyId", event.target.value)}><option value="">Ingen vald</option>{writingPolicies.map((item) => <option key={String(item.id)} value={String(item.id)}>{text(item, ["name", "label", "title"])}{text(item, ["taskKind"]) === "writing" ? "" : " (inte skrivpolicy)"}</option>)}</select><small>En sparad skrivpolicy styr AI-labbets Gateway-modeller. Den behöver minst två aktiva skrivmodeller för jämförelse.</small></label>
          <label className={styles.field}><span>Källor som receptet får använda</span><select multiple value={form.sourceIds ? form.sourceIds.split(",").filter(Boolean) : []} onChange={(event) => set("sourceIds", Array.from(event.target.selectedOptions, (option) => option.value).join(","))}>{sources.map((item) => <option key={String(item.id)} value={String(item.id)}>{text(item, ["name", "label", "title"])}</option>)}</select><small>Håll Ctrl/Cmd för flera källor.</small></label>
          <Field label="Instruktion till motorn" value={form.instructions} onChange={(value) => set("instructions", value)} multiline required placeholder="Skriv en tydlig öppning, håll texten konkret och avsluta med ..." />
        </>}

        {kind === "modelPreset" && <><div className={styles.formGrid}><label className={styles.field}><span>Leverantör</span><select value={form.provider} onChange={(event) => set("provider", event.target.value)}><option value="openai">OpenAI</option><option value="anthropic">Anthropic / Claude</option><option value="google">Google / Gemini</option><option value="xai">xAI / Grok</option><option value="other">Annan</option></select></label><Field label="Gateway-modell" value={form.modelId} onChange={(value) => set("modelId", value)} required placeholder="openai/gpt-5.4" /></div><label className={styles.field}><span>Uppgifter (en per rad)</span><textarea value={form.taskKinds} onChange={(event) => set("taskKinds", event.target.value)} rows={3} placeholder="writing\nresearch" /></label><p className={styles.formHint}>Använd modellens provider-qualified ID från Vercel AI Gateway.</p></>}

        {kind === "modelPolicy" && <><div className={styles.formGrid}><label className={styles.field}><span>Uppgift</span><select value={form.taskKind} onChange={(event) => set("taskKind", event.target.value)}><option value="writing">Skrivande</option><option value="research">Research</option><option value="image">Bild</option><option value="vision">Bildförståelse</option><option value="summarization">Sammanfattning</option></select></label><label className={styles.field}><span>Urvalsstrategi</span><select value={form.selectionMode} onChange={(event) => set("selectionMode", event.target.value)}><option value="primary_then_fallback">Primär → fallback</option><option value="quality_first">Kvalitet först</option><option value="cost_aware">Kostnadsmedveten</option><option value="manual">Manuell</option></select></label></div><label className={styles.field}><span>Modeller i ordning</span><select multiple value={form.presetIds ? form.presetIds.split(",").filter(Boolean) : []} onChange={(event) => set("presetIds", Array.from(event.target.selectedOptions, (option) => option.value).join(","))}>{presets.map((item) => <option key={String(item.id)} value={String(item.id)}>{text(item, ["name", "label", "modelId"])}</option>)}</select><small>Första valda modellen blir prioritet 1.</small></label></>}

        {kind === "destination" && <><label className={styles.field}><span>Destinationstyp</span><select value={form.destinationKind} onChange={(event) => set("destinationKind", event.target.value)}><option value="newsletter">Nyhetsbrev</option><option value="rss">RSS</option><option value="social">Social kanal</option><option value="website">Webbplats</option></select></label>{form.destinationKind === "social" && <label className={styles.field}><span>Anslutet socialt konto</span><select value={form.connectionId} onChange={(event) => set("connectionId", event.target.value)} required><option value="">Välj anslutet konto</option>{socialConnections.map((item) => <option key={String(item.id)} value={String(item.id)}>{text(item, ["name", "label", "title", "provider"])}</option>)}</select>{!socialConnections.length && <small>Inga bekräftade sociala konton finns. Anslut ett konto under Kanaler först.</small>}</label>}{form.destinationKind === "newsletter" && <label className={styles.field}><span>Mottagarlista</span><select value={form.connectionId} onChange={(event) => set("connectionId", event.target.value)} required><option value="">Välj mottagarlista</option>{newsletterAudiences.map((item) => <option key={String(item.id)} value={String(item.id)}>{text(item, ["name", "label", "title"])}</option>)}</select>{!newsletterAudiences.length && <small>Ingen mottagarlista finns ännu. Skapa eller anslut en lista först.</small>}</label>}{(form.destinationKind === "rss" || form.destinationKind === "website") && <Field label="Publik HTTPS-adress" value={form.publicUrl} onChange={(value) => set("publicUrl", value)} required placeholder="https://example.se/feed.xml" />}<Field label="Teknisk konfiguration (JSON, valfritt)" value={form.destinationConfig} onChange={(value) => set("destinationConfig", value)} multiline placeholder="{ }" /><p className={styles.formHint}>Kopplingar och hemligheter hanteras i Vercel. Lägg aldrig tokens i detta formulär.</p></>}

        {kind === "distributionRule" && <><div className={styles.formGrid}><label className={styles.field}><span>Recept</span><select value={form.recipeId} onChange={(event) => set("recipeId", event.target.value)} required><option value="">Välj recept</option>{recipes.map((item) => <option key={String(item.id)} value={String(item.id)}>{text(item, ["name", "label", "title"])}</option>)}</select></label><label className={styles.field}><span>Destination</span><select value={form.destinationId} onChange={(event) => set("destinationId", event.target.value)} required><option value="">Välj destination</option>{destinations.map((item) => <option key={String(item.id)} value={String(item.id)}>{text(item, ["name", "label", "title"])}</option>)}</select></label></div><div className={styles.formGrid}><label className={styles.field}><span>Körläge</span><select value={form.deliveryMode} onChange={(event) => set("deliveryMode", event.target.value)}><option value="manual">Manuell</option><option value="scheduled">Schemalagd</option><option value="event">Vid händelse</option></select></label><Field label="Schema (JSON)" value={form.scheduleConfig} onChange={(value) => set("scheduleConfig", value)} placeholder={form.deliveryMode === "scheduled" ? '{"cron":"0 9 * * 1"}' : "{}"} /></div><label className={styles.checkboxField}><input type="checkbox" checked={form.approvalRequired !== "false"} onChange={() => toggle("approvalRequired")} /><span>Skapa alltid utkast för godkännande</span></label><p className={styles.formHint}>Regeln skapar privata utkast. E-post, RSS och social publicering kräver en separat aktiverad leveransadapter.</p></>}

        <label className={styles.checkboxField}><input type="checkbox" checked={form.active !== "false"} onChange={() => toggle("active")} /><span>Aktiv efter sparande</span></label>
        {(message || formError) && <p className={styles.editorError} role="alert">{message || formError}</p>}
        <footer className={styles.editorFooter}><button type="button" className={styles.secondaryButton} onClick={onClose} disabled={state === "saving"}>Avbryt</button><button type="submit" className={styles.primaryButton} disabled={state === "saving"}>{state === "saving" ? <><EngineIcon name="spinner" />Sparar...</> : editing ? "Spara ändringar" : "Spara i arbetsytan"}</button></footer>
      </form>
    </section>
  </div>;
}

function Field({ label, value, onChange, multiline = false, required = false, placeholder, hint }: { label: string; value: string; onChange: (value: string) => void; multiline?: boolean; required?: boolean; placeholder?: string; hint?: string }) {
  return <label className={styles.field}><span>{label}</span>{multiline ? <textarea value={value} onChange={(event) => onChange(event.target.value)} rows={3} required={required} placeholder={placeholder} /> : <input value={value} onChange={(event) => onChange(event.target.value)} required={required} placeholder={placeholder} />}{hint && <small>{hint}</small>}</label>;
}

function ControlRow({ number, label, detail, complete, onClick }: { number: string; label: string; detail: string; complete: boolean; onClick: () => void }) {
  return <li>
    <button type="button" onClick={onClick}>
      <span>{number}</span><span><strong>{label}</strong><small>{detail}</small></span><i className={complete ? styles.controlComplete : undefined}>{complete ? "✓" : "→"}</i>
    </button>
  </li>;
}

function EntityActions({ kind, id, disabled, onEdit, onDelete }: { kind: EngineEditorKind; id: string; disabled: boolean; onEdit: (kind: EngineEditorKind, id: string) => void; onDelete: (kind: EngineEditorKind, id: string) => void }) {
  return <span className={styles.entityActions} onClick={(event) => event.stopPropagation()}><button type="button" onClick={() => onEdit(kind, id)} disabled={disabled}>Redigera</button><button type="button" className={styles.entityDelete} onClick={() => onDelete(kind, id)} disabled={disabled}>Ta bort</button></span>;
}

function editorFormDefaults(kind: EngineEditorKind, entity?: EngineWorkspaceEntity | null): Record<string, string> {
  const base = { name: "", slug: "", description: "", active: "true" };
  if (kind === "brandProfile") { const voice = asRecord(entity?.voice); return { ...base, name: text(entity ?? {}, ["name"]), slug: text(entity ?? {}, ["slug"]), organizationName: text(entity ?? {}, ["organizationName"]), defaultLanguage: text(entity ?? {}, ["defaultLanguage"]) || "sv", positioning: text(voice ?? {}, ["positioning"]), audience: text(voice ?? {}, ["audience"]), toneTraits: listText(voice?.toneTraits), vocabulary: listText(voice?.vocabulary), avoidPhrases: listText(voice?.avoidPhrases), writingSamples: listText(voice?.writingSamples), active: entity?.active === false ? "false" : "true" }; }
  if (kind === "source") return { ...base, name: text(entity ?? {}, ["name"]), slug: text(entity ?? {}, ["slug"]), sourceKind: text(entity ?? {}, ["sourceKind"]) || "website", sourceUrl: text(entity ?? {}, ["sourceUrl"]), referenceText: text(entity ?? {}, ["referenceText"]), description: text(entity ?? {}, ["description"]), trustLevel: String(entity?.trustLevel ?? 3), tags: listText(entity?.tags), active: entity?.active === false ? "false" : "true" };
  if (kind === "recipe") return { ...base, name: text(entity ?? {}, ["name"]), slug: text(entity ?? {}, ["slug"]), description: text(entity ?? {}, ["description"]), contentType: text(entity ?? {}, ["contentType"]) || "newsletter", brandProfileId: text(entity ?? {}, ["brandProfileId"]), modelPolicyId: text(entity ?? {}, ["modelPolicyId"]), instructions: text(entity ?? {}, ["instructions"]), sourceIds: listText(entity?.sourceIds, ","), active: entity?.active === false ? "false" : "true" };
  if (kind === "modelPreset") return { ...base, name: text(entity ?? {}, ["name"]), slug: text(entity ?? {}, ["slug"]), provider: text(entity ?? {}, ["provider"]) || "openai", modelId: text(entity ?? {}, ["modelId"]) || "openai/gpt-5.4", taskKinds: listText(entity?.taskKinds), enabled: entity?.enabled === false ? "false" : "true", active: entity?.enabled === false ? "false" : "true" };
  if (kind === "modelPolicy") return { ...base, name: text(entity ?? {}, ["name"]), slug: text(entity ?? {}, ["slug"]), taskKind: text(entity ?? {}, ["taskKind"]) || "writing", selectionMode: text(entity ?? {}, ["selectionMode"]) || "primary_then_fallback", presetIds: listText((entity?.steps as unknown[] | undefined)?.flatMap((step) => { const row = asRecord(step); return row?.presetId ? [row.presetId] : []; }), ","), active: entity?.active === false ? "false" : "true" };
  if (kind === "destination") { const config = asRecord(entity?.destinationConfig); return { ...base, name: text(entity ?? {}, ["name"]), slug: text(entity ?? {}, ["slug"]), destinationKind: text(entity ?? {}, ["destinationKind"]) || "newsletter", connectionId: text(entity ?? {}, ["socialConnectionId", "newsletterAudienceId"]), publicUrl: text(config ?? {}, ["targetUrl", "publicUrl"]), destinationConfig: config ? JSON.stringify(config, null, 2) : "", active: entity?.active === false ? "false" : "true" }; }
  return { ...base, name: text(entity ?? {}, ["name"]), slug: text(entity ?? {}, ["slug"]), recipeId: text(entity ?? {}, ["recipeId"]), destinationId: text(entity ?? {}, ["destinationId"]), deliveryMode: text(entity ?? {}, ["deliveryMode"]) || "manual", scheduleConfig: entity?.scheduleConfig ? JSON.stringify(entity.scheduleConfig, null, 2) : "{}", approvalRequired: entity?.approvalRequired === false ? "false" : "true", active: entity?.active === false ? "false" : "true" };
}

function listText(value: unknown, separator = "\n") {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").join(separator) : "";
}

function lines(value: string) {
  return value.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean);
}

function jsonObject(value: string, label = "JSON-fältet") {
  if (!value.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    throw new Error(`${label} måste vara ett JSON-objekt.`);
  } catch {
    throw new Error(`${label} innehåller ogiltig JSON.`);
  }
}

function buildEditorInput(kind: EngineEditorKind, form: Record<string, string>, data: EngineWorkspaceData | null): Record<string, unknown> {
  const base = { slug: form.slug.trim(), name: form.name.trim(), active: form.active !== "false" };
  if (kind === "brandProfile") return { ...base, organizationName: form.organizationName.trim(), summary: "", defaultLanguage: form.defaultLanguage.trim() || "sv", voice: { positioning: form.positioning.trim(), audience: form.audience.trim(), toneTraits: lines(form.toneTraits), vocabulary: lines(form.vocabulary), avoidPhrases: lines(form.avoidPhrases), writingSamples: lines(form.writingSamples) }, profileConfig: {}, isDefault: false };
  if (kind === "source") return { ...base, sourceKind: form.sourceKind, sourceUrl: form.sourceUrl.trim() || null, referenceText: form.referenceText.trim(), description: form.description.trim(), trustLevel: Math.max(1, Math.min(5, Number(form.trustLevel) || 3)), tags: lines(form.tags), sourceConfig: {}, isAllowed: true };
  if (kind === "recipe") return { ...base, description: form.description.trim(), contentType: form.contentType, brandProfileId: form.brandProfileId || null, modelPolicyId: form.modelPolicyId || null, instructions: form.instructions.trim(), renderingConfig: {}, sourceIds: lines(form.sourceIds) };
  if (kind === "modelPreset") return { ...base, provider: form.provider, modelId: form.modelId.trim(), taskKinds: lines(form.taskKinds), gatewaySettings: {}, enabled: form.enabled !== "false" };
  if (kind === "modelPolicy") return { ...base, taskKind: form.taskKind, selectionMode: form.selectionMode, policyConfig: {}, steps: lines(form.presetIds).map((presetId, index) => ({ presetId, priority: index + 1, enabled: true })), isDefault: false };
  if (kind === "destination") {
    const config = jsonObject(form.destinationConfig, "Teknisk konfiguration");
    const id = form.connectionId.trim() || null;
    if (form.destinationKind === "social" && !data?.availableDestinations?.socialConnections.some((item) => String(item.id) === id)) throw new Error("Välj ett bekräftat socialt konto.");
    if (form.destinationKind === "newsletter" && !data?.availableDestinations?.newsletterAudiences.some((item) => String(item.id) === id)) throw new Error("Välj en bekräftad mottagarlista.");
    if ((form.destinationKind === "rss" || form.destinationKind === "website") && !form.publicUrl.trim()) throw new Error("Ange destinationens publika HTTPS-adress.");
    return { ...base, destinationKind: form.destinationKind, socialConnectionId: form.destinationKind === "social" ? id : null, newsletterAudienceId: form.destinationKind === "newsletter" ? id : null, destinationConfig: { ...config, ...(form.publicUrl.trim() ? { targetUrl: form.publicUrl.trim() } : {}) } };
  }
  return { ...base, recipeId: form.recipeId, destinationId: form.destinationId, deliveryMode: form.deliveryMode, scheduleConfig: form.deliveryMode === "scheduled" ? jsonObject(form.scheduleConfig, "Schemakonfiguration") : {}, approvalRequired: form.approvalRequired !== "false" };
}

type ViewEntity = {
  id: string;
  label: string;
  detail: string;
  type: string;
  initial: string;
  position: string;
  destinationKind: string | null;
  deliveryAvailability: "connected" | "configuration_only" | null;
};

type EngineViewModel = {
  personas: ViewEntity[];
  sources: ViewEntity[];
  models: ViewEntity[];
  recipes: ViewEntity[];
  destinations: ViewEntity[];
  rules: ViewEntity[];
};

function engineViewModel(data: EngineWorkspaceData | null): EngineViewModel {
  if (!data) return { personas: [], sources: [], models: [], recipes: [], destinations: [], rules: [] };
  return {
    personas: viewEntities(data.brandProfiles, "Persona"),
    sources: viewEntities(data.sources, "Källa"),
    models: viewEntities(data.modelPresets, "AI-modell"),
    recipes: viewEntities(data.recipes, "Recept"),
    destinations: viewEntities(data.destinations, "Destination"),
    rules: viewEntities(data.distributionRules, "Regel"),
  };
}

function viewEntities(items: EngineWorkspaceEntity[], fallback: string): ViewEntity[] {
  return items.map((item, index) => {
    const label = text(item, ["name", "label", "title", "displayName", "provider", "kind"]) || `${fallback} ${index + 1}`;
    const detail = text(item, ["description", "instructions", "summary", "url", "prompt", "cadence", "schedule"]);
    const type = (text(item, ["type", "kind", "provider"]) || fallback).slice(0, 2).toUpperCase();
    const id = text(item, ["id"]) || `${fallback.toLowerCase()}-${index}`;
    const destinationKind = nullableText(item.destinationKind);
    const deliveryAvailability = item.deliveryAvailability === "connected" || item.deliveryAvailability === "configuration_only" ? item.deliveryAvailability : null;
    return { id, label, detail, type, initial: label.trim().slice(0, 1).toUpperCase() || "•", position: String(index + 1).padStart(2, "0"), destinationKind, deliveryAvailability };
  });
}

function destinationDeliveryDetail(destination: ViewEntity): string {
  if (destination.deliveryAvailability === "connected") {
    return "Kontot är verifierat. Innehåll stannar som utkast tills publicering är uttryckligen aktiverad.";
  }
  if (destination.destinationKind === "newsletter") {
    return "Mottagarlistan är sparad. Utskick är inte aktiverat ännu.";
  }
  if (destination.destinationKind === "rss" || destination.destinationKind === "website") {
    return "Måladressen är sparad. En leveransadapter krävs innan något skickas.";
  }
  return destination.detail || "Destinationen är konfigurerad men ingen leverans är aktiverad.";
}

function workspaceFromPayload(payload: unknown): EngineWorkspaceData | null {
  const record = asRecord(payload);
  const raw = record ? (asRecord(record.data) ?? record) : null;
  if (!raw) return null;

  const keys: Array<keyof EngineWorkspaceData> = ["brandProfiles", "sources", "modelPresets", "modelPolicies", "recipes", "destinations", "distributionRules"];
  if (!keys.some((key) => Array.isArray(raw[key]))) return null;

  return {
    brandProfiles: entityList(raw.brandProfiles),
    sources: entityList(raw.sources),
    modelPresets: entityList(raw.modelPresets),
    modelPolicies: entityList(raw.modelPolicies),
    recipes: entityList(raw.recipes),
    destinations: entityList(raw.destinations),
    distributionRules: entityList(raw.distributionRules),
    availableDestinations: {
      socialConnections: entityList(asRecord(raw.availableDestinations)?.socialConnections),
      newsletterAudiences: entityList(asRecord(raw.availableDestinations)?.newsletterAudiences),
    },
  };
}

function labVariationsFromPayload(payload: unknown): LabVariation[] {
  const record = asRecord(payload);
  const candidates = record && Array.isArray(record.variations) ? record.variations : [];
  return candidates.flatMap((candidate, index) => {
    const item = asRecord(candidate);
    const draft = item && asRecord(item.draft);
    if (!item || !draft) return [];
    const id = text(item, ["id"]) || `variation-${index}`;
    return [{
      id,
      label: text(item, ["label"]) || `Variation ${index + 1}`,
      provider: text(item, ["provider"]) || "AI Gateway",
      model: text(item, ["model"]) || "vald modell",
      draft: {
        title: text(draft, ["title"]),
        headline: text(draft, ["headline"]),
        subject: text(draft, ["subject"]),
        previewText: text(draft, ["previewText"]),
        body: text(draft, ["body"]),
        excerpt: text(draft, ["excerpt"]),
        callToAction: text(draft, ["callToAction"]),
        hashtags: text(draft, ["hashtags"]),
        imagePrompt: text(draft, ["imagePrompt"]),
        altText: text(draft, ["altText"]),
      },
    }];
  });
}

function availableProviders(models: ViewEntity[]) {
  const declared = new Set(models.map((model) => providerFromText(`${model.label} ${model.detail} ${model.type}`)).filter((provider): provider is LabProvider => Boolean(provider)));
  return defaultProviders.filter((provider) => !declared.size || declared.has(provider.id));
}

type PolicyComparisonModel = {
  id: string;
  label: string;
  modelId: string;
};

/** Mirrors the saved policy for display only. The server independently resolves
 * and validates the same policy before it ever calls AI Gateway. */
function policyComparisonModels(
  policy: EngineWorkspaceEntity | null,
  presets: EngineWorkspaceEntity[],
): PolicyComparisonModel[] {
  if (!policy || policy.active === false) return [];
  const presetById = new Map(presets.map((preset) => [String(preset.id), preset]));
  const steps = Array.isArray(policy.steps) ? policy.steps : [];
  return steps
    .flatMap((candidate) => {
      const step = asRecord(candidate);
      if (!step || step.enabled === false) return [];
      const presetId = nullableText(step.presetId);
      const preset = presetId ? presetById.get(presetId) : null;
      if (!preset || preset.enabled === false) return [];
      const modelId = text(preset, ["modelId"]);
      if (!modelId) return [];
      return [{
        id: presetId ?? modelId,
        label: text(preset, ["name", "label", "provider"]) || modelId,
        modelId,
        priority: typeof step.priority === "number" ? step.priority : Number(step.priority) || Number.MAX_SAFE_INTEGER,
      }];
    })
    .sort((a, b) => a.priority - b.priority)
    .map(({ id, label, modelId }) => ({ id, label, modelId }));
}

function providerFromText(value: string): LabProvider | null {
  const normalised = value.toLowerCase();
  if (normalised.includes("anthropic") || normalised.includes("claude")) return "anthropic";
  if (normalised.includes("gemini") || normalised.includes("google")) return "google";
  if (normalised.includes("grok") || normalised.includes("xai")) return "xai";
  if (normalised.includes("openai") || normalised.includes("gpt")) return "openai";
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function entityList(value: unknown): EngineWorkspaceEntity[] {
  return Array.isArray(value) ? value.flatMap((entry) => {
    const record = asRecord(entry);
    return record ? [record as EngineWorkspaceEntity] : [];
  }) : [];
}

function text(value: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const candidate = nullableText(value[key]);
    if (candidate) return candidate;
  }
  return "";
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function seriesToneLabel(tone: SagaSeriesTone | undefined): string {
  if (!tone) return "Sparad tonalitet";
  const labels: Record<SagaSeriesTone, string> = {
    direct: "Rak och konkret",
    warm: "Varm och mänsklig",
    insightful: "Insiktsdriven och lugn",
  };
  return labels[tone];
}

function messageFromPayload(payload: unknown) {
  const record = asRecord(payload);
  return record ? text(record, ["error", "message", "detail"]) || null : null;
}

function stageStatusLabel(value: "complete" | "ready" | "waiting") {
  return { complete: "Klar", ready: "Redo att testa", waiting: "Inte satt" }[value];
}

function capitalize(value: string) {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

type IconName = "arrow" | "voice" | "source" | "shield" | "recipe" | "spark" | "spinner" | "warning" | "check" | "send" | "clock";

function EngineIcon({ name }: { name: IconName }) {
  const common = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  if (name === "arrow") return <svg viewBox="0 0 24 24" aria-hidden="true"><path {...common} d="m13.5 5.5-6.5 6.5 6.5 6.5M7.5 12h10" /></svg>;
  if (name === "voice") return <svg viewBox="0 0 24 24" aria-hidden="true"><path {...common} d="M12 4.5a3 3 0 0 0-3 3v4a3 3 0 0 0 6 0v-4a3 3 0 0 0-3-3ZM6 11.3a6 6 0 0 0 12 0M12 17.3v2.2M8.6 19.5h6.8" /></svg>;
  if (name === "source") return <svg viewBox="0 0 24 24" aria-hidden="true"><path {...common} d="M5 6.8A2.8 2.8 0 0 1 7.8 4h8.4A2.8 2.8 0 0 1 19 6.8v10.4a2.8 2.8 0 0 1-2.8 2.8H7.8A2.8 2.8 0 0 1 5 17.2V6.8ZM8.5 8.5h7M8.5 12h7M8.5 15.5h4.2" /></svg>;
  if (name === "shield") return <svg viewBox="0 0 24 24" aria-hidden="true"><path {...common} d="M12 3.8 19 7v4.8c0 4.1-2.8 7.4-7 8.4-4.2-1-7-4.3-7-8.4V7l7-3.2ZM9 12l2 2 4-4" /></svg>;
  if (name === "recipe") return <svg viewBox="0 0 24 24" aria-hidden="true"><path {...common} d="M7 4.5h7.8L19 8.7v10.8H7V4.5ZM14.5 4.8v4h4M9.7 12h5.8M9.7 15.5h4" /></svg>;
  if (name === "spark") return <svg viewBox="0 0 24 24" aria-hidden="true"><path {...common} d="m12 3 1.3 5.6L19 10l-5.7 1.4L12 17l-1.4-5.6L5 10l5.6-1.4L12 3ZM18.5 16l.6 2.4 2.4.6-2.4.6-.6 2.4-.6-2.4-2.4-.6 2.4-.6.6-2.4Z" /></svg>;
  if (name === "spinner") return <svg className={styles.spinner} viewBox="0 0 24 24" aria-hidden="true"><path {...common} d="M20 12a8 8 0 1 1-2.3-5.7" /></svg>;
  if (name === "warning") return <svg viewBox="0 0 24 24" aria-hidden="true"><path {...common} d="m12 4 8 15H4L12 4ZM12 9v4M12 16.4h.01" /></svg>;
  if (name === "check") return <svg viewBox="0 0 24 24" aria-hidden="true"><path {...common} d="m5 12.5 4.2 4.2L19 7" /></svg>;
  if (name === "send") return <svg viewBox="0 0 24 24" aria-hidden="true"><path {...common} d="m20 4-7.2 16-2.1-7-6.7-2.2L20 4ZM10.7 13 15 8.7" /></svg>;
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle {...common} cx="12" cy="12" r="7.5" /><path {...common} d="M12 8v4.3l2.8 1.8" /></svg>;
}
