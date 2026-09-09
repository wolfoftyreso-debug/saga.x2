import {
  DEFAULT_MARKET_INSTRUMENTS,
  marketSnapshotSchema,
  unavailableMarketSnapshot,
  type MarketInstrumentId,
  type MarketInstrumentSnapshot,
  type MarketSessionState,
  type MarketSnapshot,
} from "@/lib/domain/market-snapshot";

const FMP_BASE_URL = "https://financialmodelingprep.com/stable";
export const FMP_MARKET_DATA_DOCS_URL = "https://site.financialmodelingprep.com/developer/docs/stable/index-quote";

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
type FmpCatalogEntry = {
  symbol?: unknown;
  name?: unknown;
  exchange?: unknown;
  currency?: unknown;
  fromCurrency?: unknown;
  toCurrency?: unknown;
  fromName?: unknown;
  toName?: unknown;
};
type FmpQuote = Record<string, unknown>;

type InstrumentDefinition = {
  id: MarketInstrumentId;
  label: string;
  kind: "index" | "forex" | "stock";
  /** Known FMP values are used only to disambiguate a matching catalog name. */
  symbolCandidates: readonly string[];
  nameMatchers: readonly string[];
};

/**
 * We resolve through FMP's current catalog rather than assume a Yahoo-style
 * ticker. This prevents a silent ETF/derivative replacement for OMXS30 or a
 * regional index that happens to have a similar symbol.
 */
const INSTRUMENT_DEFINITIONS: readonly InstrumentDefinition[] = [
  {
    id: "omxs30",
    label: "OMXS30",
    kind: "index",
    symbolCandidates: ["^OMXS30", "OMXS30"],
    nameMatchers: ["omx stockholm 30", "omxs30"],
  },
  {
    id: "sp500",
    label: "S&P 500",
    kind: "index",
    symbolCandidates: ["^GSPC"],
    nameMatchers: ["s&p 500", "s and p 500", "standard and poor 500"],
  },
  {
    id: "nasdaq_composite",
    label: "Nasdaq Composite",
    kind: "index",
    symbolCandidates: ["^IXIC"],
    nameMatchers: ["nasdaq composite"],
  },
  {
    id: "stoxx_europe_600",
    label: "STOXX Europe 600",
    kind: "index",
    symbolCandidates: ["^SXXP", "^STOXX"],
    nameMatchers: ["stoxx europe 600"],
  },
  {
    id: "usd_sek",
    label: "USD/SEK",
    kind: "forex",
    symbolCandidates: ["USDSEK"],
    nameMatchers: ["usd sek", "usdsek", "us dollar swedish krona"],
  },
  {
    id: "eur_sek",
    label: "EUR/SEK",
    kind: "forex",
    symbolCandidates: ["EURSEK"],
    nameMatchers: ["eur sek", "eursek", "euro swedish krona"],
  },
  {
    id: "tesla",
    label: "Tesla",
    kind: "stock",
    symbolCandidates: ["TSLA"],
    nameMatchers: ["tesla"],
  },
  {
    id: "alphabet",
    label: "Alphabet (A)",
    kind: "stock",
    // Alphabet has multiple listed share classes. The catalog must confirm
    // this explicitly selected class before any quote is shown.
    symbolCandidates: ["GOOGL"],
    nameMatchers: ["alphabet"],
  },
  {
    id: "investor_ab",
    label: "Investor AB (B)",
    kind: "stock",
    symbolCandidates: ["INVE-B.ST"],
    nameMatchers: ["investor ab"],
  },
];

