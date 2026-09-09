"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import styles from "./saga-content-automation-runs.module.css";

type RunState = "queued" | "processing" | "completed" | "failed" | "cancelled" | "skipped";
type DraftState = "draft" | "in_review" | "approved" | "scheduled" | "publishing" | "published" | "failed" | "cancelled";

export type SagaContentAutomation = {
  id: string;
  name: string;
  active: boolean;
  timezone: string;
  scheduleMode: "weekly_count" | "cron";
  nextRunAt: string | null;
  lastRunAt: string | null;
  channels: string[];
};

export type SagaContentAutomationRun = {
  id: string;
  automationRuleId: string;
  automationName: string;
  automationActive: boolean;
  state: RunState;
  triggerKind: "scheduled" | "manual";
  scheduledFor: string;
  timezone: string;
  attemptCount: number;
  maxAttemptCount: number;
  claimedAt: string | null;
  lockedUntil: string | null;
  completedAt: string | null;
  createdAt: string;
  failureCode: string | null;
  lastError: string | null;
  draft: { id: string; title: string; status: DraftState } | null;
};

export type SagaContentAutomationRunsData = {
  automations: SagaContentAutomation[];
  runs: SagaContentAutomationRun[];
};

type LoadState = "loading" | "ready" | "error";
type ManualRunStatus = "draft_created" | "queued" | "processing" | "failed";

