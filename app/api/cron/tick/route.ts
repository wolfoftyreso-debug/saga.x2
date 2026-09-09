import { NextRequest, NextResponse } from "next/server";
import { getNeonDatabaseConfigurationState, missingNeonConfiguration } from "@/lib/neon/config";
import { runDueAdAutomationWorker } from "@/lib/neon/ad-automation-worker";
import { runNeonStudioAutomationWorker } from "@/lib/neon/studio-automation-worker";
import { runDueSagaNewsSources } from "@/lib/services/saga-news-runner";
import { runDueSagaDailyKnowledgeWorker } from "@/lib/neon/saga-daily-knowledge-worker";
import { runDueSagaSignalProductionWorker } from "@/lib/neon/saga-signal-production-worker";
import { runDueSagaQuarterlyActivityPlanWorker } from "@/lib/neon/saga-quarterly-planning-worker";
import { materializeSagaAutomationMediaGenerationJobs } from "@/lib/neon/saga-media-generation-worker";
import {
  claimSagaCronTickLease,
  completeSagaCronTickLease,
  type SagaCronTickLease,
  type SagaCronTickOutcome,
  type SagaCronTickSummary,
} from "@/lib/neon/saga-cron-tick-repository";
import { authorizeVercelCron } from "@/lib/vercel/cron-auth";
import { withExecutionDeadline } from "@/lib/server/execution-deadline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const noStoreHeaders = {
  "cache-control": "no-store",
  "x-robots-tag": "noindex",
};

// The work budget leaves eight seconds below the Vercel 60-second function
// ceiling for serialization and the fenced lease completion. The 75-second
// lease leaves a further 15-second safety margin if Vercel is still unwinding.
const TICK_TIME_BUDGET_MS = 52_000;
const TICK_FINALIZE_BUDGET_MS = 56_000;
const TICK_LEASE_SECONDS = 75;

/**
 * The Vercel-first cron entrypoint runs bounded Neon workers in parallel:
 * private Studio draft generation, draft-only ad creative briefs,
 * source-to-signal research, opt-in daily knowledge bundles, opt-in
 * signal-to-review production, and the
 * receipt-only handoff to the dedicated private media worker. No path
 * publishes, sends, buys, invokes an image model, or creates a public post.
 */
