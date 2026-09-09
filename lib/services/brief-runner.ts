import { preparePublishItems, prepareRegistryItems, selectEditorialEventContext, type KnownUpdate, type RegistryItem, type StoredEvent, type UserEventState } from "@/lib/domain/editorial-gate";
import { applyFeedbackHistory, feedbackContext, type FeedbackRecord } from "@/lib/domain/feedback-learning";
import { editorialInput, editorialInstructions, discoveryInstructions, type WeeklyRecapSelectionContext } from "@/lib/openai/prompts";
import { normalizeWebCitationUrl, runDiscovery, runEditorial, type ModelCallMetadata } from "@/lib/openai/responses";
import { getOpenAIModel } from "@/lib/openai/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { getProfile } from "@/lib/services/brief-reader";
import { getEffectiveSourcePolicies, getProfileContext } from "@/lib/services/workspace";
import { getFlowControls } from "@/lib/services/flow-controls";
import { canDeliverDirectAlertNow, resolvePrimaryBriefModules, type FlowControls } from "@/lib/domain/flow-controls";
import { allowedDomainsForPolicy, evaluateSourceEvidence, filterSourcesByPolicy, sourcePolicyPromptContext, type SourcePolicyRecord, type SourceRole } from "@/lib/domain/source-catalog";
import { hasSufficientVerification, normalizePublicationSources, sourceDomain, validateSourceDates } from "@/lib/domain/source-policy";
import { canAttemptWatchDelivery, nextWatchDeliveryAttempt, shouldDeliverBriefToConversation, watchMatchesMaterialChange, type WatchDeliveryState } from "@/lib/domain/watch-delivery";
import { hasIndependentEditorialSources, requiresIndependentConflictEvidence, shouldPublishDailyWorldPulse } from "@/lib/domain/world-pulse";
import { strategicRadarSchema, weeklyRecapSchema, worldPulseSchema, type EditorialCandidate, type ProfileSettings, type Source, type StrategicRadar, type StrategicRadarItem, type StrategicRadarSection, type UpdateKind, type WeeklyRecap, type WorldPulse, type WorldPulseSection } from "@/lib/domain/types";
import type { MarketSnapshot } from "@/lib/domain/market-snapshot";
import { collectMarketSnapshot } from "@/lib/services/market-data";
import { localDateInTimezone } from "@/lib/utils/date";

type TriggeredBy = "cron" | "manual" | "retry";
type RawRecord = Record<string, unknown>;
type SourceRunContext = {
  allowedDomains: string[];
  citedUrls: string[];
  purpose: "brief" | "watch";
  cadence?: "daily" | "weekly";
  now: Date;
  timezone: string;
};
type EventContextRow = {
  id: string;
  canonical_key: string;
  title: string;
  category: string;
  actors: unknown;
  regions: unknown;
  status: StoredEvent["status"];
  latest_terms_summary: string | null;
  effective_date: string | null;
  confidence: string;
  latest_short_term_impact: string | null;
  latest_long_term_impact: string | null;
};
type UserEventStateRow = { event_id: string; last_published_update_id: string | null };
type EventUpdateContextRow = {
  id: string;
  event_id: string;
  material_fingerprint: string;
  previous_status: StoredEvent["status"] | null;
  new_status: StoredEvent["status"];
  occurred_at: string;
};
type WeeklyRecapBriefItemRow = {
  event_id: string;
  event_update_id: string | null;
  title_snapshot: string;
  what_changed: string;
  why_relevant: string;
  relevance_score: number;
};
type WeeklyRecapUpdateRow = {
  id: string;
  event_id: string;
  occurred_at: string;
};
type WeeklyRecapSourceRow = {
  event_id: string;
  event_update_id: string | null;
  source_name: string;
  url: string;
  source_type: Source["sourceType"];
  published_at: string | null;
  event_date: string | null;
  supports_claim: string;
};
type WeeklyRecapStoredItem = WeeklyRecapSelectionContext["items"][number] & {
  sources: Source[];
};
export type WeeklyRecapContext = Omit<WeeklyRecapSelectionContext, "items"> & {
  items: WeeklyRecapStoredItem[];
};
type FeedbackContextRow = FeedbackRecord["type"] extends infer T ? { event_id: string; type: T } : never;
type ActiveWatchRow = {
  id: string;
  event_id: string | null;
  kind: "event" | "topic";
  title: string;
  query_text: string | null;
  trigger_statuses: unknown;
  only_material_change: boolean;
};
type WatchDeliveryRow = {
  id: string;
  watch_id: string;
  event_update_id: string;
  delivery_state: Exclude<WatchDeliveryState, "delivering" | "suppressed">;
  attempt_count: number;
  next_attempt_at: string | null;
  conversation_message_id: string | null;
};
type PendingWatchDeliveryRow = WatchDeliveryRow & {
  watches: {
    id: string;
    user_id: string;
    title: string;
    trigger_statuses: unknown;
    event_id: string | null;
  } | null;
  event_updates: {
    id: string;
    event_id: string;
    change_summary: string;
    new_status: string;
    kind: UpdateKind;
    events: { id: string; title: string } | null;
  } | null;
};
type DirectAlertDeliveryState = "pending" | "delivering" | "delivered" | "failed";
type DirectAlertDeliveryRow = {
  id: string;
  user_id: string;
  event_id: string;
  event_update_id: string;
  brief_id: string | null;
  conversation_message_id: string | null;
  delivery_state: DirectAlertDeliveryState;
  attempt_count: number;
  claimed_at: string | null;
  next_attempt_at: string | null;
};
type DirectAlertBriefItem = {
  event_id: string;
  event_update_id: string;
  title_snapshot: string;
  what_changed: string;
  why_relevant: string;
  recommendation: "act" | "monitor" | "no_action";
  confidence: "high" | "medium" | "low";
};
type BriefDefinitionRow = {
  id: string;
  is_primary: boolean;
  name: string;
  instructions: string;
  cadence: "daily" | "weekly";
  timezone: string;
  local_time: string;
  max_items: number;
  brief_depth: "short" | "deep";
  relevance_threshold: number;
  alert_threshold: number;
  only_when_changed: boolean;
};

export type BriefRunResult = {
  briefId: string | null;
  itemCount: number;
  quietDay: boolean;
  runId: string | null;
  alreadyPublished: boolean;
};

export type WatchMonitorResult = {
  runId: string | null;
  candidateCount: number;
  registryItemCount: number;
  deliveredCount: number;
  skipped: boolean;
  reason?: string;
};

export class BriefRunError extends Error {
  constructor(message: string, readonly runId?: string) {
    super(message);
    this.name = "BriefRunError";
  }
}