export async function collectMarketSnapshot(input: {
  now?: Date;
  apiKey?: string | null;
  fetcher?: FetchLike;
  /** Avoid fetching/persisting focus-company quotes when that module is off. */
  includeCompanyFocus?: boolean;
} = {}): Promise<MarketSnapshot> {
  const now = input.now ?? new Date();
  const includeCompanyFocus = input.includeCompanyFocus !== false;
  const definitions = includeCompanyFocus
    ? INSTRUMENT_DEFINITIONS
    : INSTRUMENT_DEFINITIONS.filter((definition) => definition.kind !== "stock");
  const apiKey = input.apiKey ?? process.env.FMP_API_KEY;
  if (!apiKey?.trim()) {
    return unavailableMarketSnapshot({
      now,
      includeCompanyFocus,
      provider: "not_configured",
      note: "Marknadsdata är inte ansluten ännu. Lägg till en server-side FMP_API_KEY för verifierade index-, valuta- och bolagskurser.",
    });
  }

  const fetcher = input.fetcher ?? fetch;
  try {
    const [indexCatalog, forexCatalog, stockCatalog] = await Promise.all([
      fetchFmpCatalog(fetcher, "/index-list", apiKey),
      fetchFmpCatalog(fetcher, "/forex-list", apiKey),
      includeCompanyFocus ? fetchFmpCatalog(fetcher, "/stock-list", apiKey) : Promise.resolve(null),
    ]);
    const instruments = await Promise.all(definitions.map(async (definition) => {
      const catalog = definition.kind === "index"
        ? indexCatalog
        : definition.kind === "forex"
          ? forexCatalog
          : stockCatalog;
      if (!catalog) {
        return unavailableInstrument(definition, "Marknadsleverantörens instrumentkatalog kunde inte verifieras i denna körning.");
      }
      const match = resolveCatalogInstrument(definition, catalog);
      if (!match) return unavailableInstrument(definition, "Instrumentet kunde inte verifieras i marknadsleverantörens katalog.");

      try {
        const quotePayload = await fetchFmpJson(fetcher, `/quote?symbol=${encodeURIComponent(match.symbol)}`, apiKey);
        const quote = firstRecord(quotePayload);
        const instrument = mapQuote(definition, match, quote);
        return instrument ?? unavailableInstrument(definition, "Marknadsleverantören returnerade ingen komplett, tidsstämplad kurs.", match.symbol);
      } catch {
        return unavailableInstrument(definition, "Kursen kunde inte hämtas från marknadsleverantören just nu.", match.symbol);
      }
    }));

    const available = instruments.filter((instrument) => instrument.availability === "available");
    const coverage = available.length === instruments.length ? "complete" : available.length ? "partial" : "unavailable";
    const snapshot: MarketSnapshot = {
      provider: "fmp",
      providerLabel: "Financial Modeling Prep",
      providerUrl: FMP_MARKET_DATA_DOCS_URL,
      coverage,
      fetchedAt: now.toISOString(),
      asOf: latestQuoteTimestamp(available),
      note: coverage === "complete"
        ? "Kurserna är en referensöversikt, inte köp- eller säljsignaler. Utanför handelsperioden visas senaste tillgängliga kurs."
        : coverage === "partial"
          ? "Vissa kurser kunde inte verifieras i denna körning. Visa inte tomma fält som aktuella marknadsdata."
          : "Marknadsleverantören svarade inte med verifierbara kurser. Använd inte detta som marknadsstatus.",
      instruments,
    };
    return marketSnapshotSchema.parse(snapshot);
  } catch {
    return unavailableMarketSnapshot({
      now,
      includeCompanyFocus,
      note: "Marknadsleverantören kunde inte verifieras i denna körning. Inga gamla kurser visas som om de vore aktuella.",
    });
  }
}

export function resolveCatalogInstrument(definition: InstrumentDefinition, catalog: FmpCatalogEntry[]): { symbol: string; name: string; currency: string | null } | null {
  const entries = catalog
    .map((entry) => ({
      symbol: stringValue(entry.symbol),
      name: stringValue(entry.name) ?? ([stringValue(entry.fromName), stringValue(entry.toName)].filter(Boolean).join(" / ") || null),
      currency: stringValue(entry.currency),
    }))
    .filter((entry): entry is { symbol: string; name: string | null; currency: string | null } => Boolean(entry.symbol));
  const candidateSymbols = new Set(definition.symbolCandidates.map((symbol) => symbol.toLocaleUpperCase("en-US")));
  const matchingName = (entry: { name: string | null }) => {
    if (!entry.name) return false;
    const normalizedName = normalizeCatalogText(entry.name);
    return definition.nameMatchers.some((matcher) => normalizedName.includes(normalizeCatalogText(matcher)));
  };

  // Currency pairs are resolved inside FMP's dedicated FX catalog, so their
  // canonical symbol is sufficiently specific even when the catalog omits a
  // descriptive name field.
  if (definition.kind === "forex") {
    const exactForex = entries.find((entry) => candidateSymbols.has(entry.symbol.toLocaleUpperCase("en-US")));
    if (exactForex) return { ...exactForex, name: exactForex.name ?? definition.label };
  }

  // A vendor symbol needs the expected human name too. This avoids false
  // positives such as a stock or a derivative that reuses a familiar ticker.
  const exact = entries.find((entry) => candidateSymbols.has(entry.symbol.toLocaleUpperCase("en-US")) && matchingName(entry));
  if (exact) return { ...exact, name: exact.name as string };
  const matchingNames = entries.filter(matchingName);
  // A non-unique display-name match is intentionally unsafe: it could be an
  // ETF, price-return variant or a different regional benchmark. Do not pick
  // a convenient substitute simply to fill the screen.
  return matchingNames.length === 1 ? { ...matchingNames[0], name: matchingNames[0].name as string } : null;
}