export async function GET(request: NextRequest) {
  const authorization = authorizeVercelCron(request);
  if (!authorization.ok) {
    if (authorization.code === "configuration_required") {
      return noStore(
        {
          ok: false,
          code: "configuration_required",
          missing: authorization.missing,
          scheduler: { status: "not_installed", workPerformed: false },
        },
        503,
      );
    }

    return noStore({ ok: false, code: "unauthorized", error: "Otillåten cron-förfrågan." }, 401);
  }

  const databaseConfiguration = getNeonDatabaseConfigurationState();
  if (databaseConfiguration === "missing") {
    return noStore(
      {
        ok: false,
        code: "configuration_required",
        missing: missingNeonConfiguration(),
        scheduler: { status: "not_installed", workPerformed: false },
      },
      503,
    );
  }

  if (databaseConfiguration === "invalid") {
    return noStore(
      {
        ok: false,
        code: "database_configuration_invalid",
        scheduler: { status: "not_installed", workPerformed: false },
      },
      503,
    );
  }

  const tickStartedAt = Date.now();
  let tickLease: SagaCronTickLease | null = null;
  try {
    tickLease = await withExecutionDeadline(tickStartedAt + 5_000,
      () => claimSagaCronTickLease({ leaseSeconds: TICK_LEASE_SECONDS }));
  } catch {
    return noStore({
      ok: false,
      code: "scheduler_unavailable",
      noPublication: true,
      scheduler: {
        status: "unavailable",
        workPerformed: false,
        tick: tickBudgetSnapshot(tickStartedAt, "lease_unavailable"),
      },
    }, 503);
  }

  // Vercel may retry a delayed invocation while a previous invocation is
  // still alive. A healthy lease owner is the source of truth; reporting a
  // successful skip avoids turning that safe overlap into a retry storm.
  if (!tickLease) {
    return noStore({
      ok: true,
      status: "already_running",
      noPublication: true,
      scheduler: {
        status: "already_running",
        workPerformed: false,
        tick: {
          ...tickBudgetSnapshot(tickStartedAt, "skipped"),
          retryAfterSeconds: 60,
        },
      },
    });
  }

  let progress: TickProgress = { workPerformed: null, workOutcome: "unknown", workers: {} };
  const runBounded = <T,>(budgetMs: number, run: () => Promise<T>) => withExecutionDeadline(
    Math.min(tickStartedAt + TICK_TIME_BUDGET_MS, Date.now() + budgetMs), run,
  );
  try {
    const [workerResult, adWorkerResult, researchResult, dailyKnowledgeResult, signalProductionResult, quarterlyPlanningResult, mediaMaterializationResult] = await Promise.allSettled([
      runBounded(45_000, () => runNeonStudioAutomationWorker({ maxJobs: 5, timeBudgetMs: 45_000, workerId: "vercel-cron" })),
      runBounded(45_000, () => runDueAdAutomationWorker({ maxRuns: 3, timeBudgetMs: 45_000, workerId: "vercel-ad-automation" })),
      // One public source at a time keeps the one-minute Vercel Cron thin and
      // leaves source-specific cadence/leases in Neon. A later Workflow can
      // scale this queue without changing the source-to-signal contract.
      runBounded(16_000, () => runDueSagaNewsSources({ limit: 1, timeBudgetMs: 16_000, workerId: "vercel-saga-news" })),
      // An explicit workspace policy can create a metadata-only daily
      // knowledge bundle from already-ingested sources. It cannot create a
      // draft, invoke a model, choose a channel or publish anything.
      runBounded(10_000, () => runDueSagaDailyKnowledgeWorker({ maxJobs: 1, timeBudgetMs: 10_000, workerId: "vercel-saga-daily-knowledge" })),
      // This is opt-in per workspace and produces only a private review draft
      // after the independent quality gate. No AI/image/outbound call exists.
      runBounded(12_000, () => runDueSagaSignalProductionWorker({ maxJobs: 2, timeBudgetMs: 12_000, workerId: "vercel-saga-signal-production" })),
      // Only resumes explicit, durable private-draft receipts. It never
      // chooses a batch, schedules a draft, produces media or publishes.
      runBounded(48_000, () => runDueSagaQuarterlyActivityPlanWorker({ maxBatches: 1, maxJobsPerBatch: 1, timeBudgetMs: 48_000, workerId: "vercel-saga-quarterly-cron" })),
      // This operation only writes idempotent Neon receipts for existing,
      // quality-passed private automation drafts. Image generation lives in
      // `/api/cron/media-generation` so the text scheduler remains bounded.
      runBounded(TICK_TIME_BUDGET_MS, () => materializeSagaAutomationMediaGenerationJobs({ limit: 5 })),
    ]);
    progress = tickProgress({ studio: workerResult, ads: adWorkerResult, research: researchResult,
      dailyKnowledge: dailyKnowledgeResult, signalProduction: signalProductionResult,
      quarterlyPlanning: quarterlyPlanningResult, media: mediaMaterializationResult });
    if (workerResult.status === "rejected" || adWorkerResult.status === "rejected") {
      return finishTickResponse(tickLease, tickStartedAt, {
        outcome: "scheduler_unavailable",
        summary: { workPerformed: progress.workPerformed, workOutcome: progress.workOutcome, coreWorkerUnavailable: true },
        body: {
        ok: false,
        code: "scheduler_unavailable",
        noPublication: true,
        scheduler: {
          status: "unavailable",
          ...progress,
          tick: tickBudgetSnapshot(tickStartedAt, "unavailable", tickLease.leaseExpiresAt),
        },
        },
        status: 503,
      });
    }

    const worker = workerResult.value;
    const adWorker = adWorkerResult.value;
    const research = researchResult.status === "fulfilled" ? researchResult.value : null;
    const researchUnavailable = research === null;
    const dailyKnowledge = dailyKnowledgeResult.status === "fulfilled" ? dailyKnowledgeResult.value : null;
    const dailyKnowledgeUnavailable = dailyKnowledge === null;
    const signalProduction = signalProductionResult.status === "fulfilled" ? signalProductionResult.value : null;
    const signalProductionUnavailable = signalProduction === null;
    const quarterlyPlanning = quarterlyPlanningResult.status === "fulfilled" ? quarterlyPlanningResult.value : null;
    const quarterlyPlanningUnavailable = quarterlyPlanning === null;
    const mediaMaterialization = mediaMaterializationResult.status === "fulfilled" ? mediaMaterializationResult.value : null;
    const mediaMaterializationUnavailable = mediaMaterialization === null;
    const researchFailed = research?.failed ?? 1;
    const tickBudget = tickBudgetSnapshot(tickStartedAt, "completed", tickLease.leaseExpiresAt);
    const timeBudgetReached = tickBudget.timeBudgetReached
      || worker.timeBudgetReached
      || adWorker.timeBudgetReached
      || (research?.timeBudgetReached ?? false)
      || (dailyKnowledge?.timeBudgetReached ?? false)
      || (signalProduction?.timeBudgetReached ?? false)
      || (quarterlyPlanning?.timeBudgetReached ?? false);
    const hasRecordedFailures = worker.retriesScheduled > 0
      || worker.failuresRecorded > 0
      || adWorker.failuresRecorded > 0
      || (dailyKnowledge?.retriesScheduled ?? 0) > 0
      || (dailyKnowledge?.failuresRecorded ?? 0) > 0
      || (signalProduction?.retriesScheduled ?? 0) > 0
      || (signalProduction?.failuresRecorded ?? 0) > 0
      || (quarterlyPlanning?.failuresRecorded ?? 0) > 0;
    const workPerformed = progress.workPerformed;
    const status: SagaCronTickOutcome = hasRecordedFailures || researchUnavailable || dailyKnowledgeUnavailable || signalProductionUnavailable || quarterlyPlanningUnavailable || mediaMaterializationUnavailable || researchFailed > 0
      ? "completed_with_failures"
      : timeBudgetReached
        ? "time_budget_reached"
        : workPerformed
          ? "completed"
          : "idle";
    return finishTickResponse(tickLease, tickStartedAt, {
      outcome: status,
      summary: {
        workPerformed,
        workOutcome: progress.workOutcome,
        studioJobsClaimed: worker.jobsClaimed,
        adRunsClaimed: adWorker.runsClaimed,
        researchSourcesClaimed: research?.claimed ?? 0,
        dailyKnowledgeJobsClaimed: dailyKnowledge?.jobsClaimed ?? 0,
        signalProductionJobsClaimed: signalProduction?.jobsClaimed ?? 0,
        quarterlyReceiptsClaimed: quarterlyPlanning?.receiptsClaimed ?? 0,
        mediaJobsMaterialized: mediaMaterialization?.jobsCreated ?? 0,
        failuresRecorded: hasRecordedFailures || researchFailed > 0,
        timeBudgetReached,
      },
      body: {
        ok: !hasRecordedFailures && !researchUnavailable && !dailyKnowledgeUnavailable && !signalProductionUnavailable && !quarterlyPlanningUnavailable && !mediaMaterializationUnavailable && researchFailed === 0,
        status,
        noPublication: true,
        scheduler: {
          status: "active",
          ...progress,
          jobLimit: 5,
          jobsClaimed: worker.jobsClaimed,
          draftsCreated: worker.draftsCreated,
          retriesScheduled: worker.retriesScheduled,
          failuresRecorded: worker.failuresRecorded,
          leasesLost: worker.leasesLost,
          timeBudgetReached,
          tick: { ...tickBudget, status, leaseExpiresAt: tickLease.leaseExpiresAt },
        },
        materialization: worker.materialization,
        jobs: worker.jobs,
        adAutomations: {
          status: adWorker.failuresRecorded > 0 ? "completed_with_failures" : adWorker.timeBudgetReached ? "time_budget_reached" : adWorker.runsClaimed > 0 || adWorker.materialization.runsCreated > 0 ? "active" : "idle",
          deterministicDraftsOnly: true,
          externalExecution: "unavailable",
          materialization: adWorker.materialization,
          runsClaimed: adWorker.runsClaimed,
          draftsCreated: adWorker.draftsCreated,
          failuresRecorded: adWorker.failuresRecorded,
          leasesLost: adWorker.leasesLost,
          timeBudgetReached: adWorker.timeBudgetReached,
          runs: adWorker.runs,
        },
        research: research
          ? {
            status: research.failed > 0 ? "completed_with_failures" : research.timeBudgetReached ? "time_budget_reached" : "active",
            claimed: research.claimed,
            completed: research.completed,
            failed: research.failed,
            released: research.released,
            timeBudgetReached: research.timeBudgetReached,
            runs: research.runs,
            noPublication: true,
          }
          : {
            status: "unavailable",
            noPublication: true,
          },
        dailyKnowledge: dailyKnowledge
          ? {
            status: dailyKnowledge.failuresRecorded > 0 || dailyKnowledge.retriesScheduled > 0
              ? "completed_with_failures"
              : dailyKnowledge.timeBudgetReached
                ? "time_budget_reached"
                : dailyKnowledge.knowledgeBundlesCreated > 0 || dailyKnowledge.noQualifyingEvidence > 0 || dailyKnowledge.jobsClaimed > 0
                  ? "active"
                  : "idle",
            metadataOnly: true,
            draftsCreated: 0,
            externalExecution: "unavailable",
            materialization: dailyKnowledge.materialization,
            staleCancelled: dailyKnowledge.staleCancelled,
            leasesExpired: dailyKnowledge.leasesExpired,
            retentionPruned: dailyKnowledge.retentionPruned,
            jobsClaimed: dailyKnowledge.jobsClaimed,
            knowledgeBundlesCreated: dailyKnowledge.knowledgeBundlesCreated,
            noQualifyingEvidence: dailyKnowledge.noQualifyingEvidence,
            retriesScheduled: dailyKnowledge.retriesScheduled,
            failuresRecorded: dailyKnowledge.failuresRecorded,
            leasesLost: dailyKnowledge.leasesLost,
            timeBudgetReached: dailyKnowledge.timeBudgetReached,
            jobs: dailyKnowledge.jobs,
            noPublication: true,
          }
          : {
            status: "unavailable",
            metadataOnly: true,
            draftsCreated: 0,
            externalExecution: "unavailable",
            noPublication: true,
          },
        signalProduction: signalProduction
          ? {
            status: signalProduction.failuresRecorded > 0 || signalProduction.retriesScheduled > 0
              ? "completed_with_failures"
              : signalProduction.timeBudgetReached
                ? "time_budget_reached"
                : signalProduction.reviewDraftsCreated > 0 || signalProduction.jobsClaimed > 0
                  ? "active"
                  : "idle",
            privateReviewDraftsOnly: true,
            externalExecution: "unavailable",
            materialization: signalProduction.materialization,
            staleCancelled: signalProduction.staleCancelled,
            leasesExpired: signalProduction.leasesExpired,
            jobsClaimed: signalProduction.jobsClaimed,
            reviewDraftsCreated: signalProduction.reviewDraftsCreated,
            qualityBlocked: signalProduction.qualityBlocked,
            retriesScheduled: signalProduction.retriesScheduled,
            failuresRecorded: signalProduction.failuresRecorded,
            leasesLost: signalProduction.leasesLost,
            timeBudgetReached: signalProduction.timeBudgetReached,
            jobs: signalProduction.jobs,
            noPublication: true,
          }
          : {
            status: "unavailable",
            privateReviewDraftsOnly: true,
            externalExecution: "unavailable",
            noPublication: true,
          },
        quarterlyPlanning: quarterlyPlanning
          ? {
            status: quarterlyPlanning.failuresRecorded > 0
              ? "completed_with_failures"
              : quarterlyPlanning.timeBudgetReached
                ? "time_budget_reached"
                : quarterlyPlanning.privateDraftsCreated > 0 || quarterlyPlanning.receiptsClaimed > 0
                  ? "active"
                  : "idle",
            privateReviewDraftsOnly: true,
            media: "manual_action_required",
            receiptsClaimed: quarterlyPlanning.receiptsClaimed,
            privateDraftsCreated: quarterlyPlanning.privateDraftsCreated,
            failuresRecorded: quarterlyPlanning.failuresRecorded,
            timeBudgetReached: quarterlyPlanning.timeBudgetReached,
            receipts: quarterlyPlanning.receipts,
            noPublication: true,
          }
          : {
            status: "unavailable",
            privateReviewDraftsOnly: true,
            media: "manual_action_required",
            noPublication: true,
          },
        mediaGeneration: mediaMaterialization
          ? {
            status: mediaMaterialization.jobsCreated > 0 ? "queued" : "idle",
            privateOnly: true,
            dispatcherOnly: true,
            dedicatedCron: "/api/cron/media-generation",
            materialization: mediaMaterialization,
            noPublication: true,
          }
          : {
            status: "unavailable",
            privateOnly: true,
            dispatcherOnly: true,
            noPublication: true,
          },
      },
      status: 200,
    });
  } catch {
    return finishTickResponse(tickLease, tickStartedAt, {
      outcome: "scheduler_unavailable",
      summary: { workPerformed: progress.workPerformed, workOutcome: progress.workOutcome, unexpectedSchedulerFailure: true },
      body: {
        ok: false,
        code: "scheduler_unavailable",
        noPublication: true,
        scheduler: {
          status: "unavailable",
          ...progress,
          tick: tickBudgetSnapshot(tickStartedAt, "unavailable", tickLease.leaseExpiresAt),
        },
      },
      status: 503,
    });
  }
}