export async function runDailyBrief(input: {
  userId: string;
  triggeredBy: TriggeredBy;
  briefDefinitionId?: string;
  now?: Date;
}): Promise<BriefRunResult> {
  const database = createAdminClient();
  const profile = await getProfile(database, input.userId);
  if (!profile) throw new BriefRunError("Ingen profil hittades för den konfigurerade användaren.");
  const flowControls = await getFlowControls(database, input.userId);
  const definition = await getBriefDefinition(database, input.userId, input.briefDefinitionId);
  const briefProfile = applyBriefDefinition(profile.settings, definition);
  const primaryModules = resolvePrimaryBriefModules(definition.is_primary, flowControls);
  const includeWorldPulse = primaryModules.worldPulse;
  const includeWeeklyRecap = primaryModules.weeklyRecap;
  const includeStrategicRadar = primaryModules.strategicRadar;
  const includeMarketSnapshot = primaryModules.marketSnapshot;
  const includeCompanyFocus = primaryModules.companyFocus;

  const now = input.now ?? new Date();
  const briefDate = localDateInTimezone(briefProfile.timezone, now);
  const existingBrief = await getCompleteBriefForDate(database, input.userId, definition.id, briefDate);
  if (existingBrief) {
    // A completed database brief must never stop a transient chat-delivery
    // failure from being repaired on the next cron wake-up.
    await Promise.all([
      publishBriefToConversation(
        database,
        input.userId,
        existingBrief.id,
        existingBrief.assessment ?? "Inget väsentligt har förändrats sedan föregående brief. Du behöver inte agera på något i dag.",
        existingBrief.item_count,
        definition.only_when_changed,
        Boolean(existingBrief.worldPulse),
        existingBrief.no_material_changes,
      ),
      retryPendingWatchDeliveries(database, input.userId, now),
        queueDirectAlertsForBrief(database, input.userId, existingBrief.id, now, flowControls, briefProfile.timezone),
    ]);
    return {
      briefId: existingBrief.id,
      itemCount: existingBrief.item_count,
      quietDay: existingBrief.no_material_changes,
      runId: null,
      alreadyPublished: true,
    };
  }
  // only_when_changed deliberately leaves no `briefs` row on a quiet pass.
  // A completed non-watch run is therefore the idempotency guard for the rest
  // of that local date; watch monitor runs use triggered_by='watch' and do not
  // satisfy this query.
  const completedQuietRun = await getCompleteDailyRunForDate(database, input.userId, definition.id, briefDate);
  if (completedQuietRun && definition.only_when_changed) {
    await Promise.all([
      retryPendingWatchDeliveries(database, input.userId, now),
      retryPendingDirectAlerts(database, input.userId, now, flowControls, briefProfile.timezone),
    ]);
    return {
      briefId: null,
      itemCount: 0,
      quietDay: true,
      runId: null,
      alreadyPublished: true,
    };
  }
  await recoverStaleRun(database, input.userId, definition.id, briefDate, now);
  const coverageFrom = await getCoverageStart(database, input.userId, definition.id, now, "brief");
  const [context, sourcePolicies, activeWatches, profileContext] = await Promise.all([
    loadEditorialContext(database, input.userId, definition.id),
    getEffectiveSourcePolicies(database, input.userId, definition.id),
    loadActiveWatches(database, input.userId),
    getProfileContext(database, input.userId),
  ]);
  const discoveryPolicyDomains = allowedDomainsForPolicy(sourcePolicies, {
    roles: "discovery",
    purpose: "brief",
    cadence: definition.cadence,
    now,
    timezone: briefProfile.timezone,
  });
  const editorialPolicyDomains = allowedDomainsForPolicy(sourcePolicies, {
    roles: ["verification", "citation"],
    purpose: "brief",
    cadence: definition.cadence,
    now,
    timezone: briefProfile.timezone,
  });
  const configuredDomains = process.env.BRIEF_ALLOWED_DOMAINS
    ?.split(",")
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);
  const discoveryDomains = restrictConfiguredDomains(discoveryPolicyDomains, configuredDomains);
  const editorialDomains = restrictConfiguredDomains(editorialPolicyDomains, configuredDomains);
  if (!discoveryDomains.length || !editorialDomains.length) {
    const message = "Inga källor är tillåtna för den här briefen. Återaktivera minst en källa eller justera BRIEF_ALLOWED_DOMAINS.";
    const runId = await recordPreflightFailure(database, {
      userId: input.userId,
      briefDefinitionId: definition.id,
      briefDate,
      triggeredBy: input.triggeredBy,
      coverageFrom,
      now,
      message,
      searchMetadata: { discoveryDomainCount: discoveryDomains.length, editorialDomainCount: editorialDomains.length },
    });
    throw new BriefRunError(message, runId ?? undefined);
  }
  const effectiveProfile = applyFeedbackHistory(briefProfile, context.events, context.feedback);
  const learnedFeedback = feedbackContext(context.events, context.feedback);
  const weeklyRecapContext = includeWeeklyRecap
    ? await loadWeeklyRecapContext(database, {
      userId: input.userId,
      briefDefinitionId: definition.id,
      periodStart: startOfWeekInTimezone(briefProfile.timezone, now),
      periodEnd: briefDate,
      timezone: briefProfile.timezone,
      sourcePolicies,
    })
    : null;
  // This is a separate, server-owned factual snapshot. It is intentionally
  // neither an event candidate nor model input, so an ordinary market move
  // cannot turn into a decision card or a direct notification.
  const marketSnapshot: MarketSnapshot | null = includeMarketSnapshot
    ? await collectMarketSnapshot({ now, includeCompanyFocus })
    : null;
  const { data: run, error: runError } = await database
    .from("processing_runs")
    .insert({
      user_id: input.userId,
      brief_definition_id: definition.id,
      local_brief_date: briefDate,
      triggered_by: input.triggeredBy,
      state: "running",
      phase: "discovery",
      started_at: now.toISOString(),
      coverage_from: coverageFrom,
      model_name: getOpenAIModel(),
    })
    .select("id")
    .single();
  if (runError || !run) {
    throw new BriefRunError(runError?.message ?? "Kunde inte starta dagens körning.");
  }

  let activeModelStage: "discovery" | "editorial" | null = "discovery";
  try {
    const discoveryResponse = await runDiscovery(
      discoveryInstructions({
        profile: effectiveProfile,
        coverageFrom,
        now: now.toISOString(),
        feedback: learnedFeedback,
        explicitWatches: activeWatches.map((watch) => watch.query_text ?? watch.title).filter(Boolean).slice(0, 20),
        briefInstructions: definition.instructions,
        personalContext: profileContext,
        sourcePolicyGuidance: sourcePolicyPromptContext(sourcePolicies, { roles: "discovery", purpose: "brief", cadence: definition.cadence, now, timezone: briefProfile.timezone }),
        runPurpose: "brief",
        includeWorldPulse,
        includeStrategicRadar,
      }),
      discoveryDomains,
    );
    const discovery = {
      ...discoveryResponse,
      result: {
        ...discoveryResponse.result,
        candidates: discoveryResponse.result.candidates
          .map((candidate) => ({
            ...candidate,
            sources: filterRunSources(candidate.sources, sourcePolicies, "discovery", sourceSubject(candidate), {
              allowedDomains: discoveryDomains,
              citedUrls: discoveryResponse.metadata.webCitationUrls,
              purpose: "brief",
              cadence: definition.cadence,
              now,
              timezone: briefProfile.timezone,
            }),
          }))
          .filter((candidate) => candidate.sources.length > 0),
        worldPulseScan: includeWorldPulse
          ? filterWorldPulseScanSources(discoveryResponse.result.worldPulseScan, sourcePolicies, {
            allowedDomains: discoveryDomains,
            citedUrls: discoveryResponse.metadata.webCitationUrls,
            purpose: "brief",
            cadence: definition.cadence,
            now,
            timezone: briefProfile.timezone,
          })
          : null,
        strategicRadarScan: includeStrategicRadar
          ? filterStrategicRadarScanSources(discoveryResponse.result.strategicRadarScan, sourcePolicies, {
            allowedDomains: discoveryDomains,
            citedUrls: discoveryResponse.metadata.webCitationUrls,
            purpose: "brief",
            cadence: definition.cadence,
            now,
            timezone: briefProfile.timezone,
          })
          : null,
      },
    };
    activeModelStage = null;
    await logModelCall(database, run.id, "discovery", discovery.metadata);
    await updateRun(database, run.id, {
      phase: "editorial",
      candidate_count: discovery.result.candidates.length,
      token_metadata: { discovery: discovery.metadata },
      search_metadata: { discoveryWebSearchCalls: discovery.metadata.webSearchCalls },
    });

    activeModelStage = "editorial";
    const editorialEventContext = selectEditorialEventContext(discovery.result.candidates, context.events);
    const editorial = await runEditorial({
      instructions: editorialInstructions({
        profile: effectiveProfile,
        existingEvents: editorialEventContext.map((event) => ({
          id: event.id,
          canonicalKey: event.canonicalKey,
          title: event.title,
          status: event.status,
          termsSummary: event.termsSummary,
          effectiveDate: event.effectiveDate,
          confidence: event.confidence,
          shortTermImpact: event.shortTermImpact,
          longTermImpact: event.longTermImpact,
        })),
        coverageFrom,
        feedback: learnedFeedback,
        briefInstructions: definition.instructions,
        personalContext: profileContext,
        sourcePolicyGuidance: sourcePolicyPromptContext(sourcePolicies, { roles: ["verification", "citation"], purpose: "brief", cadence: definition.cadence, now, timezone: briefProfile.timezone }),
        runPurpose: "brief",
        includeWorldPulse,
        includeWeeklyRecap,
        includeStrategicRadar,
      }),
      candidatesJson: editorialInput(
        discovery.result.candidates,
        discovery.result.worldPulseScan,
        weeklyRecapContext,
        discovery.result.strategicRadarScan,
      ),
      allowedDomains: editorialDomains,
    });
    const policySafeEditorial = {
      ...editorial,
      result: {
      ...editorial.result,
        decisions: applyEditorialSourcePolicy(editorial.result.decisions, sourcePolicies, {
          allowedDomains: editorialDomains,
          citedUrls: editorial.metadata.webCitationUrls,
          purpose: "brief",
          cadence: definition.cadence,
          now,
          timezone: briefProfile.timezone,
        }),
        worldPulse: includeWorldPulse
          ? applyWorldPulseSourcePolicy(editorial.result.worldPulse, sourcePolicies, {
            allowedDomains: editorialDomains,
            citedUrls: editorial.metadata.webCitationUrls,
            purpose: "brief",
            cadence: definition.cadence,
            now,
            timezone: briefProfile.timezone,
          })
          : null,
        strategicRadar: includeStrategicRadar
          ? applyStrategicRadarSourcePolicy(editorial.result.strategicRadar, sourcePolicies, {
            allowedDomains: editorialDomains,
            citedUrls: editorial.metadata.webCitationUrls,
            purpose: "brief",
            cadence: definition.cadence,
            now,
            timezone: briefProfile.timezone,
          })
          : null,
      },
    };
    activeModelStage = null;
    await logModelCall(database, run.id, "editorial", editorial.metadata);
    await updateRun(database, run.id, {
      phase: "persisting",
      token_metadata: { discovery: discovery.metadata, editorial: editorial.metadata },
      search_metadata: {
        discoveryWebSearchCalls: discovery.metadata.webSearchCalls,
        editorialWebSearchCalls: editorial.metadata.webSearchCalls,
      },
    });

    const gateInput = {
      decisions: policySafeEditorial.result.decisions,
      profile: effectiveProfile,
      events: context.events,
      states: context.states,
      knownUpdates: context.knownUpdates,
      coverageFrom,
    };
    const registryItems = prepareRegistryItems(gateInput);
    const selectedPublishItems = preparePublishItems(gateInput)
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .slice(0, effectiveProfile.maxItems);
    // A direct alert is an interruption channel, not an event property. Keep
    // the verified brief card when alerts are off, but do not label or queue
    // it as an interruption the user explicitly disabled.
    const publishItems = flowControls.alerts.enabled
      ? selectedPublishItems
      : selectedPublishItems.map((item) => ({ ...item, directAlert: false }));
    const worldPulse = includeWorldPulse
      ? validateWorldPulseLinks(policySafeEditorial.result.worldPulse, registryItems.map((item) => item.canonicalKey))
      : null;
    const strategicRadar = includeStrategicRadar
      ? normalizeStrategicRadar(policySafeEditorial.result.strategicRadar)
      : null;
    if (includeWeeklyRecap && !weeklyRecapContext) {
      throw new Error("Veckans redan sparade händelser kunde inte läsas. Ingen komplett brief har publicerats.");
    }
    const weeklyRecap = weeklyRecapContext
      ? buildWeeklyRecap({
        context: weeklyRecapContext,
        selection: policySafeEditorial.result.weeklyRecap,
      })
      : null;

    // The primary daily brief is an all-up orientation, not merely a list of
    // event cards. Never turn a degraded scan into an apparently complete
    // calm brief: it must have a fully source-validated pulse first.
    if (includeWorldPulse && (!worldPulse || worldPulse.coverage !== "complete")) {
      throw new Error("Dagens omvärldspuls kunde inte verifieras fullständigt. Ingen komplett brief har publicerats.");
    }
    if (includeMarketSnapshot && !marketSnapshot) {
      throw new Error("Dagens marknadsöversikt saknas. Ingen komplett brief har publicerats.");
    }
    // The radar has its own explicit coverage and may honestly report one
    // unavailable section. It must still exist for a primary brief so a failed
    // search cannot masquerade as an empty strategic outlook.
    if (includeStrategicRadar && !strategicRadar) {
      throw new Error("Dagens AI-, affärs- och sammanhangsradar kunde inte verifieras. Ingen komplett brief har publicerats.");
    }
    if (includeWeeklyRecap && !weeklyRecap) {
      throw new Error("Veckosammanfattningen saknas. Ingen komplett brief har publicerats.");
    }
    if (!shouldPublishDailyWorldPulse({
      itemCount: publishItems.length,
      onlyWhenChanged: definition.only_when_changed,
        isPrimary: includeWorldPulse,
      pulse: worldPulse,
    })) {
      const { error: registryError } = await database.rpc("publish_registry_updates", {
        p_user_id: input.userId,
        p_run_id: run.id,
        p_registry_items: registryItems,
      });
      if (registryError) throw new Error(`Kunde inte spara händelseregistret: ${registryError.message}`);
      try {
        await Promise.all([
          deliverWatchUpdates(database, input.userId, registryItems, activeWatches, now),
          retryPendingDirectAlerts(database, input.userId, now, flowControls, briefProfile.timezone),
        ]);
      } catch (deliveryError) {
        await recordAncillaryDeliveryError(database, run.id, "Händelser registrerades, men bevakningsleveransen behöver köras om", deliveryError);
      }
      return {
        briefId: null,
        itemCount: 0,
        quietDay: true,
        runId: run.id,
        alreadyPublished: false,
      };
    }

    const assessment = publishItems.length
      ? limitToThreeSentences(editorial.result.assessment)
      : worldPulse?.overallStatus === "calm"
        ? "Inget väsentligt har förändrats sedan föregående brief. Du behöver inte agera på något i dag."
        : includeWorldPulse
          ? limitToThreeSentences(worldPulse?.summary ?? "Dagens omvärldspuls har sammanställts.")
          : "Ingen verifierad händelse nådde din relevanströskel i den här kontrollen. Du behöver inte agera på något i dag.";
    const watchlist = editorial.result.watchlist.slice(0, 3);
    const publishArgs = {
      p_user_id: input.userId,
      p_brief_definition_id: definition.id,
      p_run_id: run.id,
      p_brief_date: briefDate,
      p_timezone: briefProfile.timezone,
      p_assessment: assessment,
      p_watchlist: watchlist,
      p_registry_items: registryItems,
      p_items: publishItems,
    };
    const { data: briefId, error: publishError } = await database.rpc("publish_defined_brief_with_optional_modules", {
      ...publishArgs,
      p_world_pulse: worldPulse,
      p_market_snapshot: marketSnapshot,
      p_weekly_recap: weeklyRecap,
      p_strategic_radar: strategicRadar,
    });
    if (publishError || !briefId) {
      throw new Error(publishError?.message ?? "Databasen kunde inte publicera briefen.");
    }
    try {
      await Promise.all([
        publishBriefToConversation(
          database,
          input.userId,
          briefId,
          assessment,
          publishItems.length,
          definition.only_when_changed,
          Boolean(worldPulse),
          publishItems.length === 0 && (worldPulse?.overallStatus === "calm" || !includeWorldPulse),
        ),
        deliverWatchUpdates(database, input.userId, registryItems, activeWatches, now),
        queueDirectAlertsForBrief(database, input.userId, briefId, now, flowControls, briefProfile.timezone),
      ]);
    } catch (deliveryError) {
      await recordAncillaryDeliveryError(database, run.id, "Briefen publicerades, men chattleveransen behöver köras om", deliveryError);
    }

    return {
      briefId,
      itemCount: publishItems.length,
      quietDay: publishItems.length === 0 && (worldPulse?.overallStatus === "calm" || !includeWorldPulse),
      runId: run.id,
      alreadyPublished: false,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Okänt fel i briefkörningen.";
    if (activeModelStage) {
      await database.from("model_calls").insert({
        processing_run_id: run.id,
        stage: activeModelStage,
        model_name: getOpenAIModel(),
        state: "failed",
        error_message: message,
      });
    }
    await updateRun(database, run.id, {
      state: "failed",
      phase: "failed",
      finished_at: new Date().toISOString(),
      error_message: message,
      validation_errors: [message],
    });
    throw new BriefRunError(message, run.id);
  }
}

