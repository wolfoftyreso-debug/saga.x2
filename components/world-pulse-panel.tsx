import { MarketOverviewPanel, type MarketOverview } from "@/components/market-overview-panel";

export type WorldPulseCoverage = "complete" | "partial" | "unavailable";
export type WorldPulseSliceState = "changed" | "stable" | "uncertain" | "unavailable";
export type WorldPulseOverallStatus = "calm" | "mixed" | "attention";

export type WorldPulseSource = {
  name: string;
  url?: string;
  kind?: string;
};

export type WorldPulseSlice = {
  headline: string;
  summary: string;
  implication: string;
  state: WorldPulseSliceState;
  sources?: readonly WorldPulseSource[];
};

export type WorldPulseSections = {
  conflictSecurity: WorldPulseSlice;
  economy: WorldPulseSlice;
  personalExposure: WorldPulseSlice;
};

export type WorldPulse = {
  asOf: string;
  coverage: WorldPulseCoverage;
  coverageNote?: string;
  overallStatus: WorldPulseOverallStatus;
  summary: string;
  sections: WorldPulseSections;
  /** Optional until the separate market-data integration has a verified snapshot. */
  marketOverview?: MarketOverview;
};

const coverageLabels: Record<WorldPulseCoverage, string> = {
  complete: "Kontrollerad",
  partial: "Delvis verifierad",
  unavailable: "Saknar komplett underlag",
};

const sliceStateLabels: Record<WorldPulseSliceState, string> = {
  changed: "Nytt",
  stable: "Oförändrat",
  uncertain: "Osäkert",
  unavailable: "Saknas",
};

/**
 * A deliberately compact context layer for a daily brief. It is not a
 * headline feed: each slice explains the present state and its relevance.
 */
export function WorldPulsePanel({ pulse, id = "world-pulse" }: { pulse: WorldPulse; id?: string }) {
  const headingId = `${id}-heading`;
  const coverageNote = pulse.coverageNote ?? "Dagens genomgång kunde inte verifieras fullt ut. Lita på senaste kompletta brief för beslut tills kontrollen är klar.";
  const slices = [
    { id: "conflict_security", label: "Krig & säkerhet", ...pulse.sections.conflictSecurity },
    { id: "economy_markets", label: "Ekonomi", ...pulse.sections.economy },
    { id: "personal_exposure", label: "Din verksamhet", ...pulse.sections.personalExposure },
  ] as const;

  return (
    <section className={`world-pulse world-pulse--${pulse.overallStatus} world-pulse--coverage-${pulse.coverage}`} id={id} aria-labelledby={headingId}>
      <header className="world-pulse-header">
        <div>
          <p className="world-pulse-kicker">LÄGET I VÄRLDEN</p>
          <h2 id={headingId}>Det här gäller för dig</h2>
        </div>
        <div className="world-pulse-check">
          <span>{coverageLabels[pulse.coverage]}</span>
          <time>{pulse.asOf}</time>
        </div>
      </header>

      <p className="world-pulse-summary">{pulse.summary}</p>
      {pulse.coverage !== "complete" && <p className="world-pulse-coverage-note" role="status">{coverageNote}</p>}

      <ol className="world-pulse-slices">
        {slices.map((slice) => (
          <li className={`world-pulse-slice world-pulse-slice--${slice.id} world-pulse-slice--${slice.state}`} key={slice.id}>
            <div className="world-pulse-slice-topline">
              <h3>{slice.label}</h3>
              <span className="world-pulse-slice-tone">{sliceStateLabels[slice.state]}</span>
            </div>
            <p className="world-pulse-slice-headline">{slice.headline}</p>
            {slice.implication && <p className="world-pulse-slice-implication"><span>Det betyder för dig</span>{slice.implication}</p>}
            <details className="world-pulse-more">
              <summary>Underlag{slice.sources?.length ? ` · ${slice.sources.length} ${slice.sources.length === 1 ? "källa" : "källor"}` : ""}</summary>
              <p className="world-pulse-slice-summary">{slice.summary}</p>
              {slice.sources && slice.sources.length > 0 && <WorldPulseSources sources={slice.sources} />}
            </details>
          </li>
        ))}
      </ol>

      {pulse.marketOverview && <MarketOverviewPanel overview={pulse.marketOverview} id={`${id}-markets`} />}
    </section>
  );
}

function WorldPulseSources({ sources }: { sources: readonly WorldPulseSource[] }) {
  return (
    <ul className="world-pulse-sources">
      {sources.map((source) => (
        <li key={`${source.name}-${source.url ?? "source"}`}>
          {source.url
            ? <a href={source.url} rel="noreferrer" target="_blank">{source.name}</a>
            : <span>{source.name}</span>}
          {source.kind && <small>{source.kind}</small>}
        </li>
      ))}
    </ul>
  );
}
