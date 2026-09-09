import Link from "next/link";
import { FeedbackActions } from "@/components/feedback-actions";
import { CategoryLabel, ConfidenceChip, RecommendationChip, StatusChip } from "@/components/status-chip";
import type { BriefItemView } from "@/lib/services/brief-reader";
import { formatSwedishDate } from "@/lib/utils/date";

export function BriefItemCard({ item }: { item: BriefItemView }) {
  return (
    <article className="event-card">
      <div className="card-meta">
        <span><CategoryLabel category={item.category} /></span>
      </div>
      <Link href={`/events/${item.eventId}`} className="card-title-link">
        <h2>{item.title}</h2>
      </Link>
      <div className="chip-row">
        <StatusChip status={item.status} />
        <span className="date-meta">Händelse: {formatSwedishDate(item.eventDate)}</span>
      </div>

      <section className="card-section">
        <h3>Det här behöver du veta</h3>
        <p>{item.whatChanged}</p>
      </section>
      <section className="card-section">
        <h3>Så påverkar det dig</h3>
        <p>{item.whyRelevant}</p>
      </section>
      <div className="impact-grid">
        <section>
          <h3>Gör så här</h3>
          <p>{item.shortTermImpact}</p>
        </section>
        <section>
          <h3>På sikt</h3>
          <p>{item.longTermImpact}</p>
        </section>
      </div>
      <div className="card-footer">
        <div className="chip-row">
          <RecommendationChip recommendation={item.recommendation} />
          <ConfidenceChip confidence={item.confidence} />
          {item.directAlert && <span className="chip chip-alert">Direktnotis</span>}
        </div>
        <span className="source-count">{item.sources.length} källa{item.sources.length === 1 ? "" : "or"}</span>
      </div>
      {item.sources[0] && (
        <a className="source-link" href={item.sources[0].url} target="_blank" rel="noreferrer">
          Källa: {item.sources[0].sourceName} <span aria-hidden="true">↗</span>
        </a>
      )}
      <FeedbackActions
        eventId={item.eventId}
        briefItemId={item.id}
        initialSelected={item.selectedFeedback}
        compact
      />
    </article>
  );
}
