import "server-only";

import { createHash, randomUUID } from "node:crypto";
import {
  runSagaNewsConnector,
  toSagaNewsIngestionBatch,
  type SagaNewsConnectorConfig,
  type SagaNewsConnectorDispatcherDependencies,
} from "@/lib/news-core";
import { SagaNewsCoreError } from "@/lib/news-core/errors";
import type {
  SagaNewsIngestionBatchResult,
  SagaNewsIngestionRun,
  SagaNewsSignalCandidate,
  SagaNewsSource,
  SagaNewsSourceClaim,
  SagaNewsSourceItem,
} from "@/lib/domain/saga-news-core";
import type { AppActor } from "@/lib/neon/auth-repository";
import {
  beginClaimedSagaNewsIngestionRun,
  beginSagaNewsIngestionRun,
  claimDueSagaNewsSources,
  completeClaimedSagaNewsIngestionRun,
  completeSagaNewsIngestionRun,
  failClaimedSagaNewsIngestionRun,
  failSagaNewsIngestionRun,
  getSagaNewsSource,
  listSagaNewsSourceItems,
  listSagaNewsSources,
  persistClaimedSagaNewsConnectorBatch,
  persistSagaNewsConnectorBatch,
  releaseSagaNewsSourceClaim,
  upsertSagaNewsSignalCandidate,
} from "@/lib/neon/saga-news-core-repository";

const GDELT_ENDPOINT = "https://api.gdeltproject.org/api/v2/doc/doc";
const GUARDIAN_ENDPOINT = "https://content.guardianapis.com/search";
const DEFAULT_SIGNAL_WINDOW_MS = 1000 * 60 * 60 * 72;
const DEFAULT_SIGNAL_ITEM_LIMIT = 200;

const SWEDISH_STOP_WORDS = new Set([
  "alla", "allt", "andra", "att", "bara", "blir", "den", "det", "dig", "din", "dina", "ditt",
  "eller", "en", "ens", "era", "ett", "för", "från", "får", "har", "här", "hur", "inte",
  "kan", "med", "men", "mer", "min", "mot", "och", "också", "om", "på", "sin", "sina",
  "som", "ska", "så", "till", "under", "upp", "var", "vara", "varit", "ved", "vi", "vid",
  "vill", "vore", "vår", "våra", "vårt", "över",
]);
const ENGLISH_STOP_WORDS = new Set([
  "about", "after", "also", "and", "are", "as", "at", "be", "been", "by", "for", "from",
  "has", "have", "in", "into", "is", "its", "more", "new", "not", "of", "on", "or", "our",
  "that", "the", "their", "this", "to", "was", "were", "with", "will",
]);

type ConnectorRules = Record<string, unknown>;

export type SagaNewsRunStatus = "completed" | "reused" | "processing" | "failed";

export type SagaNewsSourceRunResult = {
  status: SagaNewsRunStatus;
  source: SagaNewsSource;
  run: SagaNewsIngestionRun;
  batch: SagaNewsIngestionBatchResult | null;
  signals: SagaNewsSignalCandidate[];
  message: string;
};

export type SagaNewsCronResult = {
  claimed: number;
  completed: number;
  failed: number;
  released: number;
  timeBudgetReached: boolean;
  runs: Array<{
    sourceId: string;
    status: "completed" | "failed" | "released" | "skipped";
    runId?: string;
    message: string;
  }>;
};

export type SagaNewsRunnerDependencies = SagaNewsConnectorDispatcherDependencies & {
  now?: () => Date;
  newId?: () => string;
  /** Production uses the hard-coded connector dispatcher. */
  dispatch?: (config: SagaNewsConnectorConfig, dependencies: SagaNewsConnectorDispatcherDependencies) => ReturnType<typeof runSagaNewsConnector>;
  /** Test seam; production always uses the conservative signal reconciler below. */
  reconcileSignals?: (actor: AppActor, source: SagaNewsSource, dependencies: Pick<SagaNewsRunnerDependencies, "now">) => Promise<SagaNewsSignalCandidate[]>;
};

/**
 * Converts one persisted public source into one safe, server-owned connector
 * invocation. There is deliberately no generic URL/header/API-key escape
 * hatch: a source must name one of the adapters installed in this file.
 */
