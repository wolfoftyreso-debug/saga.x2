"use client";

import Link from "next/link";
import { useEffect, useId, useMemo, useState, type FormEvent, type ReactNode } from "react";
import styles from "@/components/saga-draft-pattern-handoff.module.css";

export type SagaPatternChannel = "facebook_page" | "instagram" | "linkedin" | "newsletter";
export type SagaPatternContentType = "social_post" | "newsletter" | "article";
export type SagaPatternTone = "direct" | "warm" | "insightful";
export type SagaPatternObjective = "educate" | "inspire" | "convert" | "community";

type SagaPatternControls = {
  objective: SagaPatternObjective;
  audience: string;
  tone: SagaPatternTone;
  requiredElements: string[];
  forbiddenElements: string[];
  defaultChannels: SagaPatternChannel[];
  reviewRequired: true;
};

export type SagaPatternDraft = {
  id: string;
  revision: number;
  title: string;
  summary: string;
  contentType: SagaPatternContentType;
  channels: SagaPatternChannel[];
  status: "draft" | "in_review" | "approved" | "scheduled" | "published";
  language: string;
  timezone: string;
  mediaCount: number;
};

export type SagaPatternSeries = {
  id: string;
  name: string;
  slug: string;
  active: boolean;
  revision: number;
  sourceDraftId: string;
  sourceDraftRevision: number;
  controls: SagaPatternControls;
};

type ReferenceForm = {
  name: string;
  slug: string;
  objective: SagaPatternObjective;
  audience: string;
  tone: SagaPatternTone;
  requiredElements: string;
  forbiddenElements: string;
  defaultChannels: SagaPatternChannel[];
};

type AutomationForm = {
  name: string;
  channels: SagaPatternChannel[];
  generationPrompt: string;
  imagePrompt: string;
  desiredLength: string;
  tone: string;
  timezone: string;
  weekday: number;
  time: string;
};

type LoadState = "loading" | "ready" | "error";
type ActionState = "idle" | "saving" | "error";

const draftPath = (id: string) => `/api/content/drafts/${encodeURIComponent(id)}`;
const seriesPath = "/api/saga/series";
const automationsPath = "/api/content/automations";
const CHANNELS: readonly SagaPatternChannel[] = ["facebook_page", "instagram", "linkedin", "newsletter"];
const WEEKDAYS = [
  { value: 1, label: "Måndag" },
  { value: 2, label: "Tisdag" },
  { value: 3, label: "Onsdag" },
  { value: 4, label: "Torsdag" },
  { value: 5, label: "Fredag" },
  { value: 6, label: "Lördag" },
  { value: 0, label: "Söndag" },
] as const;

/**
 * The pattern page deliberately projects only the fields it needs to make a
 * reference. The actual API can return media attachments; their URLs, paths
 * and prompts never become part of this client-side handoff object.
 */
export function sagaPatternDraftFromPayload(value: unknown): SagaPatternDraft | null {
  const raw = isRecord(value) && isRecord(value.draft) ? value.draft : null;
  if (!raw) return null;
  const id = stringValue(raw.id);
  const revision = integerValue(raw.revision);
  const title = stringValue(raw.title).trim();
  const body = stringValue(raw.body).trim();
  const contentType = contentTypeValue(raw.contentType);
  const status = draftStatusValue(raw.status);
  if (!id || !revision || !title || !body || !contentType || !status) return null;
  return {
    id,
    revision,
    title,
    summary: excerpt(body, 300),
    contentType,
    channels: channelValues(raw.channels),
    status,
    language: languageValue(raw.language),
    timezone: timezoneValue(raw.timezone),
    mediaCount: Array.isArray(raw.media) ? raw.media.length : 0,
  };
}

/** A safe, narrow read of a server-snapshotted Series response. */
export function sagaPatternSeriesFromPayload(value: unknown): SagaPatternSeries | null {
  const raw = isRecord(value) && isRecord(value.series) ? value.series : null;
  const reference = raw && isRecord(raw.reference) ? raw.reference : null;
  const controls = raw && isRecord(raw.controls) ? raw.controls : null;
  if (!raw || !reference || !controls) return null;
  const id = stringValue(raw.id);
  const name = stringValue(raw.name).trim();
  const slug = stringValue(raw.slug).trim();
  const revision = integerValue(raw.revision);
  const sourceDraftId = stringValue(reference.sourceDraftId);
  const sourceDraftRevision = integerValue(reference.sourceDraftRevision);
  const parsedControls = controlsFrom(controls);
  if (!id || !name || !slug || !revision || !sourceDraftId || !sourceDraftRevision || !parsedControls) return null;
  return {
    id,
    name,
    slug,
    active: raw.active === true,
    revision,
    sourceDraftId,
    sourceDraftRevision,
    controls: parsedControls,
  };
}

