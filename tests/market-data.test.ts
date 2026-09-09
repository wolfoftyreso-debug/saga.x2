import { describe, expect, it } from "vitest";
import {
  COMPANY_FOCUS_DEFINITIONS,
  marketSnapshotSchema,
  unavailableMarketSnapshot,
} from "@/lib/domain/market-snapshot";
import { collectMarketSnapshot, resolveCatalogInstrument } from "@/lib/services/market-data";

const NOW = new Date("2026-08-19T05:00:00.000Z");

const indexCatalog = [
  { symbol: "^OMXS30", name: "OMX Stockholm 30", currency: "SEK" },
  { symbol: "^GSPC", name: "S&P 500", currency: "USD" },
  { symbol: "^IXIC", name: "NASDAQ Composite", currency: "USD" },
  { symbol: "^SXXP", name: "STOXX Europe 600", currency: "EUR" },
];

const forexCatalog = [
  // FMP catalog entries are allowed to omit one friendly display-name field.
  { symbol: "USDSEK", fromName: "US Dollar", toName: "Swedish Krona" },
  { symbol: "EURSEK", fromName: "Euro", toName: "Swedish Krona" },
];

const stockCatalog = [
  { symbol: "TSLA", name: "Tesla, Inc.", currency: "USD" },
  { symbol: "TSLQ", name: "GraniteShares 2x Short Tesla Daily ETF", currency: "USD" },
  { symbol: "GOOG", name: "Alphabet Inc. Class C", currency: "USD" },
  { symbol: "GOOGL", name: "Alphabet Inc. Class A", currency: "USD" },
  { symbol: "INVE-A.ST", name: "Investor AB ser. A", currency: "SEK" },
  { symbol: "INVE-B.ST", name: "Investor AB ser. B", currency: "SEK" },
];

function marketFetcher(input: string | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  if (url.pathname.endsWith("/index-list")) return Promise.resolve(json(indexCatalog));
  if (url.pathname.endsWith("/forex-list")) return Promise.resolve(json(forexCatalog));
  if (url.pathname.endsWith("/stock-list")) return Promise.resolve(json(stockCatalog));

  const symbol = url.searchParams.get("symbol");
  const values: Record<string, { price: number; currency: string }> = {
    "^OMXS30": { price: 2_684.2, currency: "SEK" },
    "^GSPC": { price: 5_431.6, currency: "USD" },
    "^IXIC": { price: 17_689.4, currency: "USD" },
    "^SXXP": { price: 514.8, currency: "EUR" },
    USDSEK: { price: 10.64, currency: "SEK" },
    EURSEK: { price: 11.21, currency: "SEK" },
    TSLA: { price: 247.58, currency: "USD" },
    GOOGL: { price: 191.8, currency: "USD" },
    "INVE-B.ST": { price: 311.6, currency: "SEK" },
  };
  const quote = symbol ? values[symbol] : null;
  if (!quote) return Promise.resolve(new Response("not found", { status: 404 }));
  expect(init?.headers).toMatchObject({ apikey: "server-secret" });
  expect(url.searchParams.has("apikey")).toBe(false);
  return Promise.resolve(json([{
    symbol,
    price: quote.price,
    currency: quote.currency,
    change: 4.2,
    changesPercentage: "0.42%",
    previousClose: quote.price - 4.2,
    timestamp: 1_787_080_500,
    isMarketOpen: false,
  }]));
}

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