/**
 * A scheduled brief is deliberately a once-per-local-day artifact. Watches
 * need a separate, registry-only pass so a material 10:00 change can reach the
 * user without manufacturing a second daily brief. The paired SQL RPC persists
 * events, updates and sources atomically but never inserts a `briefs` row.
 */
export async function runWatchMonitor(input: {
  userId: string;
  now?: Date;
}): Promise<WatchMonitorResult> {
  const database = createAdminClient();
  const now = input.now ?? new Date();
  const profile = await getProfile(database, input.userId);
  if (!profile) throw new BriefRunError("Ingen profil hittades för den konfigurerade användaren.");
  const flowControls = await getFlowControls(database, input.userId);
  const definition = await getBriefDefinition(database, input.userId);
  const monitorProfile = applyBriefDefinition(profile.settings, definition);
  await retryPendingDirectAlerts(database, input.userId, now, flowControls, monitorProfile.timezone);
  let deliveredCount = await retryPendingWatchDeliveries(database, input.userId, now);
  const activeWatches = await loadActiveWatches(database, input.userId);
  if (!activeWatches.length) {
    return { runId: null, candidateCount: 0, registryItemCount: 0, deliveredCount, skipped: true, reason: "Inga aktiva bevakningar." };
  }

  const briefDate = localDateInTimezone(monitorProfile.timezone, now);
  await recoverStaleRun(database, input.userId, definition.id, briefDate, now);

  const [context, sourcePolicies, profileContext] = await Promise.all([
    loadEditorialContext(database, input.userId, definition.id),
    getEffectiveSourcePolicies(database, input.userId, definition.id),
    getProfileContext(database, input.userId),
  ]);
  const configuredDomains = process.env.BRIEF_ALLOWED_DOMAINS
    ?.split(",")
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);
  const discoveryDomains = restrictConfiguredDomains(allowedDomainsForPolicy(sourcePolicies, {
    roles: ["direct_monitoring", "discovery"],
    purpose: "watch",
    now,
    timezone: monitorProfile.timezone,
  }), configuredDomains);
  const editorialDomains = restrictConfiguredDomains(allowedDomainsForPolicy(sourcePolicies, {
    roles: ["verification", "citation"],
    purpose: "watch",
    now,
    timezone: monitorProfile.timezone,
  }), configuredDomains);
  if (!discoveryDomains.length || !editorialDomains.length) {
    return {
      runId: null,
      candidateCount: 0,
      registryItemCount: 0,
      deliveredCount,
      skipped: true,
      reason: "Inga källor är tillåtna för återkommande bevakning.",
    };
  }

  const coverageFrom = await getCoverageStart(database, input.userId, definition.id, now, "watch");
  const { data: run, error: runError } = await database
    .from("processing_runs")
    .insert({
      user_id: input.userId,
      brief_definition_id: definition.id,
      local_brief_date: briefDate,
      triggered_by: "watch",
      state: "running",
      phase: "discovery",
      started_at: now.toISOString(),
      coverage_from: coverageFrom,
      model_name: getOpenAIModel(),
      search_metadata: { purpose: "watch_monitor" },
    })
    .select("id")
    .maybeSingle();
  if (runError || !run) {
    if (runError?.code === "23505") {
      return { runId: null, candidateCount: 0, registryItemCount: 0, deliveredCount, skipped: true, reason: "En annan körning pågår redan." };
    }
    throw new BriefRunError(runError?.message ?? "Kunde inte starta bevakningskörningen.");
  }

  let activeModelStage: "discovery" | "editorial" | null = "discovery";
  try {
    const effectiveProfile = applyFeedbackHistory(monitorProfile, context.events, context.feedback);
    const learnedFeedback = feedbackContext(context.events, context.feedback);
    const discoveryResponse = await runDiscovery(
      discoveryInstructions({
        profile: effectiveProfile,
        coverageFrom,
        now: now.toISOString(),
        feedback: learnedFeedback,
        explicitWatches: activeWatches.map((watch) => watch.query_text ?? watch.title).filter(Boolean).slice(0, 30),
        briefInstructions: definition.instructions,
        personalContext: profileContext,
        sourcePolicyGuidance: sourcePolicyPromptContext(sourcePolicies, { roles: ["direct_monitoring", "discovery"], purpose: "watch", now, timezone: monitorProfile.timezone }),
        runPurpose: "watch",
        includeWorldPulse: false,
      }),
      discoveryDomains,
    );
    const discovery = {
      ...discoveryResponse,
      result: {
        ...discoveryResponse.result,
        candidates: discoveryResponse.result.candidates
          .map((candidate) => ({
            ...candidate,
            sources: filterRunSources(candidate.sources, sourcePolicies, ["direct_monitoring", "discovery"], sourceSubject(candidate), {
              allowedDomains: discoveryDomains,
              citedUrls: discoveryResponse.metadata.webCitationUrls,
              purpose: "watch",
              now,
              timezone: monitorProfile.timezone,
            }),
          }))
          .filter((candidate) => candidate.sources.length > 0),
      },
    };
    activeModelStage = null;
    await logModelCall(database, run.id, "discovery", discovery.metadata);
    await updateRun(database, run.id, {
      phase: "editorial",
      candidate_count: discovery.result.candidates.length,
      token_metadata: { discovery: discovery.metadata },
      search_metadata: { purpose: "watch_monitor", discoveryWebSearchCalls: discovery.metadata.webSearchCalls },
    });

    activeModelStage = "editorial";
    const editorialEventContext = selectEditorialEventContext(discovery.result.candidates, context.events);
    const editorial = await runEditorial({
      instructions: editorialInstructions({
        profile: effectiveProfile,
        existingEvents: editorialEventContext.map((event) => ({
          id: event.id,
          canonicalKey: event.canonicalKey,
          title: event.title,
          status: event.status,
          termsSummary: event.termsSummary,
          effectiveDate: event.effectiveDate,
          confidence: event.confidence,
          shortTermImpact: event.shortTermImpact,
          longTermImpact: event.longTermImpact,
        })),
        coverageFrom,
        feedback: learnedFeedback,
        briefInstructions: definition.instructions,
        personalContext: profileContext,
        sourcePolicyGuidance: sourcePolicyPromptContext(sourcePolicies, { roles: ["verification", "citation"], purpose: "watch", now, timezone: monitorProfile.timezone }),
        runPurpose: "watch",
        includeWorldPulse: false,
      }),
      candidatesJson: editorialInput(discovery.result.candidates, null),
      allowedDomains: editorialDomains,
    });
    activeModelStage = null;
    await logModelCall(database, run.id, "editorial", editorial.metadata);
    const registryItems = prepareRegistryItems({
      decisions: applyEditorialSourcePolicy(editorial.result.decisions, sourcePolicies, {
        allowedDomains: editorialDomains,
        citedUrls: editorial.metadata.webCitationUrls,
        purpose: "watch",
        now,
        timezone: monitorProfile.timezone,
      }),
      profile: effectiveProfile,
      events: context.events,
      knownUpdates: context.knownUpdates,
      coverageFrom,
    });
    await updateRun(database, run.id, {
      phase: "persisting",
      token_metadata: { discovery: discovery.metadata, editorial: editorial.metadata },
      search_metadata: {
        purpose: "watch_monitor",
        discoveryWebSearchCalls: discovery.metadata.webSearchCalls,
        editorialWebSearchCalls: editorial.metadata.webSearchCalls,
      },
    });
    const { error: persistError } = await database.rpc("publish_registry_updates", {
      p_user_id: input.userId,
      p_run_id: run.id,
      p_registry_items: registryItems,
    });
    if (persistError) throw new Error(`Kunde inte spara bevakningshändelser: ${persistError.message}`);
    deliveredCount += await deliverWatchUpdates(database, input.userId, registryItems, activeWatches, now);
    return {
      runId: run.id,
      candidateCount: discovery.result.candidates.length,
      registryItemCount: registryItems.length,
      deliveredCount,
      skipped: false,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Okänt fel i bevakningskörningen.";
    if (activeModelStage) {
      await database.from("model_calls").insert({
        processing_run_id: run.id,
        stage: activeModelStage,
        model_name: getOpenAIModel(),
        state: "failed",
        error_message: message,
      });
    }
    await updateRun(database, run.id, {
      state: "failed",
      phase: "failed",
      finished_at: new Date().toISOString(),
      error_message: message,
      validation_errors: [message],
    });
    throw new BriefRunError(message, run.id);
  }
}

async function loadActiveWatches(database: ReturnType<typeof createAdminClient>, userId: string): Promise<ActiveWatchRow[]> {
  const { data, error } = await database
    .from("watches")
    .select("id, event_id, kind, title, query_text, trigger_statuses, only_material_change")
    .eq("user_id", userId)
    .eq("state", "active");
  if (error) throw new Error(`Kunde inte läsa aktiva bevakningar: ${error.message}`);
  return (data ?? []) as ActiveWatchRow[];
}

/**
 * A quiet loop is silent only when that brief explicitly asks for
 * only_when_changed. Turning the setting off produces a durable all-clear,
 * which makes the preference observable rather than merely stored.
 */
async function publishBriefToConversation(
  database: ReturnType<typeof createAdminClient>,
  userId: string,
  briefId: string,
  assessment: string,
  itemCount: number,
  onlyWhenChanged: boolean,
  hasWorldPulse = false,
  quiet = itemCount === 0,
): Promise<void> {
  if (!hasWorldPulse && !shouldDeliverBriefToConversation(itemCount, onlyWhenChanged)) return;
  const conversationId = await ensureMainConversation(database, userId);

  const { data: priorMessage, error: priorMessageError } = await database
    .from("conversation_messages")
    .select("id")
    .eq("conversation_id", conversationId)
    .eq("brief_id", briefId)
    .maybeSingle();
  if (priorMessageError) throw new Error(`Kunde inte kontrollera tidigare chattleverans: ${priorMessageError.message}`);
  if (!priorMessage) {
    const { error } = await database.from("conversation_messages").insert({
      conversation_id: conversationId,
      user_id: userId,
      role: "assistant",
      kind: "brief",
      text: assessment,
      brief_id: briefId,
      blocks: [{ type: "brief", itemCount, quiet }],
    });
    if (error && error.code !== "23505") throw new Error(`Kunde inte publicera briefen i chatten: ${error.message}`);
  }
  const { error: briefError } = await database
    .from("briefs")
    .update({ delivered_to_chat_at: new Date().toISOString() })
    .eq("id", briefId);
  if (briefError) throw new Error(`Kunde inte markera chattleveransen: ${briefError.message}`);
}

/**
 * A direct alert is a delivery receipt, not merely a boolean on a brief item.
 * Queue it only after the atomic brief publication has resolved the stable
 * event_update id, then let the retry loop own the fragile chat write. The
 * unique user/update constraint in migration 007 makes the operation safe
 * when a cron retries after a partial failure.
 */