export function sagaPatternReferencePayload(draft: SagaPatternDraft, form: ReferenceForm) {
  return {
    name: form.name.trim(),
    slug: slugify(form.slug),
    referenceDraftId: draft.id,
    controls: {
      objective: form.objective,
      audience: form.audience.trim(),
      tone: form.tone,
      requiredElements: lines(form.requiredElements),
      forbiddenElements: lines(form.forbiddenElements),
      defaultChannels: uniqueChannels(form.defaultChannels),
      reviewRequired: true as const,
    },
    /** This step only saves the example. Activation is a separate confirmation. */
    active: false,
  };
}

export function sagaPatternActivationPayload(series: SagaPatternSeries) {
  if (series.active || !series.revision) return null;
  return { id: series.id, expectedRevision: series.revision, active: true };
}

/**
 * A paused, review-first automation using the already active, actor-verified
 * Series. It contains no delivery destination or publish instruction.
 */
export function sagaPatternAutomationPayload(
  draft: SagaPatternDraft,
  series: SagaPatternSeries,
  form: AutomationForm,
) {
  return {
    name: form.name.trim(),
    active: false,
    contentType: draft.contentType,
    channels: uniqueChannels(form.channels),
    templateId: null,
    seriesId: series.id,
    newsletterAudienceId: null,
    generationPrompt: form.generationPrompt.trim(),
    imagePrompt: form.imagePrompt,
    desiredLength: positiveIntegerOrNull(form.desiredLength),
    tone: form.tone.trim() || null,
    language: draft.language,
    approvalRequired: true,
    timezone: form.timezone,
    scheduleMode: "weekly_count" as const,
    weeklyCount: 1,
    weekdays: [form.weekday],
    localTimes: [form.time],
    cronExpression: null,
    startsOn: null,
    endsOn: null,
  };
}

export function sagaPatternErrorMessage(value: unknown, fallback: string): string {
  const data = isRecord(value) ? value : null;
  const code = stringValue(data?.code);
  if (code === "configuration_required" || code === "database_configuration_invalid") {
    return "Arbetsytan behöver Neon i Vercel innan referenser eller automationer kan sparas.";
  }
  if (code === "authentication_required") return "Logga in i arbetsytan innan du fortsätter.";
  const error = stringValue(data?.error).trim();
  return error ? error.slice(0, 420) : fallback;
}

export function SagaDraftPatternHandoff({ draftId }: { draftId: string }) {
  // A new route id is a new authoring session. Keying the inner workbench lets
  // React reset its temporary confirmation state without cascaded setState
  // calls inside the fetch effect.
  return <SagaDraftPatternHandoffSession key={draftId} draftId={draftId} />;
}

