import Link from "next/link";
import { RunBriefButton } from "@/components/run-brief-button";
import type { FlowControlsView } from "@/lib/domain/flow-controls";
import type { ProfileSettings } from "@/lib/domain/types";
import type { RunHealth } from "@/lib/services/brief-reader";
import type { BriefDefinitionView, ProfileContextView } from "@/lib/services/workspace";
import { formatSwedishDateTime } from "@/lib/utils/date";

type SettingsControlCenterProps = {
  settings: ProfileSettings;
  flowControls: FlowControlsView;
  profileContext: ProfileContextView | null;
  latestRun: RunHealth | null;
  hasCurrentBrief: boolean;
  activeWatchCount: number;
  pausedWatchCount: number;
  activeBriefCount: number;
  sourceCount: number;
  blockedSourceCount: number;
  activeApiKeyCount: number;
  definitions: BriefDefinitionView[];
};

const runCopy: Record<RunHealth["state"], { label: string; detail: string; tone: "ready" | "working" | "attention" }> = {
  complete: { label: "Senaste kontrollen är klar", detail: "Nya poster publiceras bara efter källa och relevanskontroll.", tone: "ready" },
  running: { label: "En kontroll pågår", detail: "Systemet söker, verifierar och jämför mot tidigare läge.", tone: "working" },
  failed: { label: "Senaste kontrollen blev inte klar", detail: "Inget ofullständigt resultat publiceras som en färdig brief.", tone: "attention" },
};

function summaryList(values: string[], fallback: string) {
  if (!values.length) return fallback;
  const first = values.slice(0, 3).join(", ");
  return values.length > 3 ? `${first} +${values.length - 3}` : first;
}

function definitionSummary(definitions: BriefDefinitionView[]) {
  const primary = definitions.find((definition) => definition.isPrimary);
  if (!primary) return "Ingen huvudbrief hittad";
  return `${primary.localTime} · ${primary.timezone}`;
}