async function queueDirectAlertsForBrief(
  database: ReturnType<typeof createAdminClient>,
  userId: string,
  briefId: string,
  now: Date,
  flowControls: FlowControls,
  timezone: string,
): Promise<number> {
  // Do not create a new durable interruption receipt while the user has
  // direct alerts turned off. Existing unfinished receipts are deliberately
  // retained for audit/retry and are also held by retryPendingDirectAlerts.
  if (!flowControls.alerts.enabled) return 0;
  const { data, error } = await database
    .from("brief_items")
    .select("event_id, event_update_id")
    .eq("brief_id", briefId)
    .eq("direct_alert", true)
    .not("event_update_id", "is", null);
  if (error) throw new Error(`Kunde inte läsa briefens direktnotiser: ${error.message}`);

  for (const raw of (data ?? []) as RawRecord[]) {
    if (typeof raw.event_id !== "string" || typeof raw.event_update_id !== "string") continue;
    const { error: enqueueError } = await database
      .from("direct_alert_deliveries")
      .upsert({
        user_id: userId,
        event_id: raw.event_id,
        event_update_id: raw.event_update_id,
        brief_id: briefId,
        delivery_state: "pending",
        attempt_count: 0,
        next_attempt_at: now.toISOString(),
      }, { onConflict: "user_id,event_update_id", ignoreDuplicates: true });
    if (enqueueError) throw new Error(`Kunde inte köa direktnotisen: ${enqueueError.message}`);
  }

  return retryPendingDirectAlerts(database, userId, now, flowControls, timezone);
}

/**
 * Direct alerts use an explicit delivery state machine. A server crash after
 * inserting the chat message is safe: on retry we discover that message by
 * its event-update receipt and mark the original row delivered instead of
 * writing a second alert.
 */
async function retryPendingDirectAlerts(
  database: ReturnType<typeof createAdminClient>,
  userId: string,
  now = new Date(),
  flowControls: FlowControls,
  timezone: string,
): Promise<number> {
  if (!flowControls.alerts.enabled) return 0;
  const { data, error } = await database
    .from("direct_alert_deliveries")
    .select("id, user_id, event_id, event_update_id, brief_id, conversation_message_id, delivery_state, attempt_count, claimed_at, next_attempt_at")
    .eq("user_id", userId)
    .in("delivery_state", ["pending", "delivering", "failed"])
    .order("created_at", { ascending: true })
    .limit(100);
  if (error) throw new Error(`Kunde inte läsa väntande direktnotiser: ${error.message}`);

  let deliveredCount = 0;
  for (const raw of (data ?? []) as RawRecord[]) {
    const delivery = mapDirectAlertDelivery(raw);
    if (!delivery) continue;
    if (!canAttemptWatchDelivery({
      state: delivery.delivery_state,
      attemptCount: delivery.attempt_count,
      nextAttemptAt: delivery.next_attempt_at,
      claimedAt: delivery.claimed_at,
    }, now)) continue;
    if (!(await canDeliverPendingDirectAlert(database, delivery, flowControls, timezone, now))) continue;
    const claimed = await claimDirectAlertDelivery(database, delivery, now);
    if (!claimed) continue;
    try {
      if (await deliverClaimedDirectAlert(database, userId, claimed, now)) deliveredCount += 1;
    } catch (deliveryError) {
      await markDirectAlertFailed(database, claimed, now, deliveryError);
    }
  }
  return deliveredCount;
}

/**
 * Quiet hours delay a normal high-relevance interruption but leave the
 * verified item and its retry receipt intact. A systemic override can pass
 * only when the user explicitly opted into that exception.
 */
async function canDeliverPendingDirectAlert(
  database: ReturnType<typeof createAdminClient>,
  delivery: DirectAlertDeliveryRow,
  flowControls: FlowControls,
  timezone: string,
  now: Date,
): Promise<boolean> {
  // Normal daytime path: avoid an extra query for every queued alert.
  if (canDeliverDirectAlertNow({ controls: flowControls, timezone, systemicOverride: false, now })) return true;
  if (!flowControls.alerts.enabled || !flowControls.alerts.quietHours.allowSystemicDuringQuietHours || !delivery.brief_id) return false;

  const { data, error } = await database
    .from("brief_items")
    .select("systemic_override")
    .eq("brief_id", delivery.brief_id)
    .eq("event_id", delivery.event_id)
    .eq("event_update_id", delivery.event_update_id)
    .eq("direct_alert", true)
    .maybeSingle();
  if (error) throw new Error(`Kunde inte avgöra om direktnotisen är systemisk: ${error.message}`);
  return canDeliverDirectAlertNow({
    controls: flowControls,
    timezone,
    systemicOverride: Boolean(data && (data as RawRecord).systemic_override),
    now,
  });
}

async function claimDirectAlertDelivery(
  database: ReturnType<typeof createAdminClient>,
  delivery: DirectAlertDeliveryRow,
  now: Date,
): Promise<DirectAlertDeliveryRow | null> {
  const nextAttemptCount = delivery.attempt_count + 1;
  const { data, error } = await database
    .from("direct_alert_deliveries")
    .update({
      delivery_state: "delivering",
      attempt_count: nextAttemptCount,
      claimed_at: now.toISOString(),
      last_attempt_at: now.toISOString(),
      next_attempt_at: new Date(now.getTime() + 10 * 60_000).toISOString(),
      last_error: "Direktnotis reserverad för leverans.",
    })
    .eq("id", delivery.id)
    .eq("user_id", delivery.user_id)
    .eq("attempt_count", delivery.attempt_count)
    .eq("delivery_state", delivery.delivery_state)
    .select("id, user_id, event_id, event_update_id, brief_id, conversation_message_id, delivery_state, attempt_count, claimed_at, next_attempt_at")
    .maybeSingle();
  if (error) throw new Error(`Kunde inte reservera direktnotisen: ${error.message}`);
  return data ? mapDirectAlertDelivery(data as RawRecord) : null;
}

async function deliverClaimedDirectAlert(
  database: ReturnType<typeof createAdminClient>,
  userId: string,
  delivery: DirectAlertDeliveryRow,
  now: Date,
): Promise<boolean> {
  if (delivery.user_id !== userId || !delivery.brief_id) {
    throw new Error("Direktnotisen saknar en ägd brief som kan förklara ändringen.");
  }

  const { data: item, error: itemError } = await database
    .from("brief_items")
    .select("event_id, event_update_id, title_snapshot, what_changed, why_relevant, recommendation, confidence")
    .eq("brief_id", delivery.brief_id)
    .eq("event_id", delivery.event_id)
    .eq("event_update_id", delivery.event_update_id)
    .eq("direct_alert", true)
    .maybeSingle();
  if (itemError) throw new Error(`Kunde inte läsa innehållet i direktnotisen: ${itemError.message}`);
  const directItem = item ? mapDirectAlertBriefItem(item as RawRecord) : null;
  if (!directItem) throw new Error("Direktnotisens briefpost saknas eller är inte längre giltig.");

  const conversationId = await ensureMainConversation(database, userId);
  const { data: existingMessage, error: existingMessageError } = await database
    .from("conversation_messages")
    .select("id")
    .eq("conversation_id", conversationId)
    .eq("event_id", delivery.event_id)
    .eq("kind", "direct_alert")
    .contains("action", { eventUpdateId: delivery.event_update_id })
    .maybeSingle();
  if (existingMessageError) throw new Error(`Kunde inte kontrollera tidigare direktnotis: ${existingMessageError.message}`);

  let messageId = existingMessage?.id ?? null;
  if (!messageId) {
    const { data: message, error: messageError } = await database
      .from("conversation_messages")
      .insert({
        conversation_id: conversationId,
        user_id: userId,
        role: "assistant",
        kind: "direct_alert",
        text: `Direktnotis: ${directItem.title_snapshot}. ${directItem.what_changed}`,
        event_id: delivery.event_id,
        action: {
          type: "direct_alert",
          title: "Direktnotis: hög relevans",
          detail: `${recommendationLabel(directItem.recommendation)} · ${directItem.why_relevant}`,
          href: `/events/${delivery.event_id}`,
          eventUpdateId: delivery.event_update_id,
        },
        blocks: [{
          type: "direct_alert",
          recommendation: directItem.recommendation,
          confidence: directItem.confidence,
          briefId: delivery.brief_id,
        }],
      })
      .select("id")
      .single();
    if (messageError || !message) throw new Error(messageError?.message ?? "Kunde inte skriva direktnotisen i chatten.");
    messageId = message.id;
  }

  const { data: delivered, error: deliveredError } = await database
    .from("direct_alert_deliveries")
    .update({
      delivery_state: "delivered",
      conversation_message_id: messageId,
      delivered_at: now.toISOString(),
      claimed_at: null,
      next_attempt_at: null,
      last_error: null,
    })
    .eq("id", delivery.id)
    .eq("user_id", userId)
    .eq("delivery_state", "delivering")
    .eq("attempt_count", delivery.attempt_count)
    .select("id")
    .maybeSingle();
  if (deliveredError || !delivered) throw new Error(deliveredError?.message ?? "Kunde inte bekräfta direktnotisen.");
  return true;
}

async function markDirectAlertFailed(
  database: ReturnType<typeof createAdminClient>,
  delivery: DirectAlertDeliveryRow,
  now: Date,
  reason: unknown,
): Promise<void> {
  const message = reason instanceof Error ? reason.message : "Okänt leveransfel för direktnotis.";
  const { error } = await database
    .from("direct_alert_deliveries")
    .update({
      delivery_state: "failed",
      claimed_at: null,
      last_error: message.slice(0, 1_000),
      next_attempt_at: nextWatchDeliveryAttempt(delivery.attempt_count, now),
    })
    .eq("id", delivery.id)
    .eq("user_id", delivery.user_id)
    .eq("delivery_state", "delivering")
    .eq("attempt_count", delivery.attempt_count);
  if (error) throw new Error(`Kunde inte spara felet för direktnotisen: ${error.message}`);
}

function mapDirectAlertDelivery(raw: RawRecord): DirectAlertDeliveryRow | null {
  const state = raw.delivery_state;
  if (
    typeof raw.id !== "string"
    || typeof raw.user_id !== "string"
    || typeof raw.event_id !== "string"
    || typeof raw.event_update_id !== "string"
    || (state !== "pending" && state !== "delivering" && state !== "delivered" && state !== "failed")
  ) return null;
  return {
    id: raw.id,
    user_id: raw.user_id,
    event_id: raw.event_id,
    event_update_id: raw.event_update_id,
    brief_id: typeof raw.brief_id === "string" ? raw.brief_id : null,
    conversation_message_id: typeof raw.conversation_message_id === "string" ? raw.conversation_message_id : null,
    delivery_state: state,
    attempt_count: Number(raw.attempt_count ?? 0),
    claimed_at: typeof raw.claimed_at === "string" ? raw.claimed_at : null,
    next_attempt_at: typeof raw.next_attempt_at === "string" ? raw.next_attempt_at : null,
  };
}

function mapDirectAlertBriefItem(raw: RawRecord): DirectAlertBriefItem | null {
  if (
    typeof raw.event_id !== "string"
    || typeof raw.event_update_id !== "string"
    || typeof raw.title_snapshot !== "string"
    || typeof raw.what_changed !== "string"
    || typeof raw.why_relevant !== "string"
    || (raw.recommendation !== "act" && raw.recommendation !== "monitor" && raw.recommendation !== "no_action")
    || (raw.confidence !== "high" && raw.confidence !== "medium" && raw.confidence !== "low")
  ) return null;
  return {
    event_id: raw.event_id,
    event_update_id: raw.event_update_id,
    title_snapshot: raw.title_snapshot,
    what_changed: raw.what_changed,
    why_relevant: raw.why_relevant,
    recommendation: raw.recommendation,
    confidence: raw.confidence,
  };
}

function recommendationLabel(recommendation: DirectAlertBriefItem["recommendation"]): string {
  if (recommendation === "act") return "Bedömning: Agera";
  if (recommendation === "monitor") return "Bedömning: Bevaka";
  return "Bedömning: Ingen åtgärd";
}