function SagaDraftPatternHandoffSession({ draftId }: { draftId: string }) {
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadMessage, setLoadMessage] = useState("Läser det sparade utkastet…");
  const [draft, setDraft] = useState<SagaPatternDraft | null>(null);
  const [series, setSeries] = useState<SagaPatternSeries | null>(null);
  const [referenceForm, setReferenceForm] = useState<ReferenceForm | null>(null);
  const [automationForm, setAutomationForm] = useState<AutomationForm | null>(null);
  const [referenceState, setReferenceState] = useState<ActionState>("idle");
  const [activationState, setActivationState] = useState<ActionState>("idle");
  const [automationState, setAutomationState] = useState<ActionState>("idle");
  const [activationConfirmationOpen, setActivationConfirmationOpen] = useState(false);
  const [automationConfirmationOpen, setAutomationConfirmationOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [automationId, setAutomationId] = useState<string | null>(null);
  const headingId = useId();

  useEffect(() => {
    let current = true;
    void getJson(draftPath(draftId)).then(({ response, data }) => {
      if (!current) return;
      const nextDraft = response.ok ? sagaPatternDraftFromPayload(data) : null;
      if (!nextDraft) {
        setLoadState("error");
        setLoadMessage(response.ok
          ? "Utkastet behöver ha en rubrik och text innan det kan bli en referens."
          : sagaPatternErrorMessage(data, "Kunde inte läsa utkastet."));
        return;
      }
      setDraft(nextDraft);
      setReferenceForm(referenceDefaults(nextDraft));
      setAutomationForm(automationDefaults(nextDraft, null));
      setLoadState("ready");
    }).catch(() => {
      if (!current) return;
      setLoadState("error");
      setLoadMessage("Kunde inte nå arbetsytan. Kontrollera anslutningen och försök igen.");
    });
    return () => { current = false; };
  }, [draftId]);

  const availableChannels = useMemo(() => draft ? channelsFor(draft.contentType) : [], [draft]);
  const eligible = draft ? isReferenceEligible(draft.status) : false;
  const referencePayload = draft && referenceForm ? sagaPatternReferencePayload(draft, referenceForm) : null;
  const activationPayload = series ? sagaPatternActivationPayload(series) : null;
  const automationPayload = draft && series?.active && automationForm
    ? sagaPatternAutomationPayload(draft, series, automationForm)
    : null;

  async function saveReference(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || !referencePayload || !eligible) return;
    const invalid = referenceValidation(referencePayload);
    if (invalid) {
      setReferenceState("error");
      setNotice(invalid);
      return;
    }
    setReferenceState("saving");
    setNotice(null);
    try {
      const { response, data } = await getJson(seriesPath, { method: "POST", body: JSON.stringify(referencePayload) });
      const nextSeries = response.ok ? sagaPatternSeriesFromPayload(data) : null;
      if (!nextSeries) throw new Error(sagaPatternErrorMessage(data, "Referensen kunde inte sparas."));
      if (nextSeries.sourceDraftId !== draft.id) throw new Error("Referensen kunde inte kopplas till rätt utkast. Läs in sidan igen.");
      setSeries(nextSeries);
      setAutomationForm(automationDefaults(draft, nextSeries));
      setReferenceState("idle");
      setNotice("Referensen är sparad som en fryst serverversion. Den är inte aktiv och ingen automation har startat.");
    } catch (error) {
      setReferenceState("error");
      setNotice(error instanceof Error ? error.message : "Referensen kunde inte sparas.");
    }
  }

  async function activateReference() {
    if (!activationPayload || !draft) return;
    setActivationState("saving");
    setNotice(null);
    try {
      const { response, data } = await getJson(seriesPath, { method: "PATCH", body: JSON.stringify(activationPayload) });
      const nextSeries = response.ok ? sagaPatternSeriesFromPayload(data) : null;
      if (!nextSeries) throw new Error(sagaPatternErrorMessage(data, "Referensen kunde inte aktiveras."));
      if (nextSeries.sourceDraftId !== draft.id) throw new Error("Referensen har ändrats. Läs in sidan igen innan du bygger automationen.");
      setSeries(nextSeries);
      setAutomationForm((current) => current ? { ...current, channels: defaultChannels(draft, nextSeries) } : automationDefaults(draft, nextSeries));
      setActivationState("idle");
      setActivationConfirmationOpen(false);
      setNotice("Referensen är aktiv för AI och kvalitetskontroll. Den skapar fortfarande inget innehåll själv.");
    } catch (error) {
      setActivationState("error");
      setNotice(error instanceof Error ? error.message : "Referensen kunde inte aktiveras.");
    }
  }

  async function createAutomation() {
    if (!automationPayload || !series?.active) return;
    const invalid = automationValidation(automationPayload, draft?.contentType ?? null);
    if (invalid) {
      setAutomationState("error");
      setNotice(invalid);
      return;
    }
    setAutomationState("saving");
    setNotice(null);
    try {
      const { response, data } = await getJson(automationsPath, { method: "POST", body: JSON.stringify(automationPayload) });
      const id = isRecord(data) && isRecord(data.automation) ? stringValue(data.automation.id) : "";
      if (!response.ok || !id) throw new Error(sagaPatternErrorMessage(data, "Automationen kunde inte sparas."));
      setAutomationId(id);
      setAutomationState("idle");
      setAutomationConfirmationOpen(false);
      setNotice("Automationen är sparad som pausad. Inget jobb är köat, inget utkast har skapats och inget är publicerat.");
    } catch (error) {
      setAutomationState("error");
      setNotice(error instanceof Error ? error.message : "Automationen kunde inte sparas.");
    }
  }

  return (
    <section className={styles.workspace} aria-labelledby={headingId}>
      <header className={styles.hero}>
        <div>
          <p className={styles.eyebrow}>MÖNSTER FRÅN ETT RIKTIGT UTKAST</p>
          <h1 id={headingId}>Förädla först. Automatisera sedan.</h1>
          <p>Här gör du just det här Studio-utkastet till en tydlig referens, provar riktningen och sparar först därefter en pausad automation.</p>
        </div>
        <aside className={styles.safetyNote} aria-label="Säker arbetsordning">
          <span aria-hidden="true">01 → 02 → 03</span>
          <strong>Ingen genväg till publicering</strong>
          <p>Referens, aktivering och automation är tre separata bekräftelser.</p>
        </aside>
      </header>

      <ol className={styles.progress} aria-label="Mönsterflöde">
        <li className={styles.current}><span>01</span><div><strong>Granska utkast</strong><small>Det verkliga källobjektet</small></div></li>
        <li className={series ? styles.done : undefined}><span>02</span><div><strong>Frys referens</strong><small>{series ? "Sparad" : "Väntar"}</small></div></li>
        <li className={series?.active ? styles.done : undefined}><span>03</span><div><strong>Automatisera</strong><small>{automationId ? "Pausad automation sparad" : series?.active ? "Kan ställas in" : "Väntar på aktivering"}</small></div></li>
      </ol>

      {loadState === "loading" && <section className={styles.loading} aria-live="polite"><i /><i /><i /><span>{loadMessage}</span></section>}
      {loadState === "error" && <section className={styles.error} role="alert"><div><strong>Det går inte att fortsätta från det här utkastet just nu.</strong><p>{loadMessage}</p></div><Link href="/studio/calendar">Till kalendern</Link></section>}

      {loadState === "ready" && draft && referenceForm && automationForm && (
        <div className={styles.layout}>
          <div className={styles.mainColumn}>
            <section className={styles.card} aria-labelledby="pattern-source-title">
              <header className={styles.cardHeader}><span className={styles.stepNo}>01</span><div><p>DITT KÄLLOBJEKT</p><h2 id="pattern-source-title">{draft.title}</h2><span>Senast sparad version {draft.revision} · {contentTypeLabel(draft.contentType)}</span></div><Link href={`/studio/content/${encodeURIComponent(draft.id)}?edit=1`}>Redigera utkast</Link></header>
              <div className={styles.sourcePreview}><p>{draft.summary}</p><footer><span>{draft.channels.length ? draft.channels.map(channelLabel).join(" · ") : "Ingen kanal satt"}</span><span>{draft.mediaCount ? `${draft.mediaCount} mediatillgångar` : "Textreferens"}</span><span>{statusLabel(draft.status)}</span></footer></div>
              {!eligible && <div className={styles.blocked}><strong>Utkastet kan inte bli en referens i sitt nuvarande läge.</strong><p>Återställ eller spara en ny redaktionell version innan du fortsätter. Misslyckade, avbrutna och publiceringslåsta objekt automatiseras inte här.</p></div>}
            </section>

            <section className={series ? `${styles.card} ${styles.cardMuted}` : styles.card} aria-labelledby="pattern-reference-title">
              <header className={styles.cardHeader}><span className={styles.stepNo}>02</span><div><p>FRYS DET SOM FUNGERAR</p><h2 id="pattern-reference-title">Gör utkastet till seriens referens</h2><span>Servern läser det sparade Studio-utkastet och skapar en oföränderlig referensversion.</span></div></header>
              {!series ? <form className={styles.form} onSubmit={saveReference}>
                <div className={styles.twoColumns}>
                  <Field label="Seriens namn"><input value={referenceForm.name} maxLength={160} onChange={(event) => setReferenceForm((current) => current ? { ...current, name: event.target.value } : current)} required /></Field>
                  <Field label="Intern adress"><input value={referenceForm.slug} maxLength={79} onChange={(event) => setReferenceForm((current) => current ? { ...current, slug: slugify(event.target.value) } : current)} required /></Field>
                </div>
                <div className={styles.threeColumns}>
                  <Field label="Syfte"><select value={referenceForm.objective} onChange={(event) => setReferenceForm((current) => current ? { ...current, objective: event.target.value as SagaPatternObjective } : current)}><option value="educate">Förklara och utbilda</option><option value="inspire">Inspirera</option><option value="convert">Hjälpa beslut</option><option value="community">Bygga gemenskap</option></select></Field>
                  <Field label="Målgrupp"><input value={referenceForm.audience} maxLength={160} onChange={(event) => setReferenceForm((current) => current ? { ...current, audience: event.target.value } : current)} placeholder="Vem ska mönstret hjälpa?" required /></Field>
                  <Field label="Tonalitet"><select value={referenceForm.tone} onChange={(event) => setReferenceForm((current) => current ? { ...current, tone: event.target.value as SagaPatternTone } : current)}><option value="insightful">Insiktsdriven och lugn</option><option value="warm">Varm och mänsklig</option><option value="direct">Rak och konkret</option></select></Field>
                </div>
                <div className={styles.twoColumns}>
                  <Field label="Detta ska finnas med"><textarea rows={3} value={referenceForm.requiredElements} onChange={(event) => setReferenceForm((current) => current ? { ...current, requiredElements: event.target.value } : current)} placeholder="En sak per rad" /></Field>
                  <Field label="Detta ska undvikas"><textarea rows={3} value={referenceForm.forbiddenElements} onChange={(event) => setReferenceForm((current) => current ? { ...current, forbiddenElements: event.target.value } : current)} placeholder="En sak per rad" /></Field>
                </div>
                <fieldset className={styles.channels}><legend>Standardkanaler</legend><p>En redaktionell preferens — inte en kanalanslutning eller en publiceringsregel.</p><div>{availableChannels.map((channel) => <label key={channel}><input type="checkbox" checked={referenceForm.defaultChannels.includes(channel)} onChange={() => setReferenceForm((current) => current ? { ...current, defaultChannels: toggle(current.defaultChannels, channel) } : current)} /><span>{channelLabel(channel)}</span></label>)}</div></fieldset>
                <div className={styles.formFoot}><p><strong>Granskning är låst på.</strong> Referensen sparas inaktivt; du aktiverar den separat när den är redo.</p><button className={styles.primaryAction} type="submit" disabled={!eligible || referenceState === "saving"}>{referenceState === "saving" ? "Sparar referens…" : "Använd som referens"}<span aria-hidden="true">→</span></button></div>
              </form> : <div className={styles.savedState}><span aria-hidden="true">✓</span><div><strong>{series.name} är sparad som referens.</strong><p>Den frysta referensen kommer från version {series.sourceDraftRevision} av detta utkast. Den styr ännu inte AI eller en automation.</p></div></div>}
            </section>

            <section className={!series ? `${styles.card} ${styles.cardLocked}` : styles.card} aria-labelledby="pattern-activation-title">
              <header className={styles.cardHeader}><span className={styles.stepNo}>03</span><div><p>AKTIVERA MEDVETET</p><h2 id="pattern-activation-title">Låt AI och kvalitetskontroll se referensen</h2><span>{series?.active ? "Den aktiva serieversionen kan nu användas som jämförelsepunkt." : "Aktivering ändrar inte utkastet och startar inte någon automation."}</span></div></header>
              {!series && <LockedCopy text="Spara först referensen. Då blir aktiveringen ett eget, tydligt beslut." />}
              {series && !series.active && !activationConfirmationOpen && <div className={styles.actionPanel}><p>Aktivering gör den frysta referensen tillgänglig för AI-test och kvalitetskontroll. Det skapar inga varianter, jobb eller kalenderpunkter.</p><button type="button" className={styles.secondaryAction} onClick={() => setActivationConfirmationOpen(true)}>Aktivera referens <span aria-hidden="true">→</span></button></div>}
              {series && !series.active && activationConfirmationOpen && <div className={styles.confirmation}><strong>Bekräfta aktivering</strong><p>AI får använda just den sparade referensversionen som kontinuitetsunderlag. Alla resultat är fortsatt granskningspliktiga.</p><div><button type="button" className={styles.quietAction} onClick={() => setActivationConfirmationOpen(false)} disabled={activationState === "saving"}>Tillbaka</button><button type="button" className={styles.primaryAction} onClick={() => void activateReference()} disabled={activationState === "saving"}>{activationState === "saving" ? "Aktiverar…" : "Bekräfta aktivering"}</button></div></div>}
              {series?.active && <div className={styles.savedState}><span aria-hidden="true">✓</span><div><strong>Referensen är aktiv.</strong><p>Den kan hjälpa AI:n att hålla samman ton, struktur och kanalval — men den har ingen publiceringsbehörighet.</p></div></div>}
            </section>

            <section className={!series?.active ? `${styles.card} ${styles.cardLocked}` : styles.card} aria-labelledby="pattern-automation-title">
              <header className={styles.cardHeader}><span className={styles.stepNo}>04</span><div><p>PAUSAD AUTOMATION</p><h2 id="pattern-automation-title">Automatisera mönstret när du är nöjd</h2><span>{automationId ? "Sparad och pausad. Du väljer själv om och när den ska börja köra." : "Det här skapar en pausad, granskningspliktig grund — aldrig en publicering."}</span></div></header>
              {!series?.active && <LockedCopy text="Aktivera först den sparade referensen. Då vet automationen exakt vilken kvalitet den ska jämföras med." />}
              {series?.active && !automationId && !automationConfirmationOpen && <form className={styles.form} onSubmit={(event) => { event.preventDefault(); setAutomationConfirmationOpen(true); }}>
                <div className={styles.twoColumns}>
                  <Field label="Automationsnamn"><input value={automationForm.name} maxLength={160} onChange={(event) => setAutomationForm((current) => current ? { ...current, name: event.target.value } : current)} required /></Field>
                  <Field label="Veckodag"><select value={automationForm.weekday} onChange={(event) => setAutomationForm((current) => current ? { ...current, weekday: Number(event.target.value) } : current)}>{WEEKDAYS.map((day) => <option key={day.value} value={day.value}>{day.label}</option>)}</select></Field>
                </div>
                <div className={styles.threeColumns}>
                  <Field label="Tid"><input type="time" value={automationForm.time} onChange={(event) => setAutomationForm((current) => current ? { ...current, time: event.target.value } : current)} required /></Field>
                  <Field label="Tidszon"><input value={automationForm.timezone} maxLength={80} onChange={(event) => setAutomationForm((current) => current ? { ...current, timezone: event.target.value } : current)} required /></Field>
                  <Field label="Ungefärlig längd"><input type="number" min="20" max="60000" value={automationForm.desiredLength} onChange={(event) => setAutomationForm((current) => current ? { ...current, desiredLength: event.target.value } : current)} placeholder="Valfritt" /></Field>
                </div>
                <Field label="Vad ska nästa variant lösa?"><textarea rows={3} value={automationForm.generationPrompt} onChange={(event) => setAutomationForm((current) => current ? { ...current, generationPrompt: event.target.value } : current)} required /></Field>
                <div className={styles.twoColumns}>
                  <Field label="Bildriktning (valfritt)"><textarea rows={3} value={automationForm.imagePrompt} onChange={(event) => setAutomationForm((current) => current ? { ...current, imagePrompt: event.target.value } : current)} placeholder="Exempel: dokumentär naturbild med en liten handgjord detalj" /></Field>
                  <Field label="Egen tonnotering (valfritt)"><textarea rows={3} value={automationForm.tone} maxLength={500} onChange={(event) => setAutomationForm((current) => current ? { ...current, tone: event.target.value } : current)} placeholder="Lägg bara till det som behövs utöver referensen" /></Field>
                </div>
                <fieldset className={styles.channels}><legend>Kanaler i varje utkast</legend><p>Du kan ändra detta senare. En kanalanslutning eller publicering skapas inte här.</p><div>{availableChannels.map((channel) => <label key={channel}><input type="checkbox" checked={automationForm.channels.includes(channel)} onChange={() => setAutomationForm((current) => current ? { ...current, channels: toggle(current.channels, channel) } : current)} /><span>{channelLabel(channel)}</span></label>)}</div></fieldset>
                <div className={styles.formFoot}><p>En enkel veckorytm nu. Avancerad Cron ställs in efter att du har sett att mönstret håller.</p><button className={styles.primaryAction} type="submit" disabled={automationState === "saving"}>Automatisera detta mönster <span aria-hidden="true">→</span></button></div>
              </form>}
              {series?.active && !automationId && automationConfirmationOpen && <div className={styles.confirmation}><strong>Spara pausad automation?</strong><p>Den sparas med granskning på. Den kör inte nu, skapar inget utkast och publicerar aldrig automatiskt från det här steget.</p><div><button type="button" className={styles.quietAction} onClick={() => setAutomationConfirmationOpen(false)} disabled={automationState === "saving"}>Tillbaka</button><button type="button" className={styles.primaryAction} onClick={() => void createAutomation()} disabled={automationState === "saving"}>{automationState === "saving" ? "Sparar…" : "Spara pausad automation"}</button></div></div>}
              {automationId && <div className={styles.completeAutomation}><span aria-hidden="true">✓</span><div><strong>Automationen är sparad och pausad.</strong><p>Öppna automationerna när du vill ändra rytm, köra ett privat test eller välja om den alls ska startas. Publicering är fortsatt ett separat steg.</p><Link href="/studio/automations?view=build-content">Öppna automationer <span aria-hidden="true">→</span></Link></div></div>}
            </section>
          </div>

          <aside className={styles.sideColumn} aria-label="Vad som händer">
            <section className={styles.summaryCard}><p>DETTA GÖR VI</p><h2>Ett verktyg, fyra tydliga beslut.</h2><ol><li><span>1</span><div><strong>Se det riktiga utkastet</strong><small>Ingen påhittad förhandsvisning.</small></div></li><li><span>2</span><div><strong>Frys en referens</strong><small>Text, struktur och säkra mediesignaler sparas serverägt.</small></div></li><li><span>3</span><div><strong>Aktivera för jämförelse</strong><small>AI och kvalitet får en tydlig ribba.</small></div></li><li><span>4</span><div><strong>Spara en pausad rutin</strong><small>Du testar och fintrimmar innan den får köra.</small></div></li></ol></section>
            <section className={styles.boundaryCard}><p>HÅRD GRÄNS</p><strong>Det här steget publicerar inget.</strong><span>Ingen kanal ansluts, ingen tid läggs i kalendern och inget innehåll skickas iväg.</span></section>
          </aside>
        </div>
      )}
      {notice && <p className={referenceState === "error" || activationState === "error" || automationState === "error" ? styles.actionError : styles.notice} role="status" aria-live="polite">{notice}</p>}
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className={styles.field}><span>{label}</span>{children}</label>;
}

