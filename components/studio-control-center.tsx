import Link from "next/link";
import type { SagaBrandEntryState } from "@/lib/neon/saga-brand-entry-state";
import styles from "./studio-control-center.module.css";

export type StudioControlCenterCounts = {
  members: number;
  drafts: number;
  waitingForReview: number;
  scheduled: number;
  activeAutomations: number;
  pendingJobs: number;
  media: number;
};

export type StudioControlCenterState =
  | {
    mode: "ready";
    actor: { displayName: string | null; role: "owner" | "editor" | "viewer" };
    checkedAt: string;
    workspace: { name: string; timezone: string };
    counts: StudioControlCenterCounts;
    brandEntry: SagaBrandEntryState;
  }
  | {
    mode: "database_unconfigured" | "session_required" | "workspace_missing" | "workspace_unavailable";
  };

type Action = {
  eyebrow: string;
  title: string;
  detail: string;
  href: string;
  label: string;
  tone: "attention" | "active" | "quiet";
};

type PipelineStage = {
  id: string;
  label: string;
  metric: string;
  detail: string;
  href: string;
  tone: "attention" | "active" | "ready" | "quiet";
};

function shortcutsFor(state: StudioControlCenterState) {
  const brandEntry = state.mode === "ready" ? state.brandEntry : null;
  const planHref = brandEntry?.status === "completed"
    ? `/studio/plan?brandProfileId=${encodeURIComponent(brandEntry.brandProfileId)}`
    : brandEntry?.status === "missing" ? "/studio/brands/new"
      : brandEntry?.status === "selection_required" ? "/studio/create" : "/studio/plan";
  const planLabel = brandEntry?.status === "missing"
    ? "Varumärkesonboarding"
    : brandEntry?.status === "selection_required" ? "Välj varumärke" : "Aktivitetsplan";
  const planDetail = brandEntry?.status === "missing"
    ? "Sätt mål, årsriktning och budgetram först."
    : brandEntry?.status === "selection_required"
      ? "Välj vilken färdig varumärkesgrund du ska arbeta i."
      : "Planera nästa 13 veckor efter onboarding.";
  const createHref = brandEntry?.status === "missing" ? "/studio/brands/new" : "/studio/create";
  return [
    { href: planHref, label: planLabel, detail: planDetail },
    { href: createHref, label: "Nytt utkast", detail: brandEntry?.status === "missing" ? "Kräver en slutförd varumärkesonboarding." : "Skriv, redigera och spara." },
    { href: "/studio/calendar", label: "Kalender", detail: "Se och flytta tider." },
    { href: "/studio/automations", label: "Automationer", detail: "Granska körningar och regler." },
    { href: "/studio/ads", label: "Annonsstudio", detail: "Bygg privata material i rätt format." },
  ] as const;
}

/**
 * The Studio home deliberately renders only a server-confirmed aggregate
 * snapshot. It never fills empty cards with client-side examples or guesses
 * whether a provider, cron job, or published post is healthy.
 */