/**
 * Watches are evaluated after a verified registry update has been persisted.
 * The unique delivery key is the last line of defense against repeats when a
 * cron wakes twice or a run is retried.
 */
async function deliverWatchUpdates(
  database: ReturnType<typeof createAdminClient>,
  userId: string,
  registryItems: RegistryItem[],
  watches: ActiveWatchRow[],
  now: Date,
): Promise<number> {
  if (!registryItems.length || !watches.length) return retryPendingWatchDeliveries(database, userId, now);
  const canonicalKeys = registryItems.map((item) => item.canonicalKey);
  const { data: rawEvents, error: eventsError } = await database
    .from("events")
    .select("id, canonical_key, title")
    .in("canonical_key", canonicalKeys);
  if (eventsError) throw new Error(`Kunde inte matcha bevakningar mot händelser: ${eventsError.message}`);
  const events = (rawEvents ?? []) as Array<{ id: string; canonical_key: string; title: string }>;
  if (!events.length) return retryPendingWatchDeliveries(database, userId, now);
  const eventByKey = new Map(events.map((event) => [event.canonical_key, event]));
  const { data: rawUpdates, error: updatesError } = await database
    .from("event_updates")
    .select("id, event_id, material_fingerprint")
    .in("event_id", events.map((event) => event.id));
  if (updatesError) throw new Error(`Kunde inte läsa bevakningsuppdateringar: ${updatesError.message}`);
  const updateByEventAndFingerprint = new Map(
    ((rawUpdates ?? []) as Array<{ id: string; event_id: string; material_fingerprint: string }>).map((update) => [`${update.event_id}:${update.material_fingerprint}`, update]),
  );

  for (const item of registryItems) {
    const event = eventByKey.get(item.canonicalKey);
    if (!event) continue;
    const update = updateByEventAndFingerprint.get(`${event.id}:${item.materialFingerprint}`);
    if (!update) continue;
    const matchingWatches = watches.filter((watch) => {
      if (watch.event_id === event.id) return true;
      return watch.kind === "topic" && topicMatches(watch.query_text ?? watch.title, item);
    });
    for (const watch of matchingWatches) {
      if (!watchShouldTrigger(watch, item)) continue;
      await enqueueWatchDelivery(database, watch.id, update.id);
    }
  }
  return retryPendingWatchDeliveries(database, userId, now);
}

/**
 * The unique watch/update key is an idempotency boundary. Inserting pending
 * work first means a model run can finish successfully even if chat delivery
 * is temporarily unavailable.
 */
async function enqueueWatchDelivery(
  database: ReturnType<typeof createAdminClient>,
  watchId: string,
  eventUpdateId: string,
): Promise<void> {
  const { error } = await database.from("watch_deliveries").upsert({
    watch_id: watchId,
    event_update_id: eventUpdateId,
    delivery_state: "pending",
    attempt_count: 0,
  }, { onConflict: "watch_id,event_update_id", ignoreDuplicates: true });
  if (error) throw new Error(`Kunde inte köa bevakningsleveransen: ${error.message}`);
}

/**
 * Recover failed deliveries and abandoned claims. The schema uses a compact
 * pending/delivered/failed state machine, so a claim is represented by a
 * failed row with a short future retry time. The attempt counter is part of
 * the update predicate, preventing two cron invocations from claiming it.
 */
async function retryPendingWatchDeliveries(
  database: ReturnType<typeof createAdminClient>,
  userId: string,
  now = new Date(),
): Promise<number> {
  const { data, error } = await database
    .from("watch_deliveries")
    .select("id, watch_id, event_update_id, delivery_state, attempt_count, next_attempt_at, conversation_message_id, watches!inner(id, user_id, title, trigger_statuses, event_id), event_updates!inner(id, event_id, change_summary, new_status, kind, events!inner(id, title))")
    .eq("watches.user_id", userId)
    .eq("watches.state", "active")
    .in("delivery_state", ["pending", "failed"])
    .order("created_at", { ascending: true })
    .limit(100);
  if (error) throw new Error(`Kunde inte läsa väntande bevakningsleveranser: ${error.message}`);

  let deliveredCount = 0;
  for (const raw of (data ?? []) as unknown as RawRecord[]) {
    const delivery = mapPendingWatchDelivery(raw);
    if (!delivery) continue;
    if (!canAttemptWatchDelivery({
      state: delivery.delivery_state,
      attemptCount: Number(delivery.attempt_count ?? 0),
      nextAttemptAt: delivery.next_attempt_at,
      claimedAt: null,
    }, now)) continue;
    const claimed = await claimWatchDelivery(database, delivery, now);
    if (!claimed) continue;
    try {
      if (await deliverClaimedWatchDelivery(database, userId, claimed, now)) deliveredCount += 1;
    } catch (deliveryError) {
      await markWatchDeliveryFailed(database, claimed, now, deliveryError);
    }
  }
  return deliveredCount;
}

async function claimWatchDelivery(
  database: ReturnType<typeof createAdminClient>,
  delivery: PendingWatchDeliveryRow,
  now: Date,
): Promise<PendingWatchDeliveryRow | null> {
  const nextAttemptCount = Number(delivery.attempt_count ?? 0) + 1;
  const claimUntil = new Date(now.getTime() + 10 * 60_000).toISOString();
  const { data, error } = await database
    .from("watch_deliveries")
    .update({
      // This durable lease is intentionally a failed state with a future
      // retry. Migration 005's compact state machine has no "delivering";
      // the versioned attempt counter still makes the lease exclusive.
      delivery_state: "failed",
      attempt_count: nextAttemptCount,
      last_attempt_at: now.toISOString(),
      next_attempt_at: claimUntil,
      last_error: "Leverans reserverad för försök.",
    })
    .eq("id", delivery.id)
    .eq("attempt_count", Number(delivery.attempt_count ?? 0))
    .eq("delivery_state", delivery.delivery_state)
    .select("id, watch_id, event_update_id, delivery_state, attempt_count, next_attempt_at, conversation_message_id, watches!inner(id, user_id, title, trigger_statuses, event_id), event_updates!inner(id, event_id, change_summary, new_status, kind, events!inner(id, title))")
    .maybeSingle();
  if (error) throw new Error(`Kunde inte reservera bevakningsleveransen: ${error.message}`);
  return data ? mapPendingWatchDelivery(data as unknown as RawRecord) : null;
}

async function deliverClaimedWatchDelivery(
  database: ReturnType<typeof createAdminClient>,
  userId: string,
  delivery: PendingWatchDeliveryRow,
  now: Date,
): Promise<boolean> {
  const watch = delivery.watches;
  const update = delivery.event_updates;
  const event = update?.events;
  if (!watch || watch.user_id !== userId || !update || !event) {
    throw new Error("Bevakningen eller händelseuppdateringen är inte längre tillgänglig.");
  }
  if (watch.event_id && watch.event_id !== update.event_id) {
    throw new Error("Bevakningen gäller inte längre denna händelse.");
  }

  const conversationId = await ensureMainConversation(database, userId);
  const { data: existingMessage, error: existingMessageError } = await database
    .from("conversation_messages")
    .select("id")
    .eq("conversation_id", conversationId)
    .eq("watch_id", watch.id)
    .eq("event_id", update.event_id)
    .eq("kind", "watch_update")
    .contains("action", { eventUpdateId: update.id })
    .maybeSingle();
  if (existingMessageError) throw new Error(`Kunde inte kontrollera tidigare bevakningsmeddelande: ${existingMessageError.message}`);

  let messageId = existingMessage?.id ?? null;
  if (!messageId) {
    const condition = triggerLabels(watch.trigger_statuses).join(", ");
    const { data: message, error: messageError } = await database
      .from("conversation_messages")
      .insert({
        conversation_id: conversationId,
        user_id: userId,
        role: "assistant",
        kind: "watch_update",
        text: `Bevakningsuppdatering: ${event.title}. ${update.change_summary}`,
        event_id: update.event_id,
        watch_id: watch.id,
        action: {
          type: "watch_update",
          title: "Din bevakning har triggat",
          detail: `${watch.title} · ${condition}`,
          href: "/watches",
          eventUpdateId: update.id,
        },
      })
      .select("id")
      .single();
    if (messageError || !message) throw new Error(messageError?.message ?? "Kunde inte skriva bevakningsmeddelandet.");
    messageId = message.id;
  }

  const { data: delivered, error: deliveredError } = await database
    .from("watch_deliveries")
    .update({
      delivery_state: "delivered",
      conversation_message_id: messageId,
      delivered_at: now.toISOString(),
      next_attempt_at: null,
      last_error: null,
    })
    .eq("id", delivery.id)
    .eq("delivery_state", "failed")
    .eq("attempt_count", delivery.attempt_count)
    .select("id")
    .maybeSingle();
  if (deliveredError || !delivered) throw new Error(deliveredError?.message ?? "Kunde inte bekräfta bevakningsleveransen.");

  // This metadata is helpful in the UI but must not turn a delivered message
  // into a retry candidate if an unrelated timestamp write happens to fail.
  await database
    .from("watches")
    .update({ last_event_update_id: update.id, last_triggered_at: now.toISOString() })
    .eq("id", watch.id)
    .eq("user_id", userId);
  return true;
}

async function markWatchDeliveryFailed(
  database: ReturnType<typeof createAdminClient>,
  delivery: PendingWatchDeliveryRow,
  now: Date,
  reason: unknown,
): Promise<void> {
  const message = reason instanceof Error ? reason.message : "Okänt leveransfel.";
  const { error } = await database
    .from("watch_deliveries")
    .update({
      delivery_state: "failed",
      last_error: message.slice(0, 1_000),
      next_attempt_at: nextWatchDeliveryAttempt(Number(delivery.attempt_count ?? 0), now),
    })
    .eq("id", delivery.id)
    .eq("delivery_state", "failed")
    .eq("attempt_count", delivery.attempt_count);
  if (error) throw new Error(`Kunde inte spara leveransfelet: ${error.message}`);
}

/** Supabase represents nested relations as arrays in generated fallback types. */
function mapPendingWatchDelivery(raw: RawRecord): PendingWatchDeliveryRow | null {
  const watch = relationRecord(raw.watches);
  const update = relationRecord(raw.event_updates);
  const event = update ? relationRecord(update.events) : null;
  const deliveryState = raw.delivery_state;
  if (
    typeof raw.id !== "string"
    || typeof raw.watch_id !== "string"
    || typeof raw.event_update_id !== "string"
    || (deliveryState !== "pending" && deliveryState !== "failed" && deliveryState !== "delivered")
    || !watch
    || !update
    || !event
    || typeof watch.id !== "string"
    || typeof watch.user_id !== "string"
    || typeof watch.title !== "string"
    || typeof update.id !== "string"
    || typeof update.event_id !== "string"
    || typeof update.change_summary !== "string"
    || typeof event.id !== "string"
    || typeof event.title !== "string"
    || !isUpdateKind(update.kind)
  ) return null;
  return {
    id: raw.id,
    watch_id: raw.watch_id,
    event_update_id: raw.event_update_id,
    delivery_state: deliveryState,
    attempt_count: Number(raw.attempt_count ?? 0),
    next_attempt_at: typeof raw.next_attempt_at === "string" ? raw.next_attempt_at : null,
    conversation_message_id: typeof raw.conversation_message_id === "string" ? raw.conversation_message_id : null,
    watches: {
      id: watch.id,
      user_id: watch.user_id,
      title: watch.title,
      trigger_statuses: watch.trigger_statuses,
      event_id: typeof watch.event_id === "string" ? watch.event_id : null,
    },
    event_updates: {
      id: update.id,
      event_id: update.event_id,
      change_summary: update.change_summary,
      new_status: typeof update.new_status === "string" ? update.new_status : "changed",
      kind: update.kind,
      events: { id: event.id, title: event.title },
    },
  };
}