export function sagaNewsConnectorConfigForSource(source: SagaNewsSource): SagaNewsConnectorConfig {
  const rules = connectorRules(source);
  const endpoint = canonicalEndpoint(source.endpointUrl);
  const maxItems = Math.min(source.maxItemsPerRun, 75);

  switch (source.connectorKey) {
    case "rss_atom": {
      if (source.sourceKind !== "rss") {
        throw new SagaNewsCoreError("configuration", "RSS-connectorn kan bara användas för en RSS- eller Atom-källa.", 422);
      }
      return {
        connectorKey: "rss_atom",
        input: {
          sourceId: source.id,
          name: source.name,
          feedUrl: source.endpointUrl,
          // A configured endpoint may only connect to its own final hostname;
          // safe-outbound still rejects local/private DNS destinations.
          allowedHosts: [new URL(source.endpointUrl).hostname],
          language: source.languages[0] ?? null,
          kind: rules.kind === "editorial" ? "editorial" : "official",
          maxItems,
        },
      };
    }
    case "gdelt_doc_2": {
      if (source.sourceKind !== "public_api" || endpoint !== GDELT_ENDPOINT) {
        throw new SagaNewsCoreError("configuration", "GDELT-källan behöver den officiella ArticleList-endpointen och typen offentlig API-källa.", 422);
      }
      return {
        connectorKey: "gdelt_doc_2",
        input: {
          sourceId: source.id,
          query: sagaNewsQueryForSource(source),
          timespan: gdeltTimespanForInterval(source.minimumIntervalMinutes),
          maxRecords: maxItems,
        },
      };
    }
    case "guardian_open_platform": {
      if (source.sourceKind !== "news_api" || endpoint !== GUARDIAN_ENDPOINT) {
        throw new SagaNewsCoreError("configuration", "Guardian-källan behöver den officiella Search-endpointen och typen nyhets-API.", 422);
      }
      if (process.env.SAGA_NEWS_GUARDIAN_COMMERCIAL_LICENSED !== "true") {
        throw new SagaNewsCoreError(
          "configuration",
          "Guardian-källan är avstängd tills en kommersiell användningsrätt har bekräftats i Vercel.",
          503,
        );
      }
      return {
        connectorKey: "guardian_open_platform",
        input: {
          sourceId: source.id,
          query: sagaNewsQueryForSource(source),
          section: asGuardianSection(rules.guardianSection),
          pageSize: Math.min(source.maxItemsPerRun, 50),
        },
      };
    }
    default:
      throw new SagaNewsCoreError("configuration", "Den här källtypen har ännu ingen säker SAGA-connector.", 422);
  }
}

/** A manual check is explicitly scoped to one actor-owned source. */
export async function runSagaNewsSourceNow(
  actor: AppActor,
  options: { sourceId: string; idempotencyKey: string },
  dependencies: SagaNewsRunnerDependencies = {},
): Promise<SagaNewsSourceRunResult> {
  const source = await getSagaNewsSource(actor, options.sourceId);
  if (!source) throw new SagaNewsCoreError("configuration", "Nyhetskällan hittades inte i din arbetsyta.", 404);
  const receipt = await beginSagaNewsIngestionRun(actor, {
    sourceId: source.id,
    idempotencyKey: options.idempotencyKey,
    workerId: "saga-news-manual",
  });

  if (receipt.reused) {
    return reusedRunResult(source, receipt.run);
  }

  return executeActorSourceRun(actor, source, receipt.run, dependencies);
}

/**
 * Bounded Cron companion for the existing Vercel tick. It claims at most two
 * sources, processes one at a time, uses short leases and has no creation,
 * model, send or publication path. A source only becomes due again after its
 * configured interval.
 */
export async function runDueSagaNewsSources(
  options: { limit?: number; timeBudgetMs?: number; workerId?: string } = {},
  dependencies: SagaNewsRunnerDependencies = {},
): Promise<SagaNewsCronResult> {
  const now = dependencies.now ?? (() => new Date());
  const workerId = options.workerId?.trim() || "vercel-saga-news";
  const limit = Math.min(2, Math.max(1, Math.trunc(options.limit ?? 2)));
  const timeBudgetMs = Math.min(30_000, Math.max(5_000, Math.trunc(options.timeBudgetMs ?? 24_000)));
  const startedAt = now().getTime();
  const claims = await claimDueSagaNewsSources({ limit, workerId, leaseSeconds: 90, now: new Date(startedAt) });
  const result: SagaNewsCronResult = { claimed: claims.length, completed: 0, failed: 0, released: 0, timeBudgetReached: false, runs: [] };

  for (const claim of claims) {
    if (now().getTime() - startedAt >= timeBudgetMs) {
      result.timeBudgetReached = true;
      const released = await releaseSagaNewsSourceClaim(claim);
      if (released) result.released += 1;
      result.runs.push({ sourceId: claim.source.id, status: "released", message: "Tidsbudgeten tog slut före hämtningen." });
      continue;
    }

    await executeClaimedSourceRun(claim, workerId, dependencies, result);
  }

  return result;
}

