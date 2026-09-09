import Image from "next/image";
import Link from "next/link";
import { ChatBriefCard } from "@/components/chat-brief-card";
import { ChatComposer } from "@/components/chat-composer";
import { BriefListener } from "@/components/brief-listener";
import { BriefWorldPulse } from "@/components/brief-world-pulse";
import { RunBriefButton } from "@/components/run-brief-button";
import { StrategicRadarPanel } from "@/components/strategic-radar-panel";
import { WeeklyRecapPanel } from "@/components/weekly-recap-panel";
import type { BriefView, DashboardData, Profile } from "@/lib/services/brief-reader";
import type { ConversationBlock, ConversationBriefReference, ConversationView, ProfileContextView } from "@/lib/services/workspace";
import { formatSwedishDateTime } from "@/lib/utils/date";

type ChatThreadProps = {
  profile: Profile;
  profileContext: ProfileContextView | null;
  conversation: ConversationView | null;
  brief: BriefView | null;
  latestRun: DashboardData["latestRun"];
  today: string;
  isCurrentBrief: boolean;
  watchCount: number;
};

export function ChatThread({ profile, profileContext, conversation, brief, latestRun, today, isCurrentBrief, watchCount }: ChatThreadProps) {
  const currentBriefIsStored = Boolean(brief && conversation?.messages.some((message) => message.briefId === brief.id));
  const quietRunToday = Boolean(
    !isCurrentBrief
    && latestRun?.state === "complete"
    && latestRun.localBriefDate === today
    && latestRun.publishedCount === 0
    && latestRun.triggeredBy !== "watch"
    && !conversation?.messages.some((message) => message.kind === "watch_update" && new Date(message.createdAt) >= new Date(latestRun.startedAt)),
  );
  const hasProfile = Boolean(profileContext?.onboardingComplete);

  return (
    <section className="chat-workspace">
      <header className="chat-header">
        <div className="chat-header-identity">
          <BriefGlyph />
          <div>
            <p className="eyebrow">DIN BRIEF</p>
            <h1>God morgon, {profile.displayName}.</h1>
            <p>{hasProfile ? "Det här påverkar dig i dag. Resten är bortsorterat." : "Säg vad du vill följa. Jag sorterar bort resten."}</p>
          </div>
        </div>
        <Link className="chat-profile-link" href="/watches">
          <span className="chat-profile-link-icon" aria-hidden="true">⌁</span>
          {watchCount} bevakning{watchCount === 1 ? "" : "ar"}
        </Link>
      </header>

      <section className={latestRun?.state === "failed" ? "chat-run-status failed" : "chat-run-status"}>
        <span className="run-dot complete">{latestRun?.state === "complete" ? "Kontrollerad" : latestRun?.state === "failed" ? "Kontroll behövs" : "Väntar"}</span>
        <p>{latestRun?.state === "failed"
          ? "Dagens kontroll är inte klar. Läs senaste kompletta briefen."
          : latestRun?.finishedAt
            ? `Senast kontrollerad ${formatSwedishDateTime(latestRun.finishedAt)}.`
            : "Nästa kontroll körs enligt din plan."}</p>
        <RunBriefButton />
      </section>

      {!profileContext?.onboardingComplete && (
        <Link href="/onboarding" className="profile-prompt">
          <span className="eyebrow">GÖR URVALET PERSONLIGT</span>
          <strong>Beskriv dina marknader, beroenden och risker.</strong>
          <span>Ställ in urvalet →</span>
        </Link>
      )}

      <section className="chat-thread" aria-label="Konversation">
        {!currentBriefIsStored && isCurrentBrief && brief && <BriefMessage brief={brief} story={false} />}
        {!currentBriefIsStored && isCurrentBrief && !brief && (
          <div className="assistant-message quiet-message">
            <p>God morgon {profile.displayName}. Dagens kontroll pågår. Jag visar bara verifierade ändringar som kräver din uppmärksamhet.</p>
          </div>
        )}
        {conversation?.messages.map((message) => {
          if (message.kind === "brief") {
            const linkedBrief = brief?.id === message.briefId ? brief : null;
            return linkedBrief
              ? <BriefMessage key={message.id} brief={linkedBrief} text={message.text} story={false} showAudio={false} />
              : <HistoricalBriefMessage key={message.id} text={message.text} brief={message.brief} briefId={message.briefId} />;
          }
          const eventWatchAction = Boolean(message.eventId) && ["watch_created", "watch_exists", "watch_update"].includes(message.action?.type ?? "");
          const actionHref = eventWatchAction ? `/events/${message.eventId}` : message.action?.href;
          return (
            <article className={`chat-message ${message.role === "user" ? "user" : "assistant"}`} key={message.id}>
              {message.role === "assistant" && <BriefGlyph compact />}
              <div className="chat-message-content">
                <p>{message.text}</p>
                {message.action && (
                  <div className="chat-action-receipt">
                    <span className="eyebrow">{message.action.type === "watch_created" ? "BEVAKNING" : message.action.type === "direct_alert" ? "AGERA NU" : "ÄNDRING"}</span>
                    <strong>{message.action.title ?? "Inställningen är uppdaterad"}</strong>
                    {message.action.detail && <span>{message.action.detail}</span>}
                    {actionHref && <Link href={actionHref}>{eventWatchAction ? "Öppna händelsen →" : "Öppna →"}</Link>}
                  </div>
                )}
                {message.role === "assistant" && <CitationLinks blocks={message.blocks} />}
              </div>
            </article>
          );
        })}
        {!conversation?.messages.length && !isCurrentBrief && (
          <div className="assistant-message quiet-message">
            <p>Säg vad du vill följa. Jag sorterar bort resten.</p>
          </div>
        )}
      </section>
      {(isCurrentBrief && brief?.noMaterialChanges && !brief.worldPulse) || quietRunToday ? (
        <section className="quiet-check">
          <strong>Inget väsentligt har ändrats sedan föregående brief.</strong>
          <span>Du behöver inte göra något i dag.</span>
        </section>
      ) : null}
      <ChatComposer conversationId={conversation?.id} />
    </section>
  );
}

