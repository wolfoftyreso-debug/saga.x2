"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition, type ChangeEvent, type FormEvent } from "react";
import styles from "@/components/content-studio.module.css";
import { SagaEditorialPipeline } from "@/components/saga-editorial-pipeline";
import { localDateTimeToUtcIso } from "@/components/saga-content-calendar";
import { draftReviewFields, hasDraftEdits, mergeDraftConflict, type DraftConflictChoices } from "@/components/content-studio-conflict";
import {
  createEmptyStudioData,
  STUDIO_CHANNELS,
  channelLabel,
  calendarFromPayload,
  contentStatusLabel,
  contentTypeLabel,
  draftsFromPayload,
  isDeliveryLockedPrivateBrief,
  isQuarterlyPrivateReviewDraft,
  localDateTime,
  mediaFromPayload,
  automationsFromPayload,
  newsletterContactsFromPayload,
  newsletterAudiencesFromPayload,
  newsletterDeliveryStatusFromPayload,
  socialChannelsFromPayload,
  studioBackendReadiness,
  templatesFromPayload,
  type StudioBackendIssue,
  type StudioBackendState,
  type StudioAutomationView,
  type StudioCalendarEntryView,
  type StudioChannelKind,
  type StudioChannelView,
  type StudioContentKind,
  type StudioContentStatus,
  type StudioData,
  type StudioDraftView,
  type StudioMediaView,
  type StudioNewsletterAudienceView,
  type StudioNewsletterContactView,
  type StudioNewsletterDeliveryStatus,
  type StudioTemplateView,
} from "@/components/content-studio-adapter";

export type StudioRoute = "home" | "calendar" | "content" | "automations" | "templates" | "channels" | "research";

/**
 * The editor is intentionally opinionated about sequencing. SAGA can help
 * with a first draft, but it never treats an unreviewed model response as a
 * reusable automation. Keeping these stages in one shared definition makes
 * that boundary visible in the workbench as well as testable.
 */
export const SAGA_WORKBENCH_STAGES = [
  { id: "brief", label: "Brief", description: "Sätt mål, format och underlag." },
  { id: "ai", label: "AI-utkast", description: "Låt AI göra ett första försök." },
  { id: "refine", label: "Finslipa", description: "Justera text, bild och kanal." },
  { id: "save", label: "Spara", description: "Spara den version du kan stå för." },
  { id: "reference", label: "Referens", description: "Gör den till grund för en serie först när den fungerar." },
] as const;

export type SagaWorkbenchStageId = (typeof SAGA_WORKBENCH_STAGES)[number]["id"];

/**
 * The editorial state and an external provider action are different things.
 * Keep the UI precise: a scheduled draft has a time in SAGA, while the two
 * terminal delivery labels are reserved for the server-owned outcomes.
 */
export function studioPlanningStatusLabel(status: StudioContentStatus) {
  if (status === "scheduled") return "Planerad i SAGA";
  if (status === "publishing") return "Extern leverans pågår";
  if (status === "published") return "Extern leverans bekräftad";
  if (status === "failed") return "Extern leverans misslyckades";
  return contentStatusLabel(status);
}

export function sagaWorkbenchHandoff(input: { isSaved: boolean; hasCopy: boolean; hasChannel: boolean }) {
  if (!input.isSaved) {
    return {
      stage: "save" as const,
      title: "Spara den fungerande versionen först.",
      detail: "AI-förslag och lokala justeringar är inte en serie eller en automation.",
    };
  }
  if (!input.hasCopy || !input.hasChannel) {
    return {
      stage: "refine" as const,
      title: "Gör utkastet testbart först.",
      detail: "En serie behöver både ett tydligt budskap och minst en vald kanal.",
    };
  }
  return {
    stage: "reference" as const,
    title: "Det här kan bli seriens referensinlägg.",
    detail: "Öppna Serie när du har kontrollerat att riktning, text och form fungerar tillsammans.",
  };
}

type ContentStudioProps = {
  route: StudioRoute;
  contentId?: string;
  edit?: boolean;
  templateId?: string;
  scheduleDate?: string;
};

/**
 * A stale editor must not silently overwrite a calendar move made in another
 * tab. Keep the server snapshot separate from the author's unsaved edits.
 */
export class DraftRevisionConflictError extends Error {
  constructor(readonly latestDraft: StudioDraftView | null) {
    super(latestDraft
      ? "Utkastet ändrades i en annan vy. Dina ändringar är kvar. Jämför versionerna innan du sparar igen."
      : "Utkastet ändrades i en annan vy, men den senaste versionen kunde inte hämtas. Dina ändringar är kvar. Försök spara igen för att hämta versionen på nytt.");
    this.name = "DraftRevisionConflictError";
  }
}

const baseTemplates: StudioTemplateView[] = [
  {
    id: "built-in-point-of-view",
    name: "Tydlig ståndpunkt",
    description: "En tanke, ett konkret exempel och en fråga tillbaka.",
    contentType: "social_post",
    channels: ["linkedin", "facebook_page"],
    structure: "single_message",
    isBuiltIn: true,
  },
  {
    id: "built-in-instagram-signal",
    name: "En signal värd att dela",
    description: "Vad har hänt, varför spelar det roll och vad gör man nu?",
    contentType: "social_post",
    channels: ["instagram", "linkedin"],
    structure: "carousel",
    isBuiltIn: true,
  },
  {
    id: "built-in-weekly-letter",
    name: "Veckans brev",
    description: "En kort mänsklig öppning och tre saker läsaren behöver förstå.",
    contentType: "newsletter",
    channels: ["newsletter"],
    structure: "newsletter",
    isBuiltIn: true,
  },
  {
    id: "built-in-deep-dive",
    name: "Fördjupning",
    description: "Gör en observation till en sammanhängande artikel.",
    contentType: "article",
    channels: ["linkedin", "newsletter"],
    structure: "article",
    isBuiltIn: true,
  },
];

type StudioCreationGoal = {
  id: "point_of_view" | "clarify" | "trust" | "response";
  label: string;
  description: string;
  promptCue: string;
};

type StudioCreationFormat = {
  kind: StudioContentKind;
  label: string;
  description: string;
  templateId: string;
  icon: string;
};

type StudioCreationIntent = {
  version: 1;
  goalId: StudioCreationGoal["id"];
  format: StudioContentKind;
  angle: string;
  material: string;
};

const studioCreationGoals: StudioCreationGoal[] = [
  {
    id: "point_of_view",
    label: "Ta en tydlig position",
    description: "Säg vad du ser och varför det spelar roll.",
    promptCue: "Ta en tydlig, saklig position. Skriv rakt och konkret utan utfyllnad.",
  },
  {
    id: "clarify",
    label: "Gör något begripligt",
    description: "Förklara det läsaren annars missar.",
    promptCue: "Gör frågan begriplig med ett tydligt exempel och utan onödigt fackspråk.",
  },
  {
    id: "trust",
    label: "Bygg förtroende",
    description: "Visa erfarenhet, metod eller bevis.",
    promptCue: "Bygg förtroende med verkliga detaljer, begränsningar och ett användbart nästa steg.",
  },
  {
    id: "response",
    label: "Få en reaktion",
    description: "Öppna för ett samtal eller nästa handling.",
    promptCue: "Ge läsaren en anledning att svara eller agera, men undvik tomma uppmaningar.",
  },
];

const studioCreationFormats: StudioCreationFormat[] = [
  {
    kind: "social_post",
    label: "Inlägg",
    description: "En skarp tanke för sociala kanaler.",
    templateId: "built-in-point-of-view",
    icon: "✦",
  },
  {
    kind: "newsletter",
    label: "Nyhetsbrev",
    description: "Ett sammanhållet brev till egna läsare.",
    templateId: "built-in-weekly-letter",
    icon: "✉",
  },
  {
    kind: "article",
    label: "Artikel",
    description: "Mer djup, resonemang och sammanhang.",
    templateId: "built-in-deep-dive",
    icon: "▤",
  },
];

const studioCreationIntentPrefix = "brief-studio-creation-intent:";

function studioCreationIntentKey(launchId: string) {
  return `${studioCreationIntentPrefix}${launchId}`;
}

function createStudioLaunchId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function parseStudioCreationIntent(value: string | null): StudioCreationIntent | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<StudioCreationIntent>;
    const goalId = studioCreationGoals.some((goal) => goal.id === parsed.goalId) ? parsed.goalId : null;
    const format = studioCreationFormats.some((format) => format.kind === parsed.format) ? parsed.format : null;
    if (parsed.version !== 1 || !goalId || !format || typeof parsed.angle !== "string" || typeof parsed.material !== "string") return null;
    return { version: 1, goalId, format, angle: parsed.angle, material: parsed.material };
  } catch {
    return null;
  }
}

const navItems: Array<{ href: string; route: StudioRoute; label: string; icon: string }> = [
  { href: "/studio", route: "home", label: "Skapa", icon: "✦" },
  { href: "/studio/research", route: "research", label: "Research", icon: "⌁" },
  { href: "/studio/calendar", route: "calendar", label: "Kalender", icon: "□" },
  { href: "/studio/templates", route: "templates", label: "Mallar", icon: "◇" },
  { href: "/studio/automations", route: "automations", label: "Automationer", icon: "↻" },
  { href: "/studio/channels", route: "channels", label: "Kanaler", icon: "◉" },
];

const weekdays = ["Mån", "Tis", "Ons", "Tor", "Fre", "Lör", "Sön"];
const automationWeekdays = [
  { value: 1, short: "M", label: "Måndag" },
  { value: 2, short: "T", label: "Tisdag" },
  { value: 3, short: "O", label: "Onsdag" },
  { value: 4, short: "T", label: "Torsdag" },
  { value: 5, short: "F", label: "Fredag" },
  { value: 6, short: "L", label: "Lördag" },
  { value: 0, short: "S", label: "Söndag" },
] as const;

export function ContentStudio({ route, contentId, edit = false, templateId, scheduleDate }: ContentStudioProps) {
  const studio = useStudioData(route === "content" ? contentId : undefined);
  const [notice, setNotice] = useState<string | null>(null);

  const activeRoute = route === "content" ? null : route;
  const upcoming = studio.data.calendarEntries.length;
  const connected = useMemo(() => studio.data.channels.filter((channel) => channel.state === "connected").length, [studio.data.channels]);
  const backendReady = studio.data.backendState === "ready";

  return (
    <div className={`${styles.studio}${route === "content" ? ` ${styles.studioContentRoute}` : ""}`}>
      <StudioHeader activeRoute={activeRoute} upcoming={upcoming} connected={connected} backendState={studio.data.backendState} />

      {backendReady && notice && <div className={styles.notice} role="status"><span>{notice}</span><button type="button" onClick={() => setNotice(null)} aria-label="Stäng meddelande">×</button></div>}

      {!backendReady && <StudioBackendGate state={studio.data.backendState} issue={studio.data.backendIssue} />}

      {backendReady && <main className={styles.workspaceMain} id="studio-workspace">
        {route === "home" && <StudioHome data={studio.data} />}
        {route === "research" && <StudioResearchBoundary />}
        {route === "calendar" && <StudioCalendar data={studio.data} onLoadRange={studio.loadCalendarRange} />}
        {route === "content" && (
          <StudioContentDetail
            key={`${contentId ?? "new"}-${edit ? "edit" : "read"}`}
            data={studio.data}
            contentId={contentId ?? "new"}
            draftLoadState={studio.draftLoadState}
            onRetryDraft={studio.retryDraftLoad}
            startsInEditMode={edit || contentId === "new"}
            templateId={templateId}
            scheduleDate={scheduleDate}
            onSave={studio.saveDraft}
            onGenerate={studio.generateDraft}
            onUploadMedia={studio.uploadMedia}
            onAdaptMedia={studio.adaptMedia}
            onRemoveMedia={studio.removeMedia}
            onNotice={setNotice}
          />
        )}
        {route === "automations" && <StudioAutomations data={studio.data} onSave={studio.saveAutomation} onDelete={studio.deleteAutomation} onDuplicate={studio.duplicateAutomation} onRun={studio.runAutomation} onLoadHistory={studio.loadAutomationHistory} onNotice={setNotice} />}
        {route === "templates" && <StudioTemplates data={studio.data} />}
        {route === "channels" && <StudioChannels data={studio.data} onNotice={setNotice} onDisconnectChannel={studio.disconnectChannel} onCreateAudience={studio.createNewsletterAudience} onRefreshAudiences={studio.refreshNewsletterAudiences} />}
      </main>}
    </div>
  );
}

function StudioHeader({ activeRoute, upcoming, connected, backendState }: { activeRoute: StudioRoute | null; upcoming: number; connected: number; backendState: StudioBackendState }) {
  const assistantLabel = backendState === "ready" ? "Redo" : backendState === "checking" ? "Kontrollerar" : "Inställning krävs";
  return (
    <>
      <header className={styles.header}>
        <Link className={styles.brand} href="/studio" aria-label="SAGA, skapa">
          <span className={styles.brandMark} aria-hidden="true"><i /><i /><i /></span>
          <span className={styles.brandCopy}><strong>SAGA</strong><small>Studio</small></span>
        </Link>
        <div className={styles.headerMeta}>
          <span className={`${styles.assistantState}${backendState === "ready" ? "" : ` ${styles.assistantStateBlocked}`}`}><i aria-hidden="true" />{assistantLabel}</span>
          <span><b>{upcoming}</b> i kö</span><span><b>{connected}</b> kanaler</span>
        </div>
      </header>
      <nav className={styles.subnav} aria-label="Studio">
        <span className={styles.navLabel}>Arbetsyta</span>
        {navItems.map((item) => <Link href={item.href} key={item.route} className={activeRoute === item.route ? styles.subnavActive : undefined}><span aria-hidden="true">{item.icon}</span>{item.label}</Link>)}
        <Link href="/studio/engine"><span aria-hidden="true">✺</span>Bygg flöde</Link>
        <Link href="/studio/lens"><span aria-hidden="true">◌</span>Editorial Lens</Link>
      </nav>
    </>
  );
}

function StudioBackendGate({ state, issue }: { state: StudioBackendState; issue: StudioBackendIssue | null }) {
  const checking = state === "checking";
  const unconfigured = state === "unconfigured";
  const loginRequired = state === "unavailable" && /logga in/i.test(issue?.message ?? "");
  const actionHref = loginRequired ? "/login" : "/settings";
  const actionLabel = loginRequired ? "Logga in för att öppna Studio" : "Öppna inställningar";
  const title = checking
    ? "Kontrollerar arbetsytan…"
    : loginRequired
      ? "Logga in för att öppna Studio."
    : unconfigured
      ? "Studio behöver en riktig arbetsyta."
      : "Studio kan inte bekräfta sin arbetsyta.";
  const detail = checking
    ? "Vi öppnar inte redigering, schemaläggning eller publicering förrän en sparad arbetsyta har verifierats."
    : loginRequired
      ? "Din arbetsyta kan finnas, men Studio kan inte läsa den förrän du har loggat in. Inget innehåll visas eller ändras här."
    : unconfigured
      ? "Utkast, bilder, kalender och automationer är låsta tills Studio kan skriva till din egen databas. Inget på den här sidan är sparat eller planerat."
      : "Utkast, bilder, kalender och automationer är låsta tills Studio kan bekräfta en fungerande sparad arbetsyta.";
  const stageState = checking ? "Kontrolleras" : loginRequired ? "Inloggning krävs" : unconfigured ? "Konfiguration krävs" : "Kan inte bekräftas";

  return <section className={styles.backendGate} aria-busy={checking || undefined} role={checking ? "status" : "alert"} aria-labelledby="studio-preflight-title">
    <div className={styles.backendGateTopline}>
      <span className={styles.backendGateMark} aria-hidden="true">{checking ? "…" : "!"}</span>
      <span>{checking ? "STUDIOSTATUS" : "FÖRSTA STARTEN"}</span>
      <small>{checking ? "Kontrollerar säkra beroenden" : "Ingen lokal data visas som riktig"}</small>
    </div>
    <div className={styles.backendGateIntro}>
      <p className={styles.kicker}>{checking ? "ARBETSYTA" : "KONFIGURATION KRÄVS"}</p>
      <h1 id="studio-preflight-title">{title}</h1>
      <p>{detail}</p>
    </div>

    <ol className={styles.preflightStages} aria-label="Vad Studio kontrollerar före start">
      <li>
        <span className={styles.preflightNumber}>01</span>
        <div><strong>Sparad arbetsyta</strong><small>Utkast, media, kalender och regler behöver en verifierad databas.</small></div>
        <em>{stageState}</em>
      </li>
      <li>
        <span className={styles.preflightNumber}>02</span>
        <div><strong>Redaktionell motor</strong><small>AI-bearbetning blir tillgänglig först efter en säker serverkontroll.</small></div>
        <em>{checking ? "Väntar" : "Låst"}</em>
      </li>
      <li>
        <span className={styles.preflightNumber}>03</span>
        <div><strong>Publiceringskanaler</strong><small>Konton ansluts separat och först när du väljer det.</small></div>
        <em>{checking ? "Väntar" : "Senare"}</em>
      </li>
    </ol>

    {!checking && issue?.missingConfiguration.length ? <p className={styles.backendGateMissing}><strong>Saknar lokalt:</strong> {issue.missingConfiguration.join(", ")}</p> : null}
    {!checking && issue?.message ? <p className={styles.backendGateReason}>{issue.message}</p> : null}

    <div className={styles.backendGateActions}>
      {checking ? <span className={styles.backendGateChecking}>Hämtar säker status…</span> : <Link className={styles.primaryAction} href={actionHref}>{actionLabel} <span aria-hidden="true">→</span></Link>}
      {!checking && <Link className={styles.secondaryAction} href="/preview">Visa exempelgalleri</Link>}
    </div>
    <footer className={styles.backendGateFooter}><strong>{loginRequired ? "Efter inloggning" : "Vad händer sedan?"}</strong><span>{loginRequired ? "Studio kontrollerar arbetsytan igen och visar bara de kontroller som går att använda." : "När arbetsytan är klar visas riktiga redigerings- och publiceringskontroller. Nycklar läggs aldrig in här."}</span></footer>
  </section>;
}