function relationRecord(value: unknown): RawRecord | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && typeof candidate === "object" && !Array.isArray(candidate) ? candidate as RawRecord : null;
}

function isUpdateKind(value: unknown): value is UpdateKind {
  return value === "new_event"
    || value === "status_change"
    || value === "terms_change"
    || value === "effective_date_change"
    || value === "impact_change"
    || value === "verification_change"
    || value === "no_material_change";
}

async function ensureMainConversation(database: ReturnType<typeof createAdminClient>, userId: string): Promise<string> {
  const { data: existing, error: existingError } = await database
    .from("conversations")
    .select("id")
    .eq("user_id", userId)
    .eq("kind", "main")
    .maybeSingle();
  if (existingError) throw new Error(`Kunde inte läsa huvudkonversationen: ${existingError.message}`);
  if (existing) return existing.id;
  const { data: created, error: createError } = await database
    .from("conversations")
    .insert({ user_id: userId, kind: "main", title: "Din omvärldsbrief" })
    .select("id")
    .single();
  if (created) return created.id;
  if (createError?.code === "23505") {
    const { data: racedConversation, error: racedError } = await database
      .from("conversations")
      .select("id")
      .eq("user_id", userId)
      .eq("kind", "main")
      .maybeSingle();
    if (racedError || !racedConversation) throw new Error(racedError?.message ?? "Kunde inte läsa huvudkonversationen efter konflikt.");
    return racedConversation.id;
  }
  if (createError) throw new Error(createError.message);
  throw new Error("Kunde inte skapa huvudkonversationen.");
}

function watchShouldTrigger(watch: ActiveWatchRow, item: RegistryItem): boolean {
  return watchMatchesMaterialChange({
    triggerStatuses: stringArray(watch.trigger_statuses),
    onlyMaterialChange: watch.only_material_change,
    nextStatus: item.status,
    updateKind: item.updateKind,
  });
}