describe("server-side marknadsöversikt", () => {
  it("visar en ärlig, tom status innan en server-side nyckel har anslutits", async () => {
    const snapshot = await collectMarketSnapshot({ now: NOW, apiKey: "" });
    expect(snapshot.provider).toBe("not_configured");
    expect(snapshot.coverage).toBe("unavailable");
    expect(snapshot.instruments).toHaveLength(9);
    expect(snapshot.instruments.every((instrument) => instrument.value === null && instrument.availability === "unavailable")).toBe(true);
  });

  it("slår upp index, FX och uttryckligt valda aktier från leverantörens katalog innan den hämtar kurser", async () => {
    const snapshot = await collectMarketSnapshot({ now: NOW, apiKey: "server-secret", fetcher: marketFetcher });
    expect(snapshot.provider).toBe("fmp");
    expect(snapshot.coverage).toBe("complete");
    expect(snapshot.instruments.map((instrument) => instrument.symbol)).toEqual([
      "^OMXS30",
      "^GSPC",
      "^IXIC",
      "^SXXP",
      "USDSEK",
      "EURSEK",
      "TSLA",
      "GOOGL",
      "INVE-B.ST",
    ]);
    expect(snapshot.instruments.every((instrument) => instrument.session === "closed")).toBe(true);
    expect(snapshot.instruments[0]).toMatchObject({ label: "OMXS30", value: 2684.2, currency: "SEK", changePercent: 0.42 });
    expect(snapshot.instruments.find((instrument) => instrument.id === "tesla")).toMatchObject({ label: "Tesla", symbol: "TSLA", value: 247.58, currency: "USD" });
    expect(snapshot.instruments.find((instrument) => instrument.id === "alphabet")).toMatchObject({ label: "Alphabet (A)", symbol: "GOOGL", value: 191.8, currency: "USD" });
    expect(snapshot.instruments.find((instrument) => instrument.id === "investor_ab")).toMatchObject({ label: "Investor AB (B)", symbol: "INVE-B.ST", value: 311.6, currency: "SEK" });
    expect(snapshot.instruments.map((instrument) => instrument.id)).not.toContain("spacex");
    expect(snapshot.asOf).toBe("2026-08-18T19:15:00.000Z");
  });

  it("väljer den verifierade Alphabet-klassen i stället för en annan aktieklass eller en namnlika fond", () => {
    const result = resolveCatalogInstrument({
      id: "alphabet" as const,
      label: "Alphabet (A)",
      kind: "stock" as const,
      symbolCandidates: ["GOOGL"],
      nameMatchers: ["alphabet"],
    }, stockCatalog);
    expect(result).toEqual({ symbol: "GOOGL", name: "Alphabet Inc. Class A", currency: "USD" });
  });

  it("väljer inte en godtycklig namnlika indexvariant", () => {
    const definition = {
      id: "omxs30" as const,
      label: "OMXS30",
      kind: "index" as const,
      symbolCandidates: ["^OMXS30"],
      nameMatchers: ["omx stockholm 30"],
    };
    const result = resolveCatalogInstrument(definition, [
      { symbol: "OTHER-1", name: "OMX Stockholm 30 Net Return" },
      { symbol: "OTHER-2", name: "OMX Stockholm 30 Gross Return" },
    ]);
    expect(result).toBeNull();
  });

  it("gör en misslyckad delkurs synligt partiell i stället för att återanvända gamla siffror", async () => {
    const fetcher = (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.searchParams.get("symbol") === "^OMXS30") return Promise.resolve(new Response("down", { status: 503 }));
      return marketFetcher(input, init);
    };
    const snapshot = await collectMarketSnapshot({ now: NOW, apiKey: "server-secret", fetcher });
    const omx = snapshot.instruments.find((instrument) => instrument.id === "omxs30");
    expect(snapshot.coverage).toBe("partial");
    expect(omx).toMatchObject({ availability: "unavailable", symbol: "^OMXS30", value: null, changePercent: null });
  });

  it("behåller verifierade index och valutor när aktiekatalogen tillfälligt saknas", async () => {
    const fetcher = (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/stock-list")) return Promise.resolve(new Response("down", { status: 503 }));
      return marketFetcher(input, init);
    };
    const snapshot = await collectMarketSnapshot({ now: NOW, apiKey: "server-secret", fetcher });

    expect(snapshot.coverage).toBe("partial");
    expect(snapshot.instruments.filter((instrument) => ["tesla", "alphabet", "investor_ab"].includes(instrument.id)))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "tesla", availability: "unavailable", value: null }),
        expect.objectContaining({ id: "alphabet", availability: "unavailable", value: null }),
        expect.objectContaining({ id: "investor_ab", availability: "unavailable", value: null }),
      ]));
    expect(snapshot.instruments.filter((instrument) => ["omxs30", "sp500", "usd_sek"].includes(instrument.id)))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "omxs30", availability: "available" }),
        expect.objectContaining({ id: "sp500", availability: "available" }),
        expect.objectContaining({ id: "usd_sek", availability: "available" }),
      ]));
  });

  it("avvisar ett otillgängligt snapshot som ändå innehåller gamla kurser", () => {
    const invalid = unavailableMarketSnapshot({ now: NOW, note: "Ingen marknadsanslutning." });
    invalid.instruments[0] = { ...invalid.instruments[0], value: 2_000 };
    expect(marketSnapshotSchema.safeParse(invalid).success).toBe(false);
  });

  it("läser äldre sex-instrumentsnapshots men avvisar en halv ny standardlista", () => {
    const legacy = unavailableMarketSnapshot({ now: NOW, note: "Ingen marknadsanslutning." });
    legacy.instruments = legacy.instruments.slice(0, 6);
    expect(marketSnapshotSchema.safeParse(legacy).success).toBe(true);

    const incompleteCurrent = unavailableMarketSnapshot({ now: NOW, note: "Ingen marknadsanslutning." });
    incompleteCurrent.instruments.pop();
    expect(marketSnapshotSchema.safeParse(incompleteCurrent).success).toBe(false);
  });

  it("håller SpaceX som bolagsbevakning utan kopplad aktiekurs", () => {
    expect(COMPANY_FOCUS_DEFINITIONS).toEqual([{
      id: "spacex",
      label: "SpaceX",
      marketMode: "company_watch_only",
      marketInstrumentId: null,
      note: "Ingen verifierbar marknadskurs visas.",
    }]);
  });
});