function StudioHome({ data }: { data: StudioData }) {
  const router = useRouter();
  const [goalId, setGoalId] = useState<StudioCreationGoal["id"]>("point_of_view");
  const [formatKind, setFormatKind] = useState<StudioContentKind>("social_post");
  const [angle, setAngle] = useState("");
  const [material, setMaterial] = useState("");
  const [startError, setStartError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);

  const selectedGoal = studioCreationGoals.find((goal) => goal.id === goalId) ?? studioCreationGoals[0];
  const selectedFormat = studioCreationFormats.find((format) => format.kind === formatKind) ?? studioCreationFormats[0];
  const resumableDrafts = useMemo(
    () => data.drafts
      .filter((draft) => draft.status === "draft" || draft.status === "in_review" || draft.status === "approved")
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 3),
    [data.drafts],
  );

  function startCreation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const cleanAngle = angle.trim();
    const cleanMaterial = material.trim();
    if (cleanAngle.length < 3) {
      setStartError("Skriv en tydlig vinkel först. Det räcker med en mening.");
      return;
    }

    const launchId = createStudioLaunchId();
    const intent: StudioCreationIntent = {
      version: 1,
      goalId: selectedGoal.id,
      format: selectedFormat.kind,
      angle: cleanAngle,
      material: cleanMaterial,
    };

    try {
      window.sessionStorage.setItem(studioCreationIntentKey(launchId), JSON.stringify(intent));
    } catch {
      setStartError("Din webbläsare kunde inte föra över underlaget till redigeraren. Kopiera texten och öppna ett nytt utkast i stället.");
      return;
    }

    setOpening(true);
    router.push(`/studio/content/new?edit=1&template=${encodeURIComponent(selectedFormat.templateId)}&launch=${encodeURIComponent(launchId)}`);
  }

  return (
    <div className={styles.creationHome}>
      <section className={styles.creationIntro} aria-labelledby="creation-home-title">
        <div>
          <p className={styles.kicker}>SAGA STUDIO / NYTT INNEHÅLL</p>
          <h1 id="creation-home-title">Skapa ett utkast.</h1>
          <p>Välj riktning, lägg in underlag och öppna redigeraren. Kanal, tid och publicering blir ett separat beslut när innehållet är klart.</p>
        </div>
        <Link href="/studio/engine" className={styles.creationEngineLink}>Bygg ett återkommande flöde <span aria-hidden="true">→</span></Link>
      </section>

      <ol className={styles.creationPath} aria-label="Från idé till färdigt utkast">
        <li className={styles.creationPathActive}><span>01</span><div><strong>Välj riktning</strong><small>Mål och format</small></div></li>
        <li><span>02</span><div><strong>Ge underlag</strong><small>Vinkel och material</small></div></li>
        <li><span>03</span><div><strong>Skapa och redigera</strong><small>AI-utkast eller egen text</small></div></li>
        <li><span>04</span><div><strong>Planera vid behov</strong><small>Kanal, tid och godkännande</small></div></li>
      </ol>

      <form className={styles.creationWorkbench} id="saga-create" onSubmit={startCreation}>
        <section className={styles.creationStep} aria-labelledby="creation-direction-title">
          <div className={styles.creationStepHeading}>
            <span>01</span>
            <div><p className={styles.kicker}>RIKTNING</p><h2 id="creation-direction-title">Vad ska innehållet få människor att förstå eller göra?</h2></div>
          </div>
          <div className={styles.creationChoiceGrid}>
            <fieldset className={styles.creationChoiceGroup}>
              <legend>Välj mål</legend>
              <div className={styles.creationGoalChoices}>
                {studioCreationGoals.map((goal) => <button key={goal.id} type="button" className={goal.id === selectedGoal.id ? styles.creationChoiceSelected : undefined} aria-pressed={goal.id === selectedGoal.id} onClick={() => setGoalId(goal.id)}><strong>{goal.label}</strong><small>{goal.description}</small></button>)}
              </div>
            </fieldset>
            <fieldset className={styles.creationChoiceGroup}>
              <legend>Välj format</legend>
              <div className={styles.creationFormatChoices}>
                {studioCreationFormats.map((format) => <button key={format.kind} type="button" className={format.kind === selectedFormat.kind ? styles.creationChoiceSelected : undefined} aria-pressed={format.kind === selectedFormat.kind} onClick={() => setFormatKind(format.kind)}><span aria-hidden="true">{format.icon}</span><div><strong>{format.label}</strong><small>{format.description}</small></div></button>)}
              </div>
            </fieldset>
          </div>
        </section>

        <section className={styles.creationStep} aria-labelledby="creation-material-title">
          <div className={styles.creationStepHeading}>
            <span>02</span>
            <div><p className={styles.kicker}>DIN VINKEL</p><h2 id="creation-material-title">Skriv det som gör just den här berättelsen intressant.</h2></div>
          </div>
          <div className={styles.creationFields}>
            <label className={styles.creationAngleField}>
              <span>Din skarpa vinkel <small>krävs</small></span>
              <textarea rows={3} value={angle} onChange={(event) => { setAngle(event.target.value); setStartError(null); }} placeholder="Exempel: De flesta bilverkstäder säljer tid. De borde sälja trygghet i nästa mil istället." />
            </label>
            <label className={styles.creationMaterialField}>
              <span>Underlag att utgå ifrån <small>valfritt</small></span>
              <textarea rows={3} value={material} onChange={(event) => setMaterial(event.target.value)} placeholder="Fakta, egna anteckningar, kundfrågor eller punkter som måste med. Ingen länk hämtas automatiskt här." />
            </label>
          </div>
          <p className={styles.creationPromptPreview}><span aria-hidden="true">✦</span><span><strong>Din skrivram:</strong> {selectedGoal.promptCue}</span></p>
        </section>

        <section className={`${styles.creationStep} ${styles.creationActionStep}`} aria-labelledby="creation-draft-title">
          <div className={styles.creationStepHeading}>
            <span>03</span>
            <div><p className={styles.kicker}>UTKASTET</p><h2 id="creation-draft-title">Öppna redigeraren med din riktning på plats.</h2></div>
          </div>
          <div className={styles.creationActionBody}>
            <p>AI-fältet fylls med din vinkel och ditt underlag. Där kan du skapa ett första förslag eller skriva själv, granska texten och spara ett riktigt utkast.</p>
            {startError && <p className={styles.creationStartError} role="alert">{startError}</p>}
            <button className={styles.primaryAction} type="submit" disabled={opening}>{opening ? "Öppnar redigeraren…" : `Skapa ${selectedFormat.label.toLowerCase()}utkast`} <span aria-hidden="true">→</span></button>
            <small>Inget sparas, får tid i kalendern eller skickas till en kanal av det här steget.</small>
          </div>
        </section>

        <aside className={styles.creationOptionalStep} aria-labelledby="creation-optional-title">
          <span>04</span>
          <div>
            <p className={styles.kicker}>FÖRST NÄR UTKASTET ÄR KLART</p>
            <h2 id="creation-optional-title">Planera och välj kanal — om du vill.</h2>
            <p>Datum, godkännande och kanal sätts i utkastet. Att planera är inte samma sak som att skicka; Studio publicerar ingenting från den här startsidan.</p>
            <div><Link href="/studio/calendar">Öppna kalendern</Link><Link href="/studio/channels">Se kanaler</Link></div>
          </div>
        </aside>
      </form>

      <section className={styles.creationResume} aria-labelledby="creation-resume-title">
        <div className={styles.creationResumeHeading}>
          <div><p className={styles.kicker}>FORTSÄTT SKAPA</p><h2 id="creation-resume-title">Påbörjade utkast.</h2></div>
          <Link href="/studio/templates">Se alla mallar <span aria-hidden="true">→</span></Link>
        </div>
        {resumableDrafts.length ? <DraftRows drafts={resumableDrafts} /> : <div className={styles.creationResumeEmpty}><span aria-hidden="true">✦</span><p>Inget påbörjat just nu. Börja ovan med en vinkel som är värd att utveckla.</p></div>}
      </section>

      <SagaEditorialPipeline data={data} />
    </div>
  );
}

/** Research is deliberately gated until it has the same tenant and evidence model as Studio. */
function StudioResearchBoundary() {
  return (
    <section className={styles.researchBoundary} aria-labelledby="research-boundary-title">
      <p className={styles.kicker}>RESEARCHMOTOR</p>
      <h1 id="research-boundary-title">Research kopplas in i samma Vercel-arbetsyta.</h1>
      <p>Research är inte aktiverad ännu. Den släpps först när källor, evidens och tenant-skydd ligger i samma Vercel-arbetsyta som resten av Studio.</p>
      <div className={styles.researchBoundarySteps}>
        <div><span>01</span><strong>Studio</strong><small>Skapa och granska riktiga utkast i Neon.</small></div>
        <div><span>02</span><strong>Automation</strong><small>Lägg återkommande utkast i den Vercel-styrda kön.</small></div>
        <div><span>03</span><strong>Research</strong><small>Aktiveras först när dess tenant- och evidensmodell också ligger i Neon.</small></div>
      </div>
      <div className={styles.researchBoundaryActions}>
        <Link className={styles.primaryAction} href="/studio/content/new?edit=1">Skapa utkast <span aria-hidden="true">→</span></Link>
        <Link className={styles.secondaryAction} href="/studio/automations">Öppna automationer</Link>
        <Link className={styles.textAction} href="/settings">Se systemstatus <span aria-hidden="true">→</span></Link>
      </div>
    </section>
  );
}

function StudioCalendar({ data, onLoadRange }: { data: StudioData; onLoadRange: (from: string, to: string, timezone: string) => Promise<void> }) {
  const [month, setMonth] = useState(() => new Date());
  const [expandedDay, setExpandedDay] = useState<string | null>(null);
  const [loadingRange, setLoadingRange] = useState(false);
  const [rangeError, setRangeError] = useState<string | null>(null);
  const calendarRequest = useRef(0);
  const days = useMemo(() => makeCalendar(month), [month]);
  const entries = useMemo(() => combineCalendarEntries(data), [data]);
  const monthLabel = new Intl.DateTimeFormat("sv-SE", { month: "long", year: "numeric" }).format(month);

  function loadMonth(nextMonth: Date) {
    const requestId = calendarRequest.current + 1;
    calendarRequest.current = requestId;
    const nextDays = makeCalendar(nextMonth);
    const from = formatDateInput(nextDays[0]?.date ?? nextMonth, data.timezone);
    const to = formatDateInput(nextDays.at(-1)?.date ?? nextMonth, data.timezone);
    setExpandedDay(null);
    setMonth(nextMonth);
    setLoadingRange(true);
    setRangeError(null);
    void onLoadRange(from, to, data.timezone).catch((reason: unknown) => {
      if (calendarRequest.current === requestId) setRangeError(reason instanceof Error ? reason.message : "Kunde inte läsa den här kalenderperioden.");
    }).finally(() => {
      if (calendarRequest.current === requestId) setLoadingRange(false);
    });
  }

  function changeMonth(direction: -1 | 1) {
    loadMonth(shiftMonth(month, direction));
  }

  function returnToToday() {
    loadMonth(new Date());
  }

  return (
    <>
      <section className={styles.pageLead}>
        <p className={styles.kicker}>PUBLICERINGSKALENDER</p>
        <h1>Kalender</h1>
        <p>Klicka på en post för att läsa hela utkastet. Klicka på en tom dag för att skapa nytt innehåll på rätt tid. Alla månader hämtas när du öppnar dem.</p>
      </section>
      <section className={styles.calendarPanel}>
        <header className={styles.calendarHeader}>
          <div><button type="button" aria-label="Föregående månad" onClick={() => changeMonth(-1)}>‹</button><strong>{capitalize(monthLabel)}</strong><button type="button" aria-label="Nästa månad" onClick={() => changeMonth(1)}>›</button></div>
          <button type="button" onClick={returnToToday}>I dag</button>
        </header>
        {(loadingRange || rangeError) && <div className={styles.calendarLoadState} role={rangeError ? "alert" : "status"}>{rangeError ?? "Hämtar den här kalenderperioden…"}</div>}
        <div className={styles.calendarWeekdays}>{weekdays.map((day) => <span key={day}>{day}</span>)}</div>
        <div className={styles.calendarGrid}>
          {days.map((day) => {
            const onDay = entries.filter((entry) => sameLocalDay(entry.startAt, day.date, data.timezone));
            const dayKey = formatDateInput(day.date, data.timezone);
            const isExpanded = expandedDay === dayKey;
            const visibleEntries = isExpanded ? onDay : onDay.slice(0, 3);
            const current = isToday(day.date, data.timezone);
            return (
              <div className={`${styles.calendarDay}${day.inMonth ? "" : ` ${styles.calendarDayMuted}`}${current ? ` ${styles.calendarDayToday}` : ""}`} key={day.date.toISOString()}>
                <Link href={`/studio/content/new?edit=1&date=${formatDateInput(day.date, data.timezone)}`} aria-label={`Skapa innehåll ${formatFullDate(day.date, data.timezone)}`} className={styles.calendarDate}>{day.date.getUTCDate()}</Link>
                <div className={styles.calendarEntries}>
                  {visibleEntries.map((entry) => <CalendarEntry entry={entry} key={entry.id} />)}
                  {onDay.length > 3 && <button type="button" className={styles.moreEntries} aria-expanded={isExpanded} onClick={() => setExpandedDay((currentDay) => currentDay === dayKey ? null : dayKey)}>{isExpanded ? "Visa färre" : `Visa ${onDay.length - 3} till`}</button>}
                </div>
              </div>
            );
          })}
        </div>
      </section>
      <section className={styles.calendarLegend} aria-label="Förklaring">
        <span><i className={styles.legendDraft} /> Utkast</span><span><i className={styles.legendScheduled} /> Schemalagt</span><span><i className={styles.legendAutomation} /> Automatiskt jobb</span>
      </section>
      {!entries.length && <EmptyBlock title="Kalendern är lugn." detail="Skapa ett utkast eller bygg en automation. När något får en tid syns det här direkt." actionHref="/studio/content/new?edit=1" action="Skapa innehåll" />}
    </>
  );
}

function CalendarEntry({ entry }: { entry: StudioCalendarEntryView }) {
  const className = entry.kind === "automation_job" ? styles.calendarAutomation : entry.status === "draft" ? styles.calendarDraft : styles.calendarScheduled;
  const href = entry.draftId ? `/studio/content/${entry.draftId}` : "/studio/automations";
  return <Link href={href} className={`${styles.calendarEntry} ${className}`}><time>{formatTime(entry.startAt)}</time><span>{entry.title}</span></Link>;
}

type StudioDraftLoadState = { status: "loading" | "missing" | "error"; message: string | null };

function StudioContentDetail({ data, contentId, draftLoadState, onRetryDraft, startsInEditMode, templateId, scheduleDate, onSave, onGenerate, onUploadMedia, onAdaptMedia, onRemoveMedia, onNotice }: { data: StudioData; contentId: string; draftLoadState: StudioDraftLoadState; onRetryDraft: () => void; startsInEditMode: boolean; templateId?: string; scheduleDate?: string; onSave: (draft: StudioDraftView) => Promise<StudioDraftView>; onGenerate: (draft: StudioDraftView) => Promise<Partial<StudioDraftView>>; onUploadMedia: (draftId: string, file: File, altText?: string) => Promise<StudioMediaView>; onAdaptMedia: (draftId: string, mediaId: string, target: StudioChannelKind, instruction: string) => Promise<StudioMediaView>; onRemoveMedia: (draftId: string, mediaId: string) => Promise<void>; onNotice: (notice: string) => void }) {
  const [editing, setEditing] = useState(startsInEditMode);
  const router = useRouter();
  const existing = data.drafts.find((draft) => draft.id === contentId) ?? null;
  const template = resolvedTemplates(data).find((item) => item.id === templateId) ?? null;
  const quarterlyPrivateReview = Boolean(existing && isQuarterlyPrivateReviewDraft(existing));
  const quarterlyTerminal = existing?.quarterlyPrivateReview === true && (existing.status === "approved" || existing.status === "cancelled");

  if (!existing && contentId !== "new") {
    if (draftLoadState.status === "loading") return <section className={styles.missing} role="status" aria-busy="true"><p className={styles.kicker}>HÄMTAR UTKAST</p><h1>Läser det sparade utkastet.</h1><p>Kontrollerar inlägget direkt i din arbetsyta.</p></section>;
    if (draftLoadState.status === "error") return <section className={styles.missing} role="alert"><p className={styles.kicker}>UTKASTET KUNDE INTE LÄSAS</p><h1>Utkastet kunde inte hämtas just nu.</h1><p>{draftLoadState.message}</p><button type="button" className={styles.primaryAction} onClick={onRetryDraft}>Försök igen</button></section>;
    return <section className={styles.missing}><p className={styles.kicker}>UTKASTET HITTADES INTE</p><h1>Utkastet hittades inte i din arbetsyta.</h1><p>Det kan ha tagits bort, eller tillhöra en annan arbetsyta. Inget har ändrats.</p><Link className={styles.primaryAction} href="/studio/content/new?edit=1">Skapa nytt utkast</Link></section>;
  }

  // A delivery lock comes only from the server-owned ad-automation metadata.
  // Check it before the edit query flag so /?edit=1 cannot reopen the generic
  // Studio editor and expose AI, media, channel, schedule, or approval actions.
  if (existing && isDeliveryLockedPrivateBrief(existing)) return <PrivateAdCreativeBriefReview draft={existing} />;

  // A returned batch draft can be edited only to address that return. Once
  // the batch has atomically approved or rejected it, the durable server
  // policy and this view both lock editorial changes; later work is separate.
  if (editing && !quarterlyTerminal) return <ContentEditor key={existing?.id ?? "new"} initialDraft={existing ?? emptyDraft(data.timezone, template, scheduleDate ?? null)} quarterlyPrivateReview={quarterlyPrivateReview} templates={resolvedTemplates(data)} audiences={data.newsletterAudiences} onSave={async (draft) => { const saved = await onSave(draft); onNotice("Utkastet är sparat."); if (existing) setEditing(false); else router.replace(`/studio/content/${saved.id}`); return saved; }} onGenerate={onGenerate} onUploadMedia={onUploadMedia} onAdaptMedia={onAdaptMedia} onRemoveMedia={onRemoveMedia} onCancel={() => existing ? setEditing(false) : history.back()} />;
  if (!existing) return null;
  return <ContentPreview draft={existing} onEdit={() => setEditing(true)} onApprove={async () => {
    if (existing.contentType === "newsletter" && existing.scheduledAt && !existing.newsletterAudienceId) {
      throw new Error("Välj en mottagarlista innan du godkänner ett schemalagt nyhetsbrev.");
    }
    await onSave({ ...existing, status: "approved" });
    onNotice(existing.scheduledAt
      ? "Utkastet är godkänt. Den valda tiden ligger kvar som en planering."
      : "Utkastet är godkänt. Sätt en tid när du vill planera nästa steg.");
  }} />;
}

export function ContentPreview({ draft, onEdit, onApprove }: { draft: StudioDraftView; onEdit: () => void; onApprove: () => Promise<void> }) {
  const [approving, startApproving] = useTransition();
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const deliveryLocked = isDeliveryLockedPrivateBrief(draft);
  const quarterlyBatchDraft = draft.quarterlyPrivateReview === true;
  const quarterlyApproved = quarterlyBatchDraft && draft.status === "approved";
  const quarterlyRejected = quarterlyBatchDraft && draft.status === "cancelled";
  const quarterlyTerminal = quarterlyApproved || quarterlyRejected;
  const canEdit = !deliveryLocked && !quarterlyTerminal;
  const canApprove = !deliveryLocked && !quarterlyBatchDraft && draft.approvalRequired && (draft.status === "draft" || draft.status === "in_review" || draft.status === "scheduled");
  const hasCopy = Boolean(draft.headline.trim() || draft.body.trim());
  const hasSchedule = Boolean(draft.scheduledAt);
  const hasChannel = draft.channels.length > 0;
  const needsAudience = draft.contentType === "newsletter" && !draft.newsletterAudienceId;
  function approve() {
    setApprovalError(null);
    startApproving(async () => {
      try { await onApprove(); } catch (reason) { setApprovalError(reason instanceof Error ? reason.message : "Kunde inte godkänna utkastet."); }
    });
  }
  return (
    <>
      <header className={styles.detailHeader}>
        <Link href="/studio/calendar" className={styles.backLink}>← Till kalendern</Link>
        <div className={styles.detailMeta}><span className={`${styles.status} ${statusClass(draft.status)}`}>{studioPlanningStatusLabel(draft.status)}</span><span>{contentTypeLabel(draft.contentType)}</span></div>
        <h1>{draft.title || draft.headline || "Utan rubrik"}</h1>
        <p>{quarterlyBatchDraft ? quarterlyApproved ? "Godkänt privat batchutkast. Texten är låst efter beslutet; ingen extern leverans är bokad." : quarterlyRejected ? "Avvisat privat batchutkast. Texten är låst efter beslutet; ingen tid eller extern leverans är bekräftad." : "Privat utkast i aktivitetsplanens granskningsbatch. Ingen tid är bokad och ingen extern leverans är bekräftad." : draft.scheduledAt ? `Tid i kalendern ${formatWhen(draft.scheduledAt)}` : "Ingen tid vald"} · {channelList(draft.channels)}</p>
        <div className={styles.detailActions}>{canEdit && <button type="button" className={styles.primaryAction} onClick={onEdit}>Redigera <span>→</span></button>}{quarterlyBatchDraft ? <Link className={styles.secondaryAction} href="/studio/plan">Till batchgranskningen <span>→</span></Link> : null}{canApprove && <button type="button" className={styles.approveAction} disabled={approving} onClick={approve}>{approving ? "Godkänner…" : "Godkänn utkast"} <span>✓</span></button>}</div>
        {quarterlyBatchDraft ? <p className={styles.inlineNotice} role="status">{quarterlyApproved ? "Batchbeslutet är sparat. Redigering är låst här för att bevara granskningsspåret; en eventuell senare kalenderåtgärd är separat." : quarterlyRejected ? "Batchbeslutet är avvisat och utkastet är låst här för att bevara granskningsspåret." : "Godkänn, returnera eller avvisa utkastet i aktivitetsplanens batch. Den vanliga Studio-vyn kan bara redigera innehållet efter ett returkrav."}</p> : null}
        {approvalError && <p className={styles.saveError} role="alert">{approvalError}</p>}
      </header>
      <section className={styles.contentWorkbench} aria-label="Granska utkastet">
        <article className={styles.contentCanvas}>
          <div className={styles.canvasHeader}>
            <div><p className={styles.kicker}>INNEHÅLLSCANVAS</p><strong>Så här läser det före nästa steg.</strong></div>
            <span>{contentTypeLabel(draft.contentType)}</span>
          </div>
          <div className={styles.previewFrame}>
            <PreviewTopBar channels={draft.channels} />
            {draft.contentType === "newsletter" ? <NewsletterCanvas draft={draft} /> : <SocialCanvas draft={draft} />}
          </div>
        </article>
        <aside className={styles.contentProperties} aria-label="Kanal- och planeringskontroll">
          <section className={styles.contentPropertyPanel}>
            <p className={styles.kicker}>PLANERING I SAGA</p>
            <dl className={styles.contentPropertiesList}>
              <div><dt>Status</dt><dd>{studioPlanningStatusLabel(draft.status)}</dd></div>
              <div><dt>Kanaler</dt><dd>{channelList(draft.channels)}</dd></div>
              <div><dt>{quarterlyBatchDraft ? "Planering" : "Tid i SAGA"}</dt><dd>{quarterlyBatchDraft ? "Aktivitetsplan, ej bokad" : draft.scheduledAt ? formatWhen(draft.scheduledAt) : "Ingen tid satt"}</dd></div>
              <div><dt>{quarterlyBatchDraft ? "Beslut" : "Godkännande"}</dt><dd>{quarterlyBatchDraft ? quarterlyApproved ? "Batchgodkänt och låst" : quarterlyRejected ? "Avvisat och låst" : "Görs i batchgranskningen" : draft.approvalRequired ? "Krävs" : "Inte krävt"}</dd></div>
            </dl>
          </section>
          <section className={styles.reviewChecklist}>
            <p className={styles.kicker}>FÖRE NÄSTA STEG</p>
            <ul>
              <li className={hasCopy ? styles.reviewReady : styles.reviewPending}><span aria-hidden="true">{hasCopy ? "✓" : "!"}</span><div><strong>Budskap</strong><small>{hasCopy ? "Text finns att granska." : "Skriv rubrik eller text först."}</small></div></li>
              <li className={hasChannel ? styles.reviewReady : styles.reviewPending}><span aria-hidden="true">{hasChannel ? "✓" : "!"}</span><div><strong>Kanal</strong><small>{hasChannel ? channelList(draft.channels) : "Välj minst en kanal i redigeraren."}</small></div></li>
              <li className={quarterlyBatchDraft ? styles.reviewReady : hasSchedule && !needsAudience ? styles.reviewReady : styles.reviewPending}><span aria-hidden="true">{quarterlyBatchDraft || hasSchedule && !needsAudience ? "✓" : "!"}</span><div><strong>{quarterlyBatchDraft ? "Batchgranskning" : "Tid i kalendern"}</strong><small>{quarterlyBatchDraft ? quarterlyApproved ? "Beslutet är sparat. Utkastet är låst i Studio." : quarterlyRejected ? "Utkastet är avvisat och låst i Studio." : "Mänskligt beslut görs i aktivitetsplanen. Ingen extern leverans är bokad." : needsAudience ? "Välj en mottagarlista före nyhetsbrev." : hasSchedule ? "Tiden är satt i SAGA. Ingen extern leverans har startats." : "Sätt en tid när utkastet är klart."}</small></div></li>
            </ul>
            {quarterlyBatchDraft ? <Link href="/studio/plan">Öppna batchgranskningen →</Link> : <Link href="/studio/channels">Kontrollera kanaler →</Link>}
          </section>
        </aside>
      </section>
    </>
  );
}