function topicMatches(query: string, item: RegistryItem): boolean {
  const ignored = new Set(["följ", "bevaka", "säg", "till", "lagen", "lag", "regel", "fråga", "detta", "denna", "när", "och", "att", "för"]);
  // Short all-caps domain terms are meaningful user interests (AI, EU, USA,
  // UAE), whereas arbitrary two-letter words would create noise.
  const acronyms = new Set(["ai", "eu", "usa", "uae", "uk", "us"]);
  const terms = query
    .toLocaleLowerCase("sv-SE")
    .match(/[\p{L}\p{N}]{2,}/gu)
    ?.filter((term) => !ignored.has(term) && (term.length >= 3 || acronyms.has(term))) ?? [];
  if (!terms.length) return false;
  const haystack = [item.title, item.whatChanged, item.termsSummary, ...item.actors, ...item.regions].join(" ").toLocaleLowerCase("sv-SE");
  return terms.some((term) => haystack.includes(term));
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function triggerLabels(value: unknown): string[] {
  const labels: Record<string, string> = {
    signed: "undertecknat",
    adopted: "antaget",
    effective: "i kraft",
    implemented: "implementerat",
    changed: "väsentligt ändrat",
    reversed: "upphävt eller återkallat",
  };
  const results = stringArray(value).map((status) => labels[status] ?? status);
  return results.length ? results : ["materiell förändring"];
}

type WorldPulseLens = "conflictSecurity" | "economy" | "personalExposure";
const WORLD_PULSE_LENSES: WorldPulseLens[] = ["conflictSecurity", "economy", "personalExposure"];

/**
 * Discovery's pulse is input to editorial, not publishable evidence. Strip
 * URLs that were not actually returned by the discovery web search and mark a
 * now-empty lens unavailable instead of leaving a fake stable claim behind.
 */
function filterWorldPulseScanSources(
  pulse: WorldPulse | null,
  sourcePolicies: SourcePolicyRecord[],
  context: SourceRunContext,
): WorldPulse | null {
  if (!pulse) return null;
  const sections = {} as Record<WorldPulseLens, WorldPulseSection>;
  for (const lens of WORLD_PULSE_LENSES) {
    const section = pulse[lens];
    const sources = filterRunSources(section.sources, sourcePolicies, "discovery", worldPulseSubject(lens, section), context);
    sections[lens] = section.status !== "unavailable" && !sources.length
      ? {
        ...section,
        status: "unavailable",
        claimScope: "none",
        sources: [],
        linkedEventKeys: [],
        coverageNote: "Källunderlaget kunde inte behållas enligt den aktiva källpolicyn.",
      }
      : { ...section, sources };
  }
  return normalizeWorldPulseCoverage({ ...pulse, ...sections });
}

/**
 * Editorial's pulse is eligible for persistence only after each lens has the
 * same policy, URL-provenance and verification gate as a published event.
 * This keeps a pleasant daily all-clear from becoming an unsupported claim.
 */
function applyWorldPulseSourcePolicy(
  pulse: WorldPulse | null,
  sourcePolicies: SourcePolicyRecord[],
  context: SourceRunContext,
): WorldPulse | null {
  if (!pulse) return null;
  const sections = {} as Record<WorldPulseLens, WorldPulseSection>;

  for (const lens of WORLD_PULSE_LENSES) {
    const section = pulse[lens];
    if (section.status === "unavailable") {
      sections[lens] = section;
      continue;
    }
    const subject = worldPulseSubject(lens, section);
    const allowedSources = filterRunSources(section.sources, sourcePolicies, ["verification", "citation"], subject, context);
    const evidence = evaluateSourceEvidence(allowedSources, sourcePolicies, subject, {
      purpose: context.purpose,
      cadence: context.cadence,
      now: context.now,
      timezone: context.timezone,
    });
    const citationSources = normalizePublicationSources(evidence.citationSources);
    if (
      !evidence.verificationSatisfied
      || !evidence.citationSatisfied
      || !citationSources
      || !hasSufficientVerification(citationSources)
      || !citationSources.every(validateSourceDates)
    ) {
      return null;
    }
    if (lens === "conflictSecurity" && requiresIndependentConflictEvidence(section) && !hasIndependentEditorialSources(citationSources)) {
      return null;
    }
    sections[lens] = { ...section, sources: citationSources };
  }

  if (containsWorldPulseInvestmentAdvice([
    pulse.summary,
    ...WORLD_PULSE_LENSES.flatMap((lens) => [sections[lens].headline, sections[lens].summary, sections[lens].implication ?? ""]),
  ])) return null;

  const parsed = worldPulseSchema.safeParse({ ...pulse, ...sections });
  return parsed.success ? parsed.data : null;
}

/**
 * A model can use a pulse to point at an already durable event, but it must
 * never invent an event reference. Drop an invalid convenience link rather
 * than fail a fully sourced pulse; empty links are intentionally allowed for
 * broad, non-actionable context.
 */
function validateWorldPulseLinks(pulse: WorldPulse | null, registryKeys: string[]): WorldPulse | null {
  if (!pulse) return null;
  const known = new Set(registryKeys);
  const parsed = worldPulseSchema.safeParse({
    ...pulse,
    conflictSecurity: {
      ...pulse.conflictSecurity,
      linkedEventKeys: pulse.conflictSecurity.linkedEventKeys.filter((key) => known.has(key)),
    },
    economy: {
      ...pulse.economy,
      linkedEventKeys: pulse.economy.linkedEventKeys.filter((key) => known.has(key)),
    },
    personalExposure: {
      ...pulse.personalExposure,
      linkedEventKeys: pulse.personalExposure.linkedEventKeys.filter((key) => known.has(key)),
    },
  });
  return parsed.success ? parsed.data : null;
}

function normalizeWorldPulseCoverage(pulse: WorldPulse): WorldPulse | null {
  const sections = WORLD_PULSE_LENSES.map((lens) => pulse[lens]);
  const allUnavailable = sections.every((section) => section.status === "unavailable");
  const hasIncompleteLens = sections.some((section) => section.status === "uncertain" || section.status === "unavailable");
  const hasChange = sections.some((section) => section.status === "changed");
  const coverage = allUnavailable ? "unavailable" : hasIncompleteLens ? "partial" : "complete";
  const overallStatus = coverage === "unavailable"
    ? "unavailable"
    : hasChange
      ? "changed"
      : coverage === "complete"
        ? "calm"
        : "partial";
  const parsed = worldPulseSchema.safeParse({ ...pulse, coverage, overallStatus });
  return parsed.success ? parsed.data : null;
}

function worldPulseSubject(lens: WorldPulseLens, section: WorldPulseSection): string {
  const label: Record<WorldPulseLens, string> = {
    conflictSecurity: "värld konflikt säkerhet krig geopolitik",
    economy: "global ekonomi räntor valuta handel energi",
    personalExposure: "personlig exponering användarprofil verksamhet risk",
  };
  return [label[lens], section.headline, section.summary, section.implication ?? ""].join(" ");
}

type StrategicRadarSectionName = "aiRoadmap" | "businessOpportunities" | "contexts";
const STRATEGIC_RADAR_SECTIONS: StrategicRadarSectionName[] = ["aiRoadmap", "businessOpportunities", "contexts"];

/**
 * Discovery's radar is only an editorial lead. Retain a post only when every
 * source URL was actually returned by the discovery search and the source is
 * allowed by the active policy. An empty formerly-populated section becomes
 * explicitly unavailable rather than a false claim that nothing is relevant.
 */
function filterStrategicRadarScanSources(
  radar: StrategicRadar | null,
  sourcePolicies: SourcePolicyRecord[],
  context: SourceRunContext,
): StrategicRadar | null {
  if (!radar) return null;
  const sections = {} as Record<StrategicRadarSectionName, StrategicRadarSection>;
  for (const name of STRATEGIC_RADAR_SECTIONS) {
    const section = radar[name];
    const items = section.items
      .map((item) => ({
        ...item,
        sources: filterRunSources(item.sources, sourcePolicies, "discovery", strategicRadarSubject(name, item), context),
      }))
      .filter((item) => item.sources.length > 0);
    sections[name] = section.status === "items_found" && items.length === 0
      ? unavailableStrategicRadarSection("Källunderlaget för den här radarsektionen kunde inte behållas enligt den aktiva källpolicyn.")
      : { ...section, items };
  }
  return normalizeStrategicRadar({ ...radar, ...sections });
}

/**
 * The final radar uses the same URL provenance, source policy and independent
 * verification gate as published event cards. AI roadmap entries additionally
 * require an official primary source from the provider itself.
 */
function applyStrategicRadarSourcePolicy(
  radar: StrategicRadar | null,
  sourcePolicies: SourcePolicyRecord[],
  context: SourceRunContext,
): StrategicRadar | null {
  if (!radar) return null;
  const sections = {} as Record<StrategicRadarSectionName, StrategicRadarSection>;
  for (const name of STRATEGIC_RADAR_SECTIONS) {
    const section = radar[name];
    if (section.status !== "items_found") {
      sections[name] = section;
      continue;
    }
    const items = section.items.flatMap((item) => {
      const subject = strategicRadarSubject(name, item);
      const allowedSources = filterRunSources(item.sources, sourcePolicies, ["verification", "citation"], subject, context);
      const evidence = evaluateSourceEvidence(allowedSources, sourcePolicies, subject, {
        purpose: context.purpose,
        cadence: context.cadence,
        now: context.now,
        timezone: context.timezone,
      });
      const citationSources = normalizePublicationSources(evidence.citationSources);
      if (
        !evidence.verificationSatisfied
        || !evidence.citationSatisfied
        || !citationSources
        || !hasSufficientVerification(citationSources)
        || !citationSources.every(validateSourceDates)
        || (name === "aiRoadmap" && !citationSources.some((source) => source.sourceType === "primary"))
        || containsStrategicRadarInvestmentAdvice(item)
      ) return [];
      return [{ ...item, sources: citationSources }];
    });
    sections[name] = items.length
      ? { ...section, items }
      : unavailableStrategicRadarSection("Källunderlaget räcker inte för att publicera en verifierad post i den här sektionen.");
  }
  return normalizeStrategicRadar({ ...radar, ...sections });
}

function strategicRadarSubject(section: StrategicRadarSectionName, item: StrategicRadarItem): string {
  const label: Record<StrategicRadarSectionName, string> = {
    aiRoadmap: "kommande AI-modellförmåga officiell roadmap",
    businessOpportunities: "konkret affärsmöjlighet upphandling partnerskap marknadsöppning",
    contexts: "relevant konferens deadline möte sammanhang",
  };
  return [label[section], item.title, item.status, item.whatChanged, item.whyRelevant, item.date ?? "", item.location ?? ""]
    .filter(Boolean)
    .join(" ");
}

function unavailableStrategicRadarSection(summary: string): StrategicRadarSection {
  return { status: "unavailable", summary, items: [] };
}

function normalizeStrategicRadar(radar: StrategicRadar | null): StrategicRadar | null {
  if (!radar) return null;
  const sections = STRATEGIC_RADAR_SECTIONS.map((name) => radar[name]);
  const unavailableCount = sections.filter((section) => section.status === "unavailable").length;
  const coverage = unavailableCount === sections.length
    ? "unavailable"
    : unavailableCount > 0
      ? "partial"
      : "complete";
  const parsed = strategicRadarSchema.safeParse({ ...radar, coverage });
  return parsed.success ? parsed.data : null;
}

function containsStrategicRadarInvestmentAdvice(item: StrategicRadarItem): boolean {
  return /\b(köp|sälj|köprekommendation|säljrekommendation|buy|sell|overweight|underweight|värderad|värdering)\b/iu.test(
    [item.title, item.whatChanged, item.whyRelevant, item.nextStep].join(" "),
  );
}

function parseStoredWorldPulse(value: unknown): WorldPulse | null {
  const parsed = worldPulseSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function containsWorldPulseInvestmentAdvice(texts: string[]): boolean {
  return /\b(köp|sälj|köprekommendation|säljrekommendation|buy|sell|overweight|underweight)\b/iu.test(texts.join(" "));
}

/**
 * The model may propose any source in its structured response, but the runner
 * decides which URLs can prove and cite an event. We keep the evidence set as
 * the persisted chain so the SQL publication gate cannot accidentally count a
 * citation-only source as verification.
 */
function applyEditorialSourcePolicy(
  decisions: EditorialCandidate[],
  sourcePolicies: SourcePolicyRecord[],
  context: SourceRunContext,
): EditorialCandidate[] {
  return decisions.flatMap((decision) => {
    const subject = sourceSubject(decision);
    const allowedSources = filterRunSources(decision.sources, sourcePolicies, ["verification", "citation"], subject, context);
    const evidence = evaluateSourceEvidence(allowedSources, sourcePolicies, subject, {
      purpose: context.purpose,
      cadence: context.cadence,
      now: context.now,
      timezone: context.timezone,
    });
    // Persist only sources that are both valid evidence and actually allowed to
    // appear as citations. This prevents an invisible verification-only or
    // environment-blocked URL from silently entering the event chain.
    if (!evidence.verificationSatisfied || !evidence.citationSatisfied || !hasSufficientVerification(evidence.citationSources)) return [];
    return [{ ...decision, sources: evidence.citationSources }];
  });
}

/**
 * A policy rule controls more than visual rendering. Every returned source is
 * (1) allowed for this run's role/frequency, (2) within the final domain list
 * sent to web_search, and (3) a URL the tool actually cited in this response.
 */
function filterRunSources(
  sources: Source[],
  sourcePolicies: SourcePolicyRecord[],
  role: SourceRole | SourceRole[],
  subject: string,
  context: SourceRunContext,
): Source[] {
  const policyAllowed = filterSourcesByPolicy(sources, sourcePolicies, role, subject, {
    purpose: context.purpose,
    cadence: context.cadence,
    now: context.now,
    timezone: context.timezone,
  });
  const citedUrls = new Set(context.citedUrls);
  return policyAllowed.filter((source) => {
    const domain = sourceDomain(source.url);
    const citationUrl = normalizeWebCitationUrl(source.url);
    return Boolean(
      domain
      && context.allowedDomains.some((allowed) => domain === allowed || domain.endsWith(`.${allowed}`))
      && citationUrl
      && citedUrls.has(citationUrl),
    );
  });
}

function sourceSubject(candidate: Pick<EditorialCandidate, "title" | "category" | "actors" | "regions" | "whatChanged" | "termsSummary" | "materialFacts">): string {
  return [
    candidate.title,
    candidate.category,
    candidate.whatChanged,
    candidate.termsSummary,
    ...candidate.materialFacts.flatMap((fact) => [fact.dimension, fact.subject, fact.value ?? ""]),
    ...candidate.actors,
    ...candidate.regions,
  ]
    .filter(Boolean)
    .join(" ");
}

function restrictConfiguredDomains(policyDomains: string[], configuredDomains?: string[]): string[] {
  return configuredDomains?.length
    ? policyDomains.filter((domain) => configuredDomains.includes(domain))
    : policyDomains;
}

async function getBriefDefinition(
  database: ReturnType<typeof createAdminClient>,
  userId: string,
  requestedId?: string,
): Promise<BriefDefinitionRow> {
  let query = database
    .from("brief_definitions")
    .select("id, is_primary, name, instructions, cadence, timezone, local_time, max_items, brief_depth, relevance_threshold, alert_threshold, only_when_changed")
    .eq("user_id", userId)
    .eq("active", true);
  query = requestedId ? query.eq("id", requestedId) : query.eq("is_primary", true);
  const { data, error } = await query.maybeSingle();
  if (error) throw new BriefRunError(`Kunde inte läsa briefdefinitionen: ${error.message}`);
  if (!data) throw new BriefRunError(requestedId ? "Den valda briefen finns inte eller är pausad." : "Ingen aktiv huvudbrief hittades.");
  return data as BriefDefinitionRow;
}

function applyBriefDefinition(settings: ProfileSettings, definition: BriefDefinitionRow): ProfileSettings {
  return {
    ...settings,
    timezone: definition.timezone,
    dailyBriefTime: String(definition.local_time).slice(0, 5),
    maxItems: definition.max_items,
    briefDepth: definition.brief_depth,
    relevanceThreshold: definition.relevance_threshold,
    alertThreshold: definition.alert_threshold,
  };
}

async function getCompleteBriefForDate(
  database: ReturnType<typeof createAdminClient>,
  userId: string,
  briefDefinitionId: string,
  briefDate: string,
): Promise<{ id: string; item_count: number; no_material_changes: boolean; assessment: string | null; worldPulse: WorldPulse | null } | null> {
  const { data, error } = await database
    .from("briefs")
    .select("id, item_count, no_material_changes, assessment, world_pulse")
    .eq("user_id", userId)
    .eq("brief_definition_id", briefDefinitionId)
    .eq("brief_date", briefDate)
    .eq("state", "complete")
    .maybeSingle();
  if (error) throw new Error(`Kunde inte kontrollera om dagens brief redan är publicerad: ${error.message}`);
  if (!data) return null;
  const row = data as {
    id: string;
    item_count: number;
    no_material_changes: boolean;
    assessment: string | null;
    world_pulse?: unknown;
  };
  return { ...row, worldPulse: parseStoredWorldPulse(row.world_pulse) };
}

/** A quiet only_when_changed run has no brief row, so its completed run is the guard. */
async function getCompleteDailyRunForDate(
  database: ReturnType<typeof createAdminClient>,
  userId: string,
  briefDefinitionId: string,
  briefDate: string,
): Promise<{ id: string } | null> {
  const { data, error } = await database
    .from("processing_runs")
    .select("id")
    .eq("user_id", userId)
    .eq("brief_definition_id", briefDefinitionId)
    .eq("local_brief_date", briefDate)
    .eq("state", "complete")
    .in("triggered_by", ["cron", "manual", "retry"])
    .order("finished_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Kunde inte kontrollera en tidigare tyst körning: ${error.message}`);
  return data;
}

/** Vercel terminates route handlers after their configured duration; unlock a stranded attempt before retrying. */
async function recoverStaleRun(
  database: ReturnType<typeof createAdminClient>,
  userId: string,
  briefDefinitionId: string,
  briefDate: string,
  now: Date,
): Promise<void> {
  const cutoff = new Date(now.getTime() - 10 * 60 * 1_000).toISOString();
  const { error } = await database
    .from("processing_runs")
    .update({
      state: "failed",
      phase: "failed",
      finished_at: now.toISOString(),
      error_message: "Körningen avslutades utan slutstatus och kan nu köras om.",
      validation_errors: ["Körningen blev äldre än tio minuter utan slutstatus."],
    })
    .eq("user_id", userId)
    .eq("brief_definition_id", briefDefinitionId)
    .eq("local_brief_date", briefDate)
    .eq("state", "running")
    .lt("started_at", cutoff);
  if (error) throw new Error(`Kunde inte återställa en strandad körning: ${error.message}`);
}

async function getCoverageStart(
  database: ReturnType<typeof createAdminClient>,
  userId: string,
  briefDefinitionId: string,
  now: Date,
  purpose: "brief" | "watch",
): Promise<string> {
  let query = database
    .from("processing_runs")
    .select("coverage_to, finished_at")
    .eq("user_id", userId)
    .eq("brief_definition_id", briefDefinitionId)
    .eq("state", "complete")
    .order("finished_at", { ascending: false })
    .limit(1);
  // A monitor has its own cursor. Its successful ingest must never shrink the
  // coverage window of the next scheduled brief, otherwise an alert at 10:00
  // can disappear from the next daily brief at 07:00.
  if (purpose === "brief") query = query.in("triggered_by", ["cron", "manual", "retry"]);
  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(`Kunde inte avgöra föregående täckningsperiod: ${error.message}`);
  if (data?.coverage_to || data?.finished_at) return data.coverage_to ?? data.finished_at;
  return new Date(now.getTime() - 26 * 60 * 60 * 1_000).toISOString();
}

/** Monday through the current local date; no UTC weekday drift around midnight. */
function startOfWeekInTimezone(timezone: string, now: Date): string {
  const localDate = localDateInTimezone(timezone, now);
  const [year, month, day] = localDate.split("-").map(Number);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  const daysSinceMonday = (calendarDate.getUTCDay() + 6) % 7;
  calendarDate.setUTCDate(calendarDate.getUTCDate() - daysSinceMonday);
  return calendarDate.toISOString().slice(0, 10);
}

/**
 * This reads only previously delivered brief items. A new discovery candidate
 * is deliberately excluded until it has passed the normal publication
 * transaction, so the weekly layer cannot turn an unpersisted claim into a
 * second path to the UI.
 */
async function loadWeeklyRecapContext(
  database: ReturnType<typeof createAdminClient>,
  input: {
    userId: string;
    briefDefinitionId: string;
    periodStart: string;
    periodEnd: string;
    timezone: string;
    sourcePolicies: SourcePolicyRecord[];
  },
): Promise<WeeklyRecapContext> {
  const empty: WeeklyRecapContext = { periodStart: input.periodStart, periodEnd: input.periodEnd, items: [] };
  const { data: rawBriefs, error: briefsError } = await database
    .from("briefs")
    .select("id")
    .eq("user_id", input.userId)
    .eq("brief_definition_id", input.briefDefinitionId)
    .eq("state", "complete")
    .gte("brief_date", input.periodStart)
    .lte("brief_date", input.periodEnd);
  if (briefsError) throw new Error(`Kunde inte läsa veckans tidigare briefs: ${briefsError.message}`);
  const briefIds = (rawBriefs ?? [])
    .map((brief: RawRecord) => brief.id)
    .filter((id): id is string => typeof id === "string");
  if (!briefIds.length) return empty;

  const { data: rawItems, error: itemsError } = await database
    .from("brief_items")
    .select("event_id, event_update_id, title_snapshot, what_changed, why_relevant, relevance_score")
    .in("brief_id", briefIds);
  if (itemsError) throw new Error(`Kunde inte läsa veckans briefposter: ${itemsError.message}`);
  const historyItems = (rawItems ?? []) as WeeklyRecapBriefItemRow[];
  const updateIds = [...new Set(historyItems
    .map((item) => item.event_update_id)
    .filter((id): id is string => typeof id === "string"))];
  if (!updateIds.length) return empty;

  const [{ data: rawUpdates, error: updatesError }, { data: rawSources, error: sourcesError }] = await Promise.all([
    database.from("event_updates").select("id, event_id, occurred_at").in("id", updateIds),
    database.from("event_sources").select("event_id, event_update_id, source_name, url, source_type, published_at, event_date, supports_claim").in("event_update_id", updateIds),
  ]);
  if (updatesError) throw new Error(`Kunde inte läsa veckans händelseuppdateringar: ${updatesError.message}`);
  if (sourcesError) throw new Error(`Kunde inte läsa veckans källor: ${sourcesError.message}`);

  const updateById = new Map((rawUpdates ?? []).map((update: RawRecord) => {
    const row = update as WeeklyRecapUpdateRow;
    return [row.id, row] as const;
  }));
  const sourcesByUpdateId = new Map<string, Source[]>();
  for (const source of (rawSources ?? []) as WeeklyRecapSourceRow[]) {
    if (!source.event_update_id) continue;
    const current = sourcesByUpdateId.get(source.event_update_id) ?? [];
    current.push({
      sourceName: source.source_name,
      url: source.url,
      sourceType: source.source_type,
      publishedAt: source.published_at,
      eventDate: source.event_date,
      supportsClaim: source.supports_claim,
    });
    sourcesByUpdateId.set(source.event_update_id, current);
  }

  const bestItemByUpdateId = new Map<string, WeeklyRecapBriefItemRow>();
  for (const item of historyItems) {
    if (!item.event_update_id) continue;
    const previous = bestItemByUpdateId.get(item.event_update_id);
    if (!previous || item.relevance_score > previous.relevance_score) bestItemByUpdateId.set(item.event_update_id, item);
  }

  const items: WeeklyRecapStoredItem[] = [];
  for (const [eventUpdateId, item] of bestItemByUpdateId) {
    const update = updateById.get(eventUpdateId);
    if (!update || update.event_id !== item.event_id) continue;
    const date = localDateInTimezone(input.timezone, new Date(update.occurred_at));
    if (date < input.periodStart || date > input.periodEnd) continue;

    const subject = `${item.title_snapshot} ${item.what_changed} ${item.why_relevant}`;
    const evidence = evaluateSourceEvidence(sourcesByUpdateId.get(eventUpdateId) ?? [], input.sourcePolicies, subject);
    const citationSources = normalizePublicationSources(evidence.citationSources);
    if (
      !evidence.verificationSatisfied
      || !evidence.citationSatisfied
      || !citationSources
      || !hasSufficientVerification(citationSources)
      || !citationSources.every(validateSourceDates)
    ) continue;

    items.push({
      eventId: item.event_id,
      eventUpdateId,
      date,
      title: item.title_snapshot,
      whatChanged: item.what_changed,
      whyItMatters: item.why_relevant,
      relevanceScore: item.relevance_score,
      sources: citationSources.slice(0, 3),
    });
  }

  return {
    ...empty,
    items: items
      .sort((left, right) => right.relevanceScore - left.relevanceScore || right.date.localeCompare(left.date))
      .slice(0, 20),
  };
}

/**
 * The model has no authority to write the recap. It may select known update
 * IDs, while this function copies every display field from the durable context.
 * Falling back to the strongest stored items keeps a primary brief complete on
 * a calm day if the model returns an empty selection.
 */
export function buildWeeklyRecap(input: {
  context: WeeklyRecapContext;
  selection: { eventUpdateIds: string[] } | null;
}): WeeklyRecap {
  const byUpdateId = new Map(input.context.items.map((item) => [item.eventUpdateId, item]));
  const selectedIds = input.selection?.eventUpdateIds.length
    ? input.selection.eventUpdateIds
    : input.context.items.slice(0, 5).map((item) => item.eventUpdateId);
  const selectedItems = selectedIds.map((eventUpdateId) => {
    const item = byUpdateId.get(eventUpdateId);
    if (!item) throw new Error("Veckosammanfattningen hänvisar till en händelseuppdatering som inte finns i den sparade briefhistoriken.");
    return {
      eventId: item.eventId,
      eventUpdateId: item.eventUpdateId,
      date: item.date,
      title: item.title,
      whatChanged: item.whatChanged,
      whyItMatters: item.whyItMatters,
      sources: item.sources,
    };
  });
  const summary = selectedItems.length === 0
    ? "Veckan hittills: inga tidigare verifierade förändringar. Dagens nya beslutskort visas ovanför."
    : `Veckan hittills: ${selectedItems.length} tidigare verifierade förändringar. Dagens nya beslutskort visas ovanför.`;
  return weeklyRecapSchema.parse({
    periodStart: input.context.periodStart,
    periodEnd: input.context.periodEnd,
    summary,
    items: selectedItems,
  });
}

async function loadEditorialContext(database: ReturnType<typeof createAdminClient>, userId: string, briefDefinitionId: string): Promise<{
  events: StoredEvent[];
  states: UserEventState[];
  knownUpdates: KnownUpdate[];
  feedback: FeedbackRecord[];
}> {
  const [events, states, knownUpdates, feedbackResult] = await Promise.all([
    loadAllEvents(database),
    loadAllBriefEventStates(database, userId, briefDefinitionId),
    loadAllKnownUpdates(database),
    database.from("feedback").select("event_id, type").eq("user_id", userId).order("updated_at", { ascending: false }).limit(200),
  ]);
  if (feedbackResult.error) throw new Error(`Kunde inte läsa återkopplingshistorik: ${feedbackResult.error.message}`);

  return {
    events: events.map((event: RawRecord) => {
      const row = event as EventContextRow;
      return {
        id: row.id,
        canonicalKey: row.canonical_key,
        title: row.title,
        category: row.category,
        actors: Array.isArray(row.actors) ? row.actors.filter((actor): actor is string => typeof actor === "string") : [],
        regions: Array.isArray(row.regions) ? row.regions.filter((region): region is string => typeof region === "string") : [],
        status: row.status,
        termsSummary: row.latest_terms_summary,
        effectiveDate: row.effective_date,
        confidence: row.confidence,
        shortTermImpact: row.latest_short_term_impact,
        longTermImpact: row.latest_long_term_impact,
      };
    }),
    states: states.map((state: RawRecord) => {
      const row = state as UserEventStateRow;
      return { eventId: row.event_id, lastPublishedUpdateId: row.last_published_update_id };
    }),
    knownUpdates: knownUpdates.map((update: RawRecord) => {
      const row = update as EventUpdateContextRow;
      return {
        id: row.id,
        eventId: row.event_id,
        materialFingerprint: row.material_fingerprint,
        previousStatus: row.previous_status,
        nextStatus: row.new_status,
        occurredAt: row.occurred_at,
      };
    }),
    feedback: (feedbackResult.data ?? []).flatMap((feedback: RawRecord) => {
      const row = feedback as FeedbackContextRow;
      return isFeedbackType(row.type) ? [{ eventId: row.event_id, type: row.type }] : [];
    }),
  };
}

function isFeedbackType(value: unknown): value is FeedbackRecord["type"] {
  return value === "important" || value === "not_relevant" || value === "more_like_this" || value === "less_like_this";
}

/** The register is permanent; paginate rather than silently losing old state. */
async function loadAllEvents(database: ReturnType<typeof createAdminClient>): Promise<RawRecord[]> {
  const rows: RawRecord[] = [];
  const pageSize = 1_000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await database
      .from("events")
      .select("*")
      .order("updated_at", { ascending: false })
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error("Kunde inte läsa händelseregistret: " + error.message);
    const page = (data ?? []) as RawRecord[];
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

async function loadAllBriefEventStates(
  database: ReturnType<typeof createAdminClient>,
  userId: string,
  briefDefinitionId: string,
): Promise<RawRecord[]> {
  const rows: RawRecord[] = [];
  const pageSize = 1_000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await database
      .from("brief_event_state")
      .select("*")
      .eq("user_id", userId)
      .eq("brief_definition_id", briefDefinitionId)
      .order("event_id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error("Kunde inte läsa briefens händelsestatus: " + error.message);
    const page = (data ?? []) as RawRecord[];
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

async function loadAllKnownUpdates(database: ReturnType<typeof createAdminClient>): Promise<RawRecord[]> {
  const rows: RawRecord[] = [];
  const pageSize = 1_000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await database
      .from("event_updates")
      .select("id, event_id, material_fingerprint, previous_status, new_status, occurred_at")
      .order("occurred_at", { ascending: false })
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error("Kunde inte läsa tidigare händelseuppdateringar: " + error.message);
    const page = (data ?? []) as RawRecord[];
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

function limitToThreeSentences(value: string): string {
  const sentences = value.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [];
  return sentences.slice(0, 3).join(" ").trim();
}

async function logModelCall(
  database: ReturnType<typeof createAdminClient>,
  runId: string,
  stage: "discovery" | "editorial",
  metadata: ModelCallMetadata,
): Promise<void> {
  const { error } = await database.from("model_calls").insert({
    processing_run_id: runId,
    stage,
    model_name: metadata.model,
    response_id: metadata.responseId,
    state: "complete",
    input_tokens: metadata.inputTokens,
    output_tokens: metadata.outputTokens,
    cached_tokens: metadata.cachedTokens,
    metadata: { webSearchCalls: metadata.webSearchCalls, webCitationCount: metadata.webCitationUrls.length },
  });
  if (error) throw new Error(`Kunde inte logga modellkörningen: ${error.message}`);
}

async function updateRun(
  database: ReturnType<typeof createAdminClient>,
  runId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const { error } = await database.from("processing_runs").update(patch).eq("id", runId);
  if (error) throw new Error(`Kunde inte uppdatera körstatus: ${error.message}`);
}

/** Persist failures discovered before a normal running-row can be created. */
async function recordPreflightFailure(
  database: ReturnType<typeof createAdminClient>,
  input: {
    userId: string;
    briefDefinitionId: string;
    briefDate: string;
    triggeredBy: TriggeredBy;
    coverageFrom: string;
    now: Date;
    message: string;
    searchMetadata: Record<string, unknown>;
  },
): Promise<string | null> {
  const { data, error } = await database
    .from("processing_runs")
    .insert({
      user_id: input.userId,
      brief_definition_id: input.briefDefinitionId,
      local_brief_date: input.briefDate,
      triggered_by: input.triggeredBy,
      state: "failed",
      phase: "failed",
      started_at: input.now.toISOString(),
      finished_at: input.now.toISOString(),
      coverage_from: input.coverageFrom,
      model_name: getOpenAIModel(),
      search_metadata: input.searchMetadata,
      validation_errors: [input.message],
      error_message: input.message,
    })
    .select("id")
    .maybeSingle();
  // Preserve the original configuration error even if the observability write
  // itself fails; cron will expose it and continue with other definitions.
  if (error) return null;
  return data?.id ?? null;
}

async function recordAncillaryDeliveryError(
  database: ReturnType<typeof createAdminClient>,
  runId: string,
  prefix: string,
  reason: unknown,
): Promise<void> {
  const message = reason instanceof Error ? reason.message : "okänt fel";
  const { error } = await database
    .from("processing_runs")
    .update({ validation_errors: [`${prefix}: ${message}`] })
    .eq("id", runId);
  // The brief/registry is already durable. Never downgrade a completed run
  // merely because the best-effort diagnostic write also failed.
  if (error) return;
}