const runStates = new Set<RunState>(["queued", "processing", "completed", "failed", "cancelled", "skipped"]);
const draftStates = new Set<DraftState>(["draft", "in_review", "approved", "scheduled", "publishing", "published", "failed", "cancelled"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function nullableText(value: unknown): string | null {
  const valueText = text(value).trim();
  return valueText || null;
}

function boundedText(value: unknown, maximum: number): string | null {
  const valueText = nullableText(value);
  if (!valueText) return null;
  return valueText.length > maximum ? `${valueText.slice(0, Math.max(0, maximum - 1)).trimEnd()}…` : valueText;
}

function integer(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) ? value : fallback;
}

function validDateTime(value: string | null): string | null {
  if (!value || Number.isNaN(new Date(value).getTime())) return null;
  return value;
}

function safeError(payload: unknown, fallback: string): string {
  if (!isRecord(payload)) return fallback;
  const message = nullableText(payload.error ?? payload.message);
  return message ?? fallback;
}

function parseAutomation(value: unknown): SagaContentAutomation | null {
  if (!isRecord(value)) return null;
  const id = nullableText(value.id);
  if (!id) return null;
  const scheduleMode = value.scheduleMode === "cron" ? "cron" : "weekly_count";
  return {
    id,
    name: nullableText(value.name) ?? "Namnlös innehållsautomation",
    active: value.active === true,
    timezone: nullableText(value.timezone) ?? "Europe/Stockholm",
    scheduleMode,
    nextRunAt: validDateTime(nullableText(value.nextRunAt)),
    lastRunAt: validDateTime(nullableText(value.lastRunAt)),
    channels: Array.isArray(value.channels) ? value.channels.filter((item): item is string => typeof item === "string" && item.length <= 80) : [],
  };
}

function parseRun(value: unknown): SagaContentAutomationRun | null {
  if (!isRecord(value)) return null;
  const id = nullableText(value.id);
  const automationRuleId = nullableText(value.automationRuleId);
  const scheduledFor = validDateTime(nullableText(value.scheduledFor));
  const rawState = nullableText(value.state);
  if (!id || !automationRuleId || !scheduledFor || !rawState || !runStates.has(rawState as RunState)) return null;
  const rawDraft = isRecord(value.draft) ? value.draft : null;
  const draftId = rawDraft ? nullableText(rawDraft.id) : null;
  const rawDraftState = rawDraft ? nullableText(rawDraft.status) : null;
  let draft: SagaContentAutomationRun["draft"] = null;
  if (rawDraft && draftId && rawDraftState && draftStates.has(rawDraftState as DraftState)) {
    draft = {
      id: draftId,
      title: nullableText(rawDraft.title) ?? "Namnlöst utkast",
      status: rawDraftState as DraftState,
    };
  }
  return {
    id,
    automationRuleId,
    automationName: nullableText(value.automationName) ?? "Namnlös innehållsautomation",
    automationActive: value.automationActive === true,
    state: rawState as RunState,
    triggerKind: value.triggerKind === "manual" ? "manual" : "scheduled",
    scheduledFor,
    timezone: nullableText(value.timezone) ?? "Europe/Stockholm",
    attemptCount: Math.max(0, integer(value.attemptCount, 0)),
    maxAttemptCount: Math.max(1, integer(value.maxAttemptCount, 1)),
    claimedAt: validDateTime(nullableText(value.claimedAt)),
    lockedUntil: validDateTime(nullableText(value.lockedUntil)),
    completedAt: validDateTime(nullableText(value.completedAt)),
    createdAt: validDateTime(nullableText(value.createdAt)) ?? scheduledFor,
    failureCode: boundedText(value.failureCode, 120),
    lastError: boundedText(value.lastError, 560),
    draft,
  };
}

/** Strictly projects the actor-scoped endpoint; unrecognised fields never enter UI state. */
export function sagaContentAutomationRunsFromPayload(payload: unknown): SagaContentAutomationRunsData {
  if (!isRecord(payload)) return { automations: [], runs: [] };
  return {
    automations: Array.isArray(payload.automations) ? payload.automations.flatMap((item) => {
      const automation = parseAutomation(item);
      return automation ? [automation] : [];
    }) : [],
    runs: Array.isArray(payload.runs) ? payload.runs.flatMap((item) => {
      const run = parseRun(item);
      return run ? [run] : [];
    }) : [],
  };
}

function formatWhen(value: string | null, timezone: string): string {
  if (!value) return "Inte registrerat";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Inte registrerat";
  try {
    return new Intl.DateTimeFormat("sv-SE", {
      timeZone: timezone,
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat("sv-SE", { dateStyle: "medium", timeStyle: "short" }).format(date);
  }
}

function runStateLabel(state: RunState, attempts: number): string {
  if (state === "queued" && attempts > 0) return "Försöker igen";
  return {
    queued: "I kö",
    processing: "Bearbetas",
    completed: "Utkast klart",
    failed: "Misslyckad",
    cancelled: "Avbruten",
    skipped: "Överhoppad",
  }[state];
}

function draftStateLabel(state: DraftState): string {
  return {
    draft: "Privat utkast",
    in_review: "Väntar på granskning",
    approved: "Godkänt",
    scheduled: "Schemalagt",
    publishing: "Publicerar",
    published: "Publicerat",
    failed: "Kunde inte publiceras",
    cancelled: "Avbrutet",
  }[state];
}

function shortReceipt(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
}

function runReason(run: SagaContentAutomationRun): string | null {
  const known: Record<string, string> = {
    automation_configuration_invalid: "Automationens innehållsinställningar behöver rättas innan den kan köras.",
    ai_configuration_unavailable: "AI-tjänsten är inte tillgänglig för arbetsytan just nu.",
    ai_generation_failed: "AI-tjänsten kunde inte skapa ett användbart utkast den här gången.",
    production_quality_rejected: "Kvalitetskontrollen stoppade utkastet före det kunde sparas.",
    automation_inactive: "Automationen pausades innan den planerade körningen startade.",
    automation_reconfigured: "Automationen ändrades innan den planerade körningen startade.",
    automation_dependency_unavailable: "En tillfällig tjänst kunde inte skapa utkastet.",
    automation_worker_unavailable: "Automationsmotorn kunde inte slutföra utkastet just nu.",
  };
  return run.failureCode ? known[run.failureCode] ?? run.lastError : run.lastError;
}

async function responsePayload(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { return null; }
}

function newIdempotencyKey(): string | null {
  return typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto.randomUUID() : null;
}

export function SagaContentAutomationRuns() {
  const [state, setState] = useState<LoadState>("loading");
  const [data, setData] = useState<SagaContentAutomationRunsData>({ automations: [], runs: [] });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [runningAutomationId, setRunningAutomationId] = useState<string | null>(null);
  const manualKeys = useRef<Record<string, string>>({});

  const refresh = useCallback(async (preserveReadyState = false) => {
    if (!preserveReadyState) setState("loading");
    setError(null);
    try {
      const response = await fetch("/api/content/automation-runs?limit=50", {
        cache: "no-store",
        credentials: "same-origin",
      });
      const payload = await responsePayload(response);
      if (!response.ok) throw new Error(safeError(payload, "Kunde inte läsa de sparade automationskörningarna."));
      setData(sagaContentAutomationRunsFromPayload(payload));
      setState("ready");
    } catch (reason) {
      setState("error");
      setError(reason instanceof Error ? reason.message : "Kunde inte läsa de sparade automationskörningarna.");
    }
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => { void refresh(); });
    return () => window.cancelAnimationFrame(frame);
  }, [refresh]);

  const runsByAutomation = useMemo(() => {
    const grouped = new Map<string, SagaContentAutomationRun[]>();
    for (const run of data.runs) {
      const list = grouped.get(run.automationRuleId) ?? [];
      list.push(run);
      grouped.set(run.automationRuleId, list);
    }
    return grouped;
  }, [data.runs]);

  const counts = useMemo(() => data.runs.reduce((total, run) => ({
    queued: total.queued + (run.state === "queued" ? 1 : 0),
    processing: total.processing + (run.state === "processing" ? 1 : 0),
    completed: total.completed + (run.state === "completed" ? 1 : 0),
    failed: total.failed + (run.state === "failed" ? 1 : 0),
  }), { queued: 0, processing: 0, completed: 0, failed: 0 }), [data.runs]);

  async function runNow(automation: SagaContentAutomation) {
    const idempotencyKey = manualKeys.current[automation.id] ?? newIdempotencyKey();
    if (!idempotencyKey) {
      setNotice("Kunde inte skapa en säker körningsnyckel. Ladda om sidan och försök igen.");
      return;
    }
    manualKeys.current[automation.id] = idempotencyKey;
    setRunningAutomationId(automation.id);
    setNotice(null);
    try {
      const response = await fetch(`/api/content/automations/${encodeURIComponent(automation.id)}/run`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idempotencyKey }),
      });
      const payload = await responsePayload(response);
      const result = isRecord(payload) ? payload : null;
      const status = result ? text(result.status) as ManualRunStatus : null;
      if (response.ok && status === "draft_created") {
        delete manualKeys.current[automation.id];
        const draft = result && isRecord(result.draft) ? nullableText(result.draft.id) : null;
        setNotice(draft
          ? "Det privata utkastet är klart. Det är inte schemalagt eller publicerat."
          : "Körningen är klar. Laddar den sparade körloggen.");
      } else if (status === "queued" || status === "processing") {
        setNotice("Körningen har en sparad plats i kön. Den skapar bara ett privat utkast och publicerar aldrig.");
      } else {
        setNotice(safeError(payload, "Körningen kunde inte startas. Samma säkra körningskvitto behålls vid ett nytt försök."));
      }
    } catch {
      setNotice("Kunde inte kontakta Studio. Samma säkra körningskvitto behålls vid ett nytt försök.");
    } finally {
      setRunningAutomationId(null);
      void refresh(true);
    }
  }

  return (
    <section className={styles.monitor} aria-labelledby="content-automation-runs-title">
      <header className={styles.header}>
        <div className={styles.intro}>
          <p className={styles.kicker}>INNEHÅLLSFLÖDEN · VERKLIGA KÖRNINGAR</p>
          <h1 id="content-automation-runs-title">Se exakt vad Cron har gjort.</h1>
          <p>Varje rad nedan är ett sparat jobbkvitto i din privata arbetsyta: när det lades i kö, när en worker tog över och om ett privat utkast faktiskt skapades.</p>
        </div>
        <div className={styles.headerActions}>
          <span className={styles.privateStatus}><i aria-hidden="true" />Skapar aldrig publicering</span>
          <button type="button" className={styles.refresh} onClick={() => void refresh(true)} disabled={state === "loading"}>{state === "loading" ? "Läser…" : "Uppdatera"}</button>
          <Link className={styles.primaryAction} href="/studio/calendar">Öppna kalendern <span aria-hidden="true">→</span></Link>
        </div>
      </header>

      {notice ? <p className={styles.notice} role="status">{notice}</p> : null}

      {state === "loading" ? <RunMonitorSkeleton /> : null}
      {state === "error" ? (
        <section className={styles.failure} role="alert">
          <span aria-hidden="true">!</span>
          <div><strong>Körloggen är inte tillgänglig just nu.</strong><p>{error}</p></div>
          <button type="button" onClick={() => void refresh()}>Försök igen</button>
        </section>
      ) : null}

      {state === "ready" ? <>
        <section className={styles.summary} aria-label="Körningsstatus">
          <SummaryStat value={counts.processing} label="bearbetas" tone="active" />
          <SummaryStat value={counts.queued} label="väntar i kö" tone="queued" />
          <SummaryStat value={counts.completed} label="utkast skapade" tone="completed" />
          <SummaryStat value={counts.failed} label="kräver åtgärd" tone="failed" />
        </section>

        {!data.automations.length ? (
          <section className={styles.empty}>
            <span aria-hidden="true">↻</span>
            <div><p className={styles.kicker}>INGA INNEHÅLLSFLÖDEN</p><h2>Det finns inga sparade flöden att övervaka ännu.</h2><p>Bygg först ett innehållsflöde. När det aktiveras skapar Vercel Cron hållbara körningar här — aldrig testposter.</p></div>
            <Link className={styles.primaryAction} href="/studio/automations?view=build-content">Bygg innehållsflöde <span aria-hidden="true">→</span></Link>
          </section>
        ) : (
          <div className={styles.automationList}>
            {data.automations.map((automation) => (
              <AutomationRunCard
                key={automation.id}
                automation={automation}
                runs={runsByAutomation.get(automation.id) ?? []}
                running={runningAutomationId === automation.id}
                onRunNow={() => void runNow(automation)}
              />
            ))}
          </div>
        )}
      </> : null}

      <footer className={styles.footnote}>Visar högst 50 av de senaste innehållskörningarna. Annonsflöden har en separat arbetsyta och blandas inte in här.</footer>
    </section>
  );
}

