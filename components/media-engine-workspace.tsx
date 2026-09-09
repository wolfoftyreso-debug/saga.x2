"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition, type FormEvent } from "react";
import styles from "@/components/media-engine-workspace.module.css";
import {
  EMPTY_MEDIA_ENGINE,
  mediaEngineFromPayload,
  tenantListFromPayload,
  type MediaClusterView,
  type MediaEngineSnapshot,
  type MediaEvidenceView,
  type MediaHandoffView,
  type MediaRuleView,
  type MediaRunView,
  type MediaSourceView,
} from "@/components/media-engine-adapter";

type EngineRead = { ok: boolean; status: number; data: unknown };

type ActionState = {
  label: string;
  busy: boolean;
};

type NoticeState = {
  message: string;
  tone: "success" | "error" | "info";
};

const studioNav = [
  { href: "/studio", label: "Översikt", icon: "✦" },
  { href: "/studio/research", label: "Research", icon: "⌁", active: true },
  { href: "/studio/calendar", label: "Kalender", icon: "□" },
  { href: "/studio/templates", label: "Mallar", icon: "◇" },
  { href: "/studio/automations", label: "Automationer", icon: "↻" },
  { href: "/studio/channels", label: "Kanaler", icon: "◉" },
];

const sourceKinds = [
  { value: "rss", label: "RSS" },
  { value: "api", label: "Nyhets- eller data-API" },
  { value: "web_search", label: "Webbsökning" },
] as const;

const contentOptions = [
  { value: "social_post", label: "Inlägg" },
  { value: "newsletter", label: "Nyhetsbrev" },
  { value: "article", label: "Artikel" },
] as const;

const frameworks = [
  { value: "insikt", label: "Insikt → konsekvens → nästa steg" },
  { value: "contrarian", label: "Tydlig ståndpunkt" },
  { value: "explainer", label: "Förklara det komplexa" },
  { value: "weekly", label: "Veckans sammanhang" },
] as const;

const imageDirections = [
  { value: "editorial", label: "Redaktionell bild" },
  { value: "data", label: "Data / grafisk förklaring" },
  { value: "human", label: "Människa / verklig miljö" },
  { value: "none", label: "Ingen bild" },
] as const;