export function StudioControlCenter({ state }: { state: StudioControlCenterState }) {
  const ready = state.mode === "ready";
  const action = nextAction(state);
  const stages = ready ? pipelineStages(state.counts, state.brandEntry) : unavailableStages();
  const shortcuts = shortcutsFor(state);

  return (
    <section className={styles.controlCenter} aria-labelledby="studio-control-title">
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>SAGA / KONTROLLRUM</p>
          <h1 id="studio-control-title">Arbetsflödet, utan brus.</h1>
          <p className={styles.intro}>
            {ready
              ? `Den här vyn bygger på den sparade statusen i ${state.workspace.name}. Välj nästa beslut, följ flödet och öppna rätt verktyg.`
              : "Här visas bara status som systemet kan bekräfta. När arbetsytan inte går att läsa visar vi inga exempel, uppskattningar eller låtsasdata."}
          </p>
        </div>
        <SystemBadge state={state} />
      </header>

      <div className={styles.primaryGrid}>
        <article className={`${styles.nextAction} ${styles[`nextAction${capitalize(action.tone)}`]}`} aria-labelledby="next-action-title">
          <div className={styles.panelTopline}>
            <p>{action.eyebrow}</p>
            <span><i aria-hidden="true" />{action.tone === "attention" ? "Beslut behövs" : action.tone === "active" ? "Pågår" : "Redo"}</span>
          </div>
          <h2 id="next-action-title">{action.title}</h2>
          <p>{action.detail}</p>
          <Link href={action.href} className={styles.primaryAction}>{action.label} <span aria-hidden="true">→</span></Link>
        </article>

        <section className={styles.systemPanel} aria-labelledby="system-status-title">
          <header>
            <div>
              <p className={styles.eyebrow}>SYSTEMSTATUS</p>
              <h2 id="system-status-title">Verifieringsstatus.</h2>
            </div>
            <span className={ready ? styles.verifiedMark : styles.unverifiedMark} aria-label={ready ? "Verifierad" : "Inte verifierad"}>{ready ? "✓" : "!"}</span>
          </header>
          {ready ? <VerifiedSystemStatus state={state} /> : <UnavailableSystemStatus state={state} />}
        </section>
      </div>

      {ready ? <CurrentWork counts={state.counts} /> : null}

      <section className={styles.pipeline} aria-labelledby="pipeline-title">
        <header className={styles.sectionHeader}>
          <div>
            <p className={styles.eyebrow}>PRODUKTIONSFLÖDE</p>
            <h2 id="pipeline-title">Var arbetet befinner sig.</h2>
          </div>
          <p>{ready ? "Varje siffra kommer från den sparade arbetsytan." : "Stegen visas, men har inga bekräftade arbetsdata ännu."}</p>
        </header>
        <ol className={styles.stageList}>
          {stages.map((stage, index) => <li className={`${styles.stage} ${styles[`stage${capitalize(stage.tone)}`]}`} key={stage.id}>
            <span className={styles.stageNumber}>{String(index + 1).padStart(2, "0")}</span>
            <div>
              <p>{stage.label}</p>
              <strong>{stage.metric}</strong>
              <small>{stage.detail}</small>
            </div>
            <Link href={stage.href} aria-label={`Öppna ${stage.label}`}>→</Link>
          </li>)}
        </ol>
      </section>

      <nav className={styles.shortcutBar} aria-label="Öppna arbetsverktyg">
        <div>
          <p className={styles.eyebrow}>ARBETSYTOR</p>
          <h2>Gå direkt till rätt verktyg.</h2>
        </div>
        <ul>
          {shortcuts.map((shortcut) => <li key={shortcut.href}>
            <Link href={shortcut.href}>
              <span><strong>{shortcut.label}</strong><small>{shortcut.detail}</small></span>
              <b aria-hidden="true">→</b>
            </Link>
          </li>)}
        </ul>
      </nav>
    </section>
  );
}

function CurrentWork({ counts }: { counts: StudioControlCenterCounts }) {
  const items = [
    { label: "Sparade utkast", value: counts.drafts, href: "/studio/calendar", detail: "Öppna och planera versioner" },
    { label: "Väntar på granskning", value: counts.waitingForReview, href: "/studio/calendar", detail: "Kräver ett mänskligt beslut" },
    { label: "Tidsatta i SAGA", value: counts.scheduled, href: "/studio/calendar", detail: "Kontrolleras i kalendern" },
    { label: "Körningar i kö", value: counts.pendingJobs, href: "/studio/automations", detail: "Körs eller väntar i Studio" },
  ];

  return <section className={styles.currentWork} aria-labelledby="current-work-title">
    <header>
      <p className={styles.eyebrow}>AKTUELLT ARBETE</p>
      <h2 id="current-work-title">Det som finns i arbetsytan nu.</h2>
    </header>
    <ul>
      {items.map((item) => <li key={item.label}>
        <Link href={item.href}>
          <span className={item.value > 0 ? styles.liveCount : styles.quietCount}>{item.value}</span>
          <span><strong>{item.label}</strong><small>{item.detail}</small></span>
          <b aria-hidden="true">→</b>
        </Link>
      </li>)}
    </ul>
  </section>;
}

