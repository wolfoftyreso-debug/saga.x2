"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import type {
  SagaNewsIngestionRun,
  SagaNewsSignalCandidate,
  SagaNewsSource,
  SagaNewsSourceInput,
  SagaNewsSourceItem,
} from "@/lib/domain/saga-news-core";
import styles from "@/components/saga-news-workspace.module.css";

type LoadState = "loading" | "ready" | "unavailable";
type ConnectorKey = "rss_atom" | "gdelt_doc_2" | "guardian_open_platform";

type SagaNewsOverview = {
  sources: SagaNewsSource[];
  items: SagaNewsSourceItem[];
  runs: SagaNewsIngestionRun[];
  signals: SagaNewsSignalCandidate[];
};

export type SagaNewsSourceForm = {
  id: string | null;
  name: string;
  slug: string;
  connectorKey: ConnectorKey;
  endpointUrl: string;
  topics: string;
  publisherAllowlist: string;
  minimumIntervalMinutes: number;
  trustLevel: number;
  active: boolean;
};

const gdeltEndpoint = "https://api.gdeltproject.org/api/v2/doc/doc";
const guardianEndpoint = "https://content.guardianapis.com/search";

const connectorChoices: Array<{
  key: ConnectorKey;
  label: string;
  sourceKind: SagaNewsSourceInput["sourceKind"];
  endpoint: string;
  description: string;
}> = [
  {
    key: "rss_atom",
    label: "RSS eller Atom",
    sourceKind: "rss",
    endpoint: "",
    description: "En tydlig, godkänd publicistkälla. SAGA läser endast metadata och korta utdrag.",
  },
  {
    key: "gdelt_doc_2",
    label: "GDELT – global signal",
    sourceKind: "public_api",
    endpoint: gdeltEndpoint,
    description: "Bred omvärldssignal. Begränsa den till de publicister och ämnen ni faktiskt litar på.",
  },
  {
    key: "guardian_open_platform",
    label: "Guardian – licensierad metadata",
    sourceKind: "news_api",
    endpoint: guardianEndpoint,
    description: "Används bara när rätt kommersiell användningsrätt är aktiverad för arbetsytan.",
  },
];

const initialForm: SagaNewsSourceForm = {
  id: null,
  name: "",
  slug: "",
  connectorKey: "rss_atom",
  endpointUrl: "",
  topics: "",
  publisherAllowlist: "",
  minimumIntervalMinutes: 60,
  trustLevel: 4,
  active: true,
};

/** Pure mapping used by the form and its regression test. */
export function sagaNewsSourceInput(form: SagaNewsSourceForm): SagaNewsSourceInput {
  const choice = connectorChoices.find((candidate) => candidate.key === form.connectorKey) ?? connectorChoices[0]!;
  return {
    slug: slugify(form.slug || form.name),
    name: form.name.trim(),
    sourceKind: choice.sourceKind,
    connectorKey: choice.key,
    endpointUrl: choice.endpoint || form.endpointUrl.trim(),
    publisherAllowlist: lines(form.publisherAllowlist),
    publisherBlocklist: [],
    allowlistMode: "strict",
    topics: lines(form.topics),
    languages: ["sv"],
    countries: ["SE"],
    trustLevel: form.trustLevel,
    sourceWeight: form.trustLevel * 20,
    minimumIntervalMinutes: form.minimumIntervalMinutes,
    maxItemsPerRun: 50,
    maxItemTextChars: 30_000,
    sourcePolicy: {},
    isAllowed: true,
    active: form.active,
  };
}