function BriefMessage({ brief, text, story = true, showAudio = true }: { brief: BriefView; text?: string; story?: boolean; showAudio?: boolean }) {
  const actionItems = brief.items.filter((item) => item.recommendation === "act" || item.systemicOverride);
  const monitorItems = brief.items.filter((item) => item.recommendation === "monitor" && !item.systemicOverride);
  const actionCount = actionItems.length;
  const monitorCount = monitorItems.length;
  const itemCount = brief.items.length;
  const noActionCount = itemCount - actionCount - monitorCount;
  const lead = actionCount > 0
    ? actionCount === 1
      ? "En sak kräver åtgärd."
      : `${actionCount} saker kräver åtgärd.`
    : monitorCount > 0
      ? "Inget kräver åtgärd i dag."
      : "Ingen åtgärd i dag.";
  const actionLine = actionCount > 0
    ? `${actionCount} ${actionCount === 1 ? "sak kräver" : "saker kräver"} åtgärd nu${monitorCount ? ` · ${monitorCount} bevakas` : ""}.`
    : monitorCount > 0
      ? `${monitorCount} ${monitorCount === 1 ? "sak bevakas" : "saker bevakas"}. Du behöver inte göra något.`
      : brief.worldPulse?.overallStatus === "calm"
        ? "Inga verifierade förändringar kräver åtgärd."
        : "Inget kräver åtgärd just nu.";
  const assessment = text ?? brief.assessment;
  const showAssessment = Boolean(assessment && assessment.trim() && assessment.trim() !== lead && assessment.trim() !== actionLine);
  const narration = createNarration({
    lead,
    actionLine,
    assessment,
    actionItems,
    monitorItems,
    weeklySummary: brief.weeklyRecap?.summary,
    worldSummary: brief.worldPulse?.summary,
    strategicSummary: brief.strategicRadar
      ? [brief.strategicRadar.aiRoadmap.summary, brief.strategicRadar.businessOpportunities.summary, brief.strategicRadar.contexts.summary].join(". ")
      : undefined,
  });
  return (
    <article className="assistant-message brief-message brief-editorial">
      <div className="brief-response-meta">
        <BriefGlyph compact />
        <div>
          <strong>Brief</strong>
          <span>Verifierad morgonbrief</span>
        </div>
        <span className="brief-response-state">I dag</span>
      </div>
      <header className={`brief-decision-hero${story ? " brief-story-hero" : ""}`}>
        {story && (
          <>
            <Image
              alt=""
              className="brief-story-hero-image"
              fill
              sizes="(max-width: 740px) 100vw, 720px"
              src="/images/brief/morning-brief-hero.png"
            />
            <span className="brief-story-hero-shade" aria-hidden="true" />
          </>
        )}
        <div className="brief-decision-hero-content">
          <span className="assistant-label">DET DU BEHÖVER VETA</span>
          <h2>{lead}</h2>
          <p>{actionLine}</p>
          <div className="brief-decision-counts" aria-label="Dagens läge">
            {actionCount > 0 && <span className="brief-decision-counts-action"><strong>{actionCount}</strong> {actionCount === 1 ? "åtgärd nu" : "åtgärder nu"}</span>}
            {monitorCount > 0 && <span><strong>{monitorCount}</strong> bevakas</span>}
            {noActionCount > 0 && <span><strong>{noActionCount}</strong> utan åtgärd</span>}
            {itemCount === 0 && <span><strong>Klart</strong> ingen åtgärd</span>}
          </div>
          {story && <span className="brief-story-hero-credit">AI-illustration · inte händelsefoto</span>}
        </div>
      </header>
      {showAudio && <BriefListener className={story ? "brief-story-listener" : "brief-chat-listener"} label="Lyssna på dagens brief" text={narration} />}
      {showAssessment && <p className="brief-decision-assessment">{assessment}</p>}
      {actionItems.length > 0 && (
        <section className="brief-priorities brief-priorities--action" aria-label="Viktigt nu">
          <div className="brief-section-heading">
            <span>VIKTIGT NU</span>
            <h3>Fakta, konsekvens och åtgärd</h3>
          </div>
          {story && (
            <figure className="brief-story-decision-art">
              <Image alt="" fill sizes="(max-width: 740px) 100vw, 720px" src="/images/brief/decision-data-flow.png" />
              <figcaption>Illustration · visar sammanhang, inte själva händelsen</figcaption>
            </figure>
          )}
          <div className="chat-brief-list">{actionItems.map((item) => <ChatBriefCard item={item} briefId={brief.id} key={item.id} />)}</div>
        </section>
      )}
      {monitorItems.length > 0 && (
        <section className="brief-priorities brief-priorities--monitor" aria-label="Bevakas">
          <div className="brief-section-heading">
            <span>BEVAKAS</span>
            <h3>Ingen åtgärd nu</h3>
          </div>
          <div className="chat-brief-list">{monitorItems.map((item) => <ChatBriefCard item={item} briefId={brief.id} key={item.id} />)}</div>
        </section>
      )}
      {noActionCount > 0 && <p className="brief-checked-note">{noActionCount} {noActionCount === 1 ? "annan sak är" : "andra saker är"} kontrollerad{noActionCount === 1 ? "" : "e"}. Ingen åtgärd.</p>}
      {brief.weeklyRecap && <WeeklyRecapPanel recap={brief.weeklyRecap} id={`brief-${brief.id}-weekly-recap`} />}
      {brief.strategicRadar && <StrategicRadarPanel radar={brief.strategicRadar} id={`brief-${brief.id}-strategic-radar`} />}
      {(brief.worldPulse || brief.marketSnapshot) && (
        <section className="brief-context" aria-label="Värld, ekonomi och marknader">
          <div className="brief-section-heading">
            <span>LÄGET JUST NU</span>
            <h3>{brief.worldPulse ? "Värld, ekonomi och marknader" : "Marknadsläge"}</h3>
          </div>
          {story && brief.worldPulse && (
            <figure className="brief-story-world-art">
              <Image alt="" fill sizes="(max-width: 740px) 100vw, 720px" src="/images/brief/world-pulse.png" />
              <figcaption>Illustration · inte händelsefoto</figcaption>
            </figure>
          )}
          <BriefWorldPulse pulse={brief.worldPulse} marketSnapshot={brief.marketSnapshot} id={`brief-${brief.id}-world-pulse`} />
        </section>
      )}
      {brief.watchlist.length > 0 && (
        <div className="chat-watchlist">
          <strong>Jag bevakar</strong>
          {brief.watchlist.map((watch, index) => <span key={`${watch.question}-${index}`}>{watch.question}</span>)}
        </div>
      )}
      <Link className="brief-message-link" href={`/briefs/${brief.id}`}>Öppna hela briefen</Link>
    </article>
  );
}

