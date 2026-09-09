import Link from "next/link";
import type {
  StudioData,
  StudioDraftView,
} from "@/components/content-studio-adapter";
import styles from "@/components/saga-editorial-pipeline.module.css";

type SagaStageState = "ready" | "in_progress" | "needs_setup" | "waiting";

type SagaStage = {
  id: string;
  number: string;
  verb: string;
  swedishVerb: string;
  state: SagaStageState;
  stateLabel: string;
  title: string;
  detail: string;
  href: string;
  action: string;
};

type SagaFocus = {
  eyebrow: string;
  title: string;
  detail: string;
  href: string;
  action: string;
};

export type SagaEditorialModel = {
  stages: SagaStage[];
  focus: SagaFocus;
  snapshot: {
    drafts: number;
    awaitingReview: number;
    readyChannels: number;
    activeAutomations: number;
  };
};

/**
 * Maps only persisted Studio data to the editorial loop. Research is kept as
 * a setup state until its real evidence service is available; visual progress
 * is never used as evidence that an integration has been enabled.
 */
export function sagaEditorialModel(data: StudioData): SagaEditorialModel {
  const drafts = data.drafts;
  const latestDraft = newest(drafts);
  const reviewDraft = newest(drafts.filter((draft) => draft.status === "in_review" || draft.status === "approved"));
  const adaptableDraft = newest(drafts.filter((draft) => Boolean(draft.body.trim() || draft.headline.trim())));
  const readyChannels = data.channels.filter((channel) => channel.canPublish).length;
  const activeAutomations = data.automations.filter((automation) => automation.active).length;
  const awaitingReview = drafts.filter((draft) => draft.status === "in_review" || draft.status === "approved").length;
  const latestDraftHref = latestDraft ? draftHref(latestDraft) : "/studio/content/new?edit=1";
  const reviewHref = reviewDraft ? draftHref(reviewDraft) : latestDraftHref;
  const adaptHref = adaptableDraft ? draftHref(adaptableDraft) + "?edit=1" : "/studio/content/new?edit=1";
  const channelLabel = readyChannels
    ? String(readyChannels) + " klar" + (readyChannels === 1 ? "" : "a") + " kanal" + (readyChannels === 1 ? "" : "er")
    : "Kanaler saknas";
  const automationLabel = activeAutomations
    ? String(activeAutomations) + " aktiv" + (activeAutomations === 1 ? "" : "a") + " regel" + (activeAutomations === 1 ? "" : "er")
    : "Nästa iteration";

  const stages: SagaStage[] = [
    {
      id: "listen",
      number: "01",
      verb: "Listen",
      swedishVerb: "Lyssna",
      state: "needs_setup",
      stateLabel: "Inte aktiverat",
      title: "Samla signaler utan att fylla flödet med brus.",
      detail: "Research är inte ansluten i den här arbetsytan ännu. Lägg inte in källor här förrän källmotorn kan visa vad den faktiskt har läst.",
      href: "/studio/research",
      action: "Se research-status",
    },
    {
      id: "verify",
      number: "02",
      verb: "Verify",
      swedishVerb: "Verifiera",
      state: "needs_setup",
      stateLabel: "Väntar på research",
      title: "Skilj fakta, osäkerhet och egna slutsatser åt.",
      detail: "När research slås på får detta steg källor och evidens. Tills dess ska ett utkast börja med ditt eget underlag, inte en påhittad verifiering.",
      href: "/studio/research",
      action: "Se kraven",
    },
    {
      id: "take",
      number: "03",
      verb: "Our take",
      swedishVerb: "Vår tanke",
      state: "ready",
      stateLabel: "Din input",
      title: "Bestäm den mänskliga poängen innan AI skriver.",
      detail: "Sätt mission, perspektiv, ton och evidensnivå i Editorial Lens. Den blir skrivramen som följer med in i AI-labbet.",
      href: "/studio/lens",
      action: "Öppna Editorial Lens",
    },
    {
      id: "create",
      number: "04",
      verb: "Create",
      swedishVerb: "Skapa",
      state: drafts.length ? "in_progress" : "ready",
      stateLabel: drafts.length ? String(drafts.length) + " utkast" : "Redo för utkast",
      title: "Gör en redigerbar berättelse av riktningen.",
      detail: drafts.length
        ? "Fortsätt i ett sparat utkast eller börja en ny berättelse med samma tydliga arbetsyta."
        : "Öppna redigeraren först när du vet vad du vill säga — inte för att fylla en tom kalender.",
      href: latestDraftHref,
      action: drafts.length ? "Öppna senaste utkastet" : "Skapa utkast",
    },
    {
      id: "adapt",
      number: "05",
      verb: "Adapt",
      swedishVerb: "Anpassa",
      state: adaptableDraft ? "in_progress" : "waiting",
      stateLabel: adaptableDraft ? "Utkast finns" : "Behöver utkast",
      title: "Anpassa text och bild för sammanhanget.",
      detail: adaptableDraft
        ? "Öppna utkastet för att välja kanal, tona om texten eller skapa en bildvariant."
        : "Spara en första text innan du anpassar format, bild eller kanal.",
      href: adaptHref,
      action: adaptableDraft ? "Anpassa utkast" : "Börja med text",
    },
    {
      id: "review",
      number: "06",
      verb: "Review",
      swedishVerb: "Granska",
      state: awaitingReview ? "in_progress" : "waiting",
      stateLabel: awaitingReview ? String(awaitingReview) + " att granska" : "Inget i granskning",
      title: "Ta ställning innan något får en tid eller kanal.",
      detail: awaitingReview
        ? "Öppna nästa utkast och kontrollera budskap, bild, målgrupp och tid."
        : "När ett utkast är redo kan du godkänna det från dess egen förhandsvisning.",
      href: reviewHref,
      action: awaitingReview ? "Granska nästa" : "Öppna utkast",
    },
    {
      id: "publish",
      number: "07",
      verb: "Publish",
      swedishVerb: "Publicera",
      state: readyChannels ? "ready" : "needs_setup",
      stateLabel: channelLabel,
      title: "Publicering är ett medvetet sista steg.",
      detail: readyChannels
        ? "En ansluten kanal kan väljas i utkastet när granskningen är klar."
        : "Koppla en kanal först när du är redo att publicera. Inget skickas automatiskt från den här arbetsytan.",
      href: "/studio/channels",
      action: readyChannels ? "Se publiceringskanaler" : "Öppna kanaler",
    },
    {
      id: "learn",
      number: "08",
      verb: "Learn",
      swedishVerb: "Lär",
      state: activeAutomations ? "in_progress" : "waiting",
      stateLabel: automationLabel,
      title: "Gör nästa utkast bättre — inte bara fler.",
      detail: activeAutomations
        ? "Se dina återkommande regler och justera ämne, takt och godkännande utifrån det du lär dig."
        : "När du ser ett mönster som är värt att upprepa kan du göra en återkommande, granskningsbar regel av det.",
      href: "/studio/automations",
      action: activeAutomations ? "Förfina regler" : "Bygg en regel",
    },
  ];

  const focus = reviewDraft
    ? {
        eyebrow: "NÄSTA VERKLIGA BESLUT",
        title: draftTitle(reviewDraft),
        detail: "Det här utkastet väntar på din granskning. Öppna det, ändra om det behövs och godkänn först när du står för det.",
        href: draftHref(reviewDraft),
        action: "Öppna för granskning",
      }
    : latestDraft
      ? {
          eyebrow: "FORTSÄTT DÄR DU SLUTADE",
          title: draftTitle(latestDraft),
          detail: "Utkastet finns sparat. Nästa steg väljer du i redigeraren — inget har planerats eller publicerats härifrån.",
          href: draftHref(latestDraft),
          action: "Fortsätt utkastet",
        }
      : {
          eyebrow: "BÖRJA MED POÄNGEN",
          title: "Vad behöver din målgrupp förstå nu?",
          detail: "Skriv en vinkel nedan. Då får både du och AI:n en riktning som går att granska.",
          href: "#saga-create",
          action: "Skriv min vinkel",
        };

  return {
    stages,
    focus,
    snapshot: { drafts: drafts.length, awaitingReview, readyChannels, activeAutomations },
  };
}

