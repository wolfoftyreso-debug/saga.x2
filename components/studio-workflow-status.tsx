"use client";

import Link from "next/link";
import type {
  StudioBackendIssue,
  StudioBackendState,
  StudioData,
  StudioDraftView,
} from "@/components/content-studio-adapter";
import styles from "@/components/studio-workflow-status.module.css";

export const STUDIO_WORKFLOW_STAGE_IDS = ["intake", "draft", "review", "schedule", "publish"] as const;
export type StudioWorkflowStageId = (typeof STUDIO_WORKFLOW_STAGE_IDS)[number];
export type StudioWorkflowTone = "blocked" | "idle" | "active" | "attention" | "ready";

export type StudioWorkflowStage = {
  id: StudioWorkflowStageId;
  label: string;
  metric: string;
  detail: string;
  tone: StudioWorkflowTone;
  href: string;
  action: string;
};

export type StudioWorkflowStatusView = {
  backendState: StudioBackendState;
  headline: string;
  description: string;
  summary: string;
  stages: StudioWorkflowStage[];
  primaryHref: string;
  primaryAction: string;
  issue: StudioBackendIssue | null;
};

type StudioWorkflowStatusProps = {
  data: StudioData;
  className?: string;
};

const stageLabels: Record<StudioWorkflowStageId, string> = {
  intake: "Inflöde",
  draft: "Utkast",
  review: "Granskning",
  schedule: "Planering",
  publish: "Publicering",
};

/**
 * Builds a truthful, presentation-ready workflow from the Studio's durable
 * data. The function intentionally does not infer research, deliveries, or
 * successful publication from missing information.
 */
