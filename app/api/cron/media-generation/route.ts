import { NextRequest, NextResponse } from "next/server";
import { getNeonDatabaseConfigurationState, missingNeonConfiguration } from "@/lib/neon/config";
import { SagaAutomationMediaWorkerError, runDueSagaAutomationMediaGenerationWorker } from "@/lib/neon/saga-media-generation-worker";
import { withExecutionDeadline } from "@/lib/server/execution-deadline";
import { authorizeVercelCron } from "@/lib/vercel/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const noStoreHeaders = {
  "cache-control": "no-store",
  "x-robots-tag": "noindex",
};

/**
 * Dedicated image worker. The general `/api/cron/tick` only materializes
 * durable receipts; this route claims at most one and never invokes text
 * generation, publication, email, or a social provider in the same run.
 */
export async function GET(request: NextRequest) {
  const deadlineAt = Date.now() + 56_000;
  const authorization = authorizeVercelCron(request);
  if (!authorization.ok) {
    if (authorization.code === "configuration_required") {
      return response({
        ok: false,
        code: "configuration_required",
        missing: authorization.missing,
        mediaGeneration: { status: "not_installed", privateOnly: true, workPerformed: false },
      }, 503);
    }
    return response({ ok: false, code: "unauthorized", error: "Otillåten cron-förfrågan." }, 401);
  }

  const databaseConfiguration = getNeonDatabaseConfigurationState();
  if (databaseConfiguration === "missing") {
    return response({
      ok: false,
      code: "configuration_required",
      missing: missingNeonConfiguration(),
      mediaGeneration: { status: "not_installed", privateOnly: true, workPerformed: false },
    }, 503);
  }
  if (databaseConfiguration === "invalid") {
    return response({
      ok: false,
      code: "database_configuration_invalid",
      mediaGeneration: { status: "not_installed", privateOnly: true, workPerformed: false },
    }, 503);
  }

  try {
    // Deliberately do not preflight AI Gateway or Blob here. A missing
    // configuration belongs on the claimed receipt as a terminal failure so
    // operators can see what happened without a hidden endless cron loop.
    const worker = await withExecutionDeadline(deadlineAt, () => runDueSagaAutomationMediaGenerationWorker({
      maxJobs: 1,
      timeBudgetMs: 50_000,
      workerId: "vercel-saga-media",
    }));
    const failed = worker.failuresRecorded > 0 || worker.retriesScheduled > 0 || worker.leasesLost > 0;
    const workPerformed = worker.jobsClaimed > 0;
    return response({
      ok: !failed,
      status: failed
        ? "completed_with_failures"
        : worker.timeBudgetReached
          ? "time_budget_reached"
          : workPerformed
            ? "completed"
            : "idle",
      noPublication: true,
      mediaGeneration: {
        status: failed ? "completed_with_failures" : workPerformed ? "active" : "idle",
        privateOnly: true,
        workPerformed,
        jobLimit: 1,
        jobsClaimed: worker.jobsClaimed,
        mediaAttached: worker.mediaAttached,
        retriesScheduled: worker.retriesScheduled,
        failuresRecorded: worker.failuresRecorded,
        draftsRevised: worker.draftsRevised,
        leasesLost: worker.leasesLost,
        timeBudgetReached: worker.timeBudgetReached,
        jobs: worker.jobs,
      },
    });
  } catch (error) {
    const progress = error instanceof SagaAutomationMediaWorkerError ? error.progress : null;
    return response({
      ok: false,
      code: "media_worker_unavailable",
      noPublication: true,
      mediaGeneration: {
        status: "unavailable",
        privateOnly: true,
        // A timed-out database response does not prove that no write occurred.
        workPerformed: progress && progress.jobsClaimed > 0 ? true : null,
        workOutcome: progress && progress.jobsClaimed > 0 ? "partial_unknown" : "unknown",
        ...(progress ?? {}),
      },
    }, 503);
  }
}

function response(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: noStoreHeaders });
}