/**
 * Private ad-automation output is deliberately not a standard Studio draft.
 * It is a reviewable record of a deterministic brief and cannot become an
 * AI-generated asset, a media-editing task, a channel selection, or a
 * scheduled/publication action from this screen.
 */
export function PrivateAdCreativeBriefReview({ draft }: { draft: StudioDraftView }) {
  return <>
    <header className={`${styles.detailHeader} ${styles.privateBriefHeader}`}>
      <Link href="/studio/automations" className={styles.backLink}>← Till annonsflödet</Link>
      <div className={styles.detailMeta}><span className={`${styles.status} ${styles.privateBriefStatus}`}>Privat creative brief</span><span>Leverans låst</span></div>
      <h1>{draft.title || "Privat annonsbrief"}</h1>
      <p>Det här är ett sparat, deterministiskt underlag från annonsflödet. Det är inte AI-skrivet och kan inte göras om till en annons från Studio.</p>
      <div className={styles.detailActions}><Link className={styles.secondaryAction} href="/studio/automations">Öppna annonsflödet <span>→</span></Link></div>
    </header>

    <section className={styles.privateBriefNotice} aria-labelledby="private-brief-lock-title" role="status">
      <span aria-hidden="true">⌁</span>
      <div><strong id="private-brief-lock-title">Extern leverans saknas</strong><p>AI-copy, bildgenerering, uppladdning, bildbearbetning, kanalval, godkännande och schemaläggning är låsta för detta underlag. Ändra i stället annonsflödet och skapa ett nytt privat brief när riktningen är klar.</p></div>
    </section>

    <section className={styles.privateBriefLayout} aria-label="Privat annonsbrief för granskning">
      <article className={styles.privateBriefDocument}>
        <header><p className={styles.kicker}>SPARAT UNDERLAG</p><h2>Creative brief</h2><p>Texten nedan är exakt det sparade underlaget. Den har inte förädlats av en modell i Studio.</p></header>
        <pre>{draft.body || "Inget kreativt underlag sparades."}</pre>
      </article>
      <aside className={styles.privateBriefInspector} aria-label="Briefens gränser">
        <section>
          <p className={styles.kicker}>STATUS</p>
          <dl>
            <div><dt>Typ</dt><dd>Deterministiskt kreativt underlag</dd></div>
            <div><dt>AI</dt><dd>Inte anropad</dd></div>
            <div><dt>Media</dt><dd>Inte skapad</dd></div>
            <div><dt>Leverans</dt><dd>Extern leverans saknas</dd></div>
          </dl>
        </section>
        <section className={styles.privateBriefNextStep}>
          <p className={styles.kicker}>NÄSTA STEG</p>
          <h2>Ändra flödet, inte det här kvittot.</h2>
          <p>Gå tillbaka till annonsflödet om du vill ändra hook, erbjudande, källunderlag eller destinationer. Ett nytt test skapar då ett nytt privat underlag.</p>
          <Link href="/studio/automations">Till annonsflödet <span aria-hidden="true">→</span></Link>
        </section>
      </aside>
    </section>
  </>;
}

type WorkbenchCanvas = "copy" | "media" | "preview";

export { ContentEditor };

type LocalAiVariation = Pick<StudioDraftView, "title" | "headline" | "subject" | "body" | "cta" | "excerpt" | "hashtags" | "imagePrompt"> & {
  id: string;
};

function variationFromGeneration(generated: Partial<StudioDraftView>, fallback: StudioDraftView): LocalAiVariation {
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    title: generated.title ?? fallback.title,
    headline: generated.headline ?? fallback.headline,
    subject: generated.subject ?? fallback.subject,
    body: generated.body ?? fallback.body,
    cta: generated.cta ?? fallback.cta,
    excerpt: generated.excerpt ?? fallback.excerpt,
    hashtags: generated.hashtags ?? fallback.hashtags,
    imagePrompt: generated.imagePrompt ?? fallback.imagePrompt,
  };
}