function createNarration(input: {
  lead: string;
  actionLine: string;
  assessment: string | undefined;
  actionItems: BriefView["items"];
  monitorItems: BriefView["items"];
  weeklySummary: string | undefined;
  worldSummary: string | undefined;
  strategicSummary: string | undefined;
}) {
  const decisions = input.actionItems.slice(0, 2).map((item) => [
    item.title,
    item.whatChanged,
    item.whyRelevant,
    `Åtgärd nu: ${item.shortTermImpact}`,
  ].join(". "));
  const monitors = input.monitorItems.slice(0, 2).map((item) => `${item.title}. ${item.whyRelevant}`);
  return [input.lead, input.actionLine, input.assessment, ...decisions, ...monitors, input.weeklySummary, input.strategicSummary, input.worldSummary]
    .filter((part): part is string => Boolean(part?.trim()))
    .join(" ")
    .slice(0, 3_600);
}

function HistoricalBriefMessage({ text, brief, briefId }: { text: string; brief: ConversationBriefReference | null; briefId: string | null }) {
  const description = brief?.assessment || text;
  return (
    <article className="assistant-message brief-message historical">
      <div className="brief-response-meta">
        <BriefGlyph compact />
        <div>
          <strong>Tidigare brief</strong>
          <span>{brief?.definitionName ?? "Sparad brief"}</span>
        </div>
      </div>
      <p>{description}</p>
      {briefId && <Link href={`/briefs/${briefId}`}>Öppna {brief?.definitionName ?? "briefen"} →</Link>}
    </article>
  );
}

function BriefGlyph({ compact = false }: { compact?: boolean }) {
  return (
    <span className={`brief-glyph${compact ? " brief-glyph--compact" : ""}`} aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}

function CitationLinks({ blocks }: { blocks: ConversationBlock[] }) {
  const sources = blocks.flatMap((block) => {
    if (block.type !== "citations" || !Array.isArray(block.sources)) return [];
    return block.sources.flatMap((source) => {
      if (!source || typeof source !== "object" || Array.isArray(source)) return [];
      const value = source as { title?: unknown; url?: unknown };
      return typeof value.url === "string" ? [{ title: typeof value.title === "string" ? value.title : value.url, url: value.url }] : [];
    });
  });
  if (!sources.length) return null;
  return (
    <div className="chat-citations" aria-label="Källor för svaret">
      <span className="eyebrow">KÄLLOR</span>
      {sources.map((source) => <a key={source.url} href={source.url} target="_blank" rel="noreferrer">{source.title} ↗</a>)}
    </div>
  );
}