export function studioWorkflowStatusFromData(data: StudioData, now = new Date()): StudioWorkflowStatusView {
  if (data.backendState !== "ready") return unavailableWorkflow(data.backendState, data.backendIssue);

  const retainedDrafts = data.drafts.filter((draft) => draft.status !== "cancelled");
  const openDrafts = retainedDrafts.filter((draft) => draft.status !== "published");
  const drafting = openDrafts.filter((draft) => draft.status === "draft");
  const inReview = openDrafts.filter((draft) => draft.status === "in_review");
  const approved = openDrafts.filter((draft) => draft.status === "approved");
  const published = retainedDrafts.filter((draft) => draft.status === "published");
  const activeAutomations = data.automations.filter((automation) => automation.active);
  const upcomingAutomation = nextByDate(activeAutomations, (automation) => automation.nextRunAt, now);
  const timedDrafts = openDrafts.filter((draft) => Boolean(draft.scheduledAt));
  const upcomingDrafts = timedDrafts.filter((draft) => isOnOrAfter(draft.scheduledAt, now));
  const nextScheduledDraft = nextByDate(upcomingDrafts, (draft) => draft.scheduledAt, now);
  const staleScheduledDrafts = timedDrafts.filter((draft) => !isOnOrAfter(draft.scheduledAt, now));
  const publishableChannels = data.channels.filter((channel) => channel.state === "connected" && channel.canPublish);
  const connectedChannels = data.channels.filter((channel) => channel.state === "connected");

  const intake: StudioWorkflowStage = activeAutomations.length
    ? {
      id: "intake",
      label: stageLabels.intake,
      metric: plural(activeAutomations.length, "aktiv automation", "aktiva automationer"),
      detail: upcomingAutomation?.nextRunAt
        ? `Nästa automatiska start ${formatDateTime(upcomingAutomation.nextRunAt, data.timezone)}.`
        : "Automationerna är aktiva, men nästa tid är ännu inte angiven.",
      tone: "active",
      href: "/studio/automations",
      action: "Öppna automationer",
    }
    : {
      id: "intake",
      label: stageLabels.intake,
      metric: "Manuell start",
      detail: "Ingen aktiv automation skapar nya utkast just nu.",
      tone: "idle",
      href: "/studio/automations",
      action: "Skapa automation",
    };

  const firstDraft = newestByDate(drafting, (draft) => draft.updatedAt);
  const draft: StudioWorkflowStage = drafting.length
    ? {
      id: "draft",
      label: stageLabels.draft,
      metric: plural(drafting.length, "utkast pågår", "utkast pågår"),
      detail: firstDraft ? `Senast ändrat: ${draftTitle(firstDraft)}.` : "Utkast väntar på att fyllas med innehåll.",
      tone: "active",
      href: draftHref(firstDraft),
      action: "Öppna utkast",
    }
    : {
      id: "draft",
      label: stageLabels.draft,
      metric: "Inget öppet utkast",
      detail: openDrafts.length ? "Befintligt innehåll har redan lämnat utkaststeget." : "Starta med en idé, en mall eller en automation.",
      tone: openDrafts.length ? "ready" : "idle",
      href: "/studio/create",
      action: "Skapa utkast",
    };

  const reviewTarget = inReview[0] ?? approved[0];
  const review: StudioWorkflowStage = inReview.length
    ? {
      id: "review",
      label: stageLabels.review,
      metric: plural(inReview.length, "utkast väntar", "utkast väntar"),
      detail: "Ett godkännande eller en ändring behövs innan nästa steg.",
      tone: "attention",
      href: draftHref(reviewTarget),
      action: "Granska nu",
    }
    : approved.length
      ? {
        id: "review",
        label: stageLabels.review,
        metric: plural(approved.length, "utkast godkänt", "utkast godkända"),
        detail: "Godkända utkast kan få en publiceringstid.",
        tone: "ready",
        href: draftHref(reviewTarget),
        action: "Öppna godkänt utkast",
      }
      : {
        id: "review",
        label: stageLabels.review,
        metric: "Inget väntar",
        detail: "Det finns inget utkast i granskningskön just nu.",
        tone: "idle",
        href: "/studio/calendar",
        action: "Öppna kalender",
      };

  const schedule: StudioWorkflowStage = upcomingDrafts.length
    ? {
      id: "schedule",
      label: stageLabels.schedule,
      metric: plural(upcomingDrafts.length, "utkast med satt tid", "utkast med satta tider"),
      detail: nextScheduledDraft?.scheduledAt
        ? `Närmaste valda tid: ${formatDateTime(nextScheduledDraft.scheduledAt, data.timezone)}.`
        : "En publiceringstid är registrerad i kalendern.",
      tone: "ready",
      href: "/studio/calendar",
      action: "Visa kalender",
    }
    : staleScheduledDrafts.length
      ? {
        id: "schedule",
        label: stageLabels.schedule,
        metric: plural(staleScheduledDrafts.length, "tid behöver kontroll", "tider behöver kontrolleras"),
        detail: "En schematid har passerat utan att innehållets aktuella status kan utläsas här.",
        tone: "attention",
        href: "/studio/calendar",
        action: "Kontrollera kalender",
      }
      : approved.length
        ? {
          id: "schedule",
          label: stageLabels.schedule,
          metric: plural(approved.length, "godkänt utan tid", "godkända utan tid"),
          detail: "Välj datum och klockslag innan innehållet kan hamna i kalendern.",
          tone: "attention",
          href: draftHref(approved[0]),
          action: "Schemalägg utkast",
        }
        : {
          id: "schedule",
          label: stageLabels.schedule,
          metric: "Inget planerat",
          detail: "Kalendern har inga kommande utkast med en satt tid.",
          tone: "idle",
          href: "/studio/calendar",
          action: "Öppna kalender",
        };

  const publish: StudioWorkflowStage = data.channelLoadState === "error"
    ? {
      id: "publish",
      label: stageLabels.publish,
      metric: "Kanalstatus saknas",
      detail: data.channelLoadError || "Studio kunde inte bekräfta dina publiceringskanaler.",
      tone: "attention",
      href: "/studio/channels",
      action: "Kontrollera kanaler",
    }
    : publishableChannels.length
      ? {
        id: "publish",
        label: stageLabels.publish,
        metric: plural(publishableChannels.length, "kanal redo", "kanaler redo"),
        detail: published.length
          ? `${plural(published.length, "utkast", "utkast")} har status Publicerad i Studio.`
          : "Kanalernas anslutning är bekräftad. Publicering sker enligt utkastets egen status och tid.",
        tone: "ready",
        href: "/studio/channels",
        action: "Öppna kanaler",
      }
      : connectedChannels.length
        ? {
          id: "publish",
          label: stageLabels.publish,
          metric: plural(connectedChannels.length, "ansluten kanal", "anslutna kanaler"),
          detail: "En anslutning finns, men Studio har inte bekräftat att den kan publicera ännu.",
          tone: "attention",
          href: "/studio/channels",
          action: "Kontrollera kanal",
        }
        : {
          id: "publish",
          label: stageLabels.publish,
          metric: "Ingen kanal redo",
          detail: "Anslut en kanal innan ett godkänt utkast kan lämna Studio.",
          tone: "idle",
          href: "/studio/channels",
          action: "Anslut kanal",
        };

  const stages = [intake, draft, review, schedule, publish];
  const attentionCount = stages.filter((stage) => stage.tone === "attention").length;
  const activeCount = stages.filter((stage) => stage.tone === "active" || stage.tone === "ready").length;
  const calendarCount = data.calendarEntries.filter((entry) => isOnOrAfter(entry.startAt, now)).length;
  const headline = attentionCount
    ? plural(attentionCount, "sak behöver beslut", "saker behöver beslut")
    : activeCount
      ? "Flödet rör sig framåt"
      : "Flödet är redo att starta";
  const description = attentionCount
    ? "Börja med de gula stegen. Resten är registrerat, inte antaget."
    : activeCount
      ? "Här är den faktiska statusen från dina utkast, automationer, kalenderposter och kanaler."
      : "Inga utkast, automationer eller publiceringskanaler är registrerade ännu.";

  return {
    backendState: "ready",
    headline,
    description,
    summary: `${plural(openDrafts.length, "aktivt utkast", "aktiva utkast")} · ${plural(calendarCount, "kommande kalenderpost", "kommande kalenderposter")} · ${plural(publishableChannels.length, "publiceringsklar kanal", "publiceringsklara kanaler")}`,
    stages,
    primaryHref: attentionCount ? stages.find((stage) => stage.tone === "attention")?.href ?? "/studio/calendar" : "/studio/create",
    primaryAction: attentionCount ? "Ta nästa beslut" : "Skapa utkast",
    issue: null,
  };
}