async function executeActorSourceRun(
  actor: AppActor,
  source: SagaNewsSource,
  run: SagaNewsIngestionRun,
  dependencies: SagaNewsRunnerDependencies,
): Promise<SagaNewsSourceRunResult> {
  try {
    const connectorResult = await dispatchSource(source, dependencies);
    const batch = connectorResult.candidates.length
      ? await persistSagaNewsConnectorBatch(actor, { runId: run.id, batch: toSagaNewsIngestionBatch(connectorResult) })
      : null;
    const signals = batch?.insertedCount
      ? await reconcileSignals(actor, source, dependencies)
      : [];
    const completed = await completeSagaNewsIngestionRun(actor, { sourceId: source.id, runId: run.id });
    if (!completed) throw new SagaNewsCoreError("provider_unavailable", "Hämtningskvittot kunde inte slutföras.", 409);
    return {
      status: "completed",
      source,
      run: completed,
      batch,
      signals,
      message: batch
        ? `Hämtade ${batch.receivedCount} underlag och sparade ${batch.insertedCount} nya.`
        : "Källan svarade, men gav inga nya publicerbara underlag.",
    };
  } catch (error) {
    const failure = sagaNewsFailure(error);
    const failed = await failSagaNewsIngestionRun(actor, {
      sourceId: source.id,
      runId: run.id,
      failureCode: failure.code,
      failureSummary: failure.summary,
    }).catch(() => null);
    if (!failed) throw error;
    return {
      status: "failed",
      source,
      run: failed,
      batch: null,
      signals: [],
      message: failure.summary,
    };
  }
}

async function executeClaimedSourceRun(
  claim: SagaNewsSourceClaim,
  workerId: string,
  dependencies: SagaNewsRunnerDependencies,
  result: SagaNewsCronResult,
): Promise<void> {
  let run: SagaNewsIngestionRun | null = null;
  try {
    const receipt = await beginClaimedSagaNewsIngestionRun(claim, {
      idempotencyKey: dependencies.newId?.() ?? randomUUID(),
      workerId,
    });
    run = receipt.run;
    if (receipt.reused) {
      const released = await releaseSagaNewsSourceClaim(claim);
      if (released) result.released += 1;
      result.runs.push({ sourceId: claim.source.id, runId: run.id, status: "skipped", message: "Ett tidigare kvitto finns redan för den här körningen." });
      return;
    }

    const connectorResult = await dispatchSource(claim.source, dependencies);
    const batch = connectorResult.candidates.length
      ? await persistClaimedSagaNewsConnectorBatch(claim, { runId: run.id, batch: toSagaNewsIngestionBatch(connectorResult) })
      : null;
    if (batch?.insertedCount) {
      // The claim is created only by the server-side Cron SQL.  This actor is
      // never request-derived: it carries the source editor only as audit
      // attribution while the lease and every evidence row remain bound to the
      // claim's workspace in Neon.
      await reconcileSignals(systemActorForClaim(claim), claim.source, dependencies);
    }
    const completed = await completeClaimedSagaNewsIngestionRun(claim, { runId: run.id });
    if (!completed) throw new SagaNewsCoreError("provider_unavailable", "Cron-kvittot kunde inte slutföras.", 409);
    result.completed += 1;
    result.runs.push({ sourceId: claim.source.id, runId: completed.id, status: "completed", message: "Källan hämtades och kvitterades." });
  } catch (error) {
    const failure = sagaNewsFailure(error);
    if (run) {
      const failed = await failClaimedSagaNewsIngestionRun(claim, {
        runId: run.id,
        failureCode: failure.code,
        failureSummary: failure.summary,
      }).catch(() => null);
      if (failed) {
        result.failed += 1;
        result.runs.push({ sourceId: claim.source.id, runId: run.id, status: "failed", message: failure.summary });
        return;
      }
    }
    const released = await releaseSagaNewsSourceClaim(claim).catch(() => false);
    if (released) result.released += 1;
    result.failed += 1;
    result.runs.push({ sourceId: claim.source.id, status: released ? "released" : "failed", message: failure.summary });
  }
}

function systemActorForClaim(claim: SagaNewsSourceClaim): AppActor {
  return {
    userId: claim.source.updatedByUserId,
    workspaceId: claim.workspaceId,
    role: "owner",
    email: null,
    displayName: null,
  };
}

