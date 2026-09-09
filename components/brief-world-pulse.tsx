import { CompanyFocusPanel } from "@/components/company-focus-panel";
import { MarketOverviewPanel } from "@/components/market-overview-panel";
import { WorldPulsePanel, type WorldPulse as WorldPulsePresentation } from "@/components/world-pulse-panel";
import type { Source, WorldPulse, WorldPulseSection } from "@/lib/domain/types";
import { LEGACY_MARKET_INSTRUMENT_IDS, type MarketSnapshot } from "@/lib/domain/market-snapshot";
import { formatSwedishDateTime } from "@/lib/utils/date";

const COMPANY_FOCUS_INSTRUMENT_IDS = ["tesla", "alphabet", "investor_ab"] as const;

type BriefWorldPulseProps = {
  pulse?: WorldPulse | null;
  marketSnapshot?: MarketSnapshot | null;
  id?: string;
};

/**
 * Keeps the stored, evidence-led pulse separate from the display vocabulary.
 * The presentation intentionally has no event identity: a stable world lens
 * is orientation, never a manufactured registry update or an alert.
 */
export function BriefWorldPulse({ pulse, marketSnapshot, id }: BriefWorldPulseProps) {
  const hasCompanyFocus = Boolean(marketSnapshot?.instruments.some((instrument) => (
    (COMPANY_FOCUS_INSTRUMENT_IDS as readonly string[]).includes(instrument.id)
  )));
  const presentation: WorldPulsePresentation | null = pulse ? {
    asOf: `Kontrollerad ${formatSwedishDateTime(pulse.asOf)}`,
    coverage: pulse.coverage,
    coverageNote: coverageNote(pulse),
    overallStatus: visualOverallStatus(pulse.overallStatus),
    summary: pulse.summary,
    sections: {
      conflictSecurity: mapSection(pulse.conflictSecurity),
      economy: mapSection(pulse.economy),
      personalExposure: mapSection(pulse.personalExposure),
    },
  } : null;

  return (
    <>
      {presentation && <WorldPulsePanel pulse={presentation} id={id} />}
      {marketSnapshot && <MarketOverviewPanel overview={mapMarketSnapshot(marketSnapshot)} id={`${id ?? "brief-context"}-markets`} />}
      {marketSnapshot && hasCompanyFocus && <CompanyFocusPanel snapshot={marketSnapshot} id={`${id ?? "world-pulse"}-company-focus`} />}
    </>
  );
}

function mapMarketSnapshot(snapshot: MarketSnapshot): NonNullable<WorldPulsePresentation["marketOverview"]> {
  return {
    asOf: snapshot.asOf ? `Senast rapporterat ${formatSwedishDateTime(snapshot.asOf)}` : `Kontrollerad ${formatSwedishDateTime(snapshot.fetchedAt)}`,
    // A daily brief is a reference snapshot, not a market terminal. Never
    // upgrade it to fresh merely because the provider returned a response.
    availability: snapshot.coverage === "unavailable" ? "unavailable" : "delayed",
    coverage: snapshot.coverage,
    note: snapshot.note,
    // Keep the broad reference to the core index/FX suite. Explicit company
    // interests get their own panel below instead of disappearing behind
    // “Visa fler marknader”.
    instruments: snapshot.instruments
      .filter((instrument) => (LEGACY_MARKET_INSTRUMENT_IDS as readonly string[]).includes(instrument.id))
      .map((instrument) => ({
      id: instrument.id,
      label: instrument.label,
      value: instrument.value,
      currency: instrument.currency,
      changePercent: instrument.changePercent,
      session: instrument.session,
      })),
  };
}

function mapSection(section: WorldPulseSection): WorldPulsePresentation["sections"]["conflictSecurity"] {
  return {
    headline: section.headline,
    summary: section.summary,
    implication: section.implication ?? implicationFallback(section),
    state: section.status,
    sources: section.sources.map(mapSource),
  };
}

function mapSource(source: Source) {
  return {
    name: source.sourceName,
    url: source.url,
    kind: source.sourceType === "primary" ? "Primärkälla" : "Verifierande källa",
  };
}

function visualOverallStatus(status: WorldPulse["overallStatus"]): WorldPulsePresentation["overallStatus"] {
  if (status === "calm") return "calm";
  if (status === "changed") return "attention";
  return "mixed";
}

function implicationFallback(section: WorldPulseSection): string {
  if (section.status === "unavailable") return "Avvakta en komplett kontroll innan du ändrar något utifrån den här linsen.";
  if (section.status === "uncertain") return "Ingen åtgärd utifrån detta ensamt; invänta verifiering.";
  return "Ingen ny åtgärd behövs utifrån den här linsen.";
}

function coverageNote(pulse: WorldPulse): string | undefined {
  if (pulse.coverage === "complete") return undefined;
  const limitedSections = [pulse.conflictSecurity, pulse.economy, pulse.personalExposure]
    .filter((section) => section.status === "uncertain" || section.status === "unavailable")
    .map((section) => section.coverageNote);
  const uniqueNotes = [...new Set(limitedSections.filter(Boolean))];
  if (pulse.coverage === "unavailable") {
    return uniqueNotes[0] ?? "Dagens lägesbild saknar komplett underlag. Använd senaste kompletta brief som beslutsunderlag tills kontrollen kan göras om.";
  }
  return uniqueNotes.join(" ") || "Dagens lägesbild kunde inte verifieras fullt ut. Använd den som orientering, inte som ett komplett beslutsunderlag.";
}