export function MediaEngineWorkspace() {
  const [snapshot, setSnapshot] = useState<MediaEngineSnapshot>(EMPTY_MEDIA_ENGINE);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedTenantId, setSelectedTenantId] = useState<string | null>(null);
  const [selectedClusterId, setSelectedClusterId] = useState<string | null>(null);
  const [selectedCheckRuleId, setSelectedCheckRuleId] = useState<string>("");
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [sourceFormOpen, setSourceFormOpen] = useState(false);
  const [ruleFormOpen, setRuleFormOpen] = useState(false);
  const [tenantFormOpen, setTenantFormOpen] = useState(false);
  const [action, setAction] = useState<ActionState>({ label: "", busy: false });
  const [isPending, startTransition] = useTransition();
  const loadSequence = useRef(0);

  const activeTenant = snapshot.tenant;
  const activeRules = useMemo(() => snapshot.rules.filter((rule) => rule.active), [snapshot.rules]);
  const selectedCluster = useMemo(
    () => snapshot.clusters.find((cluster) => cluster.id === selectedClusterId) ?? snapshot.clusters[0] ?? null,
    [selectedClusterId, snapshot.clusters],
  );
  const configurationReady = Boolean(activeTenant && snapshot.configuration.ready);
  const canEdit = Boolean(activeTenant && activeTenant.role !== "viewer");
  const checkDisabledReason = !activeTenant
    ? "Skapa eller välj först en arbetsyta."
    : !canEdit
      ? "Du har visningsbehörighet i den här arbetsytan."
      : !snapshot.configuration.ready
        ? missingConfigurationMessage(snapshot)
          : !activeRules.length
          ? "Skapa en aktiv regel innan du kör första kontrollen."
          : null;
  const reportProblem = useCallback((message: string) => setNotice({ message, tone: "error" }), []);

  const load = useCallback(async (tenantId?: string | null) => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    setLoadError(null);
    const query = tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : "";
    const [engineResponse, tenantsResponse] = await Promise.all([
      readEngineEndpoint(`/api/media-engine${query}`),
      readEngineEndpoint("/api/media-engine/tenants"),
    ]);

    if (sequence !== loadSequence.current) return;

    if (!engineResponse.ok) {
      setSnapshot((current) => ({ ...EMPTY_MEDIA_ENGINE, tenants: current.tenants }));
      setLoadError(readError(engineResponse.data, engineResponse.status === 401 ? "Logga in för att använda Media Engine." : "Kunde inte läsa Media Engine just nu."));
      setLoading(false);
      return;
    }

    const next = mediaEngineFromPayload(engineResponse.data);
    if (tenantsResponse.ok) {
      const tenants = tenantListFromPayload(tenantsResponse.data);
      next.tenants = tenants;
      if (!next.tenant && tenants.length) next.tenant = tenants[0];
    }
    setSnapshot(next);
    setSelectedClusterId((current) => current && next.clusters.some((cluster) => cluster.id === current) ? current : next.clusters[0]?.id ?? null);
    setLoading(false);
  }, []);

  useEffect(() => {
    let disposed = false;
    void Promise.resolve().then(() => {
      if (!disposed) return load(selectedTenantId);
    });
    return () => { disposed = true; };
  }, [load, selectedTenantId]);

  const runAction = useCallback(async (
    label: string,
    request: () => Promise<EngineRead>,
    success: string,
    onSuccess?: (data: unknown) => string | null,
  ): Promise<boolean> => {
    setAction({ label, busy: true });
    setNotice(null);
    try {
      const result = await request();
      if (!result.ok) throw new Error(readError(result.data, "Åtgärden kunde inte genomföras."));
      const nextTenantId = onSuccess?.(result.data) ?? selectedTenantId;
      setNotice({ message: success || readMessage(result.data, "Klart."), tone: "success" });
      await load(nextTenantId);
      return true;
    } catch (error) {
      setNotice({ message: error instanceof Error ? error.message : "Åtgärden kunde inte genomföras.", tone: "error" });
      return false;
    } finally {
      setAction({ label: "", busy: false });
    }
  }, [load, selectedTenantId]);

  function changeTenant(tenantId: string) {
    setSelectedTenantId(tenantId || null);
    setSelectedClusterId(null);
  }

  function createTenant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    startTransition(() => {
      void runAction("Skapar arbetsyta", () => writeEngineEndpoint("/api/media-engine/tenants", "POST", {
        name: text(form, "name"),
        slug: text(form, "slug") || undefined,
        timezone: text(form, "timezone") || "Europe/Stockholm",
      }), "Arbetsytan är skapad. Lägg till en källa och en regel för att starta motorn.", (data) => {
        const tenantId = tenantIdFromCreatePayload(data);
        if (tenantId) setSelectedTenantId(tenantId);
        return tenantId;
      }).then((saved) => {
        if (saved) setTenantFormOpen(false);
      });
    });
  }

  function createSource(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeTenant) { setNotice({ message: "Skapa eller välj en arbetsyta först.", tone: "error" }); return; }
    const form = new FormData(event.currentTarget);
    const kind = text(form, "kind");
    const baseUrl = text(form, "baseUrl");
    if (kind !== "web_search" && !baseUrl) {
      setNotice({ message: "RSS och API-källor behöver en publik URL innan de kan sparas.", tone: "error" });
      return;
    }
    startTransition(() => {
      void runAction("Lägger till källa", () => writeEngineEndpoint("/api/media-engine/sources", "POST", {
        tenantId: activeTenant.id,
        kind,
        provider: text(form, "provider"),
        displayName: text(form, "displayName"),
        baseUrl: baseUrl || undefined,
        configPublic: { scope: text(form, "scope") || "domain" },
        active: true,
      }), "Källan är tillagd. Nästa kontroll läser den enligt din regel.").then((saved) => {
        if (saved) setSourceFormOpen(false);
      });
    });
  }

  function createRule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeTenant) { setNotice({ message: "Skapa eller välj en arbetsyta först.", tone: "error" }); return; }
    const form = new FormData(event.currentTarget);
    const domains = commaSeparatedValues(text(form, "domains"));
    const excludeDomains = commaSeparatedValues(text(form, "excludeDomains"));
    const contentType = text(form, "contentType") || "social_post";
    const selectedChannels = form.getAll("channels").map((value) => String(value)).filter(Boolean);
    const channels = contentType === "newsletter" ? ["newsletter"] : selectedChannels.filter((channel) => channel !== "newsletter");
    const scheduleMode = text(form, "scheduleMode") === "cron" ? "cron" : "threshold";
    if (!channels.length) { setNotice({ message: "Välj minst en kanal för utkastet.", tone: "error" }); return; }
    startTransition(() => {
      void runAction("Sparar regel", () => writeEngineEndpoint("/api/media-engine/rules", "POST", {
        tenantId: activeTenant.id,
        name: text(form, "name"),
        query: text(form, "query"),
        includeDomains: domains,
        excludeDomains,
        sourceIds: form.getAll("sourceIds").map((value) => String(value)).filter(Boolean),
        minMentions: numberFromForm(form, "minMentions", 3),
        minUniqueDomains: numberFromForm(form, "minUniqueDomains", 2),
        windowHours: numberFromForm(form, "windowHours", 24),
        contentType,
        channels,
        frameworkKey: text(form, "frameworkKey"),
        imageStyle: text(form, "imageStyle"),
        prompt: text(form, "prompt"),
        scheduleMode,
        cadence: scheduleMode === "cron" ? "cron" : text(form, "cadence") || "hourly",
        cronExpression: scheduleMode === "cron" ? text(form, "cronExpression") || null : null,
        approvalRequired: form.get("approvalRequired") === "on",
        autoCreateHandoff: form.get("autoCreateHandoff") === "on",
        active: true,
      }), "Regeln är aktiv. Den skapar bara research och utkast — aldrig en publicering.").then((saved) => {
        if (saved) setRuleFormOpen(false);
      });
    });
  }

  function updateSource(source: MediaSourceView, active: boolean) {
    const tenantId = activeTenant?.id;
    if (!tenantId) { reportProblem("Välj en arbetsyta först."); return; }
    void runAction(active ? "Aktiverar källa" : "Pausar källa", () => writeEngineEndpoint(`/api/media-engine/sources/${encodeURIComponent(source.id)}?tenantId=${encodeURIComponent(tenantId)}`, "PATCH", { active }), active ? "Källan är aktiv igen." : "Källan är pausad och läses inte vid nästa kontroll.");
  }

  function saveSourceSettings(source: MediaSourceView, patch: Record<string, unknown>): Promise<boolean> {
    const tenantId = activeTenant?.id;
    if (!tenantId) { reportProblem("Välj en arbetsyta först."); return Promise.resolve(false); }
    return runAction("Uppdaterar källa", () => writeEngineEndpoint(`/api/media-engine/sources/${encodeURIComponent(source.id)}?tenantId=${encodeURIComponent(tenantId)}`, "PATCH", patch), "Källinställningarna är sparade.");
  }

  function deleteSource(source: MediaSourceView) {
    const tenantId = activeTenant?.id;
    if (!tenantId) { reportProblem("Välj en arbetsyta först."); return; }
    if (!window.confirm(`Ta bort ${source.displayName}? Detta går inte att ångra.`)) return;
    void runAction("Tar bort källa", () => writeEngineEndpoint(`/api/media-engine/sources/${encodeURIComponent(source.id)}?tenantId=${encodeURIComponent(tenantId)}`, "DELETE"), "Källan är borttagen.");
  }

  function updateRule(rule: MediaRuleView, active: boolean) {
    const tenantId = activeTenant?.id;
    if (!tenantId) { reportProblem("Välj en arbetsyta först."); return; }
    void runAction(active ? "Aktiverar regel" : "Pausar regel", () => writeEngineEndpoint(`/api/media-engine/rules/${encodeURIComponent(rule.id)}?tenantId=${encodeURIComponent(tenantId)}`, "PATCH", { active }), active ? "Regeln är aktiv igen." : "Regeln är pausad. Inga nya signaler går vidare från den.");
  }

  function saveRuleSettings(rule: MediaRuleView, patch: Record<string, unknown>): Promise<boolean> {
    const tenantId = activeTenant?.id;
    if (!tenantId) { reportProblem("Välj en arbetsyta först."); return Promise.resolve(false); }
    return runAction("Uppdaterar regel", () => writeEngineEndpoint(`/api/media-engine/rules/${encodeURIComponent(rule.id)}?tenantId=${encodeURIComponent(tenantId)}`, "PATCH", patch), "Regelinställningarna är sparade.");
  }

  function deleteRule(rule: MediaRuleView) {
    const tenantId = activeTenant?.id;
    if (!tenantId) { reportProblem("Välj en arbetsyta först."); return; }
    if (!window.confirm(`Ta bort regeln “${rule.name}”? Detta går inte att ångra.`)) return;
    void runAction("Tar bort regel", () => writeEngineEndpoint(`/api/media-engine/rules/${encodeURIComponent(rule.id)}?tenantId=${encodeURIComponent(tenantId)}`, "DELETE"), "Regeln är borttagen.");
  }

  function checkNow() {
    if (checkDisabledReason) { reportProblem(checkDisabledReason); return; }
    const tenantId = activeTenant?.id;
    if (!tenantId) { reportProblem("Välj en arbetsyta först."); return; }
    void runAction("Kontrollerar källor", () => writeEngineEndpoint("/api/media-engine/check", "POST", {
      tenantId,
      idempotencyKey: idempotencyKey(),
      ...(selectedCheckRuleId ? { ruleId: selectedCheckRuleId } : {}),
    }), "Kontrollen är startad. Resultatet visas här när källor och signaler har behandlats.");
  }

  function researchCluster(cluster: MediaClusterView) {
    if (!configurationReady) { reportProblem(missingConfigurationMessage(snapshot)); return; }
    if (!canEdit) { reportProblem("Du har visningsbehörighet i den här arbetsytan."); return; }
    const tenantId = activeTenant?.id;
    if (!tenantId) { reportProblem("Välj en arbetsyta först."); return; }
    void runAction("Läser in underlag", () => writeEngineEndpoint(`/api/media-engine/clusters/${encodeURIComponent(cluster.id)}/research?tenantId=${encodeURIComponent(tenantId)}`, "POST", { tenantId, idempotencyKey: idempotencyKey() }), "Researchen är startad. Reflektionen byggs på det sparade underlaget.");
  }

  function clusterAction(cluster: MediaClusterView, actionName: "dismiss" | "restore") {
    const tenantId = activeTenant?.id;
    if (!canEdit) { reportProblem("Du har visningsbehörighet i den här arbetsytan."); return; }
    if (!tenantId) { reportProblem("Välj en arbetsyta först."); return; }
    void runAction(actionName === "dismiss" ? "Avfärdar signal" : "Återställer signal", () => writeEngineEndpoint(`/api/media-engine/clusters/${encodeURIComponent(cluster.id)}?tenantId=${encodeURIComponent(tenantId)}`, "PATCH", { tenantId, action: actionName }), actionName === "dismiss" ? "Signalen är avfärdad och går inte vidare." : "Signalen är tillbaka i researchkön.");
  }

  function createDraft(handoff: MediaHandoffView) {
    if (!configurationReady) { reportProblem(missingConfigurationMessage(snapshot)); return; }
    if (!canEdit) { reportProblem("Du har visningsbehörighet i den här arbetsytan."); return; }
    const tenantId = activeTenant?.id;
    if (!tenantId) { reportProblem("Välj en arbetsyta först."); return; }
    void runAction("Skapar privat utkast", () => writeEngineEndpoint(`/api/media-engine/handoffs/${encodeURIComponent(handoff.id)}/draft?tenantId=${encodeURIComponent(tenantId)}`, "POST", { tenantId, idempotencyKey: idempotencyKey() }), "Ett privat utkast har skapats i Studio. Det är inte publicerat och behöver fortfarande godkännas.");
  }

  function updateHandoff(handoff: MediaHandoffView, actionName: "reject" | "queue_draft") {
    const tenantId = activeTenant?.id;
    if (!canEdit) { reportProblem("Du har visningsbehörighet i den här arbetsytan."); return; }
    if (!tenantId) { reportProblem("Välj en arbetsyta först."); return; }
    void runAction(actionName === "reject" ? "Avvisar överlämning" : "Lägger i utkastkö", () => writeEngineEndpoint(`/api/media-engine/handoffs/${encodeURIComponent(handoff.id)}?tenantId=${encodeURIComponent(tenantId)}`, "PATCH", { tenantId, action: actionName }), actionName === "reject" ? "Överlämningen är avvisad. Inget innehåll skapas." : "Överlämningen ligger i utkastkön och inväntar ditt val.");
  }

  return (
    <div className={styles.engine}>
      <header className={styles.header}>
        <Link href="/studio" className={styles.brand} aria-label="SAGA, översikt">
          <span className={styles.brandMark} aria-hidden="true"><i /><i /><i /></span>
          <span><strong>SAGA</strong><small>Media Engine</small></span>
        </Link>
        <div className={styles.headerControls}>
          <label className={styles.tenantSelect}>
            <span>Arbetsyta</span>
            <select value={activeTenant?.id ?? ""} onChange={(event) => changeTenant(event.target.value)} disabled={loading || snapshot.tenants.length === 0} aria-label="Välj arbetsyta">
              {!snapshot.tenants.length && <option value="">Ingen arbetsyta</option>}
              {snapshot.tenants.map((tenant) => <option key={tenant.id} value={tenant.id}>{tenant.name}</option>)}
            </select>
          </label>
          {activeTenant && <span className={styles.rolePill} title={`Din behörighet: ${roleLabel(activeTenant.role)}`}>{roleLabel(activeTenant.role)}</span>}
          <span className={`${styles.pipelineState} ${configurationReady ? styles.pipelineReady : styles.pipelineWaiting}`}><i aria-hidden="true" />{configurationReady ? "Motorn är redo" : "Setup krävs"}</span>
          <button type="button" className={styles.iconButton} onClick={() => void load(selectedTenantId)} disabled={loading} aria-label="Uppdatera Media Engine">↻</button>
        </div>
      </header>

      <nav className={styles.subnav} aria-label="Studio">
        <span className={styles.navLabel}>Arbetsyta</span>
        {studioNav.map((item) => <Link href={item.href} key={item.href} className={item.active ? styles.subnavActive : undefined}><span aria-hidden="true">{item.icon}</span>{item.label}</Link>)}
      </nav>

      {notice && <div className={`${styles.notice} ${notice.tone === "error" ? styles.noticeError : notice.tone === "success" ? styles.noticeSuccess : ""}`} role={notice.tone === "error" ? "alert" : "status"} aria-live={notice.tone === "error" ? "assertive" : "polite"}><span>{notice.message}</span><button type="button" onClick={() => setNotice(null)} aria-label="Stäng meddelande">×</button></div>}

      <section className={styles.lead}>
        <div>
          <p className={styles.kicker}>MEDIA ENGINE</p>
          <h1>Gör signaler till innehåll du kan stå för.</h1>
          <p>Flera relevanta omnämnanden startar research. Systemet läser underlaget, visar vad som är säkert och osäkert, skriver en reflektion och lämnar över ett privat utkast till Studio.</p>
        </div>
        <div className={styles.checkCard}>
          <span className={styles.checkIcon} aria-hidden="true">⌁</span>
          <div><strong>Kontrollera nu</strong><small>Hämtar bara från dina aktiva källor.</small></div>
          <select value={selectedCheckRuleId} onChange={(event) => setSelectedCheckRuleId(event.target.value)} disabled={!activeRules.length || action.busy || !canEdit} aria-label="Välj regel för kontrollen">
            <option value="">Alla aktiva regler</option>
            {activeRules.map((rule) => <option key={rule.id} value={rule.id}>{rule.name}</option>)}
          </select>
          <button type="button" className={styles.primaryAction} onClick={checkNow} disabled={Boolean(checkDisabledReason) || action.busy} aria-describedby={checkDisabledReason ? "media-engine-check-status" : undefined} aria-busy={action.label === "Kontrollerar källor"}>{action.label === "Kontrollerar källor" ? "Kontrollerar…" : "Kör kontroll"}</button>
          {checkDisabledReason && <small className={styles.inlineHint} id="media-engine-check-status">{checkDisabledReason}</small>}
        </div>
      </section>

      <Pipeline snapshot={snapshot} selectedCluster={selectedCluster} />

      {loading ? <LoadingState /> : loadError ? <FailureState message={loadError} onRetry={() => void load(selectedTenantId)} /> : (
        <>
          {!activeTenant ? <WorkspaceEmpty onOpen={() => setTenantFormOpen(true)} /> : !snapshot.configuration.ready ? <SetupState snapshot={snapshot} onRefresh={() => void load(selectedTenantId)} /> : null}

          {activeTenant && !canEdit && <section className={styles.readOnlyState} role="status"><span aria-hidden="true">◌</span><div><strong>Du har visningsbehörighet.</strong><p>Du kan följa källor, research och utkast, men en ägare, admin eller redaktör behöver ändra regler eller starta körningar.</p></div></section>}

          {tenantFormOpen && <TenantForm onCancel={() => setTenantFormOpen(false)} onSubmit={createTenant} busy={action.busy || isPending} />}

          <section className={styles.controlGrid} aria-label="Källor och regler">
            <SourcesPanel
              sources={snapshot.sources}
              formOpen={sourceFormOpen}
              onOpenForm={() => setSourceFormOpen((current) => !current)}
              onCancelForm={() => setSourceFormOpen(false)}
              onSubmit={createSource}
              onToggle={updateSource}
              onSave={saveSourceSettings}
              onDelete={deleteSource}
              hasTenant={Boolean(activeTenant)}
              canEdit={canEdit}
              busy={action.busy || isPending}
            />
            <RulesPanel
              rules={snapshot.rules}
              sources={snapshot.sources}
              formOpen={ruleFormOpen}
              onOpenForm={() => setRuleFormOpen((current) => !current)}
              onCancelForm={() => setRuleFormOpen(false)}
              onSubmit={createRule}
              onToggle={updateRule}
              onSave={saveRuleSettings}
              onDelete={deleteRule}
              hasTenant={Boolean(activeTenant)}
              canEdit={canEdit}
              busy={action.busy || isPending}
            />
          </section>

          <section className={styles.researchSection} aria-labelledby="research-heading">
            <div className={styles.sectionHead}>
              <div><p className={styles.kicker}>RESEARCHKÖ</p><h2 id="research-heading">Vad händer inom din domän?</h2><p>En klunga går vidare först när den uppfyller din regel. Den blir aldrig ett publicerat inlägg automatiskt.</p></div>
              <span className={styles.countPill}>{snapshot.clusters.length} signal{snapshot.clusters.length === 1 ? "" : "er"}</span>
            </div>
            <div className={styles.researchLayout}>
              <ClusterList clusters={snapshot.clusters} selectedId={selectedCluster?.id ?? null} onSelect={setSelectedClusterId} />
              <ClusterDetail
                cluster={selectedCluster}
                configurationReady={configurationReady}
                canEdit={canEdit}
                action={action}
                onResearch={researchCluster}
                onClusterAction={clusterAction}
                onCreateDraft={createDraft}
                onHandoffAction={updateHandoff}
              />
            </div>
          </section>

          <section className={styles.bottomGrid}>
            <RunHistory runs={snapshot.runs} />
            <section className={styles.safetyCard}>
              <p className={styles.kicker}>PUBLICERINGSSKYDD</p>
              <h2>Research är inte publicering.</h2>
              <ol>
                <li><span>1</span>Flera oberoende signaler krävs.</li>
                <li><span>2</span>Varje påstående får en källa eller markeras som osäkert.</li>
                <li><span>3</span>Motorn skapar högst ett privat utkast.</li>
                <li><span>4</span>Du granskar, ändrar och väljer tid i Studio.</li>
              </ol>
              <Link href="/studio/calendar" className={styles.textLink}>Öppna publiceringskalendern →</Link>
            </section>
          </section>
        </>
      )}
    </div>
  );
}

