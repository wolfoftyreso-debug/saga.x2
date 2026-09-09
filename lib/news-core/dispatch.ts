import "server-only";

import {
  fetchSagaGdeltDocCandidates,
  type SagaGdeltConnectorDependencies,
  type SagaGdeltDocQuery,
} from "@/lib/news-core/gdelt";
import {
  fetchSagaGuardianOpenPlatformCandidates,
  type SagaGuardianConnectorDependencies,
  type SagaGuardianOpenPlatformQuery,
} from "@/lib/news-core/guardian";
import {
  fetchSagaRssAtomCandidates,
  type SagaRssAtomConnectorDependencies,
  type SagaRssAtomSourceConfig,
} from "@/lib/news-core/rss-atom";
import type { SagaNewsConnectorResult } from "@/lib/news-core/types";

/**
 * Exact safe configuration union for a future source repository/dispatcher.
 * There is intentionally no generic `url`, `headers`, `apiKey` or fetch
 * method: every provider has its own bounded input shape.
 */
export type SagaNewsConnectorConfig =
  | Readonly<{ connectorKey: "rss_atom"; input: SagaRssAtomSourceConfig }>
  | Readonly<{ connectorKey: "gdelt_doc_2"; input: SagaGdeltDocQuery }>
  | Readonly<{ connectorKey: "guardian_open_platform"; input: SagaGuardianOpenPlatformQuery }>;

export type SagaNewsConnectorDispatcherDependencies = Readonly<{
  rssAtom?: SagaRssAtomConnectorDependencies;
  gdelt?: SagaGdeltConnectorDependencies;
  guardian?: SagaGuardianConnectorDependencies;
}>;

/**
 * Runs exactly one configured connector. The caller owns authorization,
 * source selection, durable leases and persistence; this layer owns only
 * connector validation, fetching and result normalization.
 */
export async function runSagaNewsConnector(
  config: SagaNewsConnectorConfig,
  dependencies: SagaNewsConnectorDispatcherDependencies = {},
): Promise<SagaNewsConnectorResult> {
  switch (config.connectorKey) {
    case "rss_atom":
      return fetchSagaRssAtomCandidates(config.input, dependencies.rssAtom);
    case "gdelt_doc_2":
      return fetchSagaGdeltDocCandidates(config.input, dependencies.gdelt);
    case "guardian_open_platform":
      return fetchSagaGuardianOpenPlatformCandidates(config.input, dependencies.guardian);
  }
}
