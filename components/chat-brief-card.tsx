import Link from "next/link";
import { EventWatchButton } from "@/components/event-watch-button";
import { FeedbackActions } from "@/components/feedback-actions";
import { CategoryLabel, ConfidenceChip, RecommendationChip, StatusChip } from "@/components/status-chip";
import type { BriefItemView } from "@/lib/services/brief-reader";
import { formatSwedishDate } from "@/lib/utils/date";

export function ChatBriefCard({ item, briefId }: { item: BriefItemView; briefId?: string }) {
  const titleId = `decision-card-title-${item.id}`;
  const changeId = `decision-card-change-${item.id}`;
  const relevanceId = `decision-card-relevance-${item.id}`;
  const actionId = `decision-card-action-${item.id}`;
  const sourceLabel = `${item.sources.length} källa${item.sources.length === 1 ? "" : "or"}`;
  const nextStep = {
    act: "Gör detta nu.",
    monitor: "Ingen åtgärd nu. Jag håller koll.",
    no_action: "Ingen åtgärd nu.",
  }[item.recommendation];

  return (
    <article
      className={`chat-brief-card news-segment decision-card news-segment--${item.category} news-segment--${item.recommendation}`}
      aria-labelledby={titleId}
      data-relevance-score={item.relevanceScore}
    >
      <header className="decision-card-header">
        <div className="decision-card-context">
          <span className="decision-card-category"><CategoryLabel category={item.category} /></span>
          <StatusChip status={item.status} />
          {item.directAlert && <span className="chip chip-alert decision-card-priority">Agera nu</span>}
          {item.systemicOverride && <span className="chip chip-neutral decision-card-systemic">Större påverkan</span>}
        </div>

        <Link href={`/events/${item.eventId}`} className="decision-card-title">
          <h3 id={titleId}>{item.title}</h3>
        </Link>
      </header>

      <section className="decision-card-section decision-card-need-to-know" aria-labelledby={changeId}>
        <p className="decision-card-label" id={changeId}>Det här ändrades</p>
        <p className="decision-card-copy">{item.whatChanged}</p>
      </section>

      <section className="decision-card-section decision-card-relevance" aria-labelledby={relevanceId}>
        <p className="decision-card-label" id={relevanceId}>Det betyder för dig</p>
        <p className="decision-card-copy">{item.whyRelevant}</p>
      </section>

      <section className="decision-card-next" aria-labelledby={actionId}>
        <div className="decision-card-next-header">
          <p className="decision-card-label" id={actionId}>Gör så här</p>
          <div className="decision-card-recommendation">
            <RecommendationChip recommendation={item.recommendation} />
            <p>{nextStep}</p>
          </div>
        </div>
        <div className="decision-card-timing" aria-label="När det kan märkas">
          <div className="decision-card-timing-item">
            <p className="decision-card-timing-label">Nu · 30 dagar</p>
            <p>{item.shortTermImpact}</p>
          </div>
          <div className="decision-card-timing-item">
            <p className="decision-card-timing-label">1–24 månader</p>
            <p>{item.longTermImpact}</p>
          </div>
        </div>
      </section>

      <footer className="decision-card-footer">
        <p className="decision-card-trust" aria-label="Händelsedatum, verifiering och källor">
          <span>
            {item.eventDate
              ? <time dateTime={item.eventDate}>Datum {formatSwedishDate(item.eventDate)}</time>
              : <>Datum {formatSwedishDate(item.eventDate)}</>}
          </span>
          <span><ConfidenceChip confidence={item.confidence} /></span>
          <span>{sourceLabel}</span>
        </p>

        <div className="decision-card-actions">
          {briefId && <Link className="chat-brief-link" href={`/briefs/${briefId}`}>Öppna briefen</Link>}
          <EventWatchButton eventId={item.eventId} compact />
        </div>
      </footer>

      <div className="decision-card-feedback">
        <FeedbackActions
          eventId={item.eventId}
          briefItemId={item.id}
          initialSelected={item.selectedFeedback}
          compact
        />
      </div>
    </article>
  );
}