export function StudioWorkflowStatus({ data, className }: StudioWorkflowStatusProps) {
  const workflow = studioWorkflowStatusFromData(data);
  const unavailable = workflow.backendState !== "ready";

  return (
    <section className={[styles.workflow, className].filter(Boolean).join(" ")} aria-labelledby="studio-workflow-title">
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>REDAKTIONELL STATUS</p>
          <h2 id="studio-workflow-title">{workflow.headline}</h2>
          <p>{workflow.description}</p>
        </div>
        {!unavailable && <span className={styles.summary}>{workflow.summary}</span>}
      </header>

      {unavailable ? <UnavailableWorkflow workflow={workflow} /> : <>
        <ol className={styles.stages} aria-label="Redaktionellt flöde">
          {workflow.stages.map((stage, index) => <WorkflowStageCard stage={stage} index={index} key={stage.id} />)}
        </ol>
        <footer className={styles.footer}>
          <span>Visar bara sparade statusar — aldrig prognoser om vad som redan är publicerat.</span>
          <Link href={workflow.primaryHref} className={styles.primaryLink}>{workflow.primaryAction} <span aria-hidden="true">→</span></Link>
        </footer>
      </>}
    </section>
  );
}

function UnavailableWorkflow({ workflow }: { workflow: StudioWorkflowStatusView }) {
  const checking = workflow.backendState === "checking";
  const missing = workflow.issue?.missingConfiguration ?? [];
  return <div className={styles.unavailable} aria-live="polite" aria-busy={checking || undefined}>
    <span className={styles.unavailableMark} aria-hidden="true">{checking ? "…" : "!"}</span>
    <div>
      <strong>{checking ? "Kontrollerar den sparade arbetsytan" : "Inga arbetsflöden visas utan en verifierad backend"}</strong>
      <p>{workflow.description}</p>
      {missing.length ? <p className={styles.missing}><b>Saknar:</b> {missing.join(", ")}</p> : null}
      {checking ? <span className={styles.checking}>Hämtar säker status…</span> : <Link href={workflow.primaryHref} className={styles.primaryLink}>{workflow.primaryAction} <span aria-hidden="true">→</span></Link>}
    </div>
  </div>;
}