function VerifiedSystemStatus({ state }: { state: Extract<StudioControlCenterState, { mode: "ready" }> }) {
  const role = state.actor.role === "owner" ? "Ägare" : state.actor.role === "editor" ? "Redaktör" : "Läsbehörighet";
  return <dl className={styles.statusList}>
    <div><dt>Arbetsyta</dt><dd>{state.workspace.name}</dd></div>
    <div><dt>Databas</dt><dd><i aria-hidden="true" />Verifierad</dd></div>
    <div><dt>Roll</dt><dd>{role}</dd></div>
    <div><dt>Tidszon</dt><dd>{state.workspace.timezone}</dd></div>
    <div><dt>Varumärkesgrund</dt><dd>{brandEntryLabel(state.brandEntry)}</dd></div>
    <div className={styles.statusTimestamp}><dt>Senast kontrollerad</dt><dd>{formatCheckedAt(state.checkedAt, state.workspace.timezone)}</dd></div>
  </dl>;
}

function UnavailableSystemStatus({ state }: { state: Exclude<StudioControlCenterState, { mode: "ready" }> }) {
  const message = {
    database_unconfigured: "Studio saknar en verifierad databasanslutning. Inga sparade utkast, planer eller körningar kan visas här.",
    session_required: "Studio kan inte koppla den här sessionen till en arbetsyta. Logga in innan systemstatus visas.",
    workspace_missing: "Sessionen finns, men den tillhörande arbetsytan hittades inte. Inget arbetsinnehåll visas.",
    workspace_unavailable: "Studio kan inte läsa arbetsytan just nu. Inga siffror eller arbetsstatus visas förrän läsningen fungerar igen.",
  }[state.mode];
  return <p className={styles.unavailableDetail}>{message}</p>;
}

function SystemBadge({ state }: { state: StudioControlCenterState }) {
  if (state.mode === "ready") return <div className={styles.systemBadge}>
    <span><i aria-hidden="true" />Verifierad arbetsyta</span>
    <small>{state.workspace.name}</small>
  </div>;

  const label = state.mode === "session_required" ? "Inloggning krävs" : state.mode === "database_unconfigured" ? "Arbetsyta ej ansluten" : "Status kan inte bekräftas";
  return <div className={`${styles.systemBadge} ${styles.systemBadgeAttention}`}>
    <span><i aria-hidden="true" />{label}</span>
    <small>Ingen arbetsdata visas</small>
  </div>;
}

