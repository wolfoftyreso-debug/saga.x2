import Link from "next/link";
import type { Source, WeeklyRecap, WeeklyRecapItem } from "@/lib/domain/types";
import { formatSwedishDate } from "@/lib/utils/date";

/**
 * A compact week-to-date memory. Its items are rehydrated from already
 * published event updates, so this panel cannot turn an old article into a
 * new claim or quietly introduce a second feed.
 */
export function WeeklyRecapPanel({ recap, id = "weekly-recap" }: { recap: WeeklyRecap; id?: string }) {
  const headingId = `${id}-heading`;
  const hasItems = recap.items.length > 0;
  return (
    <section className="weekly-recap" id={id} aria-labelledby={headingId}>
      <header className="weekly-recap-header">
        <div>
          <p className="weekly-recap-kicker">VECKAN HITTILLS</p>
          <h2 id={headingId}>Det du behöver ha med dig</h2>
        </div>
        <time className="weekly-recap-period" dateTime={recap.periodEnd}>{formatPeriod(recap)}</time>
      </header>

      <p className="weekly-recap-summary">{recap.summary}</p>
      {hasItems ? (
        <ol className="weekly-recap-list">
          {recap.items.map((item) => <WeeklyRecapItemCard item={item} key={item.eventUpdateId} />)}
        </ol>
      ) : (
        <p className="weekly-recap-empty">Inga tidigare publicerade förändringar att lyfta från veckan.</p>
      )}
    </section>
  );
}

function WeeklyRecapItemCard({ item }: { item: WeeklyRecapItem }) {
  return (
    <li className="weekly-recap-item">
      <div className="weekly-recap-item-topline">
        <time dateTime={item.date}>{formatSwedishDate(item.date)}</time>
        <Link href={`/events/${item.eventId}`}>Öppna händelsen →</Link>
      </div>
      <h3>{item.title}</h3>
      <p>{item.whatChanged}</p>
      <p className="weekly-recap-why"><strong>För dig</strong>{item.whyItMatters}</p>
      <Sources sources={item.sources} />
    </li>
  );
}

function Sources({ sources }: { sources: Source[] }) {
  return (
    <details className="weekly-recap-sources">
      <summary>Underlag · {sources.length} {sources.length === 1 ? "källa" : "källor"}</summary>
      <ul>
        {sources.map((source) => (
          <li key={source.url}>
            <a href={source.url} rel="noreferrer" target="_blank">{source.sourceName}</a>
            <span>{source.sourceType === "primary" ? "Primärkälla" : "Verifierande källa"}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function formatPeriod(recap: WeeklyRecap): string {
  if (recap.periodStart === recap.periodEnd) return formatSwedishDate(recap.periodEnd);
  return `${formatSwedishDate(recap.periodStart)}–${formatSwedishDate(recap.periodEnd)}`;
}
