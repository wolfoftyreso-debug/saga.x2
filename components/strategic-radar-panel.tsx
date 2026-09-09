import type { Source, StrategicRadar, StrategicRadarItem, StrategicRadarSection } from "@/lib/domain/types";
import { formatSwedishDate, formatSwedishDateTime } from "@/lib/utils/date";

type RadarSectionDefinition = {
  id: "aiRoadmap" | "businessOpportunities" | "contexts";
  label: string;
  title: string;
};

const sections: readonly RadarSectionDefinition[] = [
  { id: "aiRoadmap", label: "AI-MODELLER", title: "Vad kommer härnäst?" },
  { id: "businessOpportunities", label: "AFFÄRSLÄGEN", title: "Vad är värt att ta tag i?" },
  { id: "contexts", label: "SAMMANHANG", title: "Var bör du vara?" },
];

const coverageLabels: Record<StrategicRadar["coverage"], string> = {
  complete: "Kontrollerad",
  partial: "Delvis kontrollerad",
  unavailable: "Underlag saknas",
};

const sectionLabels: Record<StrategicRadarSection["status"], string> = {
  items_found: "Nytt",
  none_relevant: "Inget nytt",
  unavailable: "Saknas",
};

const itemStatusLabels: Record<StrategicRadarItem["status"], string> = {
  officially_announced: "Officiellt annonserat",
  official_roadmap: "Officiell roadmap",
  announced: "Annonserat",
  open: "Öppet nu",
  deadline: "Deadline",
  upcoming: "Kommande",
  registration_open: "Anmälan öppen",
};

/**
 * A source-backed layer for upcoming capabilities, concrete commercial
 * openings and real-world contexts. It is deliberately not a generic events
 * feed: blank sections say so plainly rather than inventing recommendations.
 */
export function StrategicRadarPanel({ radar, id = "strategic-radar" }: { radar: StrategicRadar; id?: string }) {
  const headingId = `${id}-heading`;
  return (
    <section className={`strategic-radar strategic-radar--${radar.coverage}`} id={id} aria-labelledby={headingId}>
      <header className="strategic-radar-header">
        <div>
          <p className="strategic-radar-kicker">DINA NÄSTA LÄGEN</p>
          <h2 id={headingId}>AI, affärer och sammanhang</h2>
        </div>
        <div className="strategic-radar-stamp">
          <span>{coverageLabels[radar.coverage]}</span>
          <time dateTime={radar.asOf}>{formatSwedishDateTime(radar.asOf)}</time>
        </div>
      </header>

      <ol className="strategic-radar-sections">
        {sections.map((definition) => (
          <RadarSection key={definition.id} definition={definition} section={radar[definition.id]} />
        ))}
      </ol>
    </section>
  );
}

function RadarSection({ definition, section }: { definition: RadarSectionDefinition; section: StrategicRadarSection }) {
  return (
    <li className={`strategic-radar-section strategic-radar-section--${section.status}`}>
      <div className="strategic-radar-section-heading">
        <div>
          <span>{definition.label}</span>
          <h3>{definition.title}</h3>
        </div>
        <em>{sectionLabels[section.status]}</em>
      </div>
      <p className="strategic-radar-summary">{section.summary}</p>
      {section.items.length > 0 && (
        <div className="strategic-radar-items">
          {section.items.map((item, index) => <RadarItem item={item} key={`${item.title}-${item.date ?? index}`} />)}
        </div>
      )}
    </li>
  );
}

function RadarItem({ item }: { item: StrategicRadarItem }) {
  return (
    <article className="strategic-radar-item">
      <div className="strategic-radar-item-topline">
        <span>{itemStatusLabels[item.status]}</span>
        {item.date && <time dateTime={item.date}>{formatSwedishDate(item.date)}{item.endDate ? `–${formatSwedishDate(item.endDate)}` : ""}</time>}
      </div>
      <h4>{item.title}</h4>
      <p>{item.whatChanged}</p>
      <p className="strategic-radar-why"><strong>För dig</strong>{item.whyRelevant}</p>
      <p className="strategic-radar-action"><strong>Gör så här</strong>{item.nextStep}</p>
      {item.location && <p className="strategic-radar-location">{item.location}</p>}
      <RadarSources sources={item.sources} />
    </article>
  );
}

function RadarSources({ sources }: { sources: Source[] }) {
  return (
    <details className="strategic-radar-sources">
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