function LockedCopy({ text }: { text: string }) {
  return <div className={styles.lockedCopy}><span aria-hidden="true">⌁</span><p>{text}</p></div>;
}

function referenceDefaults(draft: SagaPatternDraft): ReferenceForm {
  return {
    name: `${draft.title.slice(0, 132)} – serie`,
    slug: slugify(draft.title),
    objective: "educate",
    audience: "",
    tone: "insightful",
    requiredElements: "",
    forbiddenElements: "",
    defaultChannels: defaultChannels(draft, null),
  };
}

function automationDefaults(draft: SagaPatternDraft, series: SagaPatternSeries | null): AutomationForm {
  return {
    name: `${draft.title.slice(0, 126)} – återkommande`,
    channels: defaultChannels(draft, series),
    generationPrompt: "Skapa en ny, fristående variant som följer den aktiva referensen. Ta en ny vinkel, håll dig till verifierbara påståenden och lämna resultatet för mänsklig granskning.",
    imagePrompt: "",
    desiredLength: "",
    tone: series ? toneLabel(series.controls.tone) : "",
    timezone: draft.timezone,
    weekday: 1,
    time: "09:00",
  };
}

function defaultChannels(draft: SagaPatternDraft, series: SagaPatternSeries | null): SagaPatternChannel[] {
  const allowed = channelsFor(draft.contentType);
  const preferred = series?.controls.defaultChannels ?? draft.channels;
  const selected = uniqueChannels(preferred.filter((channel) => allowed.includes(channel)));
  if (selected.length) return selected;
  return draft.contentType === "newsletter" ? ["newsletter"] : ["linkedin"];
}