function reusedRunResult(source: SagaNewsSource, run: SagaNewsIngestionRun): SagaNewsSourceRunResult {
  if (run.status === "running") {
    return { status: "processing", source, run, batch: null, signals: [], message: "Den här hämtningen pågår redan." };
  }
  if (run.status === "completed") {
    return { status: "reused", source, run, batch: null, signals: [], message: "Det här hämtningskvittot är redan klart." };
  }
  return { status: "failed", source, run, batch: null, signals: [], message: run.failureSummary ?? "Den tidigare hämtningen kunde inte slutföras." };
}

async function dispatchSource(source: SagaNewsSource, dependencies: SagaNewsRunnerDependencies) {
  const dispatch = dependencies.dispatch ?? runSagaNewsConnector;
  const connectorDependencies: SagaNewsConnectorDispatcherDependencies = {
    rssAtom: dependencies.rssAtom,
    gdelt: dependencies.gdelt,
    guardian: dependencies.guardian,
  };
  return dispatch(sagaNewsConnectorConfigForSource(source), connectorDependencies);
}

function reconcileSignals(
  actor: AppActor,
  source: SagaNewsSource,
  dependencies: SagaNewsRunnerDependencies,
): Promise<SagaNewsSignalCandidate[]> {
  return (dependencies.reconcileSignals ?? reconcileSagaNewsSignals)(actor, source, { now: dependencies.now });
}

/**
 * A deliberately conservative, explainable signal pass. It does not infer
 * facts or ask a model to decide whether a claim is true: two independently
 * published titles must share at least two substantive terms in the same
 * three-day window before SAGA creates a qualified editorial lead.
 */
export async function reconcileSagaNewsSignals(
  actor: AppActor,
  source: SagaNewsSource,
  dependencies: Pick<SagaNewsRunnerDependencies, "now"> = {},
): Promise<SagaNewsSignalCandidate[]> {
  const now = dependencies.now?.() ?? new Date();
  const [items, sources] = await Promise.all([
    listSagaNewsSourceItems(actor, { since: new Date(now.getTime() - DEFAULT_SIGNAL_WINDOW_MS), limit: DEFAULT_SIGNAL_ITEM_LIMIT }),
    listSagaNewsSources(actor),
  ]);
  const sourceById = new Map(sources.map((entry) => [entry.id, entry]));
  const candidates = candidateGroupsForSagaNewsItems(items, source.id, now);
  const signals: SagaNewsSignalCandidate[] = [];
  for (const group of candidates) {
    const evidenceSources = group.items.map((item) => sourceById.get(item.sourceId)).filter((entry): entry is SagaNewsSource => Boolean(entry));
    const publisherDomains = new Set(group.items.map((item) => item.publisherDomain));
    if (publisherDomains.size < 2 || evidenceSources.some((entry) => !entry.active || !entry.isAllowed)) continue;
    const averageTrust = Math.round(evidenceSources.reduce((total, entry) => total + entry.trustLevel * 20, 0) / evidenceSources.length);
    const topics = source.topics.length ? source.topics : group.tokens;
    const signal = await upsertSagaNewsSignalCandidate(actor, {
      signalKey: group.signalKey,
      topic: topics.join(", ").slice(0, 240),
      headline: group.items[0]?.title ?? "Ny verifierad signal",
      summary: `${publisherDomains.size} oberoende publicister har nära överlappande rubriker inom samma tidsfönster.`,
      editorialAngle: "",
      evidenceItemIds: group.items.map((item) => item.id),
      scores: {
        sourceCredibility: averageTrust,
        topicalRelevance: source.topics.length ? 100 : Math.min(100, group.tokens.length * 15),
        missionAlignment: 0,
        trendMomentum: Math.min(100, publisherDomains.size * 25 + group.items.length * 12),
        channelSuitability: 0,
      },
      policySnapshot: {
        kind: "deterministic_title_overlap",
        minimumIndependentPublishers: 2,
        windowHours: Math.round(DEFAULT_SIGNAL_WINDOW_MS / (1000 * 60 * 60)),
        matchingTerms: group.tokens,
        conclusion: "Ingen redaktionell slutsats har genererats. Källorna väntar på mänsklig och Lens-styrd bearbetning.",
      },
      state: "qualified",
      requiresHumanReview: true,
      active: true,
    });
    signals.push(signal);
  }
  return signals;
}

export type SagaNewsSignalGroup = { signalKey: string; tokens: string[]; items: SagaNewsSourceItem[] };

