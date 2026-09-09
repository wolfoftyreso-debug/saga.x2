import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { EventConversation } from "@/components/event-conversation";
import { FeedbackActions } from "@/components/feedback-actions";
import { EventWatchButton } from "@/components/event-watch-button";
import { CategoryLabel, ConfidenceChip, StatusChip } from "@/components/status-chip";
import { SetupRequired } from "@/components/setup-required";
import { statusLabels } from "@/lib/domain/event-lifecycle";
import { getEventDetail } from "@/lib/services/brief-reader";
import { getEventConversation } from "@/lib/services/workspace";
import { isSupabasePublicConfigured } from "@/lib/supabase/config";
import { createServerSupabaseClient, getAuthenticatedUserId } from "@/lib/supabase/server";
import { formatSwedishDate, formatSwedishDateTime } from "@/lib/utils/date";
import { notFound, redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function EventDetailPage({ params }: { params: Promise<{ eventId: string }> }) {
  if (!isSupabasePublicConfigured()) return <SetupRequired />;
  const userId = await getAuthenticatedUserId();
  if (!userId) redirect("/login");
  const { eventId } = await params;
  const supabase = await createServerSupabaseClient();
  const [event, conversation] = await Promise.all([
    getEventDetail(supabase, userId, eventId),
    getEventConversation(supabase, userId, eventId),
  ]);
  if (!event) notFound();

  const latestBrief = event.relatedBriefs[0];
  return (
    <AppShell>
      <Link href="/" className="back-link">‹ Chat</Link>
      <header className="event-detail-header">
        <p className="eyebrow"><CategoryLabel category={event.event.category} /></p>
        <h1>{event.event.title}</h1>
        <div className="chip-row">
          <StatusChip status={event.event.status} />
          <ConfidenceChip confidence={event.event.confidence} />
        </div>
        <p className="detail-date">Händelsedatum: {formatSwedishDate(event.event.eventDate)}{event.event.effectiveDate ? ` · I kraft: ${formatSwedishDate(event.event.effectiveDate)}` : ""}</p>
      </header>

      {event.event.termsSummary && <section className="detail-section"><h2>Nuvarande kända villkor</h2><p>{event.event.termsSummary}</p></section>}

      <section className="detail-section">
        <h2>Status och ändringslogg</h2>
        <ol className="timeline">
          {event.updates.map((update) => (
            <li key={update.id}>
              <div className="timeline-status">
                <span>{update.previousStatus ? statusLabels[update.previousStatus] : "Ny händelse"}</span>
                <span aria-hidden="true">→</span>
                <strong>{statusLabels[update.newStatus]}</strong>
              </div>
              <p>{update.changeSummary}</p>
              <span>{formatSwedishDateTime(update.occurredAt)} · {update.kind}</span>
            </li>
          ))}
        </ol>
      </section>

      {latestBrief && (
        <section className="detail-section relevance-section">
          <h2>Varför systemet bedömde den som relevant</h2>
          <p>{latestBrief.whyRelevant}</p>
          <strong>Relevans: {latestBrief.relevanceScore}/100</strong>
        </section>
      )}

      <section className="detail-section">
        <h2>Källkedja</h2>
        <ul className="source-list">
          {event.sources.map((source) => (
            <li key={source.url}>
              <a href={source.url} target="_blank" rel="noreferrer">{source.sourceName} <span aria-hidden="true">↗</span></a>
              <p>{source.supportsClaim}</p>
              <span>{source.sourceType === "primary" ? "Primärkälla" : "Sekundärkälla"} · Publicerad: {formatSwedishDate(source.publishedAt)} · Händelse: {formatSwedishDate(source.eventDate)}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="detail-section">
        <h2>Relaterade briefs</h2>
        <ul className="related-briefs">
          {event.relatedBriefs.map((brief) => <li key={brief.id}><Link href={`/briefs/${brief.id}`}>{formatSwedishDate(brief.briefDate)} · {brief.relevanceScore}/100</Link></li>)}
        </ul>
      </section>
      <section className="detail-section event-conversation-action">
        <h2>Bevaka status</h2>
        <p>Gör händelsen till en pågående bevakning. Frågor och analys fortsätter i den separata tråden nedan.</p>
        <div className="detail-actions">
          <EventWatchButton eventId={event.event.id} />
          <Link className="secondary-button link-button" href="/">Till dagliga briefen</Link>
        </div>
      </section>
      <EventConversation eventId={event.event.id} eventTitle={event.event.title} conversation={conversation} />
      <FeedbackActions eventId={event.event.id} initialSelected={event.selectedFeedback} />
    </AppShell>
  );
}