export function SagaNewsWorkspace() {
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [overview, setOverview] = useState<SagaNewsOverview | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [sourceForm, setSourceForm] = useState<SagaNewsSourceForm>(() => ({ ...initialForm }));
  const [formOpen, setFormOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busySourceIds, setBusySourceIds] = useState<Set<string>>(() => new Set());
  const [checkKeys, setCheckKeys] = useState<Map<string, string>>(() => new Map());

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoadState("loading");
    try {
      const response = await fetch("/api/saga/news", { credentials: "same-origin", cache: "no-store", signal });
      const payload: unknown = await response.json().catch(() => null);
      const data = overviewFromPayload(payload);
      if (!response.ok || !data) {
        setOverview(null);
        setLoadState("unavailable");
        setMessage(productFailureMessage(response.status, "Research kan inte öppnas ännu."));
        return;
      }
      setOverview(data);
      setLoadState("ready");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setOverview(null);
      setLoadState("unavailable");
      setMessage("Research kan inte nå arbetsytan just nu.");
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(() => load(controller.signal));
    return () => controller.abort();
  }, [load]);

  const sourceById = useMemo(() => new Map((overview?.sources ?? []).map((source) => [source.id, source])), [overview]);
  const qualifiedSignals = useMemo(
    () => (overview?.signals ?? []).filter((signal) => signal.state === "qualified" || signal.state === "in_review"),
    [overview],
  );
  const activeSources = (overview?.sources ?? []).filter((source) => source.active && source.isAllowed);

  function updateForm<K extends keyof SagaNewsSourceForm>(key: K, value: SagaNewsSourceForm[K]) {
    setSourceForm((current) => ({ ...current, [key]: value }));
  }

  function selectConnector(key: ConnectorKey) {
    const choice = connectorChoices.find((candidate) => candidate.key === key)!;
    setSourceForm((current) => ({
      ...current,
      connectorKey: key,
      endpointUrl: choice.endpoint || current.endpointUrl,
    }));
  }

  function startNewSource() {
    setSourceForm({ ...initialForm });
    setFormOpen(true);
    setMessage(null);
  }

  function editSource(source: SagaNewsSource) {
    const connectorKey = connectorChoices.some((candidate) => candidate.key === source.connectorKey)
      ? source.connectorKey as ConnectorKey
      : "rss_atom";
    setSourceForm({
      id: source.id,
      name: source.name,
      slug: source.slug,
      connectorKey,
      endpointUrl: source.endpointUrl,
      topics: source.topics.join("\n"),
      publisherAllowlist: source.publisherAllowlist.join("\n"),
      minimumIntervalMinutes: source.minimumIntervalMinutes,
      trustLevel: source.trustLevel,
      active: source.active,
    });
    setFormOpen(true);
    setMessage(null);
  }

  async function saveSource(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = sagaNewsSourceInput(sourceForm);
    if (!input.name || !input.slug || !(input.topics?.length) || !(input.publisherAllowlist?.length)) {
      setMessage("Ge källan ett namn, minst ett ämne och minst en godkänd publicist innan du sparar.");
      return;
    }
    if (input.connectorKey === "rss_atom" && !input.endpointUrl) {
      setMessage("Ange en HTTPS-adress till RSS- eller Atom-flödet.");
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch("/api/saga/news/sources", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!response.ok) {
        setMessage(productFailureMessage(response.status, "Källan kunde inte sparas."));
        return;
      }
      setFormOpen(false);
      setSourceForm({ ...initialForm });
      setMessage(sourceForm.id ? "Källan är uppdaterad." : "Källan är sparad och redo att kontrolleras.");
      await load();
    } catch {
      setMessage("Källan kunde inte nå arbetsytan och är inte bekräftat sparad.");
    } finally {
      setSaving(false);
    }
  }

  async function changeSourceActivity(source: SagaNewsSource, active: boolean) {
    setBusySourceIds((current) => new Set(current).add(source.id));
    setMessage(null);
    try {
      const response = await fetch(`/api/saga/news/sources/${encodeURIComponent(source.id)}`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ active }),
      });
      if (!response.ok) {
        setMessage(productFailureMessage(response.status, "Källans status kunde inte ändras."));
        return;
      }
      setMessage(active ? "Källan är aktiverad." : "Källan är pausad. Inga nya kontroller görs från den.");
      await load();
    } catch {
      setMessage("Statusändringen kunde inte bekräftas.");
    } finally {
      setBusySourceIds((current) => without(current, source.id));
    }
  }

  async function removeSource(source: SagaNewsSource) {
    if (!window.confirm(`Ta bort ${source.name}? Källor med sparat underlag bevaras och kan därför inte tas bort.`)) return;
    setBusySourceIds((current) => new Set(current).add(source.id));
    setMessage(null);
    try {
      const response = await fetch(`/api/saga/news/sources/${encodeURIComponent(source.id)}`, { method: "DELETE", credentials: "same-origin" });
      if (!response.ok) {
        setMessage(productFailureMessage(response.status, "Källan kan inte tas bort eftersom dess underlag behöver finnas kvar för spårbarhet."));
        return;
      }
      setMessage("Källan är borttagen.");
      await load();
    } catch {
      setMessage("Borttagningen kunde inte bekräftas.");
    } finally {
      setBusySourceIds((current) => without(current, source.id));
    }
  }

  async function checkSource(source: SagaNewsSource) {
    const key = checkKeys.get(source.id) ?? createIdempotencyKey();
    setCheckKeys((current) => new Map(current).set(source.id, key));
    setBusySourceIds((current) => new Set(current).add(source.id));
    setMessage(null);
    try {
      const response = await fetch("/api/saga/news/check", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceId: source.id, idempotencyKey: key }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        setMessage(productFailureMessage(response.status, "Kontrollen kunde inte genomföras ännu."));
        return;
      }
      const result = checkResultMessage(payload);
      setMessage(result || "Kontrollen är kvitterad. Underlag och signaler är uppdaterade.");
      setCheckKeys((current) => withoutMap(current, source.id));
      await load();
    } catch {
      setMessage("Kontrollen kunde inte nå arbetsytan. Du kan försöka igen utan att skapa en dubblett.");
    } finally {
      setBusySourceIds((current) => without(current, source.id));
    }
  }

  return (
    <section className={styles.workspace} aria-labelledby="saga-news-title">
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>SAGA / RESEARCH</p>
          <h1 id="saga-news-title">Fångar signaler. Kräver bevis. Väntar på din vinkel.</h1>
          <p className={styles.intro}>Bygg ett eget underlag av godkända källor. SAGA sparar spårbara signaler först när minst två oberoende publicister pekar åt samma håll.</p>
        </div>
        <div className={styles.headerActions}>
          <Link className={styles.secondaryAction} href="/studio/lens">Öppna Editorial Lens</Link>
          <button type="button" className={styles.primaryAction} onClick={startNewSource} disabled={loadState !== "ready"}>＋ Lägg till källa</button>
        </div>
      </header>

      <section className={styles.doctrine} aria-label="SAGA Research-princip">
        <span aria-hidden="true">⌁</span>
        <div><strong>Signal är inte en slutsats.</strong><p>Research samlar korta, länkade underlag. Först efter oberoende bekräftelse blir något ett redaktionellt förslag — aldrig en automatisk publicering.</p></div>
        <div className={styles.doctrineRules}><span>2 oberoende publicister</span><span>72 timmar</span><span>Alltid redaktionell kontroll</span></div>
      </section>

      {message && <div className={styles.message} role="status">{message}<button type="button" onClick={() => setMessage(null)} aria-label="Stäng meddelande">×</button></div>}

      {loadState === "loading" && <section className={styles.stateCard} aria-live="polite"><span className={styles.spinner} aria-hidden="true" /><div><strong>Hämtar din researchyta…</strong><p>Vi läser endast underlag från din egen arbetsyta.</p></div></section>}
      {loadState === "unavailable" && <section className={`${styles.stateCard} ${styles.stateError}`} role="alert"><div><strong>Research behöver en aktiv arbetsyta</strong><p>{message || "Källor och signaler kan inte bekräftas just nu."}</p><div className={styles.stateActions}><button type="button" onClick={() => void load()}>Försök igen</button><Link href="/studio">Till Studio</Link></div></div></section>}

      {loadState === "ready" && overview && <>
        <section className={styles.metrics} aria-label="Researchöversikt">
          <Metric label="Aktiva källor" value={String(activeSources.length)} detail={activeSources.length ? "Kontrolleras enligt sina egna intervall" : "Lägg till din första godkända källa"} />
          <Metric label="Underlag senaste flödet" value={String(overview.items.length)} detail="Korta utdrag med källänk — inte artikelkopior" />
          <Metric label="Verifierade signaler" value={String(qualifiedSignals.length)} detail="Har minst två oberoende publicister" accent />
        </section>

        <section className={styles.flow} aria-label="Från källa till redaktionellt förslag">
          <FlowStep number="01" title="Lyssna" detail={`${activeSources.length} aktiva källor`} />
          <span aria-hidden="true" />
          <FlowStep number="02" title="Verifiera" detail="Samma signal hos flera" />
          <span aria-hidden="true" />
          <FlowStep number="03" title="Vår tanke" detail="Lens sätter riktning" />
          <span aria-hidden="true" />
          <FlowStep number="04" title="Skapa utkast" detail="Alltid ett val" />
        </section>

        <section className={styles.mainGrid}>
          <div className={styles.signalPanel}>
            <div className={styles.sectionHeading}><div><p>REDATIONELL KÖ</p><h2>Signaler som förtjänar en tanke</h2></div><span>{qualifiedSignals.length} kvalificerade</span></div>
            {qualifiedSignals.length ? <div className={styles.signalList}>{qualifiedSignals.map((signal) => <SignalCard key={signal.id} signal={signal} items={overview.items} />)}</div> : <EmptySignal />}
          </div>
          <aside className={styles.controlPanel}>
            <p>STYRNING</p>
            <h2>Din Lens bestämmer vad en signal får betyda.</h2>
            <p>Research gör ingen ”our take” på egen hand. Editorial Lens sätter mission, ton, beviskrav och kontrollnivå innan du väljer att skapa.</p>
            <Link href="/studio/lens">Sätt redaktionell riktning <span aria-hidden="true">→</span></Link>
          </aside>
        </section>

        <section className={styles.sourcesSection}>
          <div className={styles.sectionHeading}><div><p>GODKÄNDA KÄLLOR</p><h2>Bygg bredd utan att tappa ursprung.</h2></div><button type="button" className={styles.textAction} onClick={startNewSource}>＋ Ny källa</button></div>
          {formOpen && <SourceEditor form={sourceForm} saving={saving} onChange={updateForm} onConnector={selectConnector} onSubmit={saveSource} onCancel={() => { setFormOpen(false); setSourceForm({ ...initialForm }); }} />}
          {overview.sources.length ? <div className={styles.sourceList}>{overview.sources.map((source) => {
            const busy = busySourceIds.has(source.id);
            return <article className={styles.sourceCard} key={source.id}>
              <div className={styles.sourceTopline}><span className={styles.sourceBadge}>{connectorLabel(source.connectorKey)}</span><span className={source.active ? styles.activeState : styles.pausedState}>{source.active ? "Aktiv" : "Pausad"}</span></div>
              <h3>{source.name}</h3>
              <p>{source.topics.join(" · ") || "Inga ämnen är angivna"}</p>
              <div className={styles.sourceMeta}><span>{source.publisherAllowlist.length} godkända publicister</span><span>var {intervalLabel(source.minimumIntervalMinutes)}</span></div>
              <div className={styles.sourceActions}>
                <button type="button" onClick={() => void checkSource(source)} disabled={busy || !source.active}>{busy ? "Kontrollerar…" : "Hämta nu"}</button>
                <button type="button" onClick={() => editSource(source)} disabled={busy}>Förfina</button>
                <button type="button" onClick={() => void changeSourceActivity(source, !source.active)} disabled={busy}>{source.active ? "Pausa" : "Aktivera"}</button>
                <button type="button" className={styles.dangerAction} onClick={() => void removeSource(source)} disabled={busy}>Ta bort</button>
              </div>
            </article>;
          })}</div> : <section className={styles.emptySource}><div><strong>Din research är tom — med flit.</strong><p>Välj era källor först. SAGA börjar inte gissa, samla okontrollerat eller skriva förrän underlaget är ditt.</p></div><button type="button" onClick={startNewSource}>Lägg till första källan</button></section>}
        </section>

        <section className={styles.evidenceGrid}>
          <article className={styles.evidencePanel}>
            <div className={styles.sectionHeading}><div><p>SENASTE UNDERLAG</p><h2>Spårbart från början.</h2></div><span>{overview.items.length} poster</span></div>
            {overview.items.length ? <ul className={styles.itemList}>{overview.items.slice(0, 8).map((item) => <li key={item.id}><div><a href={item.canonicalUrl} target="_blank" rel="noreferrer">{item.title}</a><p>{item.summary || "Kort underlag utan publicerad sammanfattning."}</p><span>{item.publisherDomain} · {formatDate(item.publishedAt ?? item.firstSeenAt)}</span></div><span className={styles.itemSource}>{sourceById.get(item.sourceId)?.name ?? "Källa"}</span></li>)}</ul> : <p className={styles.muted}>När en källa har kontrollerats syns dess korta, länkade underlag här.</p>}
          </article>
          <article className={styles.runPanel}>
            <div className={styles.sectionHeading}><div><p>KVITTON</p><h2>Varje körning går att följa.</h2></div></div>
            {overview.runs.length ? <ul className={styles.runList}>{overview.runs.slice(0, 8).map((run) => <li key={run.id}><span className={run.status === "completed" ? styles.runComplete : styles.runFailed} /><div><strong>{sourceById.get(run.sourceId)?.name ?? "Källa"}</strong><small>{run.status === "completed" ? `${run.itemsInserted} nya · ${run.itemsDuplicate} redan kända` : run.failureSummary || "Kunde inte slutföras"}</small></div><time>{formatDate(run.startedAt)}</time></li>)}</ul> : <p className={styles.muted}>Kvitton visas här efter första kontrollen.</p>}
          </article>
        </section>
      </>}
    </section>
  );
}