function mapQuote(
  definition: InstrumentDefinition,
  catalog: { symbol: string; name: string; currency: string | null },
  quote: FmpQuote | null,
): MarketInstrumentSnapshot | null {
  if (!quote) return null;
  const value = numberValue(quote.price) ?? numberValue(quote.close) ?? numberValue(quote.last);
  const asOf = fmpTimestamp(quote.timestamp) ?? fmpTimestamp(quote.lastUpdated) ?? fmpTimestamp(quote.datetime);
  const currency = stringValue(quote.currency) ?? catalog.currency ?? inferredCurrency(definition.id);
  if (value === null || value <= 0 || !currency) return null;

  const marketOpen = booleanValue(quote.isMarketOpen) ?? booleanValue(quote.is_market_open);
  const session: MarketSessionState = marketOpen === true ? "open" : marketOpen === false ? "closed" : "unknown";
  return {
    id: definition.id,
    label: definition.label,
    symbol: catalog.symbol,
    availability: "available",
    value,
    currency,
    change: numberValue(quote.change),
    changePercent: numberValue(quote.changesPercentage) ?? numberValue(quote.changePercent) ?? numberValue(quote.percent_change),
    previousClose: numberValue(quote.previousClose) ?? numberValue(quote.previous_close),
    session,
    asOf,
    note: session === "closed" ? "Senaste tillgängliga kurs; marknaden är stängd." : null,
  };
}

function unavailableInstrument(definition: InstrumentDefinition, note: string, symbol: string | null = null): MarketInstrumentSnapshot {
  return {
    id: definition.id,
    label: definition.label,
    symbol,
    availability: "unavailable",
    value: null,
    currency: null,
    change: null,
    changePercent: null,
    previousClose: null,
    session: "unknown",
    asOf: null,
    note,
  };
}

async function fetchFmpArray(fetcher: FetchLike, path: string, apiKey: string): Promise<FmpCatalogEntry[]> {
  const payload = await fetchFmpJson(fetcher, path, apiKey);
  if (!Array.isArray(payload)) throw new Error("Marknadsleverantörens katalog saknar väntad lista.");
  return payload.filter((entry): entry is FmpCatalogEntry => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry));
}

/**
 * Catalogs are independent coverage domains. If one is unavailable, the
 * remaining verified references still form a partial snapshot instead of
 * being hidden behind a false all-or-nothing failure.
 */
async function fetchFmpCatalog(fetcher: FetchLike, path: string, apiKey: string): Promise<FmpCatalogEntry[] | null> {
  try {
    return await fetchFmpArray(fetcher, path, apiKey);
  } catch {
    return null;
  }
}

async function fetchFmpJson(fetcher: FetchLike, path: string, apiKey: string): Promise<unknown> {
  const response = await fetcher(`${FMP_BASE_URL}${path}`, {
    headers: { apikey: apiKey, accept: "application/json" },
    signal: AbortSignal.timeout(8_000),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Marknadsleverantören svarade ${response.status}.`);
  return response.json();
}

function firstRecord(payload: unknown): FmpQuote | null {
  if (Array.isArray(payload)) {
    const first = payload[0];
    return first && typeof first === "object" && !Array.isArray(first) ? first as FmpQuote : null;
  }
  return payload && typeof payload === "object" && !Array.isArray(payload) ? payload as FmpQuote : null;
}

function latestQuoteTimestamp(instruments: MarketInstrumentSnapshot[]): string | null {
  const timestamps = instruments.map((instrument) => instrument.asOf).filter((value): value is string => Boolean(value));
  if (!timestamps.length) return null;
  return timestamps.sort((a, b) => Date.parse(b) - Date.parse(a))[0];
}

function fmpTimestamp(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value > 10_000_000_000 ? value : value * 1_000).toISOString();
  }
  if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && value.trim() !== "") return fmpTimestamp(numeric);
    // A plain provider date has no unambiguous quote time. `fetchedAt` still
    // tells the reader when the server checked it, but we do not invent an
    // intraday timestamp by treating a local date as UTC.
    if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) return null;
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  return null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const wrappedNegative = /^\s*\(.*\)\s*$/.test(value);
    const parsed = Number(value.replace(/[()% ,]/g, ""));
    return Number.isFinite(parsed) ? (wrappedNegative ? -Math.abs(parsed) : parsed) : null;
  }
  return null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeCatalogText(value: string): string {
  return value
    .toLocaleLowerCase("en-US")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function inferredCurrency(id: MarketInstrumentId): string | null {
  if (id === "omxs30" || id === "usd_sek" || id === "eur_sek") return "SEK";
  if (id === "sp500" || id === "nasdaq_composite" || id === "tesla" || id === "alphabet") return "USD";
  if (id === "stoxx_europe_600") return "EUR";
  if (id === "investor_ab") return "SEK";
  return null;
}

// Keep the exported defaults tied to the persisted schema rather than a
// separate presentation list. It protects against a new UI card becoming a
// hidden extra API call or a client-configurable ticker.
export const MARKET_INSTRUMENTS = DEFAULT_MARKET_INSTRUMENTS;