function nextAction(state: StudioControlCenterState): Action {
  if (state.mode === "database_unconfigured") return {
    eyebrow: "SYSTEMSTATUS", title: "Anslut arbetsytan först.",
    detail: "SAGA öppnar inte skrivning, kalender eller automationer utan en verifierad databas. Därför finns det inga tomma formulär eller lokala ersättningsdata här.",
    href: "/settings", label: "Öppna produktstatus", tone: "attention",
  };
  if (state.mode === "session_required") return {
    eyebrow: "ÅTKOMST", title: "Logga in för att läsa arbetsytan.",
    detail: "Studio behöver en verifierad session innan den kan avgöra vad som är aktivt, väntar på granskning eller ligger i kön.",
    href: "/login", label: "Logga in", tone: "attention",
  };
  if (state.mode === "workspace_missing") return {
    eyebrow: "ARBETSYTA", title: "Arbetsytan behöver kontrolleras.",
    detail: "Din session är aktiv, men Studio hittade ingen sparad arbetsyta att läsa från. Inget innehåll visas förrän kopplingen är återställd.",
    href: "/settings", label: "Öppna produktstatus", tone: "attention",
  };
  if (state.mode === "workspace_unavailable") return {
    eyebrow: "SYSTEMSTATUS", title: "Försök läsa arbetsytan igen.",
    detail: "Studio kan inte bekräfta den sparade statusen just nu. Vi visar därför varken siffror, köer eller antagna publiceringar.",
    href: "/settings", label: "Öppna produktstatus", tone: "attention",
  };
  // Keep this explicit for future state additions. It also keeps the durable
  // aggregate counts behind the only state that actually contains them.
  if (state.mode !== "ready") return {
    eyebrow: "SYSTEMSTATUS", title: "Arbetsytan behöver kontrolleras.",
    detail: "Studio kan inte bekräfta sparade arbetsdata just nu.",
    href: "/settings", label: "Öppna produktstatus", tone: "attention",
  };

  if (state.brandEntry.status === "unavailable") return {
    eyebrow: "VARUMÄRKESGRUND", title: "Kontrollera varumärkesgrunden innan du skapar.",
    detail: "Studio kan inte bekräfta en slutförd onboarding just nu. För att inte skapa innehåll på gissning hålls den säkra startpunkten stängd tills underlaget kan läsas.",
    href: "/studio/create", label: "Kontrollera igen", tone: "attention",
  };
  if (state.brandEntry.status === "missing") return {
    eyebrow: "FÖRST VARUMÄRKET", title: "Sätt riktningen före innehållet.",
    detail: "Varumärkesonboardingen samlar mål, målgrupp, årsriktning och budgetram. Därefter kan du planera 13 veckor och skapa ett referensinlägg.",
    href: "/studio/brands/new", label: "Starta varumärkesonboarding", tone: "attention",
  };
  if (state.brandEntry.status === "selection_required") return {
    eyebrow: "VÄLJ VARUMÄRKE", title: "Välj vilken varumärkesgrund du ska arbeta i.",
    detail: "Flera aktiva, slutförda varumärken finns i arbetsytan. Studio väljer inte plan, budgetram eller innehållsgrund åt dig.",
    href: "/studio/create", label: "Välj varumärke", tone: "attention",
  };

  const counts = state.counts;
  if (counts.waitingForReview > 0) return {
    eyebrow: "NÄSTA BESLUT", title: `Granska ${plural(counts.waitingForReview, "utkast", "utkast")}.`,
    detail: "De är sparade och väntar på mänsklig kontroll innan nästa steg. Öppna kalendern för att läsa, ändra och sätta tid.",
    href: "/studio/calendar", label: "Öppna granskningskön", tone: "attention",
  };
  if (counts.pendingJobs > 0) return {
    eyebrow: "AKTIV KÖ", title: `Följ ${plural(counts.pendingJobs, "körning", "körningar")}.`,
    detail: "Det finns arbete i Studio-kön. Kontrollera körningen och dess underlag i automationsvyn; extern publicering antas aldrig här.",
    href: "/studio/automations", label: "Öppna körningar", tone: "active",
  };
  if (counts.scheduled > 0) return {
    eyebrow: "INNEHÅLLSPLAN", title: `Kontrollera ${plural(counts.scheduled, "tidsatt utkast", "tidsatta utkast")}.`,
    detail: "Tider är sparade i Studio. Kalendern är platsen där du granskar innehåll och justerar datum eller klockslag.",
    href: "/studio/calendar", label: "Öppna kalendern", tone: "active",
  };
  if (counts.activeAutomations > 0) return {
    eyebrow: "ÅTERKOMMANDE FLÖDE", title: `${plural(counts.activeAutomations, "automation är", "automationer är")} aktiv${counts.activeAutomations === 1 ? "" : "a"}.`,
    detail: "Kontrollera regel, kvalitet och senaste körning innan du förändrar ett återkommande flöde.",
    href: "/studio/automations", label: "Öppna automationer", tone: "active",
  };
  return {
    eyebrow: "NÄSTA STEG", title: `Planera 13 veckor för ${state.brandEntry.brandName}.`,
    detail: "Bestäm takt, teman och tider i aktivitetsplanen. Skapa sedan ett referensinlägg som du kan förfina och använda som grund för en liten serie.",
    href: `/studio/plan?brandProfileId=${encodeURIComponent(state.brandEntry.brandProfileId)}`, label: "Öppna aktivitetsplan", tone: "quiet",
  };
}

function brandEntryLabel(entry: SagaBrandEntryState) {
  if (entry.status === "completed") return `Klar: ${entry.brandName}`;
  if (entry.status === "missing") return "Inte slutförd";
  if (entry.status === "selection_required") return "Val behövs";
  return "Kunde inte bekräftas";
}

