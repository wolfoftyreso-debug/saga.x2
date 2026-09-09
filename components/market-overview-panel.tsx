export type MarketOverviewAvailability = "fresh" | "delayed" | "stale" | "unavailable";
export type MarketOverviewCoverage = "complete" | "partial" | "unavailable";
export type MarketSessionStatus = "open" | "closed" | "delayed" | "pre_open" | "after_hours" | "unknown";

export type MarketInstrument = {
  /** A stable identifier is useful to callers, but never rendered as the title. */
  id?: string;
  /** `label` keeps this presentation model compatible with the persisted brief view. */
  name?: string;
  label?: string;
  value: number | null;
  currency?: string | null;
  changePercent: number | null;
  session: MarketSessionStatus;
};

export type MarketOverview = {
  /** The exact timestamp or explicit human-readable snapshot label supplied by the data layer. */
  asOf: string;
  /** Omit when the storage layer only knows coverage; the view then uses the conservative delayed state. */
  availability?: MarketOverviewAvailability;
  coverage: MarketOverviewCoverage;
  coverageNote?: string | null;
  /** Alias used by the stored brief snapshot. */
  note?: string | null;
  instruments: readonly MarketInstrument[];
  /** Used only by the local product-review route so it can never resemble live data. */
  illustrative?: boolean;
};

const availabilityLabels: Record<MarketOverviewAvailability, string> = {
  fresh: "Senast kontrollerad",
  delayed: "Fördröjd",
  stale: "Äldre data",
  unavailable: "Saknas",
};

const sessionLabels: Record<MarketSessionStatus, string> = {
  open: "Öppen",
  closed: "Stängd",
  delayed: "Fördröjd",
  pre_open: "Förhandel",
  after_hours: "Efterhandel",
  unknown: "Okänd session",
};

/**
 * A compact reference point for the daily orientation. It intentionally has
 * no chart, alert or trading affordance: ordinary price movement is context,
 * not a new event or a recommendation.
 */
export function MarketOverviewPanel({ overview, id = "market-overview" }: { overview: MarketOverview; id?: string }) {
  const headingId = `${id}-heading`;
  const availability = resolvedAvailability(overview);
  const noUsableSnapshot = availability === "unavailable" || overview.coverage === "unavailable";
  const availabilityNote = availabilityMessage(overview, availability, noUsableSnapshot);
  const primaryInstruments = overview.instruments.slice(0, 4);
  const additionalInstruments = overview.instruments.slice(4);

  return (
    <section
      className={`market-overview market-overview--${availability} market-overview--coverage-${overview.coverage}`}
      id={id}
      aria-labelledby={headingId}
    >
      <header className="market-overview-header">
        <div>
          <p className="market-overview-kicker">MARKNADER</p>
          <h2 id={headingId}>Marknadsläge</h2>
        </div>
        <div className="market-overview-stamp">
          <span>{availabilityLabels[availability]}</span>
          <time>{overview.asOf}</time>
        </div>
      </header>

      {availabilityNote && <p className="market-overview-note" role="status">{availabilityNote}</p>}

      {noUsableSnapshot ? (
        <div className="market-overview-empty" role="status">
          <strong>Inga verifierade kurser att visa.</strong>
          <span>Marknadsöversikten visas igen när en tidsstämplad snapshot har kunnat kontrolleras.</span>
        </div>
      ) : (
        <>
          <ul className="market-instrument-list" aria-label="Senaste marknadsnivåer">
            {primaryInstruments.map((instrument, index) => <MarketInstrumentRow instrument={instrument} key={instrument.id ?? instrument.name ?? instrument.label ?? index} />)}
          </ul>
          {additionalInstruments.length > 0 && (
            <details className="market-overview-more">
              <summary>Visa fler marknader</summary>
              <ul className="market-instrument-list market-instrument-list--more" aria-label="Fler marknadsnivåer">
                {additionalInstruments.map((instrument, index) => <MarketInstrumentRow instrument={instrument} key={instrument.id ?? instrument.name ?? instrument.label ?? index} />)}
              </ul>
            </details>
          )}
        </>
      )}

      {overview.illustrative && <p className="market-overview-preview-note"><span>EXEMPEL</span> Inte aktuella kurser.</p>}
    </section>
  );
}

function MarketInstrumentRow({ instrument }: { instrument: MarketInstrument }) {
  const marketValue = typeof instrument.value === "number" && Number.isFinite(instrument.value) ? instrument.value : null;
  const unavailable = marketValue === null;
  const changeTone = changeToneFor(instrument.changePercent);
  const instrumentName = instrument.name ?? instrument.label ?? "Okänt instrument";

  return (
    <li className={`market-instrument ${unavailable ? "market-instrument--unavailable" : ""}`}>
      <div className="market-instrument-name">
        <strong>{instrumentName}</strong>
        <span className={`market-session market-session--${instrument.session}`}>{sessionLabels[instrument.session]}</span>
      </div>
      <div className="market-instrument-value">
        <strong>{marketValue === null ? "—" : formatMarketValue(marketValue)}</strong>
        <span>{instrument.currency ?? "—"}</span>
      </div>
      <span className={`market-instrument-change market-instrument-change--${changeTone}`}>
        {formatChange(instrument.changePercent)}
      </span>
    </li>
  );
}

function resolvedAvailability(overview: MarketOverview): MarketOverviewAvailability {
  if (overview.coverage === "unavailable") return "unavailable";
  // A missing availability is deliberately never upgraded to "fresh" by the
  // presentation layer. The storage adapter must explicitly assert that.
  return overview.availability ?? "delayed";
}

function availabilityMessage(
  overview: MarketOverview,
  availability: MarketOverviewAvailability,
  noUsableSnapshot: boolean,
): string | null {
  if (overview.coverageNote ?? overview.note) return overview.coverageNote ?? overview.note ?? null;
  if (noUsableSnapshot) return "Dagens kurser kunde inte verifieras.";
  if (availability === "stale") return "Senaste verifierade kurserna — inte live.";
  if (availability === "delayed") return "Kurserna är fördröjda.";
  if (overview.coverage === "partial") return "Vissa kurser saknas i den här kontrollen.";
  return null;
}

function changeToneFor(changePercent: number | null): "positive" | "negative" | "neutral" | "unavailable" {
  if (changePercent === null || !Number.isFinite(changePercent)) return "unavailable";
  if (changePercent > 0) return "positive";
  if (changePercent < 0) return "negative";
  return "neutral";
}

function formatMarketValue(value: number): string {
  const maximumFractionDigits = Math.abs(value) < 100 ? 2 : Math.abs(value) < 1_000 ? 1 : 0;
  return new Intl.NumberFormat("sv-SE", { maximumFractionDigits, minimumFractionDigits: 0 }).format(value);
}

function formatChange(changePercent: number | null): string {
  if (changePercent === null || !Number.isFinite(changePercent)) return "Ej tillgänglig";
  const sign = changePercent > 0 ? "+" : "";
  return `${sign}${new Intl.NumberFormat("sv-SE", { maximumFractionDigits: 2, minimumFractionDigits: 2 }).format(changePercent)} %`;
}