function ContentEditor({ initialDraft, quarterlyPrivateReview = false, templates, audiences, onSave, onGenerate, onUploadMedia, onAdaptMedia, onRemoveMedia, onCancel }: { initialDraft: StudioDraftView; quarterlyPrivateReview?: boolean; templates: StudioTemplateView[]; audiences: StudioNewsletterAudienceView[]; onSave: (draft: StudioDraftView) => Promise<StudioDraftView>; onGenerate: (draft: StudioDraftView) => Promise<Partial<StudioDraftView>>; onUploadMedia: (draftId: string, file: File, altText?: string) => Promise<StudioMediaView>; onAdaptMedia: (draftId: string, mediaId: string, target: StudioChannelKind, instruction: string) => Promise<StudioMediaView>; onRemoveMedia: (draftId: string, mediaId: string) => Promise<void>; onCancel: () => void }) {
  const [draft, setDraft] = useState<StudioDraftView>(initialDraft);
  const [savedBase, setSavedBase] = useState<StudioDraftView>(initialDraft);
  const [conflictServer, setConflictServer] = useState<StudioDraftView | null>(null);
  const [conflictChoices, setConflictChoices] = useState<DraftConflictChoices>({});
  const [recoveryDrafts, setRecoveryDrafts] = useState<StudioDraftView[]>([]);
  const [selectedRecovery, setSelectedRecovery] = useState(0);
  const recoveryDraft = recoveryDrafts[selectedRecovery] ?? null;
  const [draftBrands, setDraftBrands] = useState<Array<{ id: string; name: string }>>([]);
  const [draftBrandsLoading, setDraftBrandsLoading] = useState(!uuidOrNull(initialDraft.id));
  const [draftBrandsError, setDraftBrandsError] = useState<string | null>(null);
  const [brandLoadAttempt, setBrandLoadAttempt] = useState(0);
  const [activeCanvas, setActiveCanvas] = useState<WorkbenchCanvas>("copy");
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [variations, setVariations] = useState<LocalAiVariation[]>([]);
  const [saving, startSaving] = useTransition();
  const [generating, startGenerating] = useTransition();
  const [uploadingMedia, startUploadingMedia] = useTransition();
  const [adaptingMedia, startAdaptingMedia] = useTransition();
  const [removingMediaId, setRemovingMediaId] = useState<string | null>(null);
  const [imageNotice, setImageNotice] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const conflictHeading = useRef<HTMLHeadingElement>(null);

  const selectedTemplate = templates.find((template) => template.id === draft.templateId) ?? null;
  const isSavedDraft = uuidOrNull(draft.id) !== null;
  const newBrandUnavailable = !isSavedDraft && (draftBrandsLoading || !draftBrands.some((brand) => brand.id === draft.brandProfileId));
  const hasCopy = Boolean(draft.headline.trim() || draft.body.trim());
  const busy = saving || generating || uploadingMedia || adaptingMedia || removingMediaId !== null;
  const dirty = hasDraftEdits(savedBase, draft);
  const handoff = sagaWorkbenchHandoff({ isSaved: isSavedDraft && !dirty && !conflictServer, hasCopy, hasChannel: draft.channels.length > 0 });
  const serverLocked = isDeliveryLockedPrivateBrief(savedBase) || (savedBase.quarterlyPrivateReview === true && (savedBase.status === "approved" || savedBase.status === "cancelled"));
  const conflictMerge = conflictServer ? mergeDraftConflict(savedBase, draft, conflictServer, conflictChoices) : null;

  useEffect(() => { if (conflictServer) conflictHeading.current?.focus(); }, [conflictServer]);

  useEffect(() => {
    if (isSavedDraft) return;
    let active = true;
    void readStudioEndpoint("/api/saga/brand-onboarding").then((response) => {
      if (!active) return;
      if (!response.ok || !isRecord(response.data) || !Array.isArray(response.data.onboardings)) {
        setDraftBrandsError("Varumärkena kunde inte hämtas. Din text är kvar; försök igen innan du sparar.");
        return;
      }
      const eligible = response.data.onboardings.flatMap((entry) => isRecord(entry)
        && entry.completionState === "completed" && entry.brandActive === true
        && typeof entry.brandProfileId === "string" && uuidOrNull(entry.brandProfileId) && typeof entry.brandName === "string"
        ? [{ id: entry.brandProfileId, name: entry.brandName }] : []);
      setDraftBrands(eligible);
      setDraftBrandsError(null);
      const requested = new URLSearchParams(window.location.search).get("brandProfileId");
      setDraft((current) => {
        const explicit = current.brandProfileId || requested;
        const selected = explicit ? eligible.find((brand) => brand.id === explicit) : eligible.length === 1 ? eligible[0] : null;
        return { ...current, brandProfileId: selected?.id ?? null };
      });
    }).catch(() => {
      if (active) setDraftBrandsError("Varumärkena kunde inte hämtas. Din text är kvar; försök igen innan du sparar.");
    }).finally(() => { if (active) setDraftBrandsLoading(false); });
    return () => { active = false; };
  }, [isSavedDraft, brandLoadAttempt]);

  useEffect(() => {
    if (!dirty && !conflictServer && !busy) return;
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    // Next's client navigation does not emit beforeunload. Capture link clicks
    // outside this editor too (sidebar/menu) before the router can unmount it.
    const warnBeforeNavigation = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(anchor instanceof HTMLAnchorElement) || anchor.download || (anchor.target && anchor.target !== "_self")) return;
      const target = new URL(anchor.href, window.location.href);
      if (target.origin !== window.location.origin || (target.pathname === window.location.pathname && target.search === window.location.search)) return;
      if (busy || !window.confirm("Du har osparade ändringar. Vill du lämna editorn utan att spara dem?")) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    window.addEventListener("beforeunload", warnBeforeLeaving);
    document.addEventListener("click", warnBeforeNavigation, true);
    return () => {
      window.removeEventListener("beforeunload", warnBeforeLeaving);
      document.removeEventListener("click", warnBeforeNavigation, true);
    };
  }, [dirty, conflictServer, busy]);

  useEffect(() => {
    if (isSavedDraft) return;
    const launchId = new URLSearchParams(window.location.search).get("launch");
    if (!launchId) return;

    let intent: StudioCreationIntent | null = null;
    let storageKey = "";
    try {
      storageKey = studioCreationIntentKey(launchId);
      intent = parseStudioCreationIntent(window.sessionStorage.getItem(storageKey));
    } catch {
      return;
    }
    if (!intent) return;

    const goal = studioCreationGoals.find((candidate) => candidate.id === intent.goalId);
    if (!goal) return;
    const promptParts = [
      `Mål: ${goal.label}.`,
      goal.promptCue,
      `Vinkel: ${intent.angle.trim()}`,
      intent.material.trim() ? `Underlag: ${intent.material.trim()}` : "",
    ].filter(Boolean);

    const syncIntent = window.setTimeout(() => {
      setDraft((current) => ({
        ...current,
        contentType: intent.format,
        channels: intent.format === "newsletter" ? ["newsletter"] : current.channels,
        generationPrompt: current.generationPrompt.trim() || promptParts.join("\n\n"),
        title: current.title.trim() || intent.angle.trim().slice(0, 96),
        updatedAt: new Date().toISOString(),
      }));
      setImageNotice("Din riktning ligger i AI-fältet. Kontrollera den, skapa ett utkast eller skriv själv och spara först när det är ditt.");
      window.sessionStorage.removeItem(storageKey);
    }, 0);
    return () => window.clearTimeout(syncIntent);
  }, [isSavedDraft]);

  function setField<Key extends keyof StudioDraftView>(key: Key, value: StudioDraftView[Key]) {
    setDraft((current) => ({ ...current, [key]: value, updatedAt: new Date().toISOString() }));
  }

  function selectTemplate(template: StudioTemplateView) {
    setDraft((current) => ({ ...current, templateId: template.id, contentType: template.contentType, channels: template.channels, updatedAt: new Date().toISOString() }));
  }

  function changeSchedule(value: string) {
    try {
      const patch = studioDraftSchedulePatch(value, draft.timezone);
      setDraft((current) => ({ ...current, ...patch }));
      setSaveError(null);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Kontrollera datum, tid och tidszon.");
    }
  }

  function toggleChannel(channel: StudioChannelKind) {
    setDraft((current) => {
      if (channel === "newsletter") return { ...current, contentType: "newsletter", channels: ["newsletter"] };
      if (current.contentType === "newsletter") return current;
      return { ...current, channels: current.channels.includes(channel) ? current.channels.filter((item) => item !== channel) : [...current.channels, channel] };
    });
  }

  function addImage(event: ChangeEvent<HTMLInputElement>) {
    if (quarterlyPrivateReview) { setSaveError("Bildverktygen är låsta för det här privata batchutkastet. Ändra texten och skicka tillbaka utkastet till batchgranskning."); return; }
    const file = event.currentTarget.files?.[0];
    if (!file) return;
    event.currentTarget.value = "";
    if (!file.type.startsWith("image/")) { setImageNotice("Välj en JPG-, PNG- eller WebP-bild."); return; }
    if (!uuidOrNull(draft.id)) { setImageNotice("Spara utkastet först. Då laddas bilden upp privat och kan användas vid publicering."); return; }
    setSaveError(null);
    startUploadingMedia(async () => {
      try {
        const media = await onUploadMedia(draft.id, file, file.name);
        setDraft((current) => ({ ...current, media: [...current.media.filter((item) => item.id !== media.id), media] }));
        setImageNotice("Bilden är uppladdad privat. Du kan nu förbättra och anpassa den med AI.");
      } catch (reason) {
        setSaveError(reason instanceof Error ? reason.message : "Bilden kunde inte laddas upp.");
      }
    });
  }

  function adaptImage() {
    if (quarterlyPrivateReview) { setSaveError("Bildverktygen är låsta för det här privata batchutkastet."); return; }
    const source = draft.media.at(-1);
    const target = draft.channels[0];
    if (!source) { setImageNotice("Lägg till ett foto först."); return; }
    if (!target) { setImageNotice("Välj en kanal först så bilden kan få rätt format."); return; }
    if (!uuidOrNull(draft.id) || !uuidOrNull(source.id)) { setImageNotice("Spara utkastet och bilden först innan AI kan skapa en säker bildvariant."); return; }
    setSaveError(null);
    startAdaptingMedia(async () => {
      try {
        const derivative = await onAdaptMedia(draft.id, source.id, target, draft.imagePrompt);
        setDraft((current) => ({ ...current, media: [...current.media.filter((item) => item.id !== derivative.id), derivative] }));
        setImageNotice("AI-versionen är klar som en separat bildvariant. Originalet är kvar.");
      } catch (reason) {
        setSaveError(reason instanceof Error ? reason.message : "Bilden kunde inte förbättras.");
      }
    });
  }

  function removeImage(media: StudioMediaView) {
    if (quarterlyPrivateReview) { setSaveError("Bildverktygen är låsta för det här privata batchutkastet."); return; }
    if (!uuidOrNull(draft.id) || !uuidOrNull(media.id)) return;
    setSaveError(null);
    setRemovingMediaId(media.id);
    void onRemoveMedia(draft.id, media.id).then(() => {
      setDraft((current) => ({ ...current, media: current.media.filter((item) => item.id !== media.id) }));
      setImageNotice("Bilden är borttagen från utkastet.");
    }).catch((reason: unknown) => {
      setSaveError(reason instanceof Error ? reason.message : "Bilden kunde inte tas bort.");
    }).finally(() => setRemovingMediaId(null));
  }

  function save(event: FormEvent) {
    event.preventDefault();
    if (busy || conflictServer || serverLocked || newBrandUnavailable) return;
    if (!draft.title.trim() && !draft.headline.trim()) { setImageNotice("Skriv en rubrik innan du sparar."); return; }
    if (draft.contentType === "newsletter" && draft.scheduledAt && !uuidOrNull(draft.newsletterAudienceId)) { setSaveError("Välj en mottagarlista innan du schemalägger ett nyhetsbrev."); return; }
    setSaveError(null);
    startSaving(async () => {
      try {
        const preserveApprovedQuarterlyDraft = initialDraft.quarterlyPrivateReview === true && draft.status === "approved";
        const schedule = studioDraftSchedulePatch(draft.scheduledLocalDate && draft.scheduledLocalTime ? `${draft.scheduledLocalDate}T${draft.scheduledLocalTime}` : "", draft.timezone);
        const saved = await onSave({ ...draft, ...schedule, status: quarterlyPrivateReview ? "in_review" : preserveApprovedQuarterlyDraft ? "approved" : schedule.scheduledAt ? draft.approvalRequired ? "in_review" : "scheduled" : "draft" });
        // A successful write increments the durable revision. Retain the
        // returned version so a second save from this editor stays valid.
        setDraft((current) => ({ ...saved, media: saved.media.length ? saved.media : current.media }));
        setSavedBase(saved);
        setImageNotice("Utkastet är sparat.");
      } catch (reason) {
        if (reason instanceof DraftRevisionConflictError && reason.latestDraft) {
          try {
            mergeDraftConflict(savedBase, draft, reason.latestDraft);
            setConflictServer(reason.latestDraft);
            setConflictChoices({});
            setImageNotice(null);
          } catch (invalidVersion) {
            setSaveError(invalidVersion instanceof Error ? invalidVersion.message : "Versionen kunde inte verifieras. Dina ändringar är kvar.");
            return;
          }
        }
        setSaveError(reason instanceof Error ? reason.message : "Kunde inte spara utkastet.");
      }
    });
  }

  function acceptConflictMerge() {
    if (!conflictServer || !conflictMerge || conflictMerge.unresolved.length) return;
    setRecoveryDrafts((current) => [...current, draft]);
    setSelectedRecovery(recoveryDrafts.length);
    setDraft(conflictMerge.draft);
    setSavedBase(conflictServer);
    setConflictServer(null);
    setConflictChoices({});
    setSaveError(null);
    setImageNotice("Versionerna är sammanfogade i editorn, inte sparade. Kontrollera resultatet och välj Spara utkast. Din tidigare redigering finns kvar som återställningskopia under denna redigering.");
  }

  function leaveEditor() {
    if (busy) return;
    if ((dirty || conflictServer) && !window.confirm("Du har osparade ändringar. Vill du lämna editorn utan att spara dem?")) return;
    onCancel();
  }

  function generateCopy() {
    if (newBrandUnavailable) { setSaveError("Välj ett färdigställt varumärke innan AI skapar text."); return; }
    if (quarterlyPrivateReview) { setSaveError("AI-omskrivning är låst för det här privata batchutkastet. Gör den redaktionella ändringen direkt i texten."); return; }
    if (draft.channels.length === 0) { setSaveError("Välj minst en kanal innan AI skapar ett utkast."); return; }
    if (draft.generationPrompt.trim().length < 3) { setSaveError("Skriv kort vad inlägget ska handla om innan AI skapar ett utkast."); return; }
    setSaveError(null);
    startGenerating(async () => {
      try {
        const generated = await onGenerate(draft);
        const variation = variationFromGeneration(generated, draft);
        setVariations((current) => [variation, ...current].slice(0, 3));
        setDraft((current) => ({ ...current, ...generated, updatedAt: new Date().toISOString() }));
        setActiveCanvas("copy");
        setImageNotice("AI-utkastet är klart. Det är ett arbetsförslag — finslipa det och spara bara den version du vill stå för.");
      } catch (reason) {
        setSaveError(reason instanceof Error ? reason.message : "AI-utkastet kunde inte skapas.");
      }
    });
  }

  function applyVariation(variation: LocalAiVariation) {
    const { id: variationId, ...proposal } = variation;
    if (!variationId) return;
    setDraft((current) => ({ ...current, ...proposal, updatedAt: new Date().toISOString() }));
    setActiveCanvas("copy");
    setImageNotice("AI-utkastet ligger nu på arbetsytan. Ändra fritt — inget sparas förrän du väljer Spara utkast.");
  }

  return (
    <form className={`${styles.editor} ${styles.editorWorkbench} ${styles.sagaWorkbench}`} onSubmit={save}>
      <header className={styles.workbenchHeader}>
        <div className={styles.workbenchTitleBlock}>
          <button className={styles.textButton} type="button" disabled={busy} onClick={leaveEditor}>← {isSavedDraft ? "Till granskning" : "Till Studio"}</button>
          <p className={styles.kicker}>SAGA STUDIO / REDIGERING</p>
          <h1>{quarterlyPrivateReview ? "Redigera returnerat utkast." : isSavedDraft ? "Redigera sparat utkast." : "Nytt redaktionellt utkast."}</h1>
          <p>{quarterlyPrivateReview ? "Privat batchutkast. Redigera innehållet här; beslut fattas i aktivitetsplanens batchgranskning." : "Ange riktning, skapa ett första förslag och kontrollera sedan text, form och tid i kalendern innan du sparar."}</p>
        </div>
        <div className={styles.workbenchHeaderActions}>
          <span className={styles.workbenchDraftState}><i aria-hidden="true" />{conflictServer ? "Versionskonflikt" : dirty ? "Osparade ändringar" : isSavedDraft ? "Sparat utkast" : "Ej sparat"}</span>
          <button className={`${styles.secondaryAction} ${styles.workbenchInspectorTrigger}`} type="button" aria-expanded={inspectorOpen} aria-controls="saga-workbench-inspector" onClick={() => setInspectorOpen(true)}>Egenskaper</button>
          <button className={styles.primaryAction} type="submit" disabled={busy || !!conflictServer || serverLocked || newBrandUnavailable}>{saving ? "Sparar…" : "Spara utkast"}</button>
        </div>
      </header>

      {saveError && <p className={styles.saveError} role="alert">{saveError}</p>}
      {!isSavedDraft && <section className={styles.conflictPanel} aria-label="Utkastets varumärke">
        <label className={styles.field}><span>Varumärke <small>låses när utkastet sparas</small></span><select aria-label="Varumärke för utkastet" value={draft.brandProfileId ?? ""} disabled={draftBrandsLoading || busy} onChange={(event) => setField("brandProfileId", event.target.value || null)}>
          <option value="">{draftBrandsLoading ? "Hämtar varumärken…" : "Välj varumärke"}</option>
          {draftBrands.map((brand) => <option key={brand.id} value={brand.id}>{brand.name}</option>)}
        </select></label>
        {draftBrandsError && <p role="alert">{draftBrandsError} <button type="button" onClick={() => { setDraftBrandsLoading(true); setBrandLoadAttempt((current) => current + 1); }}>Hämta varumärken igen</button></p>}
        {!draftBrandsLoading && !draftBrandsError && draftBrands.length === 0 && <p>Slutför varumärkets onboarding innan du sparar. <Link href="/studio/brands/new">Skapa varumärke</Link></p>}
      </section>}
      {serverLocked && <p className={styles.saveError} role="alert">Utkastet har låsts av ett beslut i en annan vy. Din lokala text finns kvar här, men får inte sparas över beslutet.</p>}
      {conflictMerge && <section className={styles.conflictPanel} aria-labelledby="draft-conflict-title">
        <h2 id="draft-conflict-title" ref={conflictHeading} tabIndex={-1}>Dina ändringar är kvar. Jämför med den sparade versionen.</h2>
        <p>Ändringar i olika fält kan kombineras. Datum, tid och tidszon hålls ihop. Om samma fält har ändrats på båda håll väljer du vilken version som ska användas. Inget sparas när du gör valet.</p>
        {conflictMerge.conflicts.length === 0 && <p>Inga fält krockar. Din text kan behållas tillsammans med ändringarna från den andra vyn.</p>}
        {conflictMerge.conflicts.map((field) => <fieldset className={styles.conflictField} key={field.key}>
          <legend>{field.label}</legend>
          <label><span><input type="radio" name={`conflict-${field.key}`} checked={conflictChoices[field.key] === "local"} onChange={() => setConflictChoices((current) => ({ ...current, [field.key]: "local" }))} /> Min redigering</span><pre>{field.local}</pre></label>
          <label><span><input type="radio" name={`conflict-${field.key}`} checked={conflictChoices[field.key] === "server"} onChange={() => setConflictChoices((current) => ({ ...current, [field.key]: "server" }))} /> Senast sparat</span><pre>{field.server}</pre></label>
        </fieldset>)}
        <button type="button" className={styles.primaryAction} disabled={conflictMerge.unresolved.length > 0} onClick={acceptConflictMerge}>Använd sammanfogad version</button>
        {conflictMerge.unresolved.length > 0 && <p role="status">Välj version för {conflictMerge.unresolved.length} fält innan du fortsätter.</p>}
      </section>}
      {recoveryDraft && <details className={styles.conflictPanel}>
        <summary>Återställningskopia av min tidigare redigering</summary>
        <p>Kopian finns i denna editor tills du lämnar sidan. Återställning skriver inget till servern; du måste fortfarande granska och spara.</p>
        {recoveryDrafts.length > 1 && <label>Välj återställningskopia <select value={selectedRecovery} onChange={(event) => setSelectedRecovery(Number(event.target.value))}>{recoveryDrafts.map((_, index) => <option key={index} value={index}>Före sammanfogning {index + 1}</option>)}</select></label>}
        <dl className={styles.recoveryText}>{draftReviewFields(recoveryDraft).map((field) => <div key={field.key}><dt>{field.label}</dt><dd>{field.value}</dd></div>)}</dl>
        <button type="button" className={styles.secondaryAction} disabled={busy || !!conflictServer} onClick={() => {
          setDraft({ ...recoveryDraft, revision: savedBase.revision, media: savedBase.media, status: savedBase.status, deliveryLocked: savedBase.deliveryLocked, privateBrief: savedBase.privateBrief, quarterlyPrivateReview: savedBase.quarterlyPrivateReview });
          setImageNotice("Din tidigare redigering är återställd lokalt. Kontrollera särskilt kanaler och tid innan du sparar.");
        }}>Återställ min tidigare redigering</button>
      </details>}
      {inspectorOpen && <button className={styles.workbenchScrim} type="button" aria-label="Stäng egenskaper" onClick={() => setInspectorOpen(false)} />}

      <fieldset className={`${styles.workbenchFrame} ${styles.workbenchEditableFields}`} disabled={busy || !!conflictServer || serverLocked}>
        <aside className={styles.workbenchRail} aria-label="Redaktionell styrning">
          <div className={styles.workbenchRailHeading}>
            <p className={styles.kicker}>REDIGERINGSFLÖDE</p>
            <strong>Arbeta i ordning. Spara först när innehållet håller.</strong>
          </div>
          <ol className={styles.workbenchStages} aria-label="Redaktionellt flöde">
            {SAGA_WORKBENCH_STAGES.map((stage, index) => {
              const active = stage.id === "brief" || (stage.id === "ai" && variations.length > 0) || (stage.id === "refine" && hasCopy) || (stage.id === handoff.stage);
              return <li key={stage.id} className={active ? styles.workbenchStageActive : undefined} aria-current={stage.id === handoff.stage ? "step" : undefined}><span>{String(index + 1).padStart(2, "0")}</span><div><strong>{stage.label}</strong><small>{stage.description}</small></div></li>;
            })}
          </ol>

          <section className={styles.workbenchBrief} aria-labelledby="studio-intake">
            <div className={styles.workbenchSectionHeading}><span>01</span><div><h2 id="studio-intake">Brief</h2><p>Definiera riktning och format innan AI används.</p></div></div>
            {quarterlyPrivateReview ? <div className={styles.audienceRequirement}><span aria-hidden="true">⌁</span><div><strong>Format, kanal och körning är låsta för batchen.</strong><p>Ändra den konkreta texten nedan och spara. Öppna sedan aktivitetsplanen för att skicka tillbaka samma privata utkast till granskning.</p></div></div> : <><div className={styles.typePicker}>
              {(["social_post", "newsletter", "article"] as StudioContentKind[]).map((type) => <label key={type} className={draft.contentType === type ? styles.selectedChoice : undefined}><input type="radio" name="contentType" checked={draft.contentType === type} onChange={() => setDraft((current) => ({ ...current, contentType: type, channels: type === "newsletter" ? ["newsletter"] : current.channels.filter((channel) => channel !== "newsletter") }))} /><span>{templateIcon(type)}</span><strong>{contentTypeLabel(type)}</strong></label>)}
            </div>
            <label className={styles.field}><span>Starta från mall <small>valfritt</small></span><select value={draft.templateId ?? ""} onChange={(event) => { const template = templates.find((item) => item.id === event.target.value); if (template) selectTemplate(template); else setField("templateId", null); }}><option value="">Ingen mall</option>{templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}</select></label>
            {selectedTemplate && <p className={styles.templateHint}>{selectedTemplate.description}</p>}
            <label className={styles.workbenchPromptField}><span>Instruktion till AI</span><textarea rows={5} value={draft.generationPrompt} onChange={(event) => setField("generationPrompt", event.target.value)} placeholder="Exempel: varför små AI-piloter ofta missar processen de ska förbättra." /><small>Beskriv önskad vinkel, fakta och avgränsning. Kontrollera resultatet före sparande.</small></label>
            <button className={styles.aiCopyButton} type="button" disabled={generating} onClick={generateCopy}>{generating ? "AI bearbetar…" : variations.length ? "Skapa nytt AI-förslag" : "Skapa AI-förslag"}<span aria-hidden="true">→</span></button></>}
          </section>

          {!quarterlyPrivateReview ? <section className={styles.workbenchVariations} aria-labelledby="saga-ai-variations-title">
            <div><p className={styles.kicker}>AI-FÖRSLAG</p><h2 id="saga-ai-variations-title">{variations.length ? "Välj förslag för fortsatt redigering" : "Inga förslag ännu"}</h2></div>
            {variations.length ? <ul>{variations.map((variation, index) => <li key={variation.id}><div><small>Försök {variations.length - index} · endast i denna redigering</small><strong>{variation.headline || variation.title || "Utan rubrik"}</strong></div><button type="button" onClick={() => applyVariation(variation)}>Använd</button></li>)}</ul> : <p>AI-förslag visas här först efter ett riktigt AI-anrop. De blir inte sparade förrän du själv sparar utkastet.</p>}
          </section> : null}
        </aside>

        <section className={styles.workbenchCanvasPanel} aria-label="Arbetsyta för innehåll">
          <nav className={styles.workbenchToolbar} aria-label="Redigeringsläge">
            <button type="button" aria-pressed={activeCanvas === "copy"} className={activeCanvas === "copy" ? styles.workbenchToolActive : undefined} onClick={() => setActiveCanvas("copy")}><span aria-hidden="true">T</span>Text</button>
            {!quarterlyPrivateReview ? <button type="button" aria-pressed={activeCanvas === "media"} className={activeCanvas === "media" ? styles.workbenchToolActive : undefined} onClick={() => setActiveCanvas("media")}><span aria-hidden="true">▧</span>Bild & form</button> : null}
            <button type="button" aria-pressed={activeCanvas === "preview"} className={activeCanvas === "preview" ? styles.workbenchToolActive : undefined} onClick={() => setActiveCanvas("preview")}><span aria-hidden="true">◌</span>Granska</button>
          </nav>

          {activeCanvas === "copy" && <section className={styles.workbenchDocument} id="studio-copy" aria-labelledby="studio-copy-title">
            <div className={styles.workbenchCanvasHeading}><div><p className={styles.kicker}>REDIGERBAR TEXT</p><h2 id="studio-copy-title">Innehåll</h2></div><span>{contentTypeLabel(draft.contentType)}</span></div>
            <div className={styles.workbenchPaper}>
              {draft.contentType === "newsletter" && <>
                <label className={styles.field}><span>Ämnesrad</span><input value={draft.subject} onChange={(event) => setField("subject", event.target.value)} placeholder="Vad får läsaren om den öppnar?" /></label>
                {quarterlyPrivateReview ? <div className={styles.audienceRequirement}><span aria-hidden="true">✉</span><div><strong>Mottagarlista väljs inte i den här batchen.</strong><p>Det här privata nyhetsbrevsutkastet kan redigeras, men kan inte förberedas för utskick från Studio. Beslutet ligger i batchgranskningen.</p></div></div> : <><label className={styles.field}><span>Mottagarlista <small>krävs före utskick</small></span><select value={draft.newsletterAudienceId ?? ""} onChange={(event) => setField("newsletterAudienceId", event.target.value || null)}><option value="">Välj mottagarlista</option>{audiences.map((audience) => <option key={audience.id} value={audience.id} disabled={!audience.active}>{audience.name}{audience.contactCount === null ? "" : ` · ${audience.contactCount} kontakter`}{audience.active ? "" : " · inaktiv"}</option>)}</select></label>
                <div className={styles.audienceRequirement}><span aria-hidden="true">✉</span><div><strong>{draft.newsletterAudienceId ? "Mottagarlista är vald." : "Mottagarlista krävs före utskick."}</strong><p>{draft.newsletterAudienceId ? "Listan kopplas till brevet först vid ett separat utskick. Kontakter visas inte här." : audiences.length ? "Brevet kan sparas som utkast nu. Välj en lista innan det får en tid i kalendern; den tiden är inte ett utskick." : "Ingen mottagarlista är konfigurerad ännu. Brevet kan sparas som utkast, men kan inte få en tid i kalendern eller skickas."}</p></div></div></>}
              </>}
              <label className={styles.field}><span>Intern titel <small>{quarterlyPrivateReview ? "syns i batchgranskningen" : "syns i kalendern"}</small></span><input value={draft.title} onChange={(event) => setField("title", event.target.value)} placeholder="Ge utkastet ett namn" /></label>
              <label className={styles.field}><span>Rubrik <small>syns för läsaren</small></span><textarea rows={3} value={draft.headline} onChange={(event) => setField("headline", event.target.value)} placeholder="Skriv det viktigaste först." /></label>
              <label className={`${styles.field} ${styles.workbenchBodyField}`}><span>Text</span><textarea rows={15} value={draft.body} onChange={(event) => setField("body", event.target.value)} placeholder="Skriv som du skulle säga det till en klok person du känner." /></label>
              <div className={styles.twoFields}><label className={styles.field}><span>Avslut / uppmaning</span><input value={draft.cta} onChange={(event) => setField("cta", event.target.value)} placeholder="Exempel: Vad tänker du?" /></label><label className={styles.field}><span>Hashtags</span><input value={draft.hashtags} onChange={(event) => setField("hashtags", event.target.value)} placeholder="#teknik #affär" /></label></div>
            </div>
          </section>}

          {!quarterlyPrivateReview && activeCanvas === "media" && <section className={styles.workbenchDocument} id="studio-media" aria-labelledby="studio-media-title">
            <div className={styles.workbenchCanvasHeading}><div><p className={styles.kicker}>BILD & FORM</p><h2 id="studio-media-title">Bildunderlag</h2></div><span>{draft.media.length} {draft.media.length === 1 ? "bild" : "bilder"}</span></div>
            <div className={styles.workbenchPaper}>
              <p className={styles.workbenchCanvasLead}>Utgå från egna bilder eller verklighetsnära motiv. Små detaljer får bära idén; undvik perfekta reklambilder, läsbar text och logotyper i motivet.</p>
              <input className={styles.fileInput} ref={fileInput} type="file" accept="image/*" onChange={addImage} />
              <div className={styles.mediaTools}>
                <button type="button" disabled={uploadingMedia} onClick={() => fileInput.current?.click()}><span>＋</span><strong>{uploadingMedia ? "Laddar upp…" : "Lägg till foto"}</strong><small>JPG, PNG eller WebP</small></button>
                <label><span>Bildriktning</span><textarea rows={6} value={draft.imagePrompt} onChange={(event) => setField("imagePrompt", event.target.value)} placeholder="Exempel: natur nära platsen, ett diskret spår i våt sand och mjukt kvällsljus. Inga ord eller logotyper i bilden." /><small>Riktningen följer med när du senare ber AI att förädla en verklig bild.</small></label>
                <button type="button" className={styles.aiMediaButton} disabled={adaptingMedia} onClick={adaptImage}><span aria-hidden="true">✦</span><strong>{adaptingMedia ? "Förbättrar…" : "Förbättra med AI"}</strong><small>Anpassa, beskär, förbättra</small></button>
              </div>
              {draft.media.length > 0 ? <div className={styles.mediaStrip}>{draft.media.map((media) => <div className={styles.mediaThumb} key={media.id} style={{ backgroundImage: `url("${media.url}")` }}><button type="button" disabled={removingMediaId === media.id} onClick={() => removeImage(media)} aria-label={`Ta bort ${media.alt}`}>{removingMediaId === media.id ? "…" : "×"}</button><span>{media.alt}</span></div>)}</div> : <div className={styles.workbenchMediaEmpty}><span aria-hidden="true">▧</span><div><strong>Ingen bild tillagd ännu.</strong><p>Du kan skriva klart först. När utkastet är sparat laddas egna bilder upp privat.</p></div></div>}
            </div>
          </section>}

          {activeCanvas === "preview" && <section className={styles.workbenchDocument} aria-labelledby="studio-preview-title">
            <div className={styles.workbenchCanvasHeading}><div><p className={styles.kicker}>KANALGRANSKNING</p><h2 id="studio-preview-title">Förhandsvisning</h2></div><button type="button" className={styles.textButton} onClick={() => setActiveCanvas("copy")}>Till text</button></div>
            <div className={styles.workbenchPreviewFrame}><PreviewTopBar channels={draft.channels} />{draft.contentType === "newsletter" ? <NewsletterCanvas draft={draft} /> : <SocialCanvas draft={draft} />}</div>
            <p className={styles.workbenchPreviewNote}>Förhandsvisningen hjälper dig bedöma helheten. Kanalens slutliga radbrytning och beskärning kan skilja sig.</p>
          </section>}

          {imageNotice && <p className={styles.inlineNotice} role="status">{imageNotice}</p>}
        </section>

        <aside id="saga-workbench-inspector" className={`${styles.workbenchInspector}${inspectorOpen ? ` ${styles.workbenchInspectorOpen}` : ""}`} aria-label="Egenskaper och nästa steg" role={inspectorOpen ? "dialog" : undefined} aria-modal={inspectorOpen || undefined}>
          <header className={styles.workbenchInspectorHeader}><div><p className={styles.kicker}>KONTROLLPANEL</p><h2>Kanal och status</h2></div><button className={styles.workbenchInspectorClose} type="button" onClick={() => setInspectorOpen(false)} aria-label="Stäng egenskaper">×</button></header>
          <section className={styles.workbenchInspectorSection} id="studio-delivery">
            <p className={styles.kicker}>KANAL & TID</p>
            {quarterlyPrivateReview ? <div className={styles.audienceRequirement}><span aria-hidden="true">⌁</span><div><strong>Batchens ramar är låsta.</strong><p>Kanaler, tid, tidszon och godkännande beslutas inte här. Den planerade aktiviteten är inte en bokad publicering.</p></div></div> : <>
              <fieldset className={styles.channelPicker}><legend>Förbered för kanal</legend><div>{STUDIO_CHANNELS.map((channel) => <label key={channel} className={`${draft.channels.includes(channel) ? styles.selectedChannel : ""}${draft.contentType === "newsletter" && channel !== "newsletter" ? ` ${styles.channelDisabled}` : ""}`}><input type="checkbox" checked={draft.channels.includes(channel)} disabled={draft.contentType === "newsletter" && channel !== "newsletter"} onChange={() => toggleChannel(channel)} /><span>{channelBadge(channel)}</span><strong>{channelLabel(channel)}</strong></label>)}</div></fieldset>
              <label className={styles.field}><span>Tid i kalendern <small>valfritt för utkast</small></span><input type="datetime-local" value={draft.scheduledLocalDate && draft.scheduledLocalTime ? `${draft.scheduledLocalDate}T${draft.scheduledLocalTime}` : ""} onChange={(event) => changeSchedule(event.target.value)} /></label>
              <label className={styles.field}><span>Tidszon</span><input value={draft.timezone} onChange={(event) => setField("timezone", event.target.value)} /></label>
              <label className={styles.approvalToggle}><input type="checkbox" checked={draft.approvalRequired} onChange={(event) => setField("approvalRequired", event.target.checked)} /><span><strong>Kräv mitt godkännande före nästa steg</strong><small>Att sätta en tid i SAGA skickar inget till en kanal.</small></span></label>
            </>}
          </section>
          <section className={styles.workbenchHandoff} aria-labelledby="saga-handoff-title">
            <p className={styles.kicker}>NÄSTA KONTROLL</p>
            <h2 id="saga-handoff-title">{quarterlyPrivateReview ? "Tillbaka till batchen efter sparandet." : handoff.title}</h2>
            <p>{quarterlyPrivateReview ? "Den här redigeringen kan inte starta en serie, automation eller publicering. Öppna aktivitetsplanen när du vill skicka tillbaka samma utkast till granskning." : handoff.detail}</p>
            {quarterlyPrivateReview ? <Link href="/studio/plan">Till aktivitetsplanen <span aria-hidden="true">→</span></Link> : handoff.stage === "reference" ? <Link href="/studio/series">Gör till referensinlägg <span aria-hidden="true">→</span></Link> : <button type="button" disabled>Spara och testa först</button>}
            <small>{quarterlyPrivateReview ? "Batchens beslut är det enda som kan låsa upp nästa privata utkast. Det här sparar bara din redaktionella ändring." : "Referens och automation är två separata, medvetna steg. SAGA aktiverar aldrig en rutin från ett osparat eller ogenomgånget AI-förslag."}</small>
          </section>
        </aside>
      </fieldset>
    </form>
  );
}