/** Pure matching seam covered without DB/network dependencies. */
export function candidateGroupsForSagaNewsItems(
  items: readonly SagaNewsSourceItem[],
  anchorSourceId: string,
  now = new Date(),
): SagaNewsSignalGroup[] {
  const anchors = items.filter((item) => item.sourceId === anchorSourceId && isRecentSagaNewsItem(item, now));
  const seen = new Set<string>();
  const groups: SagaNewsSignalGroup[] = [];
  for (const anchor of anchors) {
    const anchorTokens = substantiveTokens(anchor.title);
    if (anchorTokens.length < 2) continue;
    const matching = items.filter((item) => {
      if (!isRecentSagaNewsItem(item, now)) return false;
      const overlap = sharedTokens(anchorTokens, substantiveTokens(item.title));
      return overlap.length >= 2;
    });
    const publisherDomains = new Set(matching.map((item) => item.publisherDomain));
    if (publisherDomains.size < 2) continue;
    const groupTokens = commonTokens(matching.map((item) => substantiveTokens(item.title)));
    const tokens = (groupTokens.length >= 2 ? groupTokens : sharedTokens(anchorTokens, substantiveTokens(matching.find((item) => item.publisherDomain !== anchor.publisherDomain)?.title ?? ""))).slice(0, 8);
    if (tokens.length < 2) continue;
    const orderedItems = [...matching].sort((left, right) => (left.publishedAt ?? left.firstSeenAt).localeCompare(right.publishedAt ?? right.firstSeenAt));
    const day = (orderedItems[0]?.publishedAt ?? orderedItems[0]?.firstSeenAt ?? now.toISOString()).slice(0, 10);
    const signalKey = `signal-${shortHash(`${day}\n${tokens.slice().sort().join("\n")}`)}`;
    if (seen.has(signalKey)) continue;
    seen.add(signalKey);
    groups.push({ signalKey, tokens, items: orderedItems.slice(0, 50) });
  }
  return groups;
}

function isRecentSagaNewsItem(item: SagaNewsSourceItem, now: Date): boolean {
  const candidate = item.publishedAt ?? item.firstSeenAt;
  const time = new Date(candidate).getTime();
  return Number.isFinite(time) && time >= now.getTime() - DEFAULT_SIGNAL_WINDOW_MS && time <= now.getTime() + 60_000;
}

function substantiveTokens(value: string): string[] {
  return [...new Set(value
    .normalize("NFKD")
    .toLocaleLowerCase("sv-SE")
    .replace(/[\u0300-\u036f]/gu, "")
    .split(/[^a-z0-9åäö]+/u)
    .filter((token) => token.length >= 4 && !SWEDISH_STOP_WORDS.has(token) && !ENGLISH_STOP_WORDS.has(token)))]
    .slice(0, 18);
}

function sharedTokens(left: readonly string[], right: readonly string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((token) => rightSet.has(token));
}

function commonTokens(tokenSets: readonly string[][]): string[] {
  if (!tokenSets.length) return [];
  return tokenSets.slice(1).reduce((shared, tokens) => sharedTokens(shared, tokens), tokenSets[0] ?? []);
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function connectorRules(source: SagaNewsSource): ConnectorRules {
  const additional = source.sourcePolicy.additionalRules;
  return additional && typeof additional === "object" && !Array.isArray(additional)
    ? additional as ConnectorRules
    : {};
}

function sagaNewsQueryForSource(source: SagaNewsSource): string {
  const query = source.topics.map((topic) => topic.trim()).filter(Boolean).join(" OR ");
  if (query.length < 2 || query.length > 500) {
    throw new SagaNewsCoreError("configuration", "En API-källa behöver 1–40 tydliga ämnen som ryms i en kort sökfråga.", 422);
  }
  return query;
}

function gdeltTimespanForInterval(intervalMinutes: number): "15min" | "1h" | "6h" | "24h" | "3d" | "1week" | "1month" {
  if (intervalMinutes <= 15) return "15min";
  if (intervalMinutes <= 60) return "1h";
  if (intervalMinutes <= 360) return "6h";
  if (intervalMinutes <= 1_440) return "24h";
  if (intervalMinutes <= 4_320) return "3d";
  if (intervalMinutes <= 10_080) return "1week";
  return "1month";
}

function canonicalEndpoint(value: string): string {
  const url = new URL(value);
  url.search = "";
  url.hash = "";
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) url.pathname = url.pathname.slice(0, -1);
  return url.toString();
}

function asGuardianSection(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{0,79}$/u.test(trimmed) ? trimmed : undefined;
}

function sagaNewsFailure(error: unknown): { code: string; summary: string } {
  if (error instanceof SagaNewsCoreError) return { code: error.code, summary: error.message.slice(0, 1_000) };
  if (error instanceof Error) return { code: "worker_error", summary: error.message.slice(0, 1_000) || "Källan kunde inte bearbetas." };
  return { code: "worker_error", summary: "Källan kunde inte bearbetas." };
}