function tickBudgetSnapshot(
  startedAt: number,
  status: string,
  leaseExpiresAt?: string,
): {
  status: string;
  timeBudgetMs: number;
  elapsedMs: number;
  remainingMs: number;
  timeBudgetReached: boolean;
  leaseExpiresAt?: string;
} {
  const elapsedMs = Math.max(0, Math.min(120_000, Date.now() - startedAt));
  return {
    status,
    timeBudgetMs: TICK_TIME_BUDGET_MS,
    elapsedMs,
    remainingMs: Math.max(0, TICK_TIME_BUDGET_MS - elapsedMs),
    timeBudgetReached: elapsedMs >= TICK_TIME_BUDGET_MS,
    ...(leaseExpiresAt ? { leaseExpiresAt } : {}),
  };
}

async function finishTickResponse(
  lease: SagaCronTickLease,
  startedAt: number,
  input: {
    outcome: SagaCronTickOutcome;
    summary: SagaCronTickSummary;
    body: unknown;
    status: number;
  },
): Promise<NextResponse> {
  const tick = tickBudgetSnapshot(startedAt, input.outcome, lease.leaseExpiresAt);
  try {
    const completed = await withExecutionDeadline(startedAt + TICK_FINALIZE_BUDGET_MS, () => completeSagaCronTickLease(lease, {
      outcome: input.outcome,
      durationMs: tick.elapsedMs,
      summary: {
        ...input.summary,
        outcome: input.outcome,
        timeBudgetMs: tick.timeBudgetMs,
        elapsedMs: tick.elapsedMs,
        timeBudgetReached: input.summary.timeBudgetReached === true || tick.timeBudgetReached,
      },
    }));
    if (completed) return noStore(input.body, input.status);
  } catch {
    // A route can still be alive after an upstream database interruption. The
    // live row expires safely, but never report an unpersisted heartbeat as a
    // successful scheduler run.
  }

  const previousBody = input.body as Record<string, unknown>;
  return noStore({
    ...previousBody,
    ok: false,
    code: "scheduler_lease_unavailable",
    noPublication: true,
    scheduler: {
      ...(previousBody.scheduler as Record<string, unknown>),
      status: "unavailable",
      workPerformed: input.summary.workPerformed,
      completionRecorded: false,
      tick: tickBudgetSnapshot(startedAt, "lease_lost", lease.leaseExpiresAt),
    },
  }, 503);
}