function WorkflowStageCard({ stage, index }: { stage: StudioWorkflowStage; index: number }) {
  return <li className={`${styles.stage} ${styles[`tone${capitalize(stage.tone)}`]}`}>
    <div className={styles.stageTop}>
      <span className={styles.stageNumber}>{String(index + 1).padStart(2, "0")}</span>
      <span className={styles.stageState}>{stageStateLabel(stage.tone)}</span>
    </div>
    <p className={styles.stageLabel}>{stage.label}</p>
    <strong>{stage.metric}</strong>
    <p className={styles.stageDetail}>{stage.detail}</p>
    <Link href={stage.href} className={styles.stageLink}>{stage.action} <span aria-hidden="true">→</span></Link>
  </li>;
}

function unavailableWorkflow(backendState: Exclude<StudioBackendState, "ready">, issue: StudioBackendIssue | null): StudioWorkflowStatusView {
  const checking = backendState === "checking";
  const headline = checking ? "Kontrollerar Studio" : "Studio är inte redo att visa arbetsflödet";
  const description = checking
    ? "Vi verifierar först att utkast, kalender och kanaler går att läsa från en sparad arbetsyta."
    : "Det går inte att bekräfta sparade utkast, automationer eller kanaler. Därför visas inga uppskattade statusar.";
  return {
    backendState,
    headline,
    description,
    summary: "",
    stages: STUDIO_WORKFLOW_STAGE_IDS.map((id) => ({
      id,
      label: stageLabels[id],
      metric: "Ej verifierat",
      detail: "Studio visar inte påhittad aktivitetsdata utan en verifierad backend.",
      tone: "blocked",
      href: "/settings",
      action: "Öppna inställningar",
    })),
    primaryHref: "/settings",
    primaryAction: "Öppna inställningar",
    issue,
  };
}

function draftHref(draft: StudioDraftView | undefined): string {
  return draft ? `/studio/content/${encodeURIComponent(draft.id)}` : "/studio/create";
}

function nextByDate<T>(items: T[], date: (item: T) => string | null, now: Date): T | undefined {
  return items
    .filter((item) => isOnOrAfter(date(item), now))
    .sort((left, right) => (date(left) || "").localeCompare(date(right) || ""))[0];
}

function newestByDate<T>(items: T[], date: (item: T) => string): T | undefined {
  return [...items].sort((left, right) => date(right).localeCompare(date(left)))[0];
}

function isOnOrAfter(value: string | null, now: Date): boolean {
  if (!value) return false;
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) && date.valueOf() >= now.valueOf();
}

function formatDateTime(value: string, timeZone: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) return "okänd tid";
  try {
    return new Intl.DateTimeFormat("sv-SE", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      timeZone,
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat("sv-SE", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(date);
  }
}

function draftTitle(draft: StudioDraftView): string {
  return draft.title.trim() || draft.headline.trim() || "ett utkast utan rubrik";
}

function plural(count: number, singular: string, pluralValue: string): string {
  return `${count} ${count === 1 ? singular : pluralValue}`;
}

function stageStateLabel(tone: StudioWorkflowTone): string {
  return {
    blocked: "Låst",
    idle: "Tomt",
    active: "Pågår",
    attention: "Beslut behövs",
    ready: "Redo",
  }[tone];
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