function Pipeline({ snapshot, selectedCluster }: { snapshot: MediaEngineSnapshot; selectedCluster: MediaClusterView | null }) {
  const ready = snapshot.configuration.ready;
  const stages = [
    { number: "01", label: "Källor", detail: `${snapshot.sources.filter((item) => item.active).length} aktiva`, state: snapshot.sources.some((item) => item.active) ? "done" : "waiting" },
    { number: "02", label: "Regel", detail: `${snapshot.rules.filter((item) => item.active).length} aktiva`, state: snapshot.rules.some((item) => item.active) ? "done" : "waiting" },
    { number: "03", label: "Signal", detail: selectedCluster ? `${selectedCluster.mentionCount} omnämnanden` : "Väntar", state: selectedCluster ? "done" : "waiting" },
    { number: "04", label: "Research", detail: selectedCluster?.dossier ? "Underlag klart" : selectedCluster?.status === "researching" ? "Läser in" : "När tröskeln nås", state: selectedCluster?.dossier ? "done" : selectedCluster?.status === "researching" ? "active" : "waiting" },
    { number: "05", label: "Reflektion", detail: selectedCluster?.dossier?.reflection ? "Transparent" : "Efter research", state: selectedCluster?.dossier?.reflection ? "done" : "waiting" },
    { number: "06", label: "Utkast", detail: selectedCluster?.handoff?.contentDraftId ? "Privat utkast" : "Ditt godkännande", state: selectedCluster?.handoff?.contentDraftId ? "done" : "waiting" },
  ] as const;
  return <section className={styles.pipeline} aria-label="Så arbetar Media Engine">
    <div className={styles.pipelineTop}><span><i className={ready ? styles.liveDot : styles.waitDot} />{ready ? "Arbetar med dina regler" : "Inväntar konfiguration"}</span><small>Ingen automatisk publicering</small></div>
    <div className={styles.pipelineSteps}>{stages.map((stage, index) => <div key={stage.number} className={`${styles.pipelineStep} ${stage.state === "done" ? styles.stepDone : stage.state === "active" ? styles.stepActive : ""}`}><span className={styles.stepNumber}>{stage.number}</span><div><strong>{stage.label}</strong><small>{stage.detail}</small></div>{index < stages.length - 1 && <i className={styles.pipelineLine} aria-hidden="true" />}</div>)}</div>
  </section>;
}