export function SettingsControlCenter({
  settings,
  flowControls,
  profileContext,
  latestRun,
  hasCurrentBrief,
  activeWatchCount,
  pausedWatchCount,
  activeBriefCount,
  sourceCount,
  blockedSourceCount,
  activeApiKeyCount,
  definitions,
}: SettingsControlCenterProps) {
  const run = latestRun ? runCopy[latestRun.state] : null;
  const interestSummary = summaryList(profileContext?.interests ?? [], "Inga bolag eller ämnen är valda ännu");
  const opportunitySummary = summaryList(profileContext?.opportunities ?? [], "Inga affärslägen eller sammanhang är valda ännu");
  const enabledModuleCount = Object.values(flowControls.modules).filter(Boolean).length;
  const alertSummary = !flowControls.alerts.enabled
    ? "Direktnotiser är av"
    : flowControls.alerts.quietHours.enabled
      ? `Tyst ${flowControls.alerts.quietHours.start}–${flowControls.alerts.quietHours.end}`
      : `Direktnotis vid ${settings.alertThreshold}/100`;

  return (
    <section className="settings-control-center" aria-labelledby="settings-control-title">
      <header className="settings-command-header">
        <div>
          <p className="eyebrow">KONTROLLCENTRAL</p>
          <h1 id="settings-control-title">Styr din brief.</h1>
          <p>Här kontrollerar du vad som får ta din tid: urval, trösklar, källor, bevakningar och ditt personliga fokus.</p>
        </div>
        <span className={hasCurrentBrief ? "settings-command-seal is-current" : "settings-command-seal"}>
          <span aria-hidden="true">●</span>
          {hasCurrentBrief ? "Dagens brief klar" : "Väntar på kontroll"}
        </span>
      </header>

      <nav className="settings-control-nav" aria-label="Gå till en del av kontrollcentralen">
        <a href="#settings-run">Status</a>
        <a href="#briefs-control">Brief</a>
        <a href="#flow-controls">Urval</a>
        <a href="#sources-control">Källor</a>
        <a href="#watches-control">Bevakar</a>
        <a href="#focus-control">Fokus</a>
        <a href="#api-control">API/RSS</a>
      </nav>

      <section id="settings-run" className={`settings-run-status ${run ? `settings-run-status--${run.tone}` : "settings-run-status--neutral"}`} aria-labelledby="settings-run-title">
        <div className="settings-run-status-copy">
          <p className="eyebrow">KÖRSTATUS OCH NOTISNIVÅ</p>
          <h2 id="settings-run-title">{run?.label ?? "Ingen kontroll har körts ännu"}</h2>
          <p>{run?.detail ?? "När du kör första kontrollen skapas en brief endast om underlaget kan verifieras."}</p>
          <div className="settings-run-meta">
            <span>{latestRun ? `Senast: ${formatSwedishDateTime(latestRun.finishedAt ?? latestRun.startedAt)}` : "Ingen senaste körning"}</span>
            <span>{alertSummary}</span>
            {latestRun?.state === "complete" && <span>{latestRun.publishedCount} publicerade poster</span>}
          </div>
          {hasCurrentBrief && <p className="settings-run-idempotency">Dagens brief är sparad. En ny körning skriver inte över den; separata bevakningar kan fortfarande meddela verkliga ändringar.</p>}
        </div>
        <RunBriefButton />
      </section>

      <div className="settings-control-grid" aria-label="Dina styrspakar">
        <a className="settings-control-card settings-control-card--brief" href="#briefs-control">
          <span className="settings-control-card-icon" aria-hidden="true">01</span>
          <span className="settings-control-card-copy">
            <span className="eyebrow">BRIEF</span>
            <strong>{settings.maxItems} poster · {settings.briefDepth === "short" ? "kort" : "fördjupad"}</strong>
            <span>{activeBriefCount} {activeBriefCount === 1 ? "aktiv brief" : "aktiva briefar"} · {definitionSummary(definitions)}</span>
          </span>
          <span className="settings-control-card-arrow" aria-hidden="true">›</span>
        </a>

        <a className="settings-control-card settings-control-card--flow" href="#flow-controls">
          <span className="settings-control-card-icon" aria-hidden="true">02</span>
          <span className="settings-control-card-copy">
            <span className="eyebrow">URVAL</span>
            <strong>Visa från {settings.relevanceThreshold}/100</strong>
            <span>{enabledModuleCount}/5 innehållsdelar på · ämnes- och regionvikt styr prioriteringen.</span>
          </span>
          <span className="settings-control-card-arrow" aria-hidden="true">›</span>
        </a>

        <Link className="settings-control-card settings-control-card--sources" href="/settings/sources">
          <span className="settings-control-card-icon" aria-hidden="true">03</span>
          <span className="settings-control-card-copy">
            <span className="eyebrow">KÄLLOR</span>
            <strong>{sourceCount} källor i policyn</strong>
            <span>{blockedSourceCount ? `${blockedSourceCount} blockerade` : "Inga blockerade källor"}</span>
          </span>
          <span className="settings-control-card-arrow" aria-hidden="true">›</span>
        </Link>

        <Link className="settings-control-card settings-control-card--watches" href="/watches">
          <span className="settings-control-card-icon" aria-hidden="true">04</span>
          <span className="settings-control-card-copy">
            <span className="eyebrow">BEVAKNINGAR</span>
            <strong>{activeWatchCount} aktiva frågor</strong>
            <span>{pausedWatchCount ? `${pausedWatchCount} pausade` : "Endast vid materiell förändring"}</span>
          </span>
          <span className="settings-control-card-arrow" aria-hidden="true">›</span>
        </Link>

        <a className="settings-control-card settings-control-card--focus" href="#focus-control">
          <span className="settings-control-card-icon" aria-hidden="true">05</span>
          <span className="settings-control-card-copy">
            <span className="eyebrow">BOLAG OCH MARKNAD</span>
            <strong>{interestSummary}</strong>
            <span>Fokus styr relevans — inte köp- eller säljråd.</span>
          </span>
          <span className="settings-control-card-arrow" aria-hidden="true">›</span>
        </a>

        <a className="settings-control-card settings-control-card--radar" href="#radar-control">
          <span className="settings-control-card-icon" aria-hidden="true">06</span>
          <span className="settings-control-card-copy">
            <span className="eyebrow">AI OCH AFFÄRSLÄGEN</span>
            <strong>{opportunitySummary}</strong>
            <span>Officiella roadmaps, möjligheter och sammanhang.</span>
          </span>
          <span className="settings-control-card-arrow" aria-hidden="true">›</span>
        </a>

        <a className="settings-control-card settings-control-card--api" href="#api-control">
          <span className="settings-control-card-icon" aria-hidden="true">07</span>
          <span className="settings-control-card-copy">
            <span className="eyebrow">API OCH RSS</span>
            <strong>{activeApiKeyCount} {activeApiKeyCount === 1 ? "aktiv nyckel" : "aktiva nycklar"}</strong>
            <span>Privata JSON-, RSS- och liveflöden för dina verifierade poster.</span>
          </span>
          <span className="settings-control-card-arrow" aria-hidden="true">›</span>
        </a>
      </div>

      <p className="settings-control-note">Ändringar sparas först när du väljer <strong>Spara</strong> i respektive del. Källkrav och materiell förändring är alltid skyddsräcken.</p>
    </section>
  );
}