function pipelineStages(counts: StudioControlCenterCounts, brandEntry: SagaBrandEntryState): PipelineStage[] {
  const authoringReady = brandEntry.status === "completed";
  const draftHref = authoringReady ? counts.drafts ? "/studio/calendar" : "/studio/create" : brandEntry.status === "missing" ? "/studio/brands/new" : "/studio/create";
  const draftMetric = authoringReady ? plural(counts.drafts, "sparat utkast", "sparade utkast") : brandEntry.status === "missing" ? "Varumärke saknas" : brandEntry.status === "selection_required" ? "Val behövs" : "Ej verifierat";
  const draftDetail = authoringReady
    ? counts.drafts ? "Redaktionellt material finns sparat i Studio." : "Börja med en idé eller ett referensinlägg."
    : brandEntry.status === "missing" ? "Slutför varumärkesonboarding innan du skapar innehåll."
      : brandEntry.status === "selection_required" ? "Välj en slutförd aktiv varumärkesgrund innan textproduktionen öppnas."
        : "Kontrollera varumärkesgrunden innan textproduktionen öppnas.";
  return [
    {
      id: "flow", label: "Flöde", metric: counts.activeAutomations ? plural(counts.activeAutomations, "aktiv automation", "aktiva automationer") : "Manuell start",
      detail: counts.activeAutomations ? "Återkommande regler är aktiva." : "Ingen regel skapar nya utkast just nu.", href: "/studio/automations", tone: counts.activeAutomations ? "active" : "quiet",
    },
    {
      id: "draft", label: "Utkast", metric: draftMetric,
      detail: draftDetail, href: draftHref, tone: authoringReady && counts.drafts ? "active" : brandEntry.status === "missing" ? "attention" : "quiet",
    },
    {
      id: "review", label: "Granskning", metric: counts.waitingForReview ? plural(counts.waitingForReview, "utkast väntar", "utkast väntar") : "Inget väntar",
      detail: counts.waitingForReview ? "Ett mänskligt beslut behövs före nästa steg." : "Ingen sparad granskningskö just nu.", href: "/studio/calendar", tone: counts.waitingForReview ? "attention" : "quiet",
    },
    {
      id: "calendar", label: "Kalender", metric: plural(counts.scheduled, "tidsatt utkast", "tidsatta utkast"),
      detail: counts.scheduled ? "Datum och tid är sparade i SAGA." : "Inga tidsatta utkast i den här statusbilden.", href: "/studio/calendar", tone: counts.scheduled ? "ready" : "quiet",
    },
    {
      id: "jobs", label: "Körningar", metric: counts.pendingJobs ? plural(counts.pendingJobs, "jobb i kö", "jobb i kö") : "Ingen köad körning",
      detail: counts.pendingJobs ? "Studio har arbete som väntar eller körs." : "Ingen arbetskö kan utläsas just nu.", href: "/studio/automations", tone: counts.pendingJobs ? "active" : "quiet",
    },
  ];
}

function unavailableStages(): PipelineStage[] {
  return [
    { id: "flow", label: "Flöde", metric: "Ej verifierat", detail: "Systemet kan inte läsa sparade regler.", href: "/settings", tone: "quiet" },
    { id: "draft", label: "Utkast", metric: "Ej verifierat", detail: "Systemet kan inte läsa sparat innehåll.", href: "/settings", tone: "quiet" },
    { id: "review", label: "Granskning", metric: "Ej verifierat", detail: "Ingen granskningskö visas utan arbetsdata.", href: "/settings", tone: "quiet" },
    { id: "calendar", label: "Kalender", metric: "Ej verifierat", detail: "Inga tider visas utan arbetsdata.", href: "/settings", tone: "quiet" },
    { id: "jobs", label: "Körningar", metric: "Ej verifierat", detail: "Ingen körstatus visas utan arbetsdata.", href: "/settings", tone: "quiet" },
  ];
}

function plural(value: number, singular: string, pluralValue: string) {
  return `${value} ${value === 1 ? singular : pluralValue}`;
}

function capitalize(value: string) {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function formatCheckedAt(value: string, timezone: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) return "Okänd tid";
  try {
    return new Intl.DateTimeFormat("sv-SE", {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: timezone,
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat("sv-SE", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
  }
}