function SourcesPanel({ sources, formOpen, onOpenForm, onCancelForm, onSubmit, onToggle, onSave, onDelete, hasTenant, canEdit, busy }: {
  sources: MediaSourceView[]; formOpen: boolean; onOpenForm: () => void; onCancelForm: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void; onToggle: (source: MediaSourceView, active: boolean) => void; onSave: (source: MediaSourceView, patch: Record<string, unknown>) => Promise<boolean>; onDelete: (source: MediaSourceView) => void; hasTenant: boolean; canEdit: boolean; busy: boolean;
}) {
  const [editing, setEditing] = useState<MediaSourceView | null>(null);
  return <section className={styles.panel} id="sources">
    <header className={styles.panelHead}><div><p className={styles.kicker}>01 · KÄLLOR</p><h2>Vad ska motorn läsa?</h2><p>Välj de platser som får starta en signal. Källor är avgränsade till den här arbetsytan.</p></div><button type="button" className={styles.secondaryAction} onClick={onOpenForm} disabled={!hasTenant || !canEdit || busy} aria-expanded={formOpen} aria-controls="media-engine-source-form">{formOpen ? "Stäng" : "＋ Lägg till"}</button></header>
    {formOpen && <SourceForm onCancel={onCancelForm} onSubmit={onSubmit} busy={busy} />}
    {!sources.length ? <EmptyPanel icon="◎" title="Inga källor ännu." detail="Lägg till RSS, offentliga API:er eller webbsökning. Utan källor kan motorn inte hitta en signal." action="Lägg till första källan" onAction={onOpenForm} disabled={!hasTenant || !canEdit || busy} /> : <ul className={styles.sourceList}>{sources.map((source) => <li key={source.id}><div className={styles.sourceIcon} aria-hidden="true">{source.kind === "rss" ? "◔" : source.kind === "api" || source.kind === "web_search" ? "⌁" : "◌"}</div><div className={styles.sourceCopy}><strong>{source.displayName}</strong><small>{source.baseUrl ? shortDomain(source.baseUrl) : source.provider} · {source.lastSyncedAt ? `senast läst ${formatWhen(source.lastSyncedAt)}` : "inte kontrollerad ännu"}</small>{source.lastError && <span className={styles.errorText}>{source.lastError}</span>}</div><span className={`${styles.statusPill} ${source.status === "active" ? styles.statusActive : source.status === "error" ? styles.statusError : ""}`}>{source.status === "active" ? "Aktiv" : source.status === "error" ? "Fel" : "Pausad"}</span><div className={styles.rowActions}><button type="button" onClick={() => setEditing(source)} disabled={!canEdit || busy}>Ändra</button><button type="button" onClick={() => onToggle(source, !source.active)} disabled={!canEdit || busy}>{source.active ? "Pausa" : "Aktivera"}</button><button type="button" onClick={() => onDelete(source)} disabled={!canEdit || busy} aria-label={`Ta bort ${source.displayName}`}>×</button></div></li>)}</ul>}
    {editing && <SourceSettingsForm source={editing} busy={busy} onCancel={() => setEditing(null)} onSave={onSave} />}
  </section>;
}

function SourceForm({ onCancel, onSubmit, busy }: { onCancel: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void; busy: boolean }) {
  const [kind, setKind] = useState<(typeof sourceKinds)[number]["value"]>("rss");
  const needsUrl = kind !== "web_search";
  const urlHint = kind === "rss" ? "RSS- eller Atom-feed krävs" : kind === "api" ? "Publik endpoint krävs" : "Använder inbyggd webbsökning";
  return <form className={styles.inlineForm} id="media-engine-source-form" onSubmit={onSubmit}>
    <div className={styles.formHeader}><strong>Ny källa</strong><small>V1 läser bara publika källor. Tokens och lösenord stöds inte här.</small></div>
    <div className={styles.fieldGrid}><label><span>Namn</span><input required name="displayName" placeholder="Exempel: EU-kommissionens pressrum" /></label><label><span>Typ</span><select name="kind" value={kind} onChange={(event) => setKind(event.target.value as (typeof sourceKinds)[number]["value"])}>{sourceKinds.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}</select></label></div>
    <div className={styles.fieldGrid}><label><span>Leverantör</span><input required name="provider" placeholder={kind === "rss" ? "Exempel: RSS" : kind === "api" ? "Exempel: News API" : "Exempel: OpenAI webbsökning"} /></label><label><span>URL <em>{urlHint}</em></span><input type="url" required={needsUrl} name="baseUrl" placeholder={needsUrl ? "https://…" : "Valfritt"} /></label></div>
    <label><span>Avgränsning <em>valfritt</em></span><input name="scope" placeholder="Exempel: ai, regulation, nordics" /><small className={styles.fieldNote}>Regelns schema styr när källor kontrolleras i V1.</small></label>
    <div className={styles.formActions}><button type="button" onClick={onCancel}>Avbryt</button><button type="submit" className={styles.primaryAction} disabled={busy}>{busy ? "Sparar…" : "Spara källa"}</button></div>
  </form>;
}

function SourceSettingsForm({ source, busy, onCancel, onSave }: { source: MediaSourceView; busy: boolean; onCancel: () => void; onSave: (source: MediaSourceView, patch: Record<string, unknown>) => Promise<boolean> }) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void onSave(source, {
      kind: text(form, "kind"),
      provider: text(form, "provider"),
      displayName: text(form, "displayName"),
      baseUrl: text(form, "baseUrl") || null,
      configPublic: { ...source.configPublic, scope: text(form, "scope") || "domain" },
    }).then((saved) => {
      if (saved) onCancel();
    });
  }
  return <form className={`${styles.inlineForm} ${styles.settingsForm}`} onSubmit={submit}>
    <div className={styles.formHeader}><strong>Ändra källa: {source.displayName}</strong><small>Ändringarna används vid nästa kontroll.</small></div>
    <div className={styles.fieldGrid}><label><span>Namn</span><input required name="displayName" defaultValue={source.displayName} /></label><label><span>Typ</span><select name="kind" defaultValue={source.kind}>{sourceKinds.map((kind) => <option value={kind.value} key={kind.value}>{kind.label}</option>)}</select></label></div>
    <div className={styles.fieldGrid}><label><span>Leverantör</span><input required name="provider" defaultValue={source.provider} /></label><label><span>URL</span><input type="url" name="baseUrl" defaultValue={source.baseUrl ?? ""} /></label></div>
    <label><span>Avgränsning</span><input name="scope" defaultValue={typeof source.configPublic.scope === "string" ? source.configPublic.scope : ""} /><small className={styles.fieldNote}>Regelns schema styr nästa kontroll i V1.</small></label>
    <div className={styles.formActions}><button type="button" onClick={onCancel}>Avbryt</button><button type="submit" className={styles.primaryAction} disabled={busy}>{busy ? "Sparar…" : "Spara ändringar"}</button></div>
  </form>;
}