export function SagaEditorialPipeline({ data }: { data: StudioData }) {
  const model = sagaEditorialModel(data);

  return (
    <section className={styles.pipeline} aria-labelledby="saga-pipeline-title">
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>SAGA / DEN REDAKTIONELLA LOOPEN</p>
          <h2 id="saga-pipeline-title">Från signal till ett beslut du står för.</h2>
          <p>Det här är arbetsordningen. Varje steg öppnar ett riktigt verktyg eller visar tydligt varför det ännu inte går att använda.</p>
        </div>
        <dl className={styles.snapshot} aria-label="Arbetsytans aktuella läge">
          <div><dt>Utkast</dt><dd>{model.snapshot.drafts}</dd></div>
          <div><dt>Granskning</dt><dd>{model.snapshot.awaitingReview}</dd></div>
          <div><dt>Kanaler</dt><dd>{model.snapshot.readyChannels}</dd></div>
          <div><dt>Regler</dt><dd>{model.snapshot.activeAutomations}</dd></div>
        </dl>
      </header>

      <div className={styles.body}>
        <ol className={styles.stages} aria-label="SAGA:s åtta redaktionella steg">
          {model.stages.map((stage) => (
            <li className={[styles.stage, styles["stage" + stage.state.replace(/(^.)/, (letter) => letter.toUpperCase())]].filter(Boolean).join(" ")} key={stage.id}>
              <span className={styles.rail} aria-hidden="true"><i /><b>{stage.number}</b></span>
              <div className={styles.stageMain}>
                <div className={styles.stageMeta}><span>{stage.verb}</span><em>{stage.swedishVerb}</em></div>
                <h3>{stage.title}</h3>
                <p>{stage.detail}</p>
                <Link href={stage.href} className={styles.stageAction}>{stage.action} <span aria-hidden="true">→</span></Link>
              </div>
              <span className={styles.state}>{stage.stateLabel}</span>
            </li>
          ))}
        </ol>

        <aside className={styles.focus} aria-label="Nästa redaktionella beslut">
          <div className={styles.focusMark} aria-hidden="true"><i /><i /><i /></div>
          <p className={styles.eyebrow}>{model.focus.eyebrow}</p>
          <h3>{model.focus.title}</h3>
          <p>{model.focus.detail}</p>
          <Link href={model.focus.href} className={styles.focusAction}>{model.focus.action} <span aria-hidden="true">→</span></Link>
          <small>Publicering sker aldrig automatiskt från den här loopen.</small>
        </aside>
      </div>
    </section>
  );
}

function newest(drafts: StudioDraftView[]): StudioDraftView | null {
  return [...drafts].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null;
}

function draftHref(draft: StudioDraftView) {
  return "/studio/content/" + encodeURIComponent(draft.id);
}

function draftTitle(draft: StudioDraftView) {
  return draft.title.trim() || draft.headline.trim() || "Namnlöst utkast";
}