type AutomationEditorState = { mode: "create" | "edit"; automation: StudioAutomationView };

type StudioAutomationJobView = {
  id: string;
  automationRuleId: string;
  state: string;
  triggerKind: "scheduled" | "manual";
  contentDraftId: string | null;
  scheduledFor: string;
  completedAt: string | null;
  lastError: string | null;
  attemptCount: number;
};

type AutomationManualRunResult = {
  status: "draft_created" | "queued" | "processing" | "failed";
  draft: StudioDraftView | null;
  job: StudioAutomationJobView | null;
  message: string | null;
};

function StudioAutomations({ data, onSave, onDelete, onDuplicate, onRun, onLoadHistory, onNotice }: {
  data: StudioData;
  onSave: (automation: StudioAutomationView) => Promise<StudioAutomationView>;
  onDelete: (automationId: string) => Promise<void>;
  onDuplicate: (automationId: string) => Promise<StudioAutomationView>;
  onRun: (automationId: string, idempotencyKey: string) => Promise<AutomationManualRunResult>;
  onLoadHistory: (automationId: string) => Promise<StudioAutomationJobView[]>;
  onNotice: (notice: string) => void;
}) {
  const [editor, setEditor] = useState<AutomationEditorState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<StudioAutomationView | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const manualRunKeys = useRef<Record<string, string>>({});
  const activeCount = data.automations.filter((automation) => automation.active).length;
  const pausedCount = data.automations.length - activeCount;
  const queuedCount = data.calendarEntries.filter((entry) => entry.kind === "automation_job").length;

  async function saveEditor(automation: StudioAutomationView) {
    const saved = await onSave(automation);
    setEditor(null);
    onNotice(automation.id.startsWith("local-")
      ? "Automationen är sparad. Den följer schemat nedan."
      : "Automationen är uppdaterad.");
    return saved;
  }

  async function changeActive(automation: StudioAutomationView) {
    setPendingAction(`state:${automation.id}`);
    try {
      await onSave({ ...automation, active: !automation.active, updatedAt: new Date().toISOString() });
      onNotice(automation.active
        ? "Automationen är pausad. Framtida köposter stoppas av servern."
        : "Automationen är aktiv igen. Servern räknar fram nästa körning.");
    } catch (reason) {
      onNotice(reason instanceof Error ? reason.message : "Kunde inte ändra automationen.");
    } finally {
      setPendingAction(null);
    }
  }

  async function duplicateAutomation(automation: StudioAutomationView) {
    setPendingAction(`duplicate:${automation.id}`);
    try {
      const copy = await onDuplicate(automation.id);
      setEditor({ mode: "edit", automation: copy });
      onNotice("Kopian är skapad och pausad. Justera den innan du slår på den.");
    } catch (reason) {
      onNotice(reason instanceof Error ? reason.message : "Kunde inte duplicera automationen.");
    } finally {
      setPendingAction(null);
    }
  }

  async function runAutomationNow(automation: StudioAutomationView) {
    const currentKey = manualRunKeys.current[automation.id] ?? globalThis.crypto?.randomUUID?.();
    if (!currentKey) {
      onNotice("Kunde inte skapa en säker idempotensnyckel för körningen. Ladda om sidan och försök igen.");
      return;
    }
    manualRunKeys.current[automation.id] = currentKey;
    setPendingAction(`run:${automation.id}`);
    try {
      const result = await onRun(automation.id, currentKey);
      if (result.status === "draft_created") {
        delete manualRunKeys.current[automation.id];
        onNotice(result.message || "Ett nytt oschemalagt utkast är klart. Inget har skickats till en extern kanal.");
      } else if (result.status === "queued" || result.status === "processing") {
        delete manualRunKeys.current[automation.id];
        onNotice(result.message || "Körningen arbetar. Ett utkast visas när den är klar.");
      } else {
        onNotice(result.message || "Körningen misslyckades. Samma körning kan försökas igen.");
      }
    } catch (reason) {
      // Keep the key so a retry asks the server about the same manual run.
      onNotice(reason instanceof Error ? reason.message : "Kunde inte starta automationen.");
    } finally {
      setPendingAction(null);
    }
  }

  async function deleteAutomation() {
    if (!deleteTarget) return;
    setPendingAction(`delete:${deleteTarget.id}`);
    try {
      await onDelete(deleteTarget.id);
      onNotice(`”${deleteTarget.name}” är borttagen.`);
      setEditor((current) => current?.automation.id === deleteTarget.id ? null : current);
      setDeleteTarget(null);
    } catch (reason) {
      onNotice(reason instanceof Error ? reason.message : "Kunde inte ta bort automationen.");
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <>
      <section className={styles.pageLead}>
        <p className={styles.kicker}>AUTOMATIONER</p>
        <h1>Automatisera utan att tappa kontrollen.</h1>
        <p>Välj vad som ska skapas, när det ska hända och om varje utkast måste passera dig först.</p>
        <div className={styles.automationLeadActions}>
          <button type="button" className={styles.primaryAction} onClick={() => setEditor({ mode: "create", automation: emptyAutomation(data.timezone) })}>＋ Ny automation</button>
          <Link className={styles.secondaryAction} href="/studio/calendar">Se kalendern <span>→</span></Link>
        </div>
      </section>

      <section className={styles.automationStatusPanel} aria-label="Automationsstatus">
        <div><span>Aktiva</span><strong>{activeCount}</strong><small>skapar enligt schema</small></div>
        <div><span>Pausade</span><strong>{pausedCount}</strong><small>gör inget just nu</small></div>
        <div><span>I kalendern</span><strong>{queuedCount}</strong><small>köposter i visad period</small></div>
      </section>

      {editor && (
        <AutomationEditor
          key={`${editor.mode}-${editor.automation.id}`}
          mode={editor.mode}
          automation={editor.automation}
          onSave={saveEditor}
          onCancel={() => setEditor(null)}
        />
      )}

      <section className={styles.section}>
        <div className={styles.sectionHeading}>
          <div><p className={styles.kicker}>DINA FLÖDEN</p><h2>Det som körs — eller väntar på dig.</h2></div>
          <span className={styles.countPill}>{activeCount} aktiva</span>
        </div>
        {data.automations.length ? (
          <div className={styles.automationBoard}>
            {data.automations.map((automation) => (
              <AutomationCard
                key={automation.id}
                automation={automation}
                data={data}
                pendingAction={pendingAction}
                onEdit={() => setEditor({ mode: "edit", automation })}
                onToggle={() => void changeActive(automation)}
                onRun={() => void runAutomationNow(automation)}
                onDuplicate={() => void duplicateAutomation(automation)}
                onDelete={() => setDeleteTarget(automation)}
                onLoadHistory={onLoadHistory}
              />
            ))}
          </div>
        ) : (
          <EmptyBlock
            title="Inga automationer ännu."
            detail="Börja med ett tydligt flöde: till exempel tre inlägg i veckan som alltid landar hos dig som utkast."
            onClick={() => setEditor({ mode: "create", automation: emptyAutomation(data.timezone) })}
            action="Bygg första automationen"
          />
        )}
      </section>

      {deleteTarget && (
        <AutomationDeleteDialog
          automation={deleteTarget}
          deleting={pendingAction === `delete:${deleteTarget.id}`}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => void deleteAutomation()}
        />
      )}
    </>
  );
}

function AutomationCard({ automation, data, pendingAction, onEdit, onToggle, onRun, onDuplicate, onDelete, onLoadHistory }: {
  automation: StudioAutomationView;
  data: StudioData;
  pendingAction: string | null;
  onEdit: () => void;
  onToggle: () => void;
  onRun: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onLoadHistory: (automationId: string) => Promise<StudioAutomationJobView[]>;
}) {
  const linkedCalendarEntries = data.calendarEntries
    .filter((entry) => entry.automationRuleId === automation.id)
    .sort((left, right) => left.startAt.localeCompare(right.startAt));
  const nextCalendarEntry = linkedCalendarEntries[0] ?? null;
  const latestDraft = data.drafts
    .filter((draft) => draft.automationRuleId === automation.id)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null;
  const statePending = pendingAction === `state:${automation.id}`;
  const runPending = pendingAction === `run:${automation.id}`;
  const duplicatePending = pendingAction === `duplicate:${automation.id}`;
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<StudioAutomationJobView[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  async function toggleHistory() {
    if (historyOpen) { setHistoryOpen(false); return; }
    setHistoryOpen(true);
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      setHistory(await onLoadHistory(automation.id));
    } catch (reason) {
      setHistoryError(reason instanceof Error ? reason.message : "Kunde inte läsa körhistoriken.");
    } finally {
      setHistoryLoading(false);
    }
  }

  return (
    <article className={`${styles.automationCard}${automation.active ? "" : ` ${styles.automationCardPaused}`}`}>
      <header className={styles.automationCardHeader}>
        <span className={automation.active ? styles.liveDot : styles.pauseDot} aria-hidden="true" />
        <div>
          <div className={styles.automationCardTitleRow}>
            <h3>{automation.name}</h3>
            <span className={`${styles.automationState} ${automation.active ? styles.automationStateLive : styles.automationStatePaused}`}>{automation.active ? "Aktiv" : "Pausad"}</span>
          </div>
          <p>{contentTypeLabel(automation.contentType)} · {automation.postsPerWeek} {automation.postsPerWeek === 1 ? "utkast" : "utkast"} per vecka</p>
        </div>
      </header>

      <div className={styles.automationChannelRow} aria-label="Kanaler">
        {automation.channels.map((channel) => <span key={channel}>{channelBadge(channel)} {channelLabel(channel)}</span>)}
      </div>

      <div className={styles.automationCardBody}>
        <div className={styles.automationTopic}><span>Ämne</span><strong>{automation.topic || automation.prompt || "Ingen instruktion satt."}</strong></div>
        <dl className={styles.automationFacts}>
          <div><dt>Schema</dt><dd>{automationCadence(automation)}</dd></div>
          <div><dt>Nästa</dt><dd>{automation.active ? automation.nextRunAt ? `${formatWhen(automation.nextRunAt, automation.timezone)} · ${automation.timezone}` : "Beräknas av servern" : "Pausad"}</dd></div>
          <div><dt>Godkännande</dt><dd>{automation.approvalRequired ? "Du granskar före nästa steg" : "Skapar privat utkast enligt schema"}</dd></div>
        </dl>
      </div>

      <div className={styles.automationHistory}>
        <button type="button" aria-expanded={historyOpen} onClick={() => void toggleHistory()}>{historyOpen ? "Dölj körhistorik" : "Visa körhistorik"} <span>{historyOpen ? "↑" : "↓"}</span></button>
        {historyOpen && <div className={styles.automationHistoryPanel}>
          {historyLoading && <p>Hämtar körhistorik…</p>}
          {historyError && <p className={styles.automationHistoryError}>{historyError}</p>}
          {!historyLoading && !historyError && history && !history.length && <p>Inga körningar ännu.</p>}
          {!historyLoading && !historyError && history?.length ? <ul>{history.map((job) => <li key={job.id}><div><strong>{job.triggerKind === "manual" ? "Körd nu" : "Schema"} · {automationJobStateLabel(job.state)}</strong><small>{formatWhen(job.scheduledFor, automation.timezone)} · {automation.timezone}{job.completedAt ? ` · klar ${formatWhen(job.completedAt, automation.timezone)}` : ""}{job.attemptCount > 1 ? ` · försök ${job.attemptCount}` : ""}</small>{job.lastError && <em>{job.lastError}</em>}</div>{job.contentDraftId ? <Link href={`/studio/content/${job.contentDraftId}`}>Öppna utkast <span>→</span></Link> : <span className={styles.automationJobNoDraft}>{job.state === "queued" || job.state === "processing" ? "Inget utkast klart" : "Inget utkast"}</span>}</li>)}</ul> : null}
        </div>}
      </div>

      <footer className={styles.automationCardFooter}>
        <div className={styles.automationLinks}>
          {nextCalendarEntry && <Link href={nextCalendarEntry.draftId ? `/studio/content/${nextCalendarEntry.draftId}` : "/studio/calendar"}>{nextCalendarEntry.draftId ? "Öppna nästa utkast" : "Visa i kalendern"} <span>→</span></Link>}
          {!nextCalendarEntry && <Link href="/studio/calendar">Visa i kalendern <span>→</span></Link>}
          {latestDraft && (!nextCalendarEntry || nextCalendarEntry.draftId !== latestDraft.id) && <Link href={`/studio/content/${latestDraft.id}`}>Senaste utkast <span>→</span></Link>}
        </div>
        <div className={styles.automationCardActions}>
          <button type="button" onClick={onEdit}>Redigera</button>
          <button type="button" disabled={statePending} onClick={onToggle}>{statePending ? "Sparar…" : automation.active ? "Pausa" : "Återuppta"}</button>
          <button type="button" disabled={runPending} onClick={onRun}>{runPending ? "Skapar utkast…" : "Kör nu (utkast)"}</button>
          <button type="button" disabled={duplicatePending} onClick={onDuplicate}>{duplicatePending ? "Kopierar…" : "Duplicera"}</button>
          <button type="button" className={styles.automationDeleteButton} onClick={onDelete}>Ta bort</button>
        </div>
      </footer>
    </article>
  );
}

function AutomationEditor({ mode, automation, onSave, onCancel }: {
  mode: "create" | "edit";
  automation: StudioAutomationView;
  onSave: (automation: StudioAutomationView) => Promise<StudioAutomationView>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(() => normalizeAutomationDraft(automation));
  const [brands, setBrands] = useState<Array<{ id: string; name: string }>>([]);
  const [brandsLoading, setBrandsLoading] = useState(true);
  const [brandsError, setBrandsError] = useState<string | null>(null);
  const [isSaving, startSaving] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const socialChannels = STUDIO_CHANNELS.filter((channel) => channel !== "newsletter");

  useEffect(() => {
    let active = true;
    void readStudioEndpoint("/api/saga/brand-onboarding").then((response) => {
      if (!active) return;
      if (!response.ok || !isRecord(response.data) || !Array.isArray(response.data.onboardings)) {
        setBrandsError("Varumärkena kunde inte läsas. Öppna redigeraren igen för att försöka på nytt.");
        return;
      }
      const eligible = response.data.onboardings.flatMap((entry) => isRecord(entry)
        && entry.completionState === "completed" && entry.brandActive === true
        && typeof entry.brandProfileId === "string" && typeof entry.brandName === "string"
        ? [{ id: entry.brandProfileId, name: entry.brandName }] : []);
      setBrands(eligible);
      if (mode === "create" && eligible.length === 1) {
        setDraft((current) => ({ ...current, brandProfileId: current.brandProfileId || eligible[0]!.id }));
      }
    }).catch(() => {
      if (active) setBrandsError("Varumärkena kunde inte läsas. Öppna redigeraren igen för att försöka på nytt.");
    }).finally(() => { if (active) setBrandsLoading(false); });
    return () => { active = false; };
  }, [mode]);

  function setField<K extends keyof StudioAutomationView>(field: K, value: StudioAutomationView[K]) {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  function changeContentType(contentType: StudioContentKind) {
    setError(null);
    setDraft((current) => ({
      ...current,
      contentType,
      channels: contentType === "newsletter"
        ? ["newsletter"]
        : normalizeSocialChannels(current.channels),
    }));
  }

  function toggleChannel(channel: StudioChannelKind) {
    if (draft.contentType === "newsletter") return;
    setError(null);
    setDraft((current) => {
      const selected = current.channels.includes(channel);
      const social = normalizeSocialChannels(current.channels);
      if (selected && social.length === 1) {
        setError("Välj minst en kanal.");
        return current;
      }
      return { ...current, channels: selected ? social.filter((item) => item !== channel) : [...social, channel] };
    });
  }

  function changePostsPerWeek(count: number) {
    const postsPerWeek = Math.max(1, Math.min(7, count || 1));
    setError(null);
    setDraft((current) => ({ ...current, postsPerWeek, weekdays: normalizeWeekdaysForCount(postsPerWeek, current.weekdays) }));
  }

  function toggleWeekday(weekday: number) {
    setError(null);
    setDraft((current) => {
      const selected = current.weekdays.includes(weekday);
      if (selected && current.weekdays.length === 1) {
        setError("Välj minst en dag i veckan.");
        return current;
      }
      const weekdays = sortAutomationWeekdays(selected
        ? current.weekdays.filter((item) => item !== weekday)
        : [...current.weekdays, weekday]);
      return { ...current, weekdays, postsPerWeek: weekdays.length };
    });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const ready = normalizeAutomationDraft({ ...draft, updatedAt: new Date().toISOString() });
    if (brandsLoading || brandsError) { setError("Vänta tills varumärkena har kontrollerats."); return; }
    if (!ready.brandProfileId || !brands.some((brand) => brand.id === ready.brandProfileId)) { setError("Välj ett aktivt varumärke med slutförd onboarding. Äldre automationer utan varumärke måste ersättas med en ny automation."); return; }
    if (ready.name.trim().length < 2) { setError("Ge automationen ett tydligt namn."); return; }
    if (!ready.topic.trim()) { setError("Skriv vilket ämne automationen ska bevaka eller skapa kring."); return; }
    if (!ready.prompt.trim()) { setError("Skriv en kort instruktion till AI:n."); return; }
    if (!ready.channels.length) { setError("Välj minst en kanal."); return; }
    if (!ready.weekdays.length) { setError("Välj minst en dag i veckan."); return; }
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(ready.localTime)) { setError("Ange tid som HH:MM, till exempel 09:00."); return; }
    if (!isValidTimezone(ready.timezone)) { setError("Ange en giltig tidszon, till exempel Europe/Stockholm."); return; }
    setError(null);
    startSaving(async () => {
      try {
        await onSave(ready);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "Kunde inte spara automationen.");
      }
    });
  }

  return (
    <form className={`${styles.automationBuilder} ${styles.automationEditor}`} onSubmit={submit}>
      <header className={styles.automationEditorHeader}>
        <div><p className={styles.kicker}>{mode === "create" ? "NY AUTOMATION" : "REDIGERA AUTOMATION"}</p><h2>{mode === "create" ? "Sätt reglerna en gång." : "Ändra utan att tappa överblicken."}</h2><p>{mode === "create" ? "Automationen skapar privata utkast enligt ditt schema. Publicering är alltid ett separat steg." : "Ändringar gäller nästa körning. Redan skapade utkast ligger kvar i kalendern."}</p></div>
        <button type="button" className={styles.automationCloseButton} onClick={onCancel} aria-label="Stäng automationsredigeraren">×</button>
      </header>

      <ol className={styles.automationSteps} aria-label="Automationsinställningar">
        <li><span>1</span><div><strong>Vad</strong><small>format och kanal</small></div></li>
        <li><span>2</span><div><strong>När</strong><small>dagar, tid och zon</small></div></li>
        <li><span>3</span><div><strong>Hur</strong><small>instruktion och kontroll</small></div></li>
      </ol>

      <div className={styles.automationEditorGrid}>
        <section className={styles.automationEditorSection}>
          <div className={styles.automationSectionHeading}><span>01</span><div><h3>Vad ska skapas?</h3><p>Välj format och var utkasten ska användas.</p></div></div>
          <label className={styles.field}><span>Varumärke</span><select value={draft.brandProfileId ?? ""} disabled={mode === "edit" || brandsLoading || Boolean(brandsError)} onChange={(event) => setField("brandProfileId", event.target.value || null)}>
            <option value="">{brandsLoading ? "Kontrollerar varumärken…" : "Välj varumärke"}</option>
            {brands.map((brand) => <option key={brand.id} value={brand.id}>{brand.name}</option>)}
          </select><small>{mode === "edit" ? "Varumärket följer varje körning och går inte att byta. Skapa en ny automation för ett annat varumärke." : "AI använder just detta varumärkes redaktionella profil vid varje körning."}</small></label>
          {brandsError && <p className={styles.saveError} role="alert">{brandsError}</p>}
          {!brandsLoading && !brandsError && !brands.length && <p>Slutför ett varumärkes onboarding innan du skapar en automation.</p>}
          <div className={styles.automationTypePicker}>
            {(["social_post", "newsletter", "article"] as StudioContentKind[]).map((contentType) => (
              <label key={contentType} className={draft.contentType === contentType ? styles.automationTypeSelected : undefined}>
                <input type="radio" name="automation-content-type" checked={draft.contentType === contentType} onChange={() => changeContentType(contentType)} />
                <span>{templateIcon(contentType)}</span><strong>{contentTypeLabel(contentType)}</strong>
              </label>
            ))}
          </div>
          <label className={styles.field}><span>Namn</span><input value={draft.name} onChange={(event) => setField("name", event.target.value)} placeholder="Exempel: Tre Instagraminlägg i veckan" /></label>
          <label className={styles.field}><span>Ämne</span><input value={draft.topic} onChange={(event) => setField("topic", event.target.value)} placeholder="Exempel: praktiska AI-lärdomar för företagsledare" /></label>
          <fieldset className={styles.builderChannels}>
            <legend>Kanaler</legend>
            {draft.contentType === "newsletter" ? (
              <div className={styles.automationNewsletterOnly}><span>{channelBadge("newsletter")}</span><div><strong>Nyhetsbrev</strong><small>Automationen skapar brevutkast. Välj mottagarlista i utkastet innan utskick.</small></div></div>
            ) : (
              <div>{socialChannels.map((channel) => <label key={channel} className={draft.channels.includes(channel) ? styles.selectedChannel : undefined}><input type="checkbox" checked={draft.channels.includes(channel)} onChange={() => toggleChannel(channel)} /><span>{channelBadge(channel)}</span>{channelLabel(channel)}</label>)}</div>
            )}
          </fieldset>
        </section>

        <section className={styles.automationEditorSection}>
          <div className={styles.automationSectionHeading}><span>02</span><div><h3>När ska det hända?</h3><p>En tid används för alla valda dagar.</p></div></div>
          <label className={styles.field}><span>Utkast per vecka</span><select value={draft.postsPerWeek} onChange={(event) => changePostsPerWeek(Number(event.target.value))}>{[1, 2, 3, 4, 5, 6, 7].map((count) => <option key={count} value={count}>{count} {count === 1 ? "utkast" : "utkast"}</option>)}</select></label>
          <fieldset className={styles.dayPicker}><legend>Valda dagar</legend><div>{automationWeekdays.map((day) => <button key={day.value} type="button" className={draft.weekdays.includes(day.value) ? styles.daySelected : undefined} onClick={() => toggleWeekday(day.value)} aria-pressed={draft.weekdays.includes(day.value)}>{day.short}</button>)}</div><small>{automationDaysLabel(draft.weekdays)}</small></fieldset>
          <div className={styles.twoFields}>
            <label className={styles.field}><span>Tid</span><input type="time" value={draft.localTime} onChange={(event) => setField("localTime", event.target.value || "09:00")} /></label>
            <label className={styles.field}><span>Tidszon</span><input list="automation-timezones" value={draft.timezone} onChange={(event) => setField("timezone", event.target.value)} placeholder="Europe/Stockholm" /><datalist id="automation-timezones"><option value="Europe/Stockholm" /><option value="Europe/London" /><option value="America/New_York" /><option value="America/Los_Angeles" /><option value="Asia/Dubai" /></datalist></label>
          </div>
          <div className={styles.automationSchedulePreview}><span aria-hidden="true">◷</span><div><strong>{automationCadence(draft)}</strong><small>{draft.active ? "Nästa körning räknas ut och läggs i kalendern av servern." : "Den här automationen är pausad tills du återupptar den."}</small></div></div>
        </section>

        <section className={`${styles.automationEditorSection} ${styles.automationInstructionsSection}`}>
          <div className={styles.automationSectionHeading}><span>03</span><div><h3>Hur ska AI:n arbeta?</h3><p>Skriv klart och konkret. Det här är instruktionen som följer varje körning.</p></div></div>
          <label className={styles.field}><span>Instruktion till AI</span><textarea rows={5} value={draft.prompt} onChange={(event) => setField("prompt", event.target.value)} placeholder="Exempel: Skriv en skarp insikt med ett konkret exempel. Undvik utfyllnad och generiska råd." /></label>
          <div className={styles.twoFields}>
            <label className={styles.field}><span>Ton</span><select value={draft.tone} onChange={(event) => setField("tone", event.target.value)}><option>Rak och varm</option><option>Skärpt och analytisk</option><option>Personlig och reflekterande</option><option>Energi och driv</option></select></label>
            <label className={styles.field}><span>Längd</span><select value={draft.targetLength} onChange={(event) => setField("targetLength", targetLengthValue(event.target.value))}><option value="short">Kort</option><option value="medium">Mellan</option><option value="long">Längre</option></select></label>
          </div>
          <label className={styles.field}><span>Bildriktning <small>valfritt</small></span><textarea rows={3} value={draft.imageDirection} onChange={(event) => setField("imageDirection", event.target.value)} placeholder="Exempel: dokumentär naturbild, väderbitet trä och en diskret abstrakt detalj som följer innehållets idé. Inga ord eller logotyper." /><small>SAGA lägger alltid på en återhållen, dokumentär finish före privat granskning.</small></label>
          <label className={styles.approvalToggle}><input type="checkbox" checked={draft.approvalRequired} onChange={(event) => setField("approvalRequired", event.target.checked)} /><span><strong>Kräv mitt godkännande före nästa steg</strong><small>{draft.approvalRequired ? "Varje körning stannar som ett redigerbart utkast." : "Automationen skapar fortfarande bara ett privat utkast. Du väljer senare om och när det får en tid eller skickas till en kanal."}</small></span></label>
        </section>
      </div>
      {error && <p className={styles.saveError} role="alert">{error}</p>}
      <footer className={styles.automationEditorFooter}><button type="button" className={styles.secondaryAction} onClick={onCancel}>Avbryt</button><button className={styles.primaryAction} type="submit" disabled={isSaving}>{isSaving ? "Sparar…" : mode === "create" ? "Skapa automation" : "Spara ändringar"} <span>→</span></button></footer>
    </form>
  );
}