type TickProgress = {
  workPerformed: boolean | null;
  workOutcome: "confirmed" | "partial_unknown" | "unknown";
  workers: Record<string, { status: "fulfilled" | "unknown"; counters?: Record<string, number> }>;
};

function tickProgress(results: Record<string, PromiseSettledResult<unknown>>): TickProgress {
  const progress: TickProgress = { workPerformed: false, workOutcome: "confirmed", workers: {} };
  let unknown = false;
  const workCounters = ["jobsClaimed", "runsClaimed", "receiptsClaimed", "claimed", "completed", "draftsCreated", "reviewDraftsCreated",
    "privateDraftsCreated", "knowledgeBundlesCreated", "noQualifyingEvidence", "released", "staleCancelled", "leasesExpired", "retentionPruned",
    "failuresRecorded", "retriesScheduled", "qualityBlocked"];
  for (const [name, result] of Object.entries(results)) {
    if (result.status === "rejected") {
      unknown = true;
      progress.workers[name] = { status: "unknown" };
      continue;
    }
    const value = result.value as Record<string, unknown>;
    const materialization = value.materialization as Record<string, unknown> | undefined;
    const counters = Object.fromEntries(workCounters.filter((key) => typeof value[key] === "number")
      .map((key) => [key, value[key] as number]));
    for (const key of ["jobsCreated", "runsCreated", "nextRunsUpdated"]) {
      const count = materialization?.[key] ?? value[key];
      if (typeof count === "number") counters[key] = count;
    }
    if (Object.values(counters).some((count) => count > 0)) progress.workPerformed = true;
    progress.workers[name] = { status: "fulfilled", counters };
  }
  if (unknown) {
    progress.workOutcome = progress.workPerformed ? "partial_unknown" : "unknown";
    if (!progress.workPerformed) progress.workPerformed = null;
  }
  return progress;
}

function noStore(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: noStoreHeaders });
}