function SummaryStat({ value, label, tone }: { value: number; label: string; tone: "active" | "queued" | "completed" | "failed" }) {
  return <div className={styles[`summary${tone[0].toUpperCase()}${tone.slice(1)}`]}><strong>{value}</strong><span>{label}</span></div>;
}

function AutomationRunCard({ automation, runs, running, onRunNow }: {
  automation: SagaContentAutomation;
  runs: SagaContentAutomationRun[];
  running: boolean;
  onRunNow: () => void;
}) {
  const latest = runs[0] ?? null;
  return (
    <article className={styles.automationCard}>
      <header className={styles.cardHeader}>
        <div className={styles.automationIdentity}>
          <span className={automation.active ? styles.liveDot : styles.pausedDot} aria-hidden="true" />
          <div><p className={styles.kicker}>INNEHÅLLSAUTOMATION</p><h2>{automation.name}</h2><p>{automation.scheduleMode === "cron" ? "Cron-schema" : "Veckorytm"} · {automation.channels.length ? automation.channels.join(" · ") : "Kanal väljs i utkastet"}</p></div>
        </div>
        <span className={`${styles.automationStatus} ${automation.active ? styles.automationStatusActive : styles.automationStatusPaused}`}>{automation.active ? "Aktiv" : "Pausad"}</span>
      </header>

      <div className={styles.ruleFacts}>
        <div><span>Nästa planerade</span><strong>{automation.active ? formatWhen(automation.nextRunAt, automation.timezone) : "Pausad"}</strong><small>{automation.active ? automation.timezone : "Nya schemakörningar skapas inte"}</small></div>
        <div><span>Senast registrerad</span><strong>{formatWhen(automation.lastRunAt, automation.timezone)}</strong><small>{latest ? runStateLabel(latest.state, latest.attemptCount) : "Inga körningar ännu"}</small></div>
        <div><span>Manuellt prov</span><strong>Privat utkast</strong><small>Ingen publicering eller leverans</small></div>
      </div>

      <div className={styles.runActions}>
        <button type="button" className={styles.runNow} onClick={onRunNow} disabled={running}>{running ? "Köar körning…" : "Kör privat nu"}</button>
        <p>Skapar högst ett privat utkast genom ett sparat kvitto. Det publiceras aldrig här.</p>
        <Link href="/studio/automations?view=build-content">Ändra flöde <span aria-hidden="true">→</span></Link>
      </div>

      <section className={styles.runHistory} aria-label={`Körhistorik för ${automation.name}`}>
        <div className={styles.runHistoryHeader}><div><p className={styles.kicker}>DURABLA KÖRNINGAR</p><h3>Senaste jobbkvittona</h3></div><span>{runs.length} visade</span></div>
        {runs.length ? <ol>{runs.map((run) => <RunReceipt key={run.id} run={run} />)}</ol> : <p className={styles.noRuns}>Inga körningar har lagts i kön ännu. När Cron når en aktiv regel visas det faktiska kvittot här.</p>}
      </section>
    </article>
  );
}