function referenceValidation(payload: ReturnType<typeof sagaPatternReferencePayload>): string | null {
  if (payload.name.length < 2) return "Ge serien ett namn.";
  if (!/^[a-z0-9][a-z0-9-]{1,78}$/.test(payload.slug)) return "Ange en enkel intern adress med små bokstäver, siffror och bindestreck.";
  if (!payload.controls.audience) return "Skriv vem den här serien är till för.";
  if (payload.controls.requiredElements.length > 6 || payload.controls.forbiddenElements.length > 6) return "Ange högst sex saker som ska finnas med eller undvikas.";
  return null;
}

function automationValidation(payload: ReturnType<typeof sagaPatternAutomationPayload>, contentType: SagaPatternContentType | null): string | null {
  if (payload.name.length < 2) return "Ge automationen ett namn.";
  if (!payload.channels.length) return "Välj minst en kanal för varje utkast.";
  if (!payload.generationPrompt) return "Skriv vad nästa variant ska lösa.";
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(payload.localTimes[0] ?? "")) return "Ange en tid i formatet HH:MM.";
  if (!payload.timezone.trim()) return "Ange en tidszon.";
  if (contentType === "newsletter" && (payload.channels.length !== 1 || payload.channels[0] !== "newsletter")) return "Nyhetsbrev behöver kanalen Nyhetsbrev.";
  if (contentType !== "newsletter" && payload.channels.includes("newsletter")) return "Nyhetsbrevskanalen kan bara användas för innehållstypen nyhetsbrev.";
  return null;
}