function SourceEditor({ form, saving, onChange, onConnector, onSubmit, onCancel }: {
  form: SagaNewsSourceForm;
  saving: boolean;
  onChange: <K extends keyof SagaNewsSourceForm>(key: K, value: SagaNewsSourceForm[K]) => void;
  onConnector: (key: ConnectorKey) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
}) {
  const choice = connectorChoices.find((candidate) => candidate.key === form.connectorKey)!;
  return <form className={styles.sourceEditor} onSubmit={onSubmit}>
    <div className={styles.editorHeading}><div><p>{form.id ? "FÖRFINA KÄLLA" : "NY KÄLLA"}</p><h3>{form.id ? "Gör urvalet skarpare" : "Välj ett tydligt ursprung"}</h3></div><button type="button" onClick={onCancel} disabled={saving}>Stäng</button></div>
    <div className={styles.connectorChoices}>{connectorChoices.map((candidate) => <label key={candidate.key} className={form.connectorKey === candidate.key ? styles.connectorSelected : ""}><input type="radio" name="connector" checked={form.connectorKey === candidate.key} onChange={() => onConnector(candidate.key)} /><strong>{candidate.label}</strong><small>{candidate.description}</small></label>)}</div>
    <div className={styles.formGrid}>
      <label><span>Namn</span><input value={form.name} onChange={(event) => onChange("name", event.target.value)} placeholder="Till exempel Svensk elbilsbevakning" required maxLength={240} /></label>
      <label><span>Kort namn</span><input value={form.slug} onChange={(event) => onChange("slug", event.target.value)} placeholder="svensk-elbilsbevakning" required maxLength={79} /></label>
      {choice.key === "rss_atom" ? <label className={styles.wideField}><span>RSS- eller Atom-adress</span><input type="url" value={form.endpointUrl} onChange={(event) => onChange("endpointUrl", event.target.value)} placeholder="https://exempel.se/feed.xml" required /></label> : <div className={`${styles.readOnlyField} ${styles.wideField}`}><span>Serverstyrd anslutning</span><strong>{choice.key === "gdelt_doc_2" ? "GDELT ArticleList" : "Guardian Open Platform"}</strong><small>{choice.key === "guardian_open_platform" ? "Kontrolleras mot er licens innan något hämtas." : "SAGA använder den officiella anslutningen; inga nycklar sparas i formuläret."}</small></div>}
      <label className={styles.wideField}><span>Ämnen att lyssna efter</span><textarea value={form.topics} onChange={(event) => onChange("topics", event.target.value)} rows={3} placeholder="Kinesiska elbilar&#10;elbil i Stockholm&#10;trygga ägandekostnader" required /><small>Ett ämne per rad. SAGA använder dem för att hitta relevanta rubriker, inte för att skapa påståenden.</small></label>
      <label className={styles.wideField}><span>Godkända publicister</span><textarea value={form.publisherAllowlist} onChange={(event) => onChange("publisherAllowlist", event.target.value)} rows={3} placeholder="di.se&#10;svd.se&#10;transportstyrelsen.se" required /><small>En domän per rad. Strikt urval gör att övriga publicister inte blir bevis.</small></label>
      <label><span>Kontrollintervall</span><select value={form.minimumIntervalMinutes} onChange={(event) => onChange("minimumIntervalMinutes", Number(event.target.value))}><option value={15}>Var 15:e minut</option><option value={60}>Varje timme</option><option value={360}>Var 6:e timme</option><option value={1440}>Varje dag</option></select></label>
      <label><span>Källtyngd</span><select value={form.trustLevel} onChange={(event) => onChange("trustLevel", Number(event.target.value))}><option value={3}>God grund</option><option value={4}>Hög</option><option value={5}>Mycket hög</option></select></label>
    </div>
    <div className={styles.editorFooter}><label className={styles.toggle}><input type="checkbox" checked={form.active} onChange={(event) => onChange("active", event.target.checked)} /><span><strong>Aktivera när den sparas</strong><small>En källa kan alltid pausas senare.</small></span></label><div><button type="button" onClick={onCancel} disabled={saving}>Avbryt</button><button type="submit" disabled={saving}>{saving ? "Sparar…" : form.id ? "Spara ändringar" : "Spara källa"}</button></div></div>
  </form>;
}