function AutomationDeleteDialog({ automation, deleting, onCancel, onConfirm }: { automation: StudioAutomationView; deleting: boolean; onCancel: () => void; onConfirm: () => void }) {
  return <div className={styles.automationDialogBackdrop} role="presentation">
    <section className={styles.automationDeleteDialog} role="dialog" aria-modal="true" aria-labelledby="delete-automation-title">
      <span className={styles.automationDialogIcon} aria-hidden="true">!</span>
      <p className={styles.kicker}>TA BORT AUTOMATION</p>
      <h2 id="delete-automation-title">Ta bort ”{automation.name}”?</h2>
      <p>Det går inte att ångra. Servern tar bort regeln och dess framtida köposter. Utkast som redan skapats ligger kvar tills du tar bort dem separat.</p>
      <div><button type="button" className={styles.secondaryAction} disabled={deleting} onClick={onCancel}>Behåll automationen</button><button type="button" className={styles.automationDangerAction} disabled={deleting} onClick={onConfirm}>{deleting ? "Tar bort…" : "Ta bort"}</button></div>
    </section>
  </div>;
}

function emptyAutomation(timezone: string): StudioAutomationView {
  const now = new Date().toISOString();
  return {
    id: localAutomationId(),
    name: "",
    active: true,
    contentType: "social_post",
    channels: ["instagram"],
    postsPerWeek: 3,
    weekdays: [1, 3, 5],
    localTime: "09:00",
    timezone,
    topic: "",
    prompt: "",
    tone: "Rak och varm",
    targetLength: "medium",
    imageDirection: "",
    approvalRequired: true,
    nextRunAt: null,
    lastRunAt: null,
    updatedAt: now,
  };
}

function localAutomationId() {
  return `local-automation-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`;
}

function normalizeAutomationDraft(automation: StudioAutomationView): StudioAutomationView {
  const contentType = automation.contentType;
  const channels = contentType === "newsletter" ? ["newsletter"] as StudioChannelKind[] : normalizeSocialChannels(automation.channels);
  const postsPerWeek = Math.max(1, Math.min(7, automation.postsPerWeek || automation.weekdays.length || 1));
  return {
    ...automation,
    contentType,
    channels,
    postsPerWeek,
    weekdays: normalizeWeekdaysForCount(postsPerWeek, automation.weekdays),
    localTime: /^([01]\d|2[0-3]):[0-5]\d$/.test(automation.localTime) ? automation.localTime : "09:00",
    timezone: automation.timezone || "Europe/Stockholm",
    tone: automation.tone || "Rak och varm",
    targetLength: targetLengthValue(automation.targetLength),
  };
}

function normalizeSocialChannels(channels: StudioChannelKind[]) {
  const social = [...new Set(channels.filter((channel) => channel !== "newsletter"))];
  return social.length ? social : ["instagram"] as StudioChannelKind[];
}

function normalizeWeekdaysForCount(count: number, current: number[]) {
  const requested = Math.max(1, Math.min(7, count));
  const known = sortAutomationWeekdays([...new Set(current.filter((weekday) => automationWeekdays.some((day) => day.value === weekday)))]);
  const fallbacks = automationWeekdays.map((day) => day.value);
  return sortAutomationWeekdays([...known, ...fallbacks.filter((weekday) => !known.includes(weekday))].slice(0, requested));
}

function sortAutomationWeekdays(values: number[]) {
  return [...values].sort((left, right) => automationWeekdays.findIndex((day) => day.value === left) - automationWeekdays.findIndex((day) => day.value === right));
}

function automationDaysLabel(values: number[]) {
  const labels = sortAutomationWeekdays(values)
    .flatMap((weekday) => {
      const label = automationWeekdays.find((day) => day.value === weekday)?.label;
      return label ? [label] : [];
    });
  return labels.length ? labels.join(", ") : "Inga dagar valda";
}

function automationCadence(automation: Pick<StudioAutomationView, "postsPerWeek" | "weekdays" | "localTime" | "timezone">) {
  const count = `${automation.postsPerWeek} ${automation.postsPerWeek === 1 ? "utkast" : "utkast"} per vecka`;
  return `${count} · ${automationDaysLabel(automation.weekdays)} kl. ${automation.localTime} · ${automation.timezone}`;
}

function targetLengthValue(value: string): StudioAutomationView["targetLength"] {
  return value === "short" || value === "long" ? value : "medium";
}

function isValidTimezone(value: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function automationJobStateLabel(state: string) {
  return {
    queued: "I kö",
    processing: "Arbetar",
    completed: "Klar",
    failed: "Misslyckades",
    cancelled: "Avbruten",
    skipped: "Hoppad över",
  }[state] ?? state;
}

function StudioTemplates({ data }: { data: StudioData }) {
  const templates = resolvedTemplates(data);
  return <>
    <section className={styles.pageLead}><p className={styles.kicker}>MALLBIBLIOTEK</p><h1>Mallar</h1><p>En mall bestämmer struktur och rekommenderade kanaler, inte vad du ska tycka eller skriva.</p><Link className={styles.primaryAction} href="/studio/content/new?edit=1">＋ Börja utan mall</Link></section>
    <section className={styles.templateGrid}>{templates.map((template) => <article key={template.id} className={styles.templateCard}><div className={styles.templateCardTop}><span>{templateIcon(template.contentType)}</span><small>{template.isBuiltIn ? "GRUNDMALL" : "EGEN MALL"}</small></div><h2>{template.name}</h2><p>{template.description}</p><div>{template.channels.map((channel) => <span key={channel}>{channelBadge(channel)} {channelLabel(channel)}</span>)}</div><Link href={`/studio/content/new?edit=1&template=${encodeURIComponent(template.id)}`}>Använd mallen <span>→</span></Link></article>)}</section>
  </>;
}

function StudioChannels({ data, onNotice, onDisconnectChannel, onCreateAudience, onRefreshAudiences }: { data: StudioData; onNotice: (notice: string) => void; onDisconnectChannel: (connectionId: string) => Promise<void>; onCreateAudience: (input: { name: string; description: string; senderName: string | null; senderEmail: string | null; replyToEmail: string | null }) => Promise<StudioNewsletterAudienceView>; onRefreshAudiences: () => Promise<StudioNewsletterAudienceView[]> }) {
  const known = STUDIO_CHANNELS.filter((kind) => kind !== "newsletter").map((kind) => {
    const discovered = data.channels.find((channel) => channel.kind === kind);
    if (discovered) return discovered;

    const isChecking = data.channelLoadState === "loading";
    return {
      id: `unconnected-${kind}`,
      kind,
      accountName: null,
      state: isChecking ? "checking" as const : "unavailable" as const,
      canPublish: false,
      lastSyncedAt: null,
      missingConfiguration: data.channelLoadMissing,
      unavailableReason: isChecking
        ? "Kontrollerar kanalens inställningar."
        : data.channelLoadError ?? "Kanalens inställningar kunde inte läsas från servern.",
    };
  });
  return <>
    <section className={styles.pageLead}><p className={styles.kicker}>KANALER OCH KONTO</p><h1>Kanaler</h1><p>Anslut bara de konton du vill använda. Du kan koppla bort dem när som helst.</p></section>
    <section className={styles.channelGrid}>{known.map((channel) => <ChannelCard channel={channel} key={channel.kind} onNotice={onNotice} onDisconnect={onDisconnectChannel} />)}<NewsletterChannelCard audiences={data.newsletterAudiences} delivery={data.newsletterDelivery} /></section>
    <NewsletterAudienceManager audiences={data.newsletterAudiences} onCreateAudience={onCreateAudience} onRefreshAudiences={onRefreshAudiences} onNotice={onNotice} />
    <section className={styles.connectionNote}><span aria-hidden="true">⌁</span><div><strong>Det här händer när du ansluter.</strong><p>Du loggar in hos kanalen, väljer rätt konto och godkänner bara behörigheter som krävs för att skapa utkast, ladda upp media och publicera.</p></div></section>
  </>;
}

function NewsletterChannelCard({ audiences, delivery }: { audiences: StudioNewsletterAudienceView[]; delivery: StudioNewsletterDeliveryStatus }) {
  const activeAudiences = audiences.filter((audience) => audience.active);
  const totalContacts = activeAudiences.reduce<number | null>((total, audience) => total === null || audience.contactCount === null ? null : total + audience.contactCount, 0);
  const ready = delivery.configured && activeAudiences.length > 0;
  const missing = delivery.missing.length ? delivery.missing.join(", ") : "leveranskonfiguration";
  const copy = !delivery.configured
    ? `Utskick är inte konfigurerat. Saknar: ${missing}.`
    : activeAudiences.length
      ? `${activeAudiences.length} aktiv${activeAudiences.length === 1 ? "" : "a"} mottagarlista${activeAudiences.length === 1 ? "" : "or"}${totalContacts === null ? "" : ` · ${totalContacts} kontakter`}.`
      : "Skapa en aktiv mottagarlista innan du kan schemalägga ett brev.";
  return <article className={`${styles.channelCard} ${styles.channelNewsletter}`}><div className={styles.channelCardHead}><span>{channelBadge("newsletter")}</span><i className={ready ? styles.liveDot : styles.warningDot} /></div><h2>Nyhetsbrev</h2><p>{copy}</p><div className={styles.channelState}><span>{ready ? "Klar för utskick" : !delivery.configured ? `Saknar: ${missing}` : "Kräver mottagarlista"}</span></div><Link className={styles.primaryAction} href="/studio/content/new?edit=1&template=built-in-weekly-letter">{ready ? "Skapa nyhetsbrev" : "Skapa utkast"}</Link></article>;
}

function NewsletterAudienceManager({ audiences, onCreateAudience, onRefreshAudiences, onNotice }: { audiences: StudioNewsletterAudienceView[]; onCreateAudience: (input: { name: string; description: string; senderName: string | null; senderEmail: string | null; replyToEmail: string | null }) => Promise<StudioNewsletterAudienceView>; onRefreshAudiences: () => Promise<StudioNewsletterAudienceView[]>; onNotice: (notice: string) => void }) {
  const [selectedAudienceId, setSelectedAudienceId] = useState<string | null>(audiences[0]?.id ?? null);
  const [creating, setCreating] = useState(audiences.length === 0);
  const [saving, startSaving] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const selected = audiences.find((audience) => audience.id === selectedAudienceId) ?? audiences[0] ?? null;

  function createAudience(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError(null);
    startSaving(async () => {
      try {
        const created = await onCreateAudience({
          name: String(form.get("name") ?? "").trim(),
          description: String(form.get("description") ?? "").trim(),
          senderName: nullableFormValue(form.get("senderName")),
          senderEmail: nullableFormValue(form.get("senderEmail")),
          replyToEmail: nullableFormValue(form.get("replyToEmail")),
        });
        setSelectedAudienceId(created.id);
        setCreating(false);
        onNotice("Mottagarlistan är skapad. Lägg nu till personer som har tackat ja till brevet.");
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "Kunde inte skapa mottagarlistan.");
      }
    });
  }

  return <section className={styles.audienceManager}>
    <div className={styles.sectionHeading}><div><p className={styles.kicker}>NYHETSBREV</p><h2>Mottagarlistor och samtycke.</h2><p>Här hanterar du listor och personer. Adresser visas bara när du öppnar en specifik lista.</p></div><button type="button" className={styles.secondaryAction} onClick={() => void onRefreshAudiences().catch((reason) => setError(reason instanceof Error ? reason.message : "Kunde inte uppdatera listorna."))}>↻ Uppdatera</button></div>
    <div className={styles.audienceLayout}>
      <div className={styles.audienceList} aria-label="Mottagarlistor">
        {audiences.map((audience) => <button type="button" key={audience.id} className={audience.id === selected?.id ? styles.audienceSelected : undefined} onClick={() => { setSelectedAudienceId(audience.id); setCreating(false); }}><span>{audience.active ? "●" : "○"}</span><div><strong>{audience.name}</strong><small>{audience.contactCount === null ? "Antal kontakter hämtas vid behov" : `${audience.subscribedCount ?? audience.contactCount} prenumererar · ${audience.contactCount} totalt`}</small></div><i>›</i></button>)}
        <button type="button" className={styles.newAudienceButton} onClick={() => setCreating((value) => !value)}>＋ Ny mottagarlista</button>
      </div>
      <div className={styles.audienceWorkspace}>
        {creating ? <form className={styles.audienceForm} onSubmit={createAudience}>
          <div><p className={styles.kicker}>NY MOTTAGARLISTA</p><h3>Vem ska få brevet?</h3></div>
          <label className={styles.field}><span>Namn på listan</span><input required name="name" placeholder="Exempel: Kunder i Norden" /></label>
          <label className={styles.field}><span>Beskrivning</span><textarea required name="description" rows={3} placeholder="Vilka personer är med och varför får de brevet?" /></label>
          <div className={styles.twoFields}><label className={styles.field}><span>Avsändarnamn <small>valfritt</small></span><input name="senderName" placeholder="Erik / Brief" /></label><label className={styles.field}><span>Avsändaradress <small>valfritt</small></span><input type="email" name="senderEmail" placeholder="hello@dittbolag.se" /></label></div>
          <label className={styles.field}><span>Svarsadress <small>valfritt</small></span><input type="email" name="replyToEmail" placeholder="svar@dittbolag.se" /></label>
          {error && <p className={styles.saveError} role="alert">{error}</p>}
          <button type="submit" className={styles.primaryAction} disabled={saving}>{saving ? "Skapar…" : "Skapa mottagarlista"}</button>
        </form> : selected ? <NewsletterContacts key={selected.id} audience={selected} onAudienceChanged={onRefreshAudiences} onNotice={onNotice} /> : <div className={styles.audienceEmpty}><span>✉</span><h3>Börja med en mottagarlista.</h3><p>Ett nyhetsbrev kan inte skickas till en okänd grupp.</p></div>}
      </div>
    </div>
  </section>;
}