function RunReceipt({ run }: { run: SagaContentAutomationRun }) {
  const retry = run.state === "queued" && run.attemptCount > 0;
  const reason = runReason(run);
  return <li className={styles.runReceipt}>
    <div className={styles.receiptTopline}>
      <span className={`${styles.runState} ${styles[`runState${run.state[0].toUpperCase()}${run.state.slice(1)}`] ?? ""}`}>{runStateLabel(run.state, run.attemptCount)}</span>
      <span title={run.id}>Kvitto {shortReceipt(run.id)}</span>
    </div>
    <div className={styles.receiptMain}>
      <div>
        <strong>{run.triggerKind === "manual" ? "Manuellt startad" : "Schemalagd körning"}</strong>
        <p>I kö: {formatWhen(run.createdAt, run.timezone)} · planerad: {formatWhen(run.scheduledFor, run.timezone)}</p>
      </div>
      {run.draft ? <Link className={styles.draftLink} href={`/studio/content/${encodeURIComponent(run.draft.id)}`}><span><strong>{run.draft.title}</strong><small>{draftStateLabel(run.draft.status)}</small></span>Öppna utkast <b aria-hidden="true">→</b></Link> : <span className={styles.noDraft}>{run.state === "processing" ? "Arbetar med utkastet" : retry ? `Nytt försök ${formatWhen(run.scheduledFor, run.timezone)}` : "Inget utkast ännu"}</span>}
    </div>
    <dl className={styles.receiptFacts}>
      <div><dt>Försök</dt><dd>{run.attemptCount} av {run.maxAttemptCount}</dd></div>
      <div><dt>Tagen av worker</dt><dd>{formatWhen(run.claimedAt, run.timezone)}</dd></div>
      <div><dt>Avslutad</dt><dd>{formatWhen(run.completedAt, run.timezone)}</dd></div>
      {run.state === "processing" ? <div><dt>Lease till</dt><dd>{formatWhen(run.lockedUntil, run.timezone)}</dd></div> : null}
    </dl>
    {reason ? <p className={styles.runReason}><strong>{retry ? "Orsak till nytt försök:" : "Orsak:"}</strong> {reason}</p> : null}
  </li>;
}

function RunMonitorSkeleton() {
  return <div className={styles.skeleton} aria-busy="true" aria-label="Läser verkliga automationskörningar"><div /><div /><div /><div /></div>;
}