function SignalCard({ signal, items }: { signal: SagaNewsSignalCandidate; items: SagaNewsSourceItem[] }) {
  const evidence = items.filter((item) => signal.evidenceItemIds.includes(item.id));
  return <article className={styles.signalCard}>
    <div className={styles.signalTopline}><span>{signal.independentSourceCount} oberoende källor</span><time>{formatDate(signal.lastSeenAt)}</time></div>
    <h3>{signal.headline}</h3>
    <p>{signal.summary || "Verifierat underlag väntar på att tolkas genom er redaktionella riktning."}</p>
    <div className={styles.signalEvidence}><strong>Belägg</strong>{evidence.slice(0, 3).map((item) => <a key={item.id} href={item.canonicalUrl} target="_blank" rel="noreferrer">{item.publisherDomain}</a>)}<span>{signal.requiresHumanReview ? "Granskning krävs" : "Redo"}</span></div>
    <div className={styles.signalActions}><Link href="/studio/lens">Tolka genom Lens</Link><Link href="/studio/content/new?edit=1">Skapa utkast</Link></div>
  </article>;
}

function EmptySignal() {
  return <div className={styles.emptySignal}><span aria-hidden="true">⌁</span><div><strong>Inget kvalificerat ännu.</strong><p>Det är rätt beteende. SAGA väntar tills minst två oberoende, godkända publicister har ett tydligt överlapp.</p></div></div>;
}