function NewsletterContacts({ audience, onAudienceChanged, onNotice }: { audience: StudioNewsletterAudienceView; onAudienceChanged: () => Promise<StudioNewsletterAudienceView[]>; onNotice: (notice: string) => void }) {
  const [contacts, setContacts] = useState<StudioNewsletterContactView[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, startAdding] = useTransition();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void readStudioEndpoint(`/api/newsletter/audiences/${encodeURIComponent(audience.id)}/contacts?limit=100`).then((response) => {
      if (!active) return;
      if (!response.ok) { setContacts([]); setError(responseError(response.data, "Kunde inte läsa mottagarna.")); }
      else setContacts(newsletterContactsFromPayload(response.data));
      setLoading(false);
    });
    return () => { active = false; };
  }, [audience.id]);

  function addContact(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    if (form.get("consent") !== "on") { setError("Bekräfta att personen har tackat ja till just denna mottagarlista."); return; }
    setError(null);
    startAdding(async () => {
      const response = await writeStudioEndpoint(`/api/newsletter/audiences/${encodeURIComponent(audience.id)}/contacts`, "POST", {
        email: String(form.get("email") ?? "").trim(),
        displayName: nullableFormValue(form.get("displayName")),
        status: "subscribed",
        consentSource: String(form.get("consentSource") ?? "manual").trim() || "manual",
        consentedAt: new Date().toISOString(),
        contactMetadata: {},
      });
      const rawContact = isRecord(response.data) && isRecord(response.data.contact) ? response.data.contact : response.data;
      const contact = newsletterContactsFromPayload({ contacts: [rawContact] })[0];
      if (!response.ok || !contact) { setError(responseError(response.data, "Kunde inte lägga till mottagaren.")); return; }
      setContacts((current) => [contact, ...current.filter((item) => item.id !== contact.id)]);
      formElement.reset();
      void onAudienceChanged().catch(() => undefined);
      onNotice("Mottagaren är tillagd med dokumenterat samtycke.");
    });
  }

  return <div className={styles.contactsPanel}>
    <header><div><p className={styles.kicker}>MOTTAGARLISTA</p><h3>{audience.name}</h3><p>{audience.description || "Ingen beskrivning angiven."}</p></div><span>{audience.active ? "Aktiv" : "Inaktiv"}</span></header>
    <form className={styles.contactForm} onSubmit={addContact}>
      <div className={styles.contactFormHeading}><strong>Lägg till person</strong><small>Endast personer som har tackat ja till brevet.</small></div>
      <div className={styles.twoFields}><label className={styles.field}><span>E-postadress</span><input required type="email" name="email" placeholder="namn@foretag.se" /></label><label className={styles.field}><span>Namn <small>valfritt</small></span><input name="displayName" placeholder="Förnamn Efternamn" /></label></div>
      <label className={styles.field}><span>Varifrån kommer samtycket?</span><input required name="consentSource" defaultValue="Manuellt tillagd med samtycke" /></label>
      <label className={styles.consentToggle}><input type="checkbox" name="consent" /><span><strong>Jag bekräftar att personen har tackat ja.</strong><small>Detta sätts som samtycke för den här listan. Lägg inte in köpta eller oklara listor.</small></span></label>
      {error && <p className={styles.saveError} role="alert">{error}</p>}
      <button type="submit" className={styles.secondaryAction} disabled={adding}>{adding ? "Lägger till…" : "Lägg till person"}</button>
    </form>
    <div className={styles.contactList} aria-live="polite"><div className={styles.contactListHeading}><strong>Personer i listan</strong><span>{loading ? "Hämtar…" : `${contacts.length} visas`}</span></div>{!loading && !contacts.length && <p>Inga personer i listan ännu.</p>}{contacts.map((contact) => <div key={contact.id}><span className={styles.contactAvatar}>{(contact.displayName || contact.email).slice(0, 1).toLocaleUpperCase("sv-SE")}</span><div><strong>{contact.displayName || contact.email}</strong><small>{contact.displayName ? contact.email : `Samtycke: ${contact.consentSource}`}</small></div><span className={styles.contactStatus}>{contact.status === "subscribed" ? "Prenumererar" : contact.status}</span></div>)}</div>
  </div>;
}

function ChannelCard({ channel, onNotice, onDisconnect }: { channel: StudioChannelView; onNotice: (notice: string) => void; onDisconnect: (connectionId: string) => Promise<void> }) {
  const hasConnectRoute = Boolean(channel.connectUrl);
  const hasConfigurationGap = channel.state === "unavailable" || (!hasConnectRoute && (channel.state === "disconnected" || channel.state === "needs_reauth"));
  const [disconnecting, startDisconnecting] = useTransition();
  const missing = channel.missingConfiguration ?? [];
  const setupReason = missing.length
    ? `Saknar: ${missing.join(", ")}.`
    : channel.unavailableReason ?? "Kopplingen är inte konfigurerad ännu.";
  const stateLabel = channel.state === "connected"
    ? "Ansluten"
    : channel.state === "needs_reauth"
      ? "Logga in igen"
      : channel.state === "checking"
        ? "Kontrollerar"
        : hasConfigurationGap
          ? "Inställning krävs"
          : "Inte ansluten";
  const description = channel.accountName
    ? `Kopplad som ${channel.accountName}`
    : channel.state === "checking"
      ? "Kontrollerar om kontot kan anslutas."
      : hasConfigurationGap
        ? "Kontot kan inte anslutas förrän inställningarna nedan är klara."
      : "Koppla kontot när du är redo att publicera.";

  function disconnect() {
    if (!uuidOrNull(channel.id)) {
      onNotice("Kontot behöver läsas om innan det går att koppla från. Uppdatera sidan och försök igen.");
      return;
    }
    if (!window.confirm(`Koppla från ${channelLabel(channel.kind)}? Studio kan inte längre använda kontot förrän det ansluts igen.`)) return;
    startDisconnecting(async () => {
      try {
        await onDisconnect(channel.id);
        onNotice(`${channelLabel(channel.kind)} är frånkopplad. Studio kan inte längre använda kontot.`);
      } catch (reason) {
        onNotice(reason instanceof Error ? reason.message : "Kunde inte koppla från kontot.");
      }
    });
  }

  return <article className={`${styles.channelCard} ${styles[`channel${channel.kind.replace("_page", "").replace(/(^.)/, (letter) => letter.toUpperCase())}`] ?? ""}`}>
    <div className={styles.channelCardHead}><span>{channelBadge(channel.kind)}</span><i className={channel.state === "connected" ? styles.liveDot : channel.state === "needs_reauth" ? styles.warningDot : styles.pauseDot} /></div>
    <h2>{channelLabel(channel.kind)}</h2>
    <p>{description}</p>
    {hasConfigurationGap && <div className={styles.channelSetup} role="note"><strong>Vad saknas?</strong><span>{setupReason}</span></div>}
    <div className={styles.channelState}><span>{stateLabel}</span>{channel.lastSyncedAt && <small>Synkad {formatWhen(channel.lastSyncedAt)}</small>}</div>
    {channel.state === "connected"
      ? <button type="button" className={styles.secondaryAction} disabled={disconnecting} onClick={disconnect}>{disconnecting ? "Kopplar från…" : "Koppla från konto"}</button>
      : hasConnectRoute
        ? <a className={styles.primaryAction} href={channel.connectUrl!}>{channel.state === "needs_reauth" ? "Logga in igen" : "Anslut konto"}</a>
        : channel.state === "checking"
          ? <span className={styles.channelPending}>Kontrollerar anslutning…</span>
          : <button type="button" className={styles.secondaryAction} onClick={() => window.location.reload()}>{hasConfigurationGap ? "Uppdatera status" : "Försök igen"}</button>}
  </article>;
}

function DraftRows({ drafts }: { drafts: StudioDraftView[] }) {
  return <ul className={styles.draftRows}>{drafts.map((draft) => <li key={draft.id}><Link href={`/studio/content/${draft.id}`}><span className={`${styles.status} ${statusClass(draft.status)}`}>{studioPlanningStatusLabel(draft.status)}</span><div><strong>{draft.title || draft.headline || "Utan rubrik"}</strong><small>{channelList(draft.channels)} · {draft.scheduledAt ? `Tid i kalendern ${formatWhen(draft.scheduledAt)}` : "Ingen tid vald"}</small></div><i>›</i></Link></li>)}</ul>;
}

function EmptyBlock({ title, detail, actionHref, action, onClick }: { title: string; detail: string; actionHref?: string; action: string; onClick?: () => void }) {
  return <div className={styles.emptyBlock}><span aria-hidden="true">✦</span><div><h2>{title}</h2><p>{detail}</p>{actionHref ? <Link href={actionHref}>{action} →</Link> : <button type="button" onClick={onClick}>{action} →</button>}</div></div>;
}

function PreviewTopBar({ channels }: { channels: StudioChannelKind[] }) {
  return <div className={styles.previewTopBar}><span>FÖRHANDSVISNING</span><div>{channels.length ? channels.map((channel) => <span key={channel}>{channelBadge(channel)}</span>) : <span>Välj kanal</span>}</div></div>;
}

function SocialCanvas({ draft }: { draft: StudioDraftView }) {
  const firstMedia = draft.media[0];
  return <div className={styles.socialCanvas}><div className={styles.socialIdentity}><span className={styles.avatar}>B</span><div><strong>Ditt konto</strong><small>{draft.channels.length ? channelList(draft.channels) : "Välj kanal"}</small></div><i>•••</i></div>{firstMedia ? <div className={styles.socialImage} style={{ backgroundImage: `url("${firstMedia.url}")` }} /> : <div className={styles.socialPlaceholder}><span>＋</span><strong>Din bild</strong><small>Lägg till foto eller AI-bild i redigeraren.</small></div>}<div className={styles.socialCopy}><h2>{draft.headline || "Din rubrik visas här."}</h2><p>{draft.body || "Skriv enkelt och konkret. Förhandsvisningen visar din text innan du väljer nästa steg."}</p>{draft.cta && <strong className={styles.socialCta}>{draft.cta}</strong>}{draft.hashtags && <span className={styles.hashtags}>{draft.hashtags}</span>}</div></div>;
}

function NewsletterCanvas({ draft }: { draft: StudioDraftView }) {
  return <div className={styles.newsletterCanvas}><div className={styles.emailChrome}><span>Från: {draft.newsletterAudienceId ? "Konfigurerad mottagarlista" : "Mottagarlista ej vald"}</span><span>{draft.subject || "Din ämnesrad visas här"}</span></div><div className={styles.emailBody}><p className={styles.emailBrand}>NYHETSBREV · FÖRHANDSVISNING</p><h2>{draft.headline || "Skriv en rubrik som gör det värt att läsa vidare."}</h2><p>{draft.body || "Här ser du hur brevet kommer kännas. Du kan skriva, lägga in en bild och redigera tidpunkten från samma vy."}</p>{draft.cta && <a>{draft.cta} →</a>}<footer>{draft.newsletterAudienceId ? "Mottagarlistan och avsändaren hämtas vid utskick." : "Detta är bara en förhandsvisning. Ingen mottagarlista är vald."}</footer></div></div>;
}

function useStudioData(contentId?: string) {
  // Keep the server preview and the client's first hydration render on the
  // same explicit "checking" snapshot. The factory prevents a retained
  // module-level object from leaking a completed preflight into a later SSR.
  const [data, setData] = useState<StudioData>(() => createEmptyStudioData());
  const [draftRequest, setDraftRequest] = useState<(StudioDraftLoadState & { id: string }) | null>(null);
  const [draftLoadAttempt, setDraftLoadAttempt] = useState(0);
  // The bounded collection is a tray, not proof that a direct-linked draft
  // does not exist. Resolve omitted IDs through the actor-scoped detail API.
  const missingDraftId = contentId && contentId !== "new" && data.backendState === "ready"
    && !data.drafts.some((draft) => draft.id === contentId) ? contentId : null;
  const draftLoadState: StudioDraftLoadState = draftRequest && draftRequest.id === contentId
    ? draftRequest : { status: "loading", message: null };
  const retryDraftLoad = useCallback(() => {
    setDraftRequest(null);
    setDraftLoadAttempt((attempt) => attempt + 1);
  }, []);

  useEffect(() => {
    if (!missingDraftId) return;
    const controller = new AbortController();
    let active = true;
    void Promise.resolve().then(async () => {
      if (!active) return;
      setDraftRequest({ id: missingDraftId, status: "loading", message: null });
      const response = await readStudioEndpoint(`/api/content/drafts/${encodeURIComponent(missingDraftId)}`, controller.signal);
      if (!active) return;
      const payload = isRecord(response.data) && isRecord(response.data.draft) ? response.data.draft : null;
      const draft = response.ok && payload ? draftsFromPayload({ drafts: [payload] }).find((entry) => entry.id === missingDraftId) : null;
      if (draft) {
        setData((current) => ({ ...current, drafts: current.drafts.some((entry) => entry.id === draft.id)
          ? current.drafts : [...current.drafts, draft] }));
      } else {
        setDraftRequest({ id: missingDraftId, status: response.status === 404 ? "missing" : "error", message:
          responseError(response.data, "Det gick inte att läsa den sparade versionen. Inget har ändrats. Försök igen.") });
      }
    });
    return () => { active = false; controller.abort(); };
  }, [missingDraftId, draftLoadAttempt]);

  useEffect(() => {
    let active = true;
    const month = new Date();
    const from = formatDateInput(new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1)), "Europe/Stockholm");
    const to = formatDateInput(new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 2, 0)), "Europe/Stockholm");
    void Promise.all([
      readStudioEndpoint("/api/content/drafts?include=media"),
      readStudioEndpoint("/api/content/templates"),
      readStudioEndpoint("/api/content/automations"),
      readStudioEndpoint(`/api/content/calendar?from=${from}&to=${to}&timezone=Europe%2FStockholm`),
      readStudioEndpoint("/api/content/newsletter-audiences"),
      readStudioEndpoint("/api/newsletter/audiences"),
      readStudioEndpoint("/api/newsletter/status"),
      readStudioEndpoint("/api/social/channels"),
    ]).then(([drafts, templates, automations, calendar, audienceConfiguration, audienceSummary, newsletterDelivery, channels]) => {
      if (!active) return;
      const loaded = true;
      const backend = studioBackendReadiness([
        { ...drafts, establishesPersistence: true },
        { ...templates, establishesPersistence: true },
        { ...automations, establishesPersistence: true },
        { ...calendar, establishesPersistence: true },
        { ...audienceConfiguration, establishesPersistence: true },
        { ...audienceSummary, establishesPersistence: true },
        { ...newsletterDelivery, establishesPersistence: true },
        // This endpoint is a safe channel diagnostic, but a 200 from it
        // cannot make Studio write controls real by itself.
        { ...channels, establishesPersistence: false },
      ]);
      const channelLoadError = channels.ok
        ? null
        : responseError(channels.data, "Kunde inte läsa kanalinställningarna. Kontrollera att du är inloggad och att Studio-servern är ansluten.");
      const channelLoadMissing = channels.ok ? [] : configurationMissing(channels.data);
      const remoteDrafts = drafts.ok ? draftsFromPayload(drafts.data) : [];
      const remoteAutomations = automations.ok ? automationsFromPayload(automations.data).map(hydrateAutomationBrief) : [];
      const remoteAudiences = mergeNewsletterAudiences(
        audienceConfiguration.ok ? newsletterAudiencesFromPayload(audienceConfiguration.data) : [],
        audienceSummary.ok ? newsletterAudiencesFromPayload(audienceSummary.data) : [],
      );
      setData({
        timezone: "Europe/Stockholm",
        drafts: remoteDrafts,
        templates: mergeTemplates(templates.ok ? templatesFromPayload(templates.data) : []),
        automations: remoteAutomations,
        calendarEntries: calendar.ok ? calendarFromPayload(calendar.data) : [],
        channels: channels.ok ? socialChannelsFromPayload(channels.data) : [],
        newsletterAudiences: remoteAudiences,
        newsletterDelivery: newsletterDelivery.ok ? newsletterDeliveryStatusFromPayload(newsletterDelivery.data) : { configured: false, missing: [] },
        channelLoadState: channels.ok ? "ready" : "error",
        channelLoadError,
        channelLoadMissing,
        loaded,
        backendState: backend.state,
        backendIssue: backend.issue,
      });
    });
    return () => { active = false; };
  }, []);

  const loadCalendarRange = useCallback(async (from: string, to: string, timezone: string) => {
    const response = await readStudioEndpoint(`/api/content/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&timezone=${encodeURIComponent(timezone)}`);
    if (!response.ok) throw new Error(responseError(response.data, "Kunde inte läsa den här kalenderperioden."));
    const nextEntries = calendarFromPayload(response.data);
    setData((current) => {
      const outsideRange = current.calendarEntries.filter((entry) => {
        const entryDate = formatDateInput(new Date(entry.startAt), timezone);
        return entryDate < from || entryDate > to;
      });
      return { ...current, calendarEntries: [...nextEntries, ...outsideRange] };
    });
  }, []);

  const disconnectChannel = useCallback(async (connectionId: string) => {
    if (!uuidOrNull(connectionId)) throw new Error("Kontot kan inte kopplas från eftersom anslutnings-id saknas.");
    let response: Response;
    try {
      response = await fetch(`/api/social/connections/id/${encodeURIComponent(connectionId)}`, { method: "DELETE" });
    } catch {
      throw new Error("Kunde inte kontakta servern för att koppla från kontot.");
    }
    const payload = await responseJson(response);
    if (!response.ok) throw new Error(responseError(payload, "Kunde inte koppla från kontot."));
    setData((current) => ({
      ...current,
      channels: current.channels.map((channel) => channel.id === connectionId
        ? { ...channel, accountName: null, canPublish: false, lastSyncedAt: null, state: "disconnected" }
        : channel),
    }));
  }, []);

  async function saveDraft(draft: StudioDraftView) {
    const isLocal = draft.id.startsWith("local-");
    const endpoint = isLocal ? studioBrandEndpoint("/api/content/drafts", draft.brandProfileId) : `/api/content/drafts/${encodeURIComponent(draft.id)}`;
    const response = await writeStudioEndpoint(endpoint, isLocal ? "POST" : "PATCH", draftPayload(draft));
    if (!response.ok && response.status === 409 && !isLocal) {
      const latestResponse = await readStudioEndpoint(`/api/content/drafts/${encodeURIComponent(draft.id)}`);
      const latestPayload = isRecord(latestResponse.data) && isRecord(latestResponse.data.draft)
        ? latestResponse.data.draft
        : latestResponse.data;
      const latest = latestResponse.ok && isRecord(latestPayload)
        ? draftsFromPayload({ drafts: [latestPayload] })[0] ?? null
        : null;
      // Do not replace the parent's draft yet: a concurrently approved or
      // locked draft could unmount the editor and destroy its unsaved text.
      // The editor owns this separate snapshot until an explicit resolution.
      throw new DraftRevisionConflictError(latest);
    }
    const savedPayload = isRecord(response.data) && isRecord(response.data.draft) ? response.data.draft : response.data;
    const saved = response.ok ? draftsFromPayload(savedPayload)[0] ?? (isRecord(savedPayload) ? draftsFromPayload({ drafts: [savedPayload] })[0] : null) : null;
    if (!saved) throw new Error(responseError(response.data, "Kunde inte spara utkastet. Kontrollera att innehålls-API:t är anslutet och försök igen."));
    const next = { ...saved, media: saved.media.length ? saved.media : draft.media };
    setData((current) => ({ ...current, drafts: [next, ...current.drafts.filter((item) => item.id !== next.id)], calendarEntries: calendarEntriesWithDraft(current.calendarEntries, next) }));
    return next;
  }

  async function saveAutomation(automation: StudioAutomationView) {
    const local = automation.id.startsWith("local-");
    const response = await writeStudioEndpoint(local ? "/api/content/automations" : `/api/content/automations/${encodeURIComponent(automation.id)}`, local ? "POST" : "PATCH", automationPayload(automation));
    const savedPayload = isRecord(response.data) && isRecord(response.data.automation) ? response.data.automation : response.data;
    const rawSaved = response.ok ? automationsFromPayload(savedPayload)[0] ?? (isRecord(savedPayload) ? automationsFromPayload({ automations: [savedPayload] })[0] : null) : null;
    const saved = rawSaved ? hydrateAutomationBrief(rawSaved) : null;
    if (!saved) throw new Error(responseError(response.data, "Kunde inte spara automationen. Kontrollera att innehålls-API:t är anslutet och försök igen."));
    const next = saved;
    setData((current) => ({
      ...current,
      automations: [next, ...current.automations.filter((item) => item.id !== next.id)],
      // Pausing cancels future queued jobs on the server. Remove only those
      // local calendar rows; do not invent new jobs when the rule resumes.
      calendarEntries: next.active
        ? current.calendarEntries
        : current.calendarEntries.filter((entry) => entry.automationRuleId !== next.id),
    }));
    return next;
  }

  async function duplicateAutomation(automationId: string) {
    let response: Response;
    try {
      response = await fetch(`/api/content/automations/${encodeURIComponent(automationId)}/duplicate`, { method: "POST" });
    } catch {
      throw new Error("Kunde inte kontakta servern för att duplicera automationen.");
    }
    const payload = await responseJson(response);
    const rawAutomation = isRecord(payload) && isRecord(payload.automation) ? payload.automation : payload;
    const parsed = response.ok ? automationsFromPayload({ automations: [rawAutomation] })[0] ?? null : null;
    const automation = parsed ? hydrateAutomationBrief(parsed) : null;
    if (!automation) throw new Error(responseError(payload, "Kunde inte duplicera automationen."));
    setData((current) => ({ ...current, automations: [automation, ...current.automations.filter((item) => item.id !== automation.id)] }));
    return automation;
  }

  async function runAutomation(automationId: string, idempotencyKey: string): Promise<AutomationManualRunResult> {
    const response = await writeStudioEndpoint(`/api/content/automations/${encodeURIComponent(automationId)}/run`, "POST", { idempotencyKey });
    const payload = response.data;
    const rawStatus = isRecord(payload) ? stringValue(payload.status) : "";
    const status = rawStatus === "draft_created" || rawStatus === "queued" || rawStatus === "processing" || rawStatus === "failed" ? rawStatus : null;
    if (!status) throw new Error(responseError(payload, "Kunde inte köra automationen."));

    const rawAutomation = isRecord(payload) && isRecord(payload.automation) ? payload.automation : null;
    const rawDraft = isRecord(payload) && isRecord(payload.draft) ? payload.draft : null;
    const rawJob = isRecord(payload) && isRecord(payload.job) ? payload.job : null;
    const parsedAutomation = rawAutomation ? automationsFromPayload({ automations: [rawAutomation] })[0] ?? null : null;
    const nextAutomation = parsedAutomation ? hydrateAutomationBrief(parsedAutomation) : null;
    const draft = rawDraft ? draftsFromPayload({ drafts: [rawDraft] })[0] ?? null : null;
    const job = rawJob ? automationJobFromPayload(rawJob) : null;
    const message = isRecord(payload) ? nullableStringValue(payload.message) : null;

    if (nextAutomation || draft) {
      setData((current) => ({
        ...current,
        automations: nextAutomation ? [nextAutomation, ...current.automations.filter((item) => item.id !== nextAutomation.id)] : current.automations,
        // A manual run intentionally creates an unscheduled private draft.
        // Do not turn it into a calendar entry in the client.
        drafts: draft ? [draft, ...current.drafts.filter((item) => item.id !== draft.id)] : current.drafts,
      }));
    }

    return { status, draft, job, message };
  }

  async function loadAutomationHistory(automationId: string) {
    const response = await readStudioEndpoint(`/api/content/automations/${encodeURIComponent(automationId)}/jobs?limit=20`);
    if (!response.ok) throw new Error(responseError(response.data, "Kunde inte läsa körhistoriken."));
    return automationJobsFromPayload(response.data);
  }

  async function deleteAutomation(automationId: string) {
    if (automationId.startsWith("local-")) throw new Error("Automationen har inte sparats ännu och kan därför inte tas bort från servern.");
    let response: Response;
    try {
      response = await fetch(`/api/content/automations/${encodeURIComponent(automationId)}`, { method: "DELETE" });
    } catch {
      throw new Error("Kunde inte kontakta servern för att ta bort automationen.");
    }
    const payload = await responseJson(response);
    if (!response.ok) throw new Error(responseError(payload, "Kunde inte ta bort automationen."));
    setData((current) => ({
      ...current,
      automations: current.automations.filter((automation) => automation.id !== automationId),
      calendarEntries: current.calendarEntries.filter((entry) => entry.automationRuleId !== automationId),
    }));
  }

  async function refreshNewsletterAudiences() {
    const [configuration, summary] = await Promise.all([
      readStudioEndpoint("/api/content/newsletter-audiences"),
      readStudioEndpoint("/api/newsletter/audiences"),
    ]);
    if (!configuration.ok && !summary.ok) throw new Error("Kunde inte uppdatera mottagarlistorna.");
    const next = mergeNewsletterAudiences(
      configuration.ok ? newsletterAudiencesFromPayload(configuration.data) : [],
      summary.ok ? newsletterAudiencesFromPayload(summary.data) : [],
    );
    setData((current) => ({ ...current, newsletterAudiences: next }));
    return next;
  }

  async function createNewsletterAudience(input: {
    name: string;
    description: string;
    senderName: string | null;
    senderEmail: string | null;
    replyToEmail: string | null;
  }) {
    const response = await writeStudioEndpoint("/api/content/newsletter-audiences", "POST", {
      ...input,
      audienceMetadata: {},
      active: true,
    });
    const rawAudience = isRecord(response.data) && isRecord(response.data.audience) ? response.data.audience : response.data;
    const audience = newsletterAudiencesFromPayload({ audiences: [rawAudience] })[0];
    if (!response.ok || !audience) throw new Error(responseError(response.data, "Kunde inte skapa mottagarlistan."));
    setData((current) => ({ ...current, newsletterAudiences: [audience, ...current.newsletterAudiences.filter((item) => item.id !== audience.id)] }));
    void refreshNewsletterAudiences().catch(() => undefined);
    return audience;
  }

  async function generateDraft(draft: StudioDraftView): Promise<Partial<StudioDraftView>> {
    const response = await writeStudioEndpoint(studioBrandEndpoint("/api/content/generate", draft.brandProfileId), "POST", {
      contentType: draft.contentType,
      channels: draft.channels,
      topic: draft.generationPrompt,
      brief: "",
      voice: "Rak, varm och konkret svenska.",
      targetLength: "medium",
      templateInstructions: "",
      desiredCallToAction: draft.cta,
      imageDirection: draft.imagePrompt,
    });
    if (!response.ok || !isRecord(response.data) || !isRecord(response.data.draft)) {
      throw new Error(responseError(response.data, "AI-utkastet kunde inte skapas. Kontrollera varumärkesvalet och AI-anslutningen."));
    }
    const generated = response.data.draft;
    const hashtags = Array.isArray(generated.hashtags) ? generated.hashtags.filter((item): item is string => typeof item === "string").join(" ") : "";
    return {
      title: stringValue(generated.title),
      headline: stringValue(generated.headline),
      subject: stringValue(generated.subject),
      body: stringValue(generated.body),
      cta: stringValue(generated.callToAction ?? generated.cta),
      excerpt: stringValue(generated.excerpt),
      hashtags,
      imagePrompt: stringValue(generated.imagePrompt, draft.imagePrompt),
    };
  }

  async function uploadMedia(draftId: string, file: File, altText?: string): Promise<StudioMediaView> {
    if (!uuidOrNull(draftId)) throw new Error("Spara utkastet innan du laddar upp en bild.");
    const form = new FormData();
    form.set("file", file);
    if (altText) form.set("altText", altText);
    let response: Response;
    try {
      response = await fetch(`/api/content/drafts/${encodeURIComponent(draftId)}/media/upload`, { method: "POST", body: form });
    } catch {
      throw new Error("Bilden kunde inte laddas upp. Kontrollera anslutningen och försök igen.");
    }
    const payload = await responseJson(response);
    if (!response.ok) throw new Error(responseError(payload, "Bilden kunde inte laddas upp."));
    const media = mediaFromPayload(payload)[0];
    if (!media) throw new Error("Bilden laddades upp men ett säkert förhandsformat saknas.");
    setData((current) => ({ ...current, drafts: current.drafts.map((draft) => draft.id === draftId ? { ...draft, media: [...draft.media.filter((item) => item.id !== media.id), media] } : draft) }));
    return media;
  }

  async function adaptMedia(draftId: string, mediaId: string, target: StudioChannelKind, instruction: string): Promise<StudioMediaView> {
    if (!uuidOrNull(draftId) || !uuidOrNull(mediaId)) throw new Error("Spara utkastet och bilden innan AI skapar en variant.");
    const response = await writeStudioEndpoint(`/api/content/media/${encodeURIComponent(mediaId)}/adapt`, "POST", {
      target,
      instruction,
      preserveSubject: true,
      outputStyle: "editorial",
    });
    if (!response.ok) throw new Error(responseError(response.data, "Bilden kunde inte förbättras."));
    const media = mediaFromPayload(response.data)[0];
    if (!media) throw new Error("Bildvarianten skapades men kunde inte visas säkert.");
    setData((current) => ({ ...current, drafts: current.drafts.map((draft) => draft.id === draftId ? { ...draft, media: [...draft.media.filter((item) => item.id !== media.id), media] } : draft) }));
    return media;
  }

  async function removeMedia(draftId: string, mediaId: string): Promise<void> {
    if (!uuidOrNull(draftId) || !uuidOrNull(mediaId)) throw new Error("Bilden kan inte tas bort innan utkastet har sparats.");
    let response: Response;
    try {
      response = await fetch(`/api/content/drafts/${encodeURIComponent(draftId)}/media/${encodeURIComponent(mediaId)}`, { method: "DELETE" });
    } catch {
      throw new Error("Bilden kunde inte tas bort. Kontrollera anslutningen och försök igen.");
    }
    const payload = await responseJson(response);
    if (!response.ok) throw new Error(responseError(payload, "Bilden kunde inte tas bort."));
    setData((current) => ({ ...current, drafts: current.drafts.map((draft) => draft.id === draftId ? { ...draft, media: draft.media.filter((item) => item.id !== mediaId) } : draft) }));
  }

  return { data, draftLoadState, retryDraftLoad, loadCalendarRange, disconnectChannel, saveDraft, saveAutomation, deleteAutomation, duplicateAutomation, runAutomation, loadAutomationHistory, createNewsletterAudience, refreshNewsletterAudiences, generateDraft, uploadMedia, adaptMedia, removeMedia };
}

