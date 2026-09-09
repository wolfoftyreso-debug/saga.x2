import { z } from "zod";

/**
 * Market prices are an orientation layer alongside the daily world pulse.
 * They are deliberately immutable brief snapshots: a market move by itself
 * must never manufacture an event update, recommendation or direct alert.
 */
export const MARKET_SNAPSHOT_COVERAGE = ["complete", "partial", "unavailable"] as const;
export const MARKET_INSTRUMENT_AVAILABILITY = ["available", "unavailable"] as const;
export const MARKET_SESSION_STATES = ["open", "closed", "delayed", "unknown"] as const;
/**
 * The original six instruments remain a supported persisted snapshot shape.
 * New snapshots add the three explicit company equities below. Keeping this
 * list makes old, completed briefs readable after the product expands.
 */
export const LEGACY_MARKET_INSTRUMENT_IDS = [
  "omxs30",
  "sp500",
  "nasdaq_composite",
  "stoxx_europe_600",
  "usd_sek",
  "eur_sek",
] as const;

export const MARKET_INSTRUMENT_IDS = [
  ...LEGACY_MARKET_INSTRUMENT_IDS,
  "tesla",
  "alphabet",
  "investor_ab",
] as const;

/**
 * SpaceX is a named company focus, not a guessed public-market instrument.
 * The absence of a marketInstrumentId is intentional: the UI may follow
 * verified company developments, but must not render a synthetic price.
 */
export const COMPANY_FOCUS_IDS = ["spacex"] as const;
export const COMPANY_FOCUS_MARKET_MODES = ["company_watch_only"] as const;

export type MarketSnapshotCoverage = (typeof MARKET_SNAPSHOT_COVERAGE)[number];
export type MarketInstrumentAvailability = (typeof MARKET_INSTRUMENT_AVAILABILITY)[number];
export type MarketSessionState = (typeof MARKET_SESSION_STATES)[number];
export type MarketInstrumentId = (typeof MARKET_INSTRUMENT_IDS)[number];
export type CompanyFocusId = (typeof COMPANY_FOCUS_IDS)[number];
export type CompanyFocusMarketMode = (typeof COMPANY_FOCUS_MARKET_MODES)[number];

export const marketInstrumentSnapshotSchema = z.object({
  id: z.enum(MARKET_INSTRUMENT_IDS),
  label: z.string().min(2).max(80),
  /** Provider ticker after a server-side catalog lookup; never a client input. */
  symbol: z.string().min(1).max(80).nullable(),
  availability: z.enum(MARKET_INSTRUMENT_AVAILABILITY),
  value: z.number().finite().positive().nullable(),
  currency: z.string().min(2).max(12).nullable(),
  change: z.number().finite().nullable(),
  changePercent: z.number().finite().nullable(),
  previousClose: z.number().finite().positive().nullable(),
  session: z.enum(MARKET_SESSION_STATES),
  /** Provider quote time when supplied. It is distinct from fetchedAt. */
  asOf: z.string().datetime({ offset: true }).nullable(),
  note: z.string().min(3).max(280).nullable(),
}).superRefine((instrument, context) => {
  if (instrument.availability === "available") {
    if (instrument.value === null || instrument.currency === null || instrument.symbol === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "En tillgänglig marknadskurs måste ha värde, valuta och providersymbol.",
      });
    }
  }
  if (instrument.availability === "unavailable" && (instrument.value !== null || instrument.change !== null || instrument.changePercent !== null || instrument.previousClose !== null || instrument.asOf !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "En otillgänglig marknadskurs får inte innehålla gamla eller ofullständiga siffror.",
    });
  }
});

export const companyFocusDefinitionSchema = z.object({
  id: z.enum(COMPANY_FOCUS_IDS),
  label: z.string().min(2).max(80),
  marketMode: z.enum(COMPANY_FOCUS_MARKET_MODES),
  /** Null means no provider-verified equity is connected to this focus. */
  marketInstrumentId: z.null(),
  note: z.string().min(3).max(180),
});

export type CompanyFocusDefinition = z.infer<typeof companyFocusDefinitionSchema>;

export const COMPANY_FOCUS_DEFINITIONS: readonly CompanyFocusDefinition[] = [
  {
    id: "spacex",
    label: "SpaceX",
    marketMode: "company_watch_only",
    marketInstrumentId: null,
    note: "Ingen verifierbar marknadskurs visas.",
  },
];