function controlsFrom(value: Record<string, unknown>): SagaPatternControls | null {
  const objective = objectiveValue(value.objective);
  const audience = stringValue(value.audience).trim();
  const tone = toneValue(value.tone);
  if (!objective || !audience || !tone || value.reviewRequired !== true) return null;
  return {
    objective,
    audience,
    tone,
    requiredElements: strings(value.requiredElements),
    forbiddenElements: strings(value.forbiddenElements),
    defaultChannels: channelValues(value.defaultChannels),
    reviewRequired: true,
  };
}

function getJson(path: string, init?: RequestInit) {
  return fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  }).then(async (response) => {
    let data: unknown = null;
    try { data = await response.json(); } catch { /* a non-JSON error is still handled as an error */ }
    return { response, data };
  });
}

function isReferenceEligible(status: SagaPatternDraft["status"]) {
  return status === "draft" || status === "in_review" || status === "approved" || status === "scheduled" || status === "published";
}

function contentTypeValue(value: unknown): SagaPatternContentType | null {
  return value === "social_post" || value === "newsletter" || value === "article" ? value : null;
}

function draftStatusValue(value: unknown): SagaPatternDraft["status"] | null {
  return value === "draft" || value === "in_review" || value === "approved" || value === "scheduled" || value === "published" ? value : null;
}