function RulesPanel({ rules, sources, formOpen, onOpenForm, onCancelForm, onSubmit, onToggle, onSave, onDelete, hasTenant, canEdit, busy }: {
  rules: MediaRuleView[]; sources: MediaSourceView[]; formOpen: boolean; onOpenForm: () => void; onCancelForm: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void; onToggle: (rule: MediaRuleView, active: boolean) => void; onSave: (rule: MediaRuleView, patch: Record<string, unknown>) => Promise<boolean>; onDelete: (rule: MediaRuleView) => void; hasTenant: boolean; canEdit: boolean; busy: boolean;
}) {
  const [contentType, setContentType] = useState("social_post");
  const [scheduleMode, setScheduleMode] = useState<"threshold" | "cron">("threshold");
  const [cadence, setCadence] = useState("hourly");
  const [editing, setEditing] = useState<MediaRuleView | null>(null);
  return <section className={styles.panel} id="rules">
    <header className={styles.panelHead}><div><p className={styles.kicker}>02 · TRIGGERS</p><h2>När blir något värt att läsa?</h2><p>Regeln kräver både volym och oberoende källor. Det stoppar repetitivt brus.</p></div><button type="button" className={styles.secondaryAction} onClick={onOpenForm} disabled={!hasTenant || !canEdit || busy} aria-expanded={formOpen} aria-controls="media-engine-rule-form">{formOpen ? "Stäng" : "＋ Ny regel"}</button></header>
    {formOpen && <form className={styles.inlineForm} id="media-engine-rule-form" onSubmit={onSubmit}>
      <div className={styles.formHeader}><strong>Ny signalregel</strong><small>Den skapar research, aldrig publicering.</small></div>
      <label><span>Namn</span><input required name="name" placeholder="Exempel: AI-reglering i EU" /></label>
      <label><span>Vad letar du efter?</span><input required name="query" placeholder="EU AI Act OR generativ AI OR model providers" /></label>
      <div className={styles.fieldGrid}><label><span>Minsta omnämnanden</span><select name="minMentions" defaultValue="3"><option value="2">2</option><option value="3">3</option><option value="5">5</option><option value="8">8</option></select></label><label><span>Oberoende domäner</span><select name="minUniqueDomains" defaultValue="2"><option value="1">1</option><option value="2">2</option><option value="3">3</option><option value="5">5</option></select></label></div>
      <div className={styles.fieldGrid}><label><span>Tidsfönster</span><select name="windowHours" defaultValue="24"><option value="6">6 timmar</option><option value="24">24 timmar</option><option value="72">3 dagar</option><option value="168">7 dagar</option></select></label><label><span>Innehållsformat</span><select name="contentType" value={contentType} onChange={(event) => setContentType(event.target.value)}>{contentOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label></div>
      <label><span>Begränsa till domäner <em>valfritt, separera med komma</em></span><input name="domains" placeholder="ec.europa.eu, reuters.com" /></label>
      <label><span>Uteslut domäner <em>valfritt, separera med komma</em></span><input name="excludeDomains" placeholder="exempel.se, duplicerad-källa.com" /></label>
      {sources.length ? <fieldset className={styles.choiceSet}><legend>Vilka källor gäller regeln?</legend><div>{sources.map((source) => <label key={source.id}><input type="checkbox" name="sourceIds" value={source.id} defaultChecked={source.active} /><span>{source.displayName}</span><small>{source.active ? "Aktiv" : "Pausad"}</small></label>)}</div><p>Om ingen källa väljs använder motorn arbetsytans aktiva källor.</p></fieldset> : <p className={styles.formHint}>Lägg gärna till minst en källa först. Regeln sparas, men hittar inget förrän en källa är aktiv.</p>}
      <div className={styles.fieldGrid}><label><span>Textstruktur</span><select name="frameworkKey">{frameworks.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label><label><span>Bildriktning</span><select name="imageStyle">{imageDirections.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label></div>
      {contentType === "newsletter" ? <p className={styles.formHint}>Nyhetsbrev går bara till nyhetsbrevskanalen. Det väljs automatiskt.</p> : <fieldset className={styles.choiceSet}><legend>Vart ska utkastet kunna gå?</legend><div><label><input type="checkbox" name="channels" value="linkedin" defaultChecked /><span>LinkedIn</span><small>Standard</small></label><label><input type="checkbox" name="channels" value="instagram" /><span>Instagram</span></label><label><input type="checkbox" name="channels" value="facebook_page" /><span>Facebook</span></label></div></fieldset>}
      <div className={styles.fieldGrid}><label><span>Starta research när</span><select name="scheduleMode" value={scheduleMode} onChange={(event) => { const next = event.target.value === "cron" ? "cron" : "threshold"; setScheduleMode(next); setCadence(next === "cron" ? "cron" : cadence === "cron" ? "hourly" : cadence); }}><option value="threshold">Tröskeln nås</option><option value="cron">Fast cron-tid</option></select></label><label><span>Kontrollfrekvens</span><select name="cadence" value={cadence} onChange={(event) => setCadence(event.target.value)} disabled={scheduleMode === "cron"}>{scheduleMode === "cron" ? <option value="cron">Enligt cron</option> : <><option value="continuous">Direkt vid ny signal</option><option value="hourly">Varje timme</option><option value="daily">En gång per dag</option><option value="weekly">En gång per vecka</option></>}</select></label></div>
      {scheduleMode === "cron" && <label><span>Cron-uttryck</span><input required name="cronExpression" placeholder="0 8 * * 1-5" /><small className={styles.fieldNote}>Exempel: 08.00 måndag–fredag. Cron kör kontrollen; den publicerar aldrig.</small></label>}
      <label><span>Redaktionell instruktion <em>valfritt</em></span><textarea name="prompt" rows={3} placeholder="Skriv rakt. Säg vad som är känt, vad som saknas och vad det betyder." /></label>
      <label className={styles.checkToggle}><input defaultChecked type="checkbox" name="approvalRequired" /><span><strong>Kräv mitt godkännande</strong><small>Alla utkast stannar i Studio tills du väljer nästa steg.</small></span></label>
      <label className={styles.checkToggle}><input defaultChecked type="checkbox" name="autoCreateHandoff" /><span><strong>Skapa innehållshandoff när researchen är klar</strong><small>Det gör aldrig en publicering. Det förbereder bara ett privat utkast.</small></span></label>
      <div className={styles.formActions}><button type="button" onClick={onCancelForm}>Avbryt</button><button type="submit" className={styles.primaryAction} disabled={busy}>{busy ? "Sparar…" : "Aktivera regel"}</button></div>
    </form>}
    {!rules.length ? <EmptyPanel icon="↗" title="Ingen signalregel ännu." detail="Beskriv ämnet, välj tröskel och bestäm hur ett framtida utkast ska byggas." action="Skapa första regel" onAction={onOpenForm} disabled={!hasTenant || !canEdit || busy} /> : <ul className={styles.ruleList}>{rules.map((rule) => <li key={rule.id}><div className={styles.ruleTop}><span className={rule.active ? styles.ruleLive : styles.rulePaused} aria-hidden="true" /><div><strong>{rule.name}</strong><small>{rule.minMentions} omnämnanden · {rule.minUniqueDomains} domäner · {formatWindow(rule.windowHours)}</small></div><span className={`${styles.statusPill} ${rule.active ? styles.statusActive : ""}`}>{rule.active ? "Aktiv" : "Pausad"}</span></div><p>{rule.query || "Ingen sökfråga angiven."}</p><div className={styles.ruleFoot}><span>{rule.scheduleMode === "cron" ? "Cron" : `Tröskel · ${cadenceLabel(rule.cadence)}`} · {channelSummary(rule.channels)} · {frameworkLabel(rule.frameworkKey)}</span><div><button type="button" onClick={() => setEditing(rule)} disabled={!canEdit || busy}>Ändra</button><button type="button" onClick={() => onToggle(rule, !rule.active)} disabled={!canEdit || busy}>{rule.active ? "Pausa" : "Aktivera"}</button><button type="button" onClick={() => onDelete(rule)} disabled={!canEdit || busy}>Ta bort</button></div></div></li>)}</ul>}
    {editing && <RuleSettingsForm key={editing.id} rule={editing} sources={sources} busy={busy} onCancel={() => setEditing(null)} onSave={onSave} />}
  </section>;
}

function RuleSettingsForm({ rule, sources, busy, onCancel, onSave }: {
  rule: MediaRuleView;
  sources: MediaSourceView[];
  busy: boolean;
  onCancel: () => void;
  onSave: (rule: MediaRuleView, patch: Record<string, unknown>) => Promise<boolean>;
}) {
  const [contentType, setContentType] = useState(rule.contentType === "newsletter" ? "newsletter" : rule.contentType === "article" ? "article" : "social_post");
  const [scheduleMode, setScheduleMode] = useState<"threshold" | "cron">(rule.scheduleMode === "cron" ? "cron" : "threshold");
  const [cadence, setCadence] = useState(rule.scheduleMode === "cron" || rule.cadence === "cron" ? "cron" : rule.cadence || "hourly");
  const [formError, setFormError] = useState<string | null>(null);

  function changeScheduleMode(value: string) {
    const next = value === "cron" ? "cron" : "threshold";
    setScheduleMode(next);
    setCadence(next === "cron" ? "cron" : cadence === "cron" ? "hourly" : cadence);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const selectedChannels = form.getAll("channels").map((value) => String(value)).filter(Boolean);
    const channels = contentType === "newsletter" ? ["newsletter"] : selectedChannels.filter((channel) => channel !== "newsletter");
    if (!channels.length) {
      setFormError("Välj minst en kanal för utkastet.");
      return;
    }
    setFormError(null);
    void onSave(rule, {
      name: text(form, "name"),
      query: text(form, "query"),
      includeDomains: commaSeparatedValues(text(form, "domains")),
      excludeDomains: commaSeparatedValues(text(form, "excludeDomains")),
      sourceIds: form.getAll("sourceIds").map((value) => String(value)).filter(Boolean),
      minMentions: numberFromForm(form, "minMentions", rule.minMentions),
      minUniqueDomains: numberFromForm(form, "minUniqueDomains", rule.minUniqueDomains),
      windowHours: numberFromForm(form, "windowHours", rule.windowHours),
      contentType,
      channels,
      frameworkKey: text(form, "frameworkKey"),
      imageStyle: text(form, "imageStyle"),
      prompt: text(form, "prompt"),
      scheduleMode,
      cadence: scheduleMode === "cron" ? "cron" : cadence === "cron" ? "hourly" : cadence,
      cronExpression: scheduleMode === "cron" ? text(form, "cronExpression") || null : null,
      approvalRequired: form.get("approvalRequired") === "on",
      autoCreateHandoff: form.get("autoCreateHandoff") === "on",
    }).then((saved) => {
      if (saved) onCancel();
    });
  }

  return <form className={`${styles.inlineForm} ${styles.settingsForm}`} onSubmit={submit}>
    <div className={styles.formHeader}><strong>Ändra regel: {rule.name}</strong><small>Du styr hela nästa researchflöde här. Publicering sker aldrig från denna panel.</small></div>
    <div className={styles.fieldGrid}><label><span>Namn</span><input required name="name" defaultValue={rule.name} /></label><label><span>Innehållsformat</span><select name="contentType" value={contentType} onChange={(event) => setContentType(event.target.value)}>{contentOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label></div>
    <label><span>Vad letar du efter?</span><input required name="query" defaultValue={rule.query} /></label>
    <div className={styles.fieldGrid}><label><span>Begränsa till domäner</span><input name="domains" defaultValue={rule.domains.join(", ")} placeholder="ec.europa.eu, reuters.com" /></label><label><span>Uteslut domäner</span><input name="excludeDomains" defaultValue={rule.excludeDomains.join(", ")} placeholder="exempel.se" /></label></div>
    <div className={styles.fieldGrid}><label><span>Minsta omnämnanden</span><input required min="1" max="100" type="number" name="minMentions" defaultValue={rule.minMentions} /></label><label><span>Oberoende domäner</span><input required min="1" max="50" type="number" name="minUniqueDomains" defaultValue={rule.minUniqueDomains} /></label></div>
    <label><span>Tidsfönster <em>timmar</em></span><input required min="1" max="8760" type="number" name="windowHours" defaultValue={rule.windowHours} /></label>
    {sources.length ? <fieldset className={styles.choiceSet}><legend>Vilka källor gäller regeln?</legend><div>{sources.map((source) => <label key={source.id}><input type="checkbox" name="sourceIds" value={source.id} defaultChecked={rule.sourceIds.includes(source.id)} /><span>{source.displayName}</span><small>{source.active ? "Aktiv" : "Pausad"}</small></label>)}</div><p>Tomt val betyder arbetsytans aktiva källor.</p></fieldset> : <p className={styles.formHint}>Regeln kan sparas, men behöver minst en aktiv källa för att kunna hitta signaler.</p>}
    <div className={styles.fieldGrid}><label><span>Textstruktur</span><select name="frameworkKey" defaultValue={rule.frameworkKey}>{!frameworks.some((item) => item.value === rule.frameworkKey) && <option value={rule.frameworkKey}>{rule.frameworkKey}</option>}{frameworks.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label><label><span>Bildriktning</span><select name="imageStyle" defaultValue={rule.imageStyle}>{!imageDirections.some((item) => item.value === rule.imageStyle) && <option value={rule.imageStyle}>{rule.imageStyle}</option>}{imageDirections.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label></div>
    {contentType === "newsletter" ? <p className={styles.formHint}>Nyhetsbrev går bara till nyhetsbrevskanalen. Det väljs automatiskt.</p> : <fieldset className={styles.choiceSet}><legend>Vart ska utkastet kunna gå?</legend><div><label><input type="checkbox" name="channels" value="linkedin" defaultChecked={rule.channels.includes("linkedin")} /><span>LinkedIn</span></label><label><input type="checkbox" name="channels" value="instagram" defaultChecked={rule.channels.includes("instagram")} /><span>Instagram</span></label><label><input type="checkbox" name="channels" value="facebook_page" defaultChecked={rule.channels.includes("facebook_page")} /><span>Facebook</span></label></div></fieldset>}
    <div className={styles.fieldGrid}><label><span>Starta research när</span><select name="scheduleMode" value={scheduleMode} onChange={(event) => changeScheduleMode(event.target.value)}><option value="threshold">Tröskeln nås</option><option value="cron">Fast cron-tid</option></select></label><label><span>Kontrollfrekvens</span><select name="cadence" value={cadence} onChange={(event) => setCadence(event.target.value)} disabled={scheduleMode === "cron"}>{scheduleMode === "cron" ? <option value="cron">Enligt cron</option> : <><option value="continuous">Direkt vid ny signal</option><option value="hourly">Varje timme</option><option value="daily">En gång per dag</option><option value="weekly">En gång per vecka</option></>}</select></label></div>
    {scheduleMode === "cron" && <label><span>Cron-uttryck</span><input required name="cronExpression" defaultValue={rule.cronExpression ?? ""} placeholder="0 8 * * 1-5" /><small className={styles.fieldNote}>Exempel: 08.00 måndag–fredag. Det kör en kontroll, aldrig en publicering.</small></label>}
    <label><span>Redaktionell instruktion <em>valfritt</em></span><textarea name="prompt" rows={3} defaultValue={rule.prompt} /></label>
    <label className={styles.checkToggle}><input defaultChecked={rule.approvalRequired} type="checkbox" name="approvalRequired" /><span><strong>Kräv mitt godkännande</strong><small>Utkast stannar i Studio tills du går vidare.</small></span></label>
    <label className={styles.checkToggle}><input defaultChecked={rule.autoCreateHandoff} type="checkbox" name="autoCreateHandoff" /><span><strong>Skapa innehållshandoff när researchen är klar</strong><small>Det förbereder ett privat utkast — aldrig en publicering.</small></span></label>
    {formError && <p className={styles.formError} role="alert">{formError}</p>}
    <div className={styles.formActions}><button type="button" onClick={onCancel}>Avbryt</button><button type="submit" className={styles.primaryAction} disabled={busy}>{busy ? "Sparar…" : "Spara ändringar"}</button></div>
  </form>;
}

function ClusterList({ clusters, selectedId, onSelect }: { clusters: MediaClusterView[]; selectedId: string | null; onSelect: (id: string) => void }) {
  if (!clusters.length) return <div className={styles.clusterEmpty}><span aria-hidden="true">⌁</span><strong>Ingen signal har passerat tröskeln.</strong><p>När flera relevanta källor beskriver samma sak hamnar ämnet här för kontroll.</p></div>;
  return <aside className={styles.clusterList} aria-label="Signaler i researchkön">{clusters.map((cluster) => <button type="button" key={cluster.id} className={selectedId === cluster.id ? styles.clusterSelected : undefined} onClick={() => onSelect(cluster.id)}><span className={clusterStatusClass(cluster.status)} aria-hidden="true" /><div><strong>{cluster.title}</strong><small>{cluster.mentionCount} omnämnanden · {cluster.uniqueDomainCount} domäner</small><p>{cluster.summary || "Samlar källor och bedömer om ämnet förtjänar research."}</p></div><i>›</i></button>)}</aside>;
}

function ClusterDetail({ cluster, configurationReady, canEdit, action, onResearch, onClusterAction, onCreateDraft, onHandoffAction }: {
  cluster: MediaClusterView | null; configurationReady: boolean; canEdit: boolean; action: ActionState; onResearch: (cluster: MediaClusterView) => void; onClusterAction: (cluster: MediaClusterView, action: "dismiss" | "restore") => void; onCreateDraft: (handoff: MediaHandoffView) => void; onHandoffAction: (handoff: MediaHandoffView, action: "reject" | "queue_draft") => void;
}) {
  if (!cluster) return <article className={styles.clusterDetailEmpty}><span aria-hidden="true">◎</span><h3>Här visas researchen när en regel slår till.</h3><p>Välj en signal till vänster för att läsa bevis, osäkerheter, reflektion och exakt vilket utkast som skulle skapas.</p></article>;
  const dossier = cluster.dossier;
  const handoff = cluster.handoff;
  const researching = cluster.status === "researching";
  const canResearch = configurationReady && canEdit && cluster.status !== "dismissed" && !researching;
  return <article className={styles.clusterDetail}>
    <header className={styles.detailHead}><div><div className={styles.detailEyebrow}><span className={clusterStatusClass(cluster.status)} />{clusterStatusLabel(cluster.status)}</div><h3>{cluster.title}</h3><p>{cluster.summary || "Ämnet väntar på ett kontrollerat underlag."}</p></div><div className={styles.detailActions}>{cluster.status === "dismissed" ? <button type="button" className={styles.secondaryAction} onClick={() => onClusterAction(cluster, "restore")} disabled={!canEdit || action.busy}>Återställ</button> : <><button type="button" className={styles.secondaryAction} onClick={() => onClusterAction(cluster, "dismiss")} disabled={!canEdit || action.busy}>Avfärda</button><button type="button" className={styles.primaryAction} onClick={() => onResearch(cluster)} disabled={!canResearch || action.busy} aria-busy={researching || action.label === "Läser in underlag"}>{researching || action.label === "Läser in underlag" ? "Läser…" : dossier ? "Uppdatera research" : "Läs in allt"}</button></>}</div></header>

    <section className={styles.signalFacts} aria-label="Signalens omfattning"><div><small>OMNÄMNANDEN</small><strong>{cluster.mentionCount}</strong></div><div><small>OBEROENDE DOMÄNER</small><strong>{cluster.uniqueDomainCount}</strong></div><div><small>SENAST SEDD</small><strong>{cluster.lastSeenAt ? formatWhen(cluster.lastSeenAt) : "Nu"}</strong></div></section>

    <section className={styles.evidenceSection}><div className={styles.subsectionHead}><div><p className={styles.kicker}>KÄLLKEDJA</p><h4>Vad stöder detta?</h4></div><small>{dossier?.evidence.length ?? 0} verifierbara källor</small></div>{dossier?.evidence.length ? <EvidenceList evidence={dossier.evidence} /> : <p className={styles.awaiting}>Källor och påståenden visas här efter att researchen har körts. Inga slutsatser visas utan underlag.</p>}</section>

    {dossier ? <Dossier dossier={dossier} clusterReflection={cluster.reflection} /> : <section className={styles.waitingResearch}><span aria-hidden="true">⌁</span><div><strong>{researching ? "Research pågår." : "Ingen reflektion ännu."}</strong><p>{researching ? "Motorn samlar bevis och markerar motsägelser innan den skriver." : "Kör research när signalen är tillräckligt tydlig. Då ser du både vad som är känt och vad som inte går att säga ännu."}</p></div></section>}

    <HandoffPanel handoff={handoff} dossierReady={dossier?.status === "ready"} canEdit={canEdit} action={action} onCreateDraft={onCreateDraft} onHandoffAction={onHandoffAction} />
  </article>;
}

function EvidenceList({ evidence }: { evidence: MediaEvidenceView[] }) {
  return <ul className={styles.evidenceList}>{evidence.map((item) => <li key={item.id}><span className={item.sourceType === "primary" ? styles.primarySource : styles.secondarySource}>{item.sourceType === "primary" ? "Primär" : "Sekundär"}</span><div><a href={item.url} target="_blank" rel="noreferrer"><strong>{item.sourceName}</strong><small>{item.domain} · {item.eventDate ? `händelse ${formatWhen(item.eventDate)}` : item.publishedAt ? `publicerad ${formatWhen(item.publishedAt)}` : "datum ej angivet"}</small></a>{item.supportsClaim && <p>{item.supportsClaim}</p>}</div><span className={styles.externalArrow} aria-hidden="true">↗</span></li>)}</ul>;
}

function Dossier({ dossier, clusterReflection }: { dossier: NonNullable<MediaClusterView["dossier"]>; clusterReflection: string }) {
  const reflection = dossier.reflection || clusterReflection;
  return <section className={styles.dossier}>
    <div className={styles.subsectionHead}><div><p className={styles.kicker}>TRANSPARENT REFLEKTION</p><h4>Det vi kan säga — och inte säga.</h4></div><span className={`${styles.statusPill} ${dossier.status === "ready" ? styles.statusActive : dossier.status === "failed" ? styles.statusError : ""}`}>{dossier.status === "ready" ? "Klar" : dossier.status === "failed" ? "Fel" : "Utkast"}</span></div>
    <div className={styles.knowledgeGrid}><InsightCard tone="known" label="Det här vet vi" text={dossier.whatWeKnow} fallback="Inget verifierat påstående har sammanställts ännu." /><InsightCard tone="unknown" label="Det här vet vi inte" text={dossier.whatWeDontKnow} fallback="Osäkerheter och luckor markeras här i stället för att fyllas med antaganden." /><InsightCard tone="impact" label="Varför spelar det roll?" text={dossier.whyItMatters} fallback="Praktisk påverkan visas när researchen är klar." /></div>
    <div className={styles.reflection}><span aria-hidden="true">✦</span><div><strong>Reflektion</strong><p>{reflection || "Reflektionen kommer från underlaget ovan. Den är skild från källornas sakpåståenden."}</p></div></div>
    {(dossier.uncertainties.length > 0 || dossier.conflicts.length > 0) && <div className={styles.openQuestions}>
      {dossier.uncertainties.length > 0 && <div><strong>Öppna frågor</strong><ul>{dossier.uncertainties.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul></div>}
      {dossier.conflicts.length > 0 && <div className={styles.conflicts}><strong>Motsägelser i underlaget</strong><ul>{dossier.conflicts.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul></div>}
    </div>}
    <div className={styles.angle}><span>FÖRESLAGEN VINKEL</span><p>{dossier.suggestedAngle || "Ingen vinkel har valts ännu."}</p></div>
  </section>;
}

function InsightCard({ tone, label, text, fallback }: { tone: "known" | "unknown" | "impact"; label: string; text: string; fallback: string }) {
  return <article className={`${styles.insightCard} ${styles[`insight${tone[0].toUpperCase()}${tone.slice(1)}`]}`}><span>{tone === "known" ? "✓" : tone === "unknown" ? "?" : "→"}</span><strong>{label}</strong><p>{text || fallback}</p></article>;
}

function HandoffPanel({ handoff, dossierReady, canEdit, action, onCreateDraft, onHandoffAction }: { handoff: MediaHandoffView | null; dossierReady: boolean; canEdit: boolean; action: ActionState; onCreateDraft: (handoff: MediaHandoffView) => void; onHandoffAction: (handoff: MediaHandoffView, action: "reject" | "queue_draft") => void }) {
  if (!handoff) return <section className={styles.handoffEmpty}><span aria-hidden="true">▧</span><div><p className={styles.kicker}>CONTENT HANDOFF</p><h4>{dossierReady ? "Researchen väntar på ett innehållsramverk." : "Inget utkast kan skapas ännu."}</h4><p>{dossierReady ? "När servern har skapat överlämningen visas format, textstruktur och bildriktning här." : "Motorn behöver först ett klart, verifierbart researchunderlag."}</p></div></section>;
  const created = Boolean(handoff.contentDraftId);
  const isRejected = handoff.status === "rejected";
  const canRestore = isRejected && !created;
  const canReject = !isRejected && !created && handoff.status !== "published";
  return <section className={styles.handoff}>
    <div className={styles.handoffTop}><div><p className={styles.kicker}>CONTENT HANDOFF</p><h4>Från research till privat utkast.</h4><p>Systemet använder ramen nedan, men lämnar alltid godkännande och publicering till dig.</p></div><span className={handoffStatusClass(handoff.status)}>{handoffStatusLabel(handoff.status)}</span></div>
    <div className={styles.handoffGrid}><div><small>FORMAT</small><strong>{contentLabel(handoff.contentType)}</strong></div><div><small>TEXTSTRUKTUR</small><strong>{frameworkLabel(handoff.frameworkKey)}</strong></div><div className={styles.visualBrief}><small>BILDRIKTNING</small><span className={styles.visualFrame} aria-hidden="true"><i /><i /><i /></span><strong>{imageLabel(handoff.imageStyle)}</strong></div><div><small>PUBLICERING</small><strong>{handoff.approvalRequired ? "Godkännande krävs" : "Kontrolleras i Studio"}</strong></div></div>
    <div className={styles.handoffActions}>{created && handoff.contentDraftId ? <Link className={styles.primaryAction} href={`/studio/content/${encodeURIComponent(handoff.contentDraftId)}`}>Öppna privat utkast →</Link> : <button type="button" className={styles.primaryAction} onClick={() => onCreateDraft(handoff)} disabled={!dossierReady || !canEdit || action.busy || isRejected} aria-busy={action.label === "Skapar privat utkast"}>{action.label === "Skapar privat utkast" ? "Skapar…" : "Skapa privat utkast"}</button>}{canRestore && <button type="button" className={styles.secondaryAction} onClick={() => onHandoffAction(handoff, "queue_draft")} disabled={!canEdit || action.busy}>Återställ till utkastkö</button>}{canReject && <button type="button" className={styles.quietDanger} onClick={() => onHandoffAction(handoff, "reject")} disabled={!canEdit || action.busy}>Avvisa</button>}</div><small className={styles.handoffSafety}>{isRejected ? "Den här överlämningen är avvisad. Återställ den till utkastkön om researchen fortfarande ska användas." : "Utkastet publiceras aldrig automatiskt. Du ändrar text, bild och tid i Studio innan något går ut."}</small>
  </section>;
}

function RunHistory({ runs }: { runs: MediaRunView[] }) {
  return <section className={styles.runHistory}><div className={styles.sectionHead}><div><p className={styles.kicker}>KÖRHISTORIK</p><h2>Motorns senaste arbete.</h2></div><small>{runs.length ? "Senaste 20 körningar" : "Inget att visa ännu"}</small></div>{runs.length ? <ul>{runs.slice(0, 6).map((run) => <li key={run.id}><span className={runStatusClass(run.status)} aria-hidden="true" /><div><strong>{run.status === "completed" ? "Kontroll klar" : run.status === "failed" ? "Kontroll misslyckades" : run.status === "running" ? "Kontrollerar källor" : "Kontroll köad"}</strong><small>{run.startedAt ? formatWhen(run.startedAt) : "Tid saknas"}{run.clusterCount !== null ? ` · ${run.clusterCount} signaler` : ""}{run.sourceCount !== null ? ` · ${run.sourceCount} källor` : ""}</small>{run.error && <p>{run.error}</p>}</div></li>)}</ul> : <p className={styles.runEmpty}>När en kontroll har körts syns resultat och eventuella fel här.</p>}</section>;
}

function WorkspaceEmpty({ onOpen }: { onOpen: () => void }) {
  return <section className={styles.workspaceEmpty}><div><span aria-hidden="true">▦</span><p className={styles.kicker}>FÖRSTA STEGET</p><h2>Skapa en arbetsyta för din mediamotor.</h2><p>Varje kund, varumärke eller team får egna källor, regler, research och publiceringsflöden. Inget blandas mellan arbetsytor.</p><button type="button" className={styles.primaryAction} onClick={onOpen}>Skapa arbetsyta</button></div><div className={styles.workspaceVisual} aria-hidden="true"><i /><i /><i /><i /></div></section>;
}

function TenantForm({ onCancel, onSubmit, busy }: { onCancel: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void; busy: boolean }) {
  return <section className={styles.tenantFormWrap}><form className={styles.tenantForm} onSubmit={onSubmit}><div><p className={styles.kicker}>NY ARBETSYTA</p><h2>Vem är den här motorn till för?</h2><p>Arbetsytan avgränsar all research, alla källor och varje framtida publicering.</p></div><div className={styles.fieldGrid}><label><span>Namn</span><input required name="name" placeholder="Exempel: Northstar Media" autoFocus /></label><label><span>Kort namn <em>valfritt</em></span><input name="slug" placeholder="northstar" /></label></div><label><span>Tidszon</span><select name="timezone" defaultValue="Europe/Stockholm"><option value="Europe/Stockholm">Stockholm (CET/CEST)</option><option value="Europe/London">London</option><option value="America/New_York">New York</option><option value="Asia/Dubai">Dubai</option></select></label><div className={styles.formActions}><button type="button" onClick={onCancel}>Avbryt</button><button type="submit" className={styles.primaryAction} disabled={busy}>{busy ? "Skapar…" : "Skapa arbetsyta"}</button></div></form></section>;
}

function SetupState({ snapshot, onRefresh }: { snapshot: MediaEngineSnapshot; onRefresh: () => void }) {
  return <section className={styles.setupState}><span aria-hidden="true">!</span><div><p className={styles.kicker}>KONFIGURATION KRÄVS</p><h2>Motorn är pausad tills den kan verifiera sitt underlag.</h2><p>{missingConfigurationMessage(snapshot)}</p>{snapshot.configuration.missing.length > 0 && <ul>{snapshot.configuration.missing.map((item) => <li key={item}>{item}</li>)}</ul>}</div><button type="button" className={styles.secondaryAction} onClick={onRefresh}>Uppdatera status</button></section>;
}

function FailureState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <section className={styles.failureState}><span aria-hidden="true">!</span><div><p className={styles.kicker}>KAN INTE LÄSA MOTORN</p><h2>{message}</h2><p>Inga exempeldata visas. När anslutningen fungerar visar sidan bara vad som faktiskt finns i din arbetsyta.</p></div><button type="button" className={styles.primaryAction} onClick={onRetry}>Försök igen</button></section>;
}

function LoadingState() {
  return <section className={styles.loadingState} aria-live="polite"><span className={styles.loader} aria-hidden="true" /><div><strong>Hämtar Media Engine</strong><p>Läser arbetsyta, källor, signalregler och researchstatus.</p></div></section>;
}

function EmptyPanel({ icon, title, detail, action, onAction, disabled }: { icon: string; title: string; detail: string; action: string; onAction: () => void; disabled: boolean }) {
  return <div className={styles.emptyPanel}><span aria-hidden="true">{icon}</span><div><strong>{title}</strong><p>{detail}</p><button type="button" onClick={onAction} disabled={disabled}>{action} →</button></div></div>;
}

async function readEngineEndpoint(url: string): Promise<EngineRead> {
  try {
    const response = await fetch(url, { cache: "no-store" });
    return { ok: response.ok, status: response.status, data: await responseJson(response) };
  } catch { return { ok: false, status: 0, data: null }; }
}

async function writeEngineEndpoint(url: string, method: "POST" | "PATCH" | "DELETE", body?: unknown): Promise<EngineRead> {
  try {
    const response = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { ok: response.ok, status: response.status, data: await responseJson(response) };
  } catch { return { ok: false, status: 0, data: null }; }
}

async function responseJson(response: Response): Promise<unknown> {
  try { return await response.json() as unknown; } catch { return null; }
}

function readError(payload: unknown, fallback: string) {
  return isRecord(payload) && typeof payload.error === "string" && payload.error.trim() ? payload.error : fallback;
}

function readMessage(payload: unknown, fallback: string) {
  return isRecord(payload) && typeof payload.message === "string" && payload.message.trim() ? payload.message : fallback;
}

function tenantIdFromCreatePayload(payload: unknown): string | null {
  if (!isRecord(payload) || !isRecord(payload.tenant) || typeof payload.tenant.id !== "string") return null;
  return payload.tenant.id.trim() || null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(form: FormData, key: string) {
  return String(form.get(key) ?? "").trim();
}

function commaSeparatedValues(value: string) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function numberFromForm(form: FormData, key: string, fallback: number) {
  const value = Number(text(form, key));
  return Number.isFinite(value) ? value : fallback;
}

function idempotencyKey() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (character) => {
    const value = Math.floor(Math.random() * 16);
    return (character === "x" ? value : (value & 0x3) | 0x8).toString(16);
  });
}

function shortDomain(value: string) {
  try { return new URL(value).hostname.replace(/^www\./, ""); } catch { return value; }
}

function formatWhen(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const diff = Date.now() - date.getTime();
  if (diff >= 0 && diff < 60 * 60 * 1000) return "nyss";
  if (diff >= 0 && diff < 24 * 60 * 60 * 1000) return `${Math.max(1, Math.round(diff / (60 * 60 * 1000)))} h sedan`;
  return new Intl.DateTimeFormat("sv-SE", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(date);
}

function formatWindow(hours: number) {
  return hours === 1 ? "1 timme" : hours < 24 ? `${hours} timmar` : hours === 24 ? "24 timmar" : hours % 24 === 0 ? `${hours / 24} dagar` : `${hours} timmar`;
}

function frameworkLabel(value: string) {
  return frameworks.find((item) => item.value === value)?.label ?? (value || "Ej valt");
}

function imageLabel(value: string) {
  return imageDirections.find((item) => item.value === value)?.label ?? (value || "Ej valt");
}

function contentLabel(value: string) {
  return contentOptions.find((item) => item.value === value)?.label ?? (value || "Utkast");
}

function channelSummary(channels: string[]) {
  const labels: Record<string, string> = { linkedin: "LinkedIn", instagram: "Instagram", facebook_page: "Facebook", newsletter: "Nyhetsbrev" };
  const values = channels.map((channel) => labels[channel] ?? channel).filter(Boolean);
  return values.length ? values.join(", ") : "Kanal ej vald";
}

function cadenceLabel(value: string) {
  return { continuous: "Direkt", hourly: "Varje timme", daily: "Dagligen", weekly: "Veckovis", cron: "Cron" }[value] ?? (value || "Standard");
}

function roleLabel(value: string) {
  return { owner: "Ägare", admin: "Admin", editor: "Redaktör", viewer: "Visning" }[value] ?? "Visning";
}

function clusterStatusLabel(status: MediaClusterView["status"]) {
  return { collecting: "Samlar signaler", threshold_met: "Tröskel nådd", researching: "Research pågår", ready: "Klar för granskning", dismissed: "Avfärdad", pending: "Väntar", published: "Publicerad", unknown: "Okänd status" }[status];
}

function clusterStatusClass(status: MediaClusterView["status"]) {
  return status === "ready" ? styles.statusDotReady : status === "researching" ? styles.statusDotWorking : status === "dismissed" ? styles.statusDotMuted : status === "threshold_met" ? styles.statusDotAlert : styles.statusDotWaiting;
}

function handoffStatusLabel(status: MediaHandoffView["status"]) {
  return { queued: "I utkastkö", drafted: "Privat utkast", in_review: "Väntar på granskning", approved: "Godkänd", scheduled: "Schemalagd", published: "Publicerad", rejected: "Avvisad", failed: "Fel", unknown: "Förbereds" }[status];
}

function handoffStatusClass(status: MediaHandoffView["status"]) {
  return `${styles.handoffStatus} ${status === "failed" ? styles.handoffFailed : status === "rejected" ? styles.handoffMuted : status === "drafted" || status === "in_review" ? styles.handoffReady : ""}`;
}

function runStatusClass(status: MediaRunView["status"]) {
  return status === "completed" ? styles.runDone : status === "failed" ? styles.runFailed : status === "running" ? styles.runWorking : styles.runQueued;
}

function missingConfigurationMessage(snapshot: MediaEngineSnapshot) {
  if (!snapshot.tenant) return "Skapa först en arbetsyta. Sedan kan du lägga till källor och regler separat för varje tenant.";
  if (snapshot.configuration.missing.length) return `För att köra motorn saknas: ${snapshot.configuration.missing.join(", ")}.`;
  return "Motorn är inte färdigkonfigurerad ännu. Den kör inga delvis verifierade kontroller.";
}