async function readStudioEndpoint(url: string, signal?: AbortSignal): Promise<{ ok: boolean; status: number; data: unknown }> {
  try {
    const response = await fetch(url, { cache: "no-store", credentials: "same-origin", signal });
    return { ok: response.ok, status: response.status, data: await responseJson(response) };
  } catch { return { ok: false, status: 0, data: null }; }
}

async function writeStudioEndpoint(url: string, method: "POST" | "PATCH", body: unknown): Promise<{ ok: boolean; status: number; data: unknown }> {
  try {
    const response = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { ok: response.ok, status: response.status, data: await responseJson(response) };
  } catch { return { ok: false, status: 0, data: null }; }
}

async function responseJson(response: Response): Promise<unknown> {
  try { return await response.json() as unknown; } catch { return null; }
}

function responseError(payload: unknown, fallback: string) {
  return isRecord(payload) && typeof payload.error === "string" && payload.error ? payload.error : fallback;
}

function configurationMissing(payload: unknown): string[] {
  if (!isRecord(payload) || !Array.isArray(payload.missing)) return [];
  return payload.missing.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

/** Match the durable server schema exactly; UI-only fields never cross the wire. */
export function draftPayload(draft: StudioDraftView) {
  const channels = draft.contentType === "newsletter"
    ? ["newsletter"] as StudioChannelKind[]
    : draft.channels.filter((channel) => channel !== "newsletter");
  const quarterlyPrivateReview = isQuarterlyPrivateReviewDraft(draft);
  const preserveApprovedQuarterlyDraft = draft.quarterlyPrivateReview === true && draft.status === "approved";
  // While a batch draft is still under review its desired activity time lives
  // only on the plan slot. Do not echo a stale/injected delivery time before
  // the server records an approved batch decision.
  const hasCompleteSchedule = !quarterlyPrivateReview && Boolean(draft.scheduledAt && draft.scheduledLocalDate && draft.scheduledLocalTime);
  const status = quarterlyPrivateReview
    ? "in_review"
    : preserveApprovedQuarterlyDraft
      ? "approved"
    : draft.status === "scheduled" && !hasCompleteSchedule
    ? "draft"
    : ["draft", "in_review", "approved", "scheduled", "cancelled"].includes(draft.status)
      ? draft.status
      : "draft";
  const expectedRevision = uuidOrNull(draft.id) && typeof draft.revision === "number" && Number.isInteger(draft.revision) && draft.revision >= 1
    ? draft.revision
    : null;
  return {
    contentType: draft.contentType,
    channels,
    title: draft.title.trim(),
    headline: nullableText(draft.headline),
    subject: nullableText(draft.subject),
    body: draft.body,
    cta: nullableText(draft.cta),
    excerpt: nullableText(draft.excerpt),
    hashtags: splitHashtags(draft.hashtags),
    status,
    generationPrompt: nullableText(draft.generationPrompt),
    imagePrompt: nullableText(draft.imagePrompt),
    language: "sv",
    timezone: draft.timezone,
    scheduledAt: hasCompleteSchedule ? draft.scheduledAt : null,
    scheduledLocalDate: hasCompleteSchedule ? draft.scheduledLocalDate : null,
    scheduledLocalTime: hasCompleteSchedule ? draft.scheduledLocalTime : null,
    approvalRequired: quarterlyPrivateReview ? true : draft.approvalRequired,
    templateId: uuidOrNull(draft.templateId),
    automationRuleId: uuidOrNull(draft.automationRuleId),
    newsletterAudienceId: uuidOrNull(draft.newsletterAudienceId),
    // A full persisted editor document may include schedule fields. Sending
    // its current revision keeps that combined content/time update atomic;
    // fresh local drafts deliberately have no revision yet.
    ...(expectedRevision === null ? {} : { expectedRevision }),
  };
}

function automationPayload(automation: StudioAutomationView) {
  return {
    brandProfileId: automation.brandProfileId ?? null,
    name: automation.name.trim(),
    active: automation.active,
    contentType: automation.contentType,
    channels: automation.contentType === "newsletter" ? ["newsletter"] : automation.channels.filter((channel) => channel !== "newsletter"),
    templateId: null,
    newsletterAudienceId: null,
    generationPrompt: serializeAutomationBrief(automation),
    imagePrompt: automation.imageDirection,
    desiredLength: automation.targetLength === "short" ? 70 : automation.targetLength === "long" ? 380 : 180,
    tone: nullableText(automation.tone),
    language: "sv",
    approvalRequired: automation.approvalRequired,
    timezone: automation.timezone,
    scheduleMode: "weekly_count",
    weeklyCount: automation.postsPerWeek,
    weekdays: automation.weekdays.length === automation.postsPerWeek ? automation.weekdays : [],
    localTimes: [automation.localTime],
    cronExpression: null,
    startsOn: null,
    endsOn: null,
  };
}

const automationTopicMarker = "## ÄMNE\n";
const automationInstructionMarker = "\n\n## INSTRUKTION\n";

/**
 * The durable automation contract has one generation-prompt field. Keeping a
 * short, explicit topic inside that prompt lets the Studio restore the two
 * fields users actually edit without inventing a second client-side record.
 */
function serializeAutomationBrief(automation: Pick<StudioAutomationView, "topic" | "prompt">) {
  const topic = automation.topic.trim();
  const prompt = automation.prompt.trim();
  return topic ? `${automationTopicMarker}${topic}${automationInstructionMarker}${prompt}` : prompt;
}

function hydrateAutomationBrief(automation: StudioAutomationView): StudioAutomationView {
  if (automation.topic.trim() || !automation.prompt.startsWith(automationTopicMarker)) return automation;
  const divider = automation.prompt.indexOf(automationInstructionMarker);
  if (divider < 0) return automation;
  const topic = automation.prompt.slice(automationTopicMarker.length, divider).trim();
  const prompt = automation.prompt.slice(divider + automationInstructionMarker.length).trim();
  return { ...automation, topic, prompt };
}

function nullableText(value: string) { const normalized = value.trim(); return normalized || null; }
function splitHashtags(value: string) { return value.split(/[\s,]+/).map((entry) => entry.trim()).filter(Boolean).slice(0, 30); }
function uuidOrNull(value: string | null) { return value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : null; }

function emptyDraft(timezone: string, template: StudioTemplateView | null, date: string | null): StudioDraftView {
  const now = new Date().toISOString();
  const dateTime = date ? `${date}T09:00` : "";
  return {
    id: `local-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`,
    contentType: template?.contentType ?? "social_post",
    channels: template?.channels ?? [],
    title: "",
    headline: "",
    subject: "",
    body: "",
    cta: "",
    excerpt: "",
    hashtags: "",
    status: "draft",
    generationPrompt: "",
    imagePrompt: "",
    timezone,
    scheduledAt: dateTime ? localDateTimeToUtcIso(date!, "09:00", timezone) : null,
    scheduledLocalDate: date ?? null,
    scheduledLocalTime: date ? "09:00" : null,
    revision: null,
    approvalRequired: true,
    media: [],
    templateId: template?.id ?? null,
    automationRuleId: null,
    newsletterAudienceId: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function studioDraftSchedulePatch(value: string, timezone: string): Pick<StudioDraftView, "scheduledAt" | "scheduledLocalDate" | "scheduledLocalTime"> {
  if (!value) return { scheduledAt: null, scheduledLocalDate: null, scheduledLocalTime: null };
  const [date, time] = value.split("T");
  return { scheduledAt: localDateTimeToUtcIso(date ?? "", time ?? "", timezone), scheduledLocalDate: date, scheduledLocalTime: time };
}

export function studioBrandEndpoint(path: string, brandProfileId?: string | null): string {
  const brand = uuidOrNull(brandProfileId ?? null);
  return brand ? `${path}?brandProfileId=${encodeURIComponent(brand)}` : path;
}

function combineCalendarEntries(data: StudioData) {
  const fromDrafts: StudioCalendarEntryView[] = data.drafts.flatMap((draft) => draft.scheduledAt ? [{ id: `draft-${draft.id}`, kind: "draft" as const, startAt: draft.scheduledAt, endAt: null, status: draft.status, draftId: draft.id, automationRuleId: draft.automationRuleId, title: draft.title || draft.headline || "Utan rubrik", channels: draft.channels }] : []);
  return mergeById(data.calendarEntries, fromDrafts);
}

function calendarEntriesWithDraft(entries: StudioCalendarEntryView[], draft: StudioDraftView): StudioCalendarEntryView[] {
  const without = entries.filter((entry) => entry.draftId !== draft.id);
  if (!draft.scheduledAt) return without;
  return [{ id: `draft-${draft.id}`, kind: "draft" as const, startAt: draft.scheduledAt, endAt: null, status: draft.status, draftId: draft.id, automationRuleId: draft.automationRuleId, title: draft.title || draft.headline || "Utan rubrik", channels: draft.channels }, ...without];
}

function resolvedTemplates(data: StudioData) { return mergeTemplates(data.templates); }
function mergeTemplates(templates: StudioTemplateView[]) { return mergeById(templates, baseTemplates); }
function mergeNewsletterAudiences(configuration: StudioNewsletterAudienceView[], summaries: StudioNewsletterAudienceView[]) {
  const summaryById = new Map(summaries.map((audience) => [audience.id, audience]));
  const configured = configuration.map((audience) => {
    const summary = summaryById.get(audience.id);
    return summary ? { ...audience, active: summary.active, contactCount: summary.contactCount, subscribedCount: summary.subscribedCount } : audience;
  });
  return [...configured, ...summaries.filter((audience) => !configuration.some((configuredAudience) => configuredAudience.id === audience.id))];
}
function mergeById<T extends { id: string }>(primary: T[], fallback: T[]) { return [...primary, ...fallback.filter((item) => !primary.some((other) => other.id === item.id))]; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function stringValue(value: unknown, fallback = "") { return typeof value === "string" ? value : fallback; }
function nullableStringValue(value: unknown) { return typeof value === "string" && value ? value : null; }

function automationJobFromPayload(value: unknown): StudioAutomationJobView | null {
  if (!isRecord(value)) return null;
  const id = stringValue(value.id);
  const automationRuleId = stringValue(value.automationRuleId ?? value.automation_rule_id);
  const scheduledFor = stringValue(value.scheduledFor ?? value.scheduled_for);
  if (!id || !automationRuleId || !scheduledFor) return null;
  return {
    id,
    automationRuleId,
    state: stringValue(value.state, "queued"),
    triggerKind: value.triggerKind === "manual" || value.trigger_kind === "manual" ? "manual" : "scheduled",
    contentDraftId: nullableStringValue(value.contentDraftId ?? value.content_draft_id),
    scheduledFor,
    completedAt: nullableStringValue(value.completedAt ?? value.completed_at),
    lastError: nullableStringValue(value.lastError ?? value.last_error),
    attemptCount: typeof (value.attemptCount ?? value.attempt_count) === "number" && Number.isFinite(value.attemptCount ?? value.attempt_count)
      ? Number(value.attemptCount ?? value.attempt_count)
      : 0,
  };
}

function automationJobsFromPayload(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.jobs)) return [];
  return value.jobs.flatMap((job) => {
    const parsed = automationJobFromPayload(job);
    return parsed ? [parsed] : [];
  });
}
function nullableFormValue(value: FormDataEntryValue | null) { return typeof value === "string" && value.trim() ? value.trim() : null; }

function makeCalendar(month: Date) {
  const year = month.getFullYear(); const monthIndex = month.getMonth();
  const first = new Date(Date.UTC(year, monthIndex, 1)); const mondayOffset = (first.getUTCDay() + 6) % 7;
  const start = new Date(first); start.setUTCDate(start.getUTCDate() - mondayOffset);
  return Array.from({ length: 42 }, (_, index) => { const date = new Date(start); date.setUTCDate(start.getUTCDate() + index); return { date, inMonth: date.getUTCMonth() === monthIndex }; });
}
function shiftMonth(date: Date, amount: number) { return new Date(date.getFullYear(), date.getMonth() + amount, 1); }
function sameLocalDay(value: string, date: Date, timezone: string) { return formatDateInput(new Date(value), timezone) === formatDateInput(date, timezone); }
function formatDateInput(value: Date, timezone: string) { return localDateTime(value, timezone).slice(0, 10); }
function formatTime(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat("sv-SE", { hour: "2-digit", minute: "2-digit" }).format(date); }
function formatWhen(value: string, timezone?: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("sv-SE", { timeZone: timezone, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(date); }
function formatFullDate(value: Date, timezone: string) { return new Intl.DateTimeFormat("sv-SE", { timeZone: timezone, weekday: "long", day: "numeric", month: "long" }).format(value); }
function isToday(value: Date, timezone: string) { return formatDateInput(value, timezone) === formatDateInput(new Date(), timezone); }
function capitalize(value: string) { return value.slice(0, 1).toLocaleUpperCase("sv-SE") + value.slice(1); }
function channelList(channels: StudioChannelKind[]) { return channels.length ? channels.map(channelLabel).join(" · ") : "Ingen kanal vald"; }
function channelBadge(channel: StudioChannelKind) { return { instagram: "◎", facebook_page: "f", linkedin: "in", newsletter: "✉" }[channel]; }
function templateIcon(type: StudioContentKind) { return { social_post: "✦", newsletter: "✉", article: "▤" }[type]; }
function statusClass(status: StudioContentStatus) { return `${styles.status} ${styles[`status${status.replace(/(^.)/, (letter) => letter.toUpperCase())}`] ?? ""}`; }