export const marketSnapshotSchema = z.object({
  provider: z.enum(["fmp", "not_configured", "unavailable"]),
  providerLabel: z.string().min(3).max(80),
  providerUrl: z.string().url().nullable(),
  coverage: z.enum(MARKET_SNAPSHOT_COVERAGE),
  /** The time this server-side snapshot was assembled. */
  fetchedAt: z.string().datetime({ offset: true }),
  /** Latest provider quote among the displayed instruments, when present. */
  asOf: z.string().datetime({ offset: true }).nullable(),
  note: z.string().min(3).max(420).nullable(),
  instruments: z.array(marketInstrumentSnapshotSchema)
    .min(LEGACY_MARKET_INSTRUMENT_IDS.length)
    .max(MARKET_INSTRUMENT_IDS.length),
}).superRefine((snapshot, context) => {
  if (!isSupportedInstrumentSet(snapshot.instruments)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "En marknadsöversikt måste innehålla antingen den äldre sexlistan eller den aktuella standardlistan av instrument.",
      path: ["instruments"],
    });
  }
  const availableCount = snapshot.instruments.filter((instrument) => instrument.availability === "available").length;
  const allUnavailable = availableCount === 0;
  if (snapshot.coverage === "complete" && availableCount !== snapshot.instruments.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Komplett marknadsöversikt kräver samtliga standardinstrument." });
  }
  if (snapshot.coverage === "partial" && (allUnavailable || availableCount === snapshot.instruments.length)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Partiell marknadsöversikt måste innehålla både tillgängliga och otillgängliga instrument." });
  }
  if (snapshot.coverage === "unavailable" && !allUnavailable) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Otillgänglig marknadsöversikt får inte innehålla enstaka kurser." });
  }
});

export type MarketInstrumentSnapshot = z.infer<typeof marketInstrumentSnapshotSchema>;
export type MarketSnapshot = z.infer<typeof marketSnapshotSchema>;

export const DEFAULT_MARKET_INSTRUMENTS: ReadonlyArray<Pick<MarketInstrumentSnapshot, "id" | "label">> = [
  { id: "omxs30", label: "OMXS30" },
  { id: "sp500", label: "S&P 500" },
  { id: "nasdaq_composite", label: "Nasdaq Composite" },
  { id: "stoxx_europe_600", label: "STOXX Europe 600" },
  { id: "usd_sek", label: "USD/SEK" },
  { id: "eur_sek", label: "EUR/SEK" },
  { id: "tesla", label: "Tesla" },
  { id: "alphabet", label: "Alphabet (A)" },
  { id: "investor_ab", label: "Investor AB (B)" },
];

export function unavailableMarketSnapshot(input: {
  now?: Date;
  provider?: "not_configured" | "unavailable";
  note: string;
  /** Company equities are omitted with the whole company-focus module, never replaced by a proxy. */
  includeCompanyFocus?: boolean;
}): MarketSnapshot {
  const fetchedAt = (input.now ?? new Date()).toISOString();
  const instruments = input.includeCompanyFocus === false
    ? DEFAULT_MARKET_INSTRUMENTS.filter((instrument) => (LEGACY_MARKET_INSTRUMENT_IDS as readonly string[]).includes(instrument.id))
    : DEFAULT_MARKET_INSTRUMENTS;
  return marketSnapshotSchema.parse({
    provider: input.provider ?? "unavailable",
    providerLabel: input.provider === "not_configured" ? "Marknadsdata ej ansluten" : "Marknadsdata otillgänglig",
    providerUrl: null,
    coverage: "unavailable",
    fetchedAt,
    asOf: null,
    note: input.note,
    instruments: instruments.map((instrument) => ({
      ...instrument,
      symbol: null,
      availability: "unavailable",
      value: null,
      currency: null,
      change: null,
      changePercent: null,
      previousClose: null,
      session: "unknown",
      asOf: null,
      note: input.note,
    })),
  });
}

function isSupportedInstrumentSet(instruments: readonly { id: MarketInstrumentId }[]): boolean {
  const actualIds = instruments.map((instrument) => instrument.id);
  return [LEGACY_MARKET_INSTRUMENT_IDS, MARKET_INSTRUMENT_IDS].some((expectedIds) => (
    actualIds.length === expectedIds.length
    && new Set(actualIds).size === actualIds.length
    && expectedIds.every((id) => actualIds.includes(id))
  ));
}