function Metric({ label, value, detail, accent = false }: { label: string; value: string; detail: string; accent?: boolean }) {
  return <article className={accent ? `${styles.metric} ${styles.metricAccent}` : styles.metric}><span>{label}</span><strong>{value}</strong><p>{detail}</p></article>;
}

function FlowStep({ number, title, detail }: { number: string; title: string; detail: string }) {
  return <div><span>{number}</span><strong>{title}</strong><small>{detail}</small></div>;
}

function overviewFromPayload(payload: unknown): SagaNewsOverview | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const data = "data" in payload && payload.data && typeof payload.data === "object" && !Array.isArray(payload.data) ? payload.data as Record<string, unknown> : null;
  if (!data || !Array.isArray(data.sources) || !Array.isArray(data.items) || !Array.isArray(data.runs) || !Array.isArray(data.signals)) return null;
  return { sources: data.sources as SagaNewsSource[], items: data.items as SagaNewsSourceItem[], runs: data.runs as SagaNewsIngestionRun[], signals: data.signals as SagaNewsSignalCandidate[] };
}

function lines(value: string): string[] { return value.split(/\r?\n|,/).map((entry) => entry.trim().toLowerCase()).filter(Boolean); }
function slugify(value: string): string { return value.trim().toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/gu, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 79); }
function without<T>(values: Set<T>, value: T): Set<T> { const next = new Set(values); next.delete(value); return next; }
function withoutMap<K, V>(values: Map<K, V>, key: K): Map<K, V> { const next = new Map(values); next.delete(key); return next; }
function createIdempotencyKey(): string { return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(16)}-0000-4000-8000-${Math.random().toString(16).slice(2).padEnd(12, "0").slice(0, 12)}`; }
function connectorLabel(key: string): string { return connectorChoices.find((candidate) => candidate.key === key)?.label ?? "Källa"; }
function intervalLabel(minutes: number): string { if (minutes < 60) return `${minutes} min`; if (minutes === 60) return "timme"; if (minutes % 60 === 0) return `${minutes / 60} h`; return `${minutes} min`; }
function formatDate(value: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat("sv-SE", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(date); }
function productFailureMessage(status: number, fallback: string): string { if (status === 401) return "Logga in igen för att öppna din researchyta."; if (status === 403) return "Du har inte behörighet att ändra den här researchytan."; if (status === 422) return "Uppgifterna behöver justeras innan SAGA kan använda källan."; if (status === 503) return "Research är inte tillgänglig ännu. Försök igen när arbetsytan är aktiv."; return fallback; }
function checkResultMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const row = payload as Record<string, unknown>;
  if (typeof row.message === "string") return row.message;
  const data = row.data;
  return data && typeof data === "object" && !Array.isArray(data) && typeof (data as Record<string, unknown>).message === "string"
    ? (data as Record<string, unknown>).message as string
    : null;
}
