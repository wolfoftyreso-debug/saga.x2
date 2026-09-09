import { COMPANY_FOCUS_DEFINITIONS, type MarketInstrumentSnapshot, type MarketSnapshot } from "@/lib/domain/market-snapshot";
import { formatSwedishDateTime } from "@/lib/utils/date";

const EQUITY_FOCUS = ["tesla", "alphabet", "investor_ab"] as const;

const sessionLabels: Record<MarketInstrumentSnapshot["session"], string> = {
  open: "Öppen",
  closed: "Stängd",
  delayed: "Fördröjd",
  unknown: "Okänd session",
};

/**
 * The named company layer is deliberately separate from the broad market
 * reference. It keeps a user-requested company focus visible without
 * suggesting that ordinary price moves are recommendations or registry news.
 */
export function CompanyFocusPanel({ snapshot, id = "company-focus" }: { snapshot: MarketSnapshot; id?: string }) {
  const headingId = `${id}-heading`;
  const instrumentsById = new Map(snapshot.instruments.map((instrument) => [instrument.id, instrument]));
  const snapshotTime = snapshot.asOf ?? snapshot.fetchedAt;
  const stamp = snapshot.coverage === "unavailable" ? "Kurser saknas" : snapshot.coverage === "partial" ? "Delvis data" : "Senaste tillgängliga";

  return (
    <section className={`company-focus company-focus--${snapshot.coverage}`} id={id} aria-labelledby={headingId}>
      <header className="company-focus-header">
        <div>
          <p className="company-focus-kicker">FOKUSBOLAG</p>
          <h2 id={headingId}>Dina bolag</h2>
        </div>
        <span className="company-focus-stamp">{stamp}</span>
      </header>

      <p className="company-focus-intro">Tesla, Alphabet och Investor AB som marknadsreferens. SpaceX följs som bolag – utan påhittad kurs.</p>

      <ul className="company-focus-list" aria-label="Dina fokusbolag">
        {EQUITY_FOCUS.map((id) => <PublicCompanyRow instrument={instrumentsById.get(id)} key={id} />)}
        {COMPANY_FOCUS_DEFINITIONS.map((company) => (
          <li className="company-focus-row company-focus-row--watch" key={company.id}>
            <div className="company-focus-name">
              <strong>{company.label}</strong>
              <span>Bolagsbevakning</span>
            </div>
            <div className="company-focus-watch-copy">
              <strong>Ingen kurs</strong>
              <span>{company.note}</span>
            </div>
          </li>
        ))}
      </ul>

      <footer className="company-focus-footer">
        <time>Kontrollerad {formatSwedishDateTime(snapshotTime)}</time>
        <span>Prisnivåer är orientering, inte råd.</span>
      </footer>
    </section>
  );
}

function PublicCompanyRow({ instrument }: { instrument: MarketInstrumentSnapshot | undefined }) {
  const marketValue = instrument?.availability === "available" && typeof instrument.value === "number" ? instrument.value : null;
  const isAvailable = marketValue !== null;
  const currency = isAvailable && instrument ? instrument.currency : null;
  const changePercent = instrument && instrument.availability === "available" ? instrument.changePercent : null;
  const changeTone = changePercent === null ? "unavailable" : changePercent > 0 ? "positive" : changePercent < 0 ? "negative" : "neutral";
  const label = instrument?.label ?? "Kurs saknas";

  return (
    <li className={`company-focus-row${isAvailable ? "" : " company-focus-row--unavailable"}`}>
      <div className="company-focus-name">
        <strong>{label}</strong>
        <span>{instrument ? sessionLabels[instrument.session] : "Inte tillgänglig"}</span>
      </div>
      <div className="company-focus-price">
        <strong>{marketValue === null ? "—" : formatMarketValue(marketValue)}</strong>
        <span>{currency ?? "Ingen verifierad kurs"}</span>
      </div>
      <span className={`company-focus-change company-focus-change--${changeTone}`}>{formatChange(changePercent)}</span>
    </li>
  );
}

function formatMarketValue(value: number): string {
  const maximumFractionDigits = Math.abs(value) < 100 ? 2 : Math.abs(value) < 1_000 ? 1 : 0;
  return new Intl.NumberFormat("sv-SE", { maximumFractionDigits }).format(value);
}

function formatChange(changePercent: number | null): string {
  if (changePercent === null || !Number.isFinite(changePercent)) return "Kurs saknas";
  const sign = changePercent > 0 ? "+" : "";
  return `${sign}${new Intl.NumberFormat("sv-SE", { maximumFractionDigits: 2, minimumFractionDigits: 2 }).format(changePercent)} %`;
}