function objectiveValue(value: unknown): SagaPatternObjective | null {
  return value === "educate" || value === "inspire" || value === "convert" || value === "community" ? value : null;
}

function toneValue(value: unknown): SagaPatternTone | null {
  return value === "direct" || value === "warm" || value === "insightful" ? value : null;
}

function channelValues(value: unknown): SagaPatternChannel[] {
  return uniqueChannels(strings(value).filter((channel): channel is SagaPatternChannel => CHANNELS.includes(channel as SagaPatternChannel)));
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean) : [];
}

function uniqueChannels(value: readonly SagaPatternChannel[]): SagaPatternChannel[] {
  return [...new Set(value)];
}

function toggle(values: readonly SagaPatternChannel[], value: SagaPatternChannel): SagaPatternChannel[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

function lines(value: string): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const entry of value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
    const key = entry.toLocaleLowerCase("sv-SE");
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(entry);
    if (output.length === 6) break;
  }
  return output;
}

function slugify(value: string): string {
  return value
    .toLocaleLowerCase("sv-SE")
    .replace(/[åä]/g, "a")
    .replace(/ö/g, "o")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 79);
}

function positiveIntegerOrNull(value: string): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 20 && parsed <= 60_000 ? parsed : null;
}

function integerValue(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function languageValue(value: unknown): string {
  const candidate = stringValue(value);
  return /^[a-z]{2}(-[A-Z]{2})?$/.test(candidate) ? candidate : "sv";
}

function timezoneValue(value: unknown): string {
  const candidate = stringValue(value).trim();
  return candidate.length >= 3 && candidate.length <= 80 ? candidate : "Europe/Stockholm";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function excerpt(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max).trimEnd()}…`;
}

function channelLabel(channel: SagaPatternChannel): string {
  return channel === "facebook_page" ? "Facebook" : channel === "instagram" ? "Instagram" : channel === "linkedin" ? "LinkedIn" : "Nyhetsbrev";
}

function channelsFor(contentType: SagaPatternContentType): SagaPatternChannel[] {
  return contentType === "newsletter" ? ["newsletter"] : ["facebook_page", "instagram", "linkedin"];
}

function contentTypeLabel(contentType: SagaPatternContentType): string {
  return contentType === "newsletter" ? "Nyhetsbrev" : contentType === "article" ? "Artikel" : "Socialt inlägg";
}

function statusLabel(status: SagaPatternDraft["status"]): string {
  return status === "in_review" ? "För granskning" : status === "approved" ? "Godkänt" : status === "scheduled" ? "Planerat" : status === "published" ? "Publicerat" : "Utkast";
}

function toneLabel(tone: SagaPatternTone): string {
  return tone === "direct" ? "Rak och konkret" : tone === "warm" ? "Varm och mänsklig" : "Insiktsdriven och lugn";
}
