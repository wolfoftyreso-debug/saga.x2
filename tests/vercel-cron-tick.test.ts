import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  runWorker: vi.fn(),
  runAdWorker: vi.fn(),
  runResearch: vi.fn(),
  runDailyKnowledge: vi.fn(),
  runSignalProduction: vi.fn(),
  runQuarterlyPlanning: vi.fn(),
  materializeMedia: vi.fn(),
  claimTickLease: vi.fn(),
  completeTickLease: vi.fn(),
}));

vi.mock("@/lib/neon/studio-automation-worker", () => ({
  runNeonStudioAutomationWorker: mocks.runWorker,
}));
vi.mock("@/lib/neon/ad-automation-worker", () => ({
  runDueAdAutomationWorker: mocks.runAdWorker,
}));

vi.mock("@/lib/services/saga-news-runner", () => ({
  runDueSagaNewsSources: mocks.runResearch,
}));
vi.mock("@/lib/neon/saga-daily-knowledge-worker", () => ({
  runDueSagaDailyKnowledgeWorker: mocks.runDailyKnowledge,
}));
vi.mock("@/lib/neon/saga-signal-production-worker", () => ({
  runDueSagaSignalProductionWorker: mocks.runSignalProduction,
}));
vi.mock("@/lib/neon/saga-quarterly-planning-worker", () => ({
  runDueSagaQuarterlyActivityPlanWorker: mocks.runQuarterlyPlanning,
}));
vi.mock("@/lib/neon/saga-media-generation-worker", () => ({
  materializeSagaAutomationMediaGenerationJobs: mocks.materializeMedia,
}));
vi.mock("@/lib/neon/saga-cron-tick-repository", () => ({
  claimSagaCronTickLease: mocks.claimTickLease,
  completeSagaCronTickLease: mocks.completeTickLease,
}));

import { GET as tick } from "@/app/api/cron/tick/route";
import { authorizeVercelCron } from "@/lib/vercel/cron-auth";
import { executionAbortSignal } from "@/lib/server/execution-deadline";

const originalCronSecret = process.env.CRON_SECRET;
const originalDatabaseUrl = process.env.DATABASE_URL;

function cronRequest(secret?: string): NextRequest {
  return new NextRequest("http://localhost/api/cron/tick", {
    headers: secret ? { authorization: `Bearer ${secret}` } : undefined,
  });
}

beforeEach(() => {
  delete process.env.CRON_SECRET;
  delete process.env.DATABASE_URL;
  mocks.runWorker.mockReset();
  mocks.runAdWorker.mockReset();
  mocks.runDailyKnowledge.mockReset();
  mocks.runSignalProduction.mockReset();
  mocks.runQuarterlyPlanning.mockReset();
  mocks.materializeMedia.mockReset();
  mocks.claimTickLease.mockReset();
  mocks.completeTickLease.mockReset();
  mocks.claimTickLease.mockResolvedValue({
    claimToken: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    leaseExpiresAt: "2026-08-28T09:01:15.000Z",
    startedAt: "2026-08-28T09:00:00.000Z",
  });
  mocks.completeTickLease.mockResolvedValue(true);
  mocks.runWorker.mockResolvedValue({
    materialization: { rulesScanned: 0, jobsCreated: 0, nextRunsUpdated: 0 },
    jobsClaimed: 0,
    draftsCreated: 0,
    retriesScheduled: 0,
    failuresRecorded: 0,
    leasesLost: 0,
    timeBudgetReached: false,
    jobs: [],
  });
  mocks.runResearch.mockResolvedValue({
    claimed: 0,
    completed: 0,
    failed: 0,
    released: 0,
    timeBudgetReached: false,
    runs: [],
  });
  mocks.runDailyKnowledge.mockResolvedValue({
    materialization: { policiesScanned: 0, jobsCreated: 0 },
    staleCancelled: 0,
    leasesExpired: 0,
    retentionPruned: 0,
    jobsClaimed: 0,
    knowledgeBundlesCreated: 0,
    noQualifyingEvidence: 0,
    retriesScheduled: 0,
    failuresRecorded: 0,
    leasesLost: 0,
    timeBudgetReached: false,
    jobs: [],
  });
  mocks.runAdWorker.mockResolvedValue({
    materialization: { automationsScanned: 0, runsCreated: 0, nextRunsUpdated: 0, unsafeFlowsSkipped: 0 },
    runsClaimed: 0,
    draftsCreated: 0,
    failuresRecorded: 0,
    leasesLost: 0,
    timeBudgetReached: false,
    runs: [],
  });
  mocks.runSignalProduction.mockResolvedValue({
    materialization: { qualifiedSignalsScanned: 0, jobsCreated: 0 },
    staleCancelled: 0,
    leasesExpired: 0,
    jobsClaimed: 0,
    reviewDraftsCreated: 0,
    qualityBlocked: 0,
    retriesScheduled: 0,
    failuresRecorded: 0,
    leasesLost: 0,
    timeBudgetReached: false,
    jobs: [],
  });
  mocks.runQuarterlyPlanning.mockResolvedValue({
    receipts: [],
    receiptsClaimed: 0,
    privateDraftsCreated: 0,
    failuresRecorded: 0,
    timeBudgetReached: false,
    noPublication: true,
  });
  mocks.materializeMedia.mockResolvedValue({ candidatesScanned: 0, jobsCreated: 0 });
});

afterEach(() => {
  vi.useRealTimers();
  if (originalCronSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = originalCronSecret;
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

describe.sequential("Vercel cron tick", () => {
  it("uses the standard bearer header without exposing the secret", () => {
    process.env.CRON_SECRET = "cron-secret";
    expect(authorizeVercelCron(cronRequest("cron-secret"))).toEqual({ ok: true });
    expect(authorizeVercelCron(cronRequest("wrong-secret"))).toEqual({ ok: false, code: "unauthorized" });
    expect(authorizeVercelCron(cronRequest())).toEqual({ ok: false, code: "unauthorized" });
  });

  it("returns a no-store setup response only after cron authentication", async () => {
    process.env.CRON_SECRET = "cron-secret";

    const unauthorized = await tick(cronRequest("wrong-secret"));
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("cache-control")).toBe("no-store");
    await expect(unauthorized.json()).resolves.toEqual({ ok: false, code: "unauthorized", error: "Otillåten cron-förfrågan." });

    const response = await tick(cronRequest("cron-secret"));
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      ok: false,
      code: "configuration_required",
      missing: ["DATABASE_URL"],
      scheduler: { status: "not_installed", workPerformed: false },
    });
  });

  it("runs the bounded Neon worker and reports actual private-draft work", async () => {
    process.env.CRON_SECRET = "cron-secret";
    process.env.DATABASE_URL = "postgresql://user:secret@ep-example.neon.tech/neondb?sslmode=require";
    mocks.runWorker.mockResolvedValueOnce({
      materialization: { rulesScanned: 2, jobsCreated: 1, nextRunsUpdated: 2 },
      jobsClaimed: 1,
      draftsCreated: 1,
      retriesScheduled: 0,
      failuresRecorded: 0,
      leasesLost: 0,
      timeBudgetReached: false,
      jobs: [{ jobId: "job-1", status: "draft_created", draftId: "draft-1" }],
    });
    mocks.runAdWorker.mockResolvedValueOnce({
      materialization: { automationsScanned: 1, runsCreated: 1, nextRunsUpdated: 1, unsafeFlowsSkipped: 0 },
      runsClaimed: 1,
      draftsCreated: 1,
      failuresRecorded: 0,
      leasesLost: 0,
      timeBudgetReached: false,
      runs: [{ runId: "ad-run-1", status: "draft_created", draftId: "ad-draft-1" }],
    });

    const response = await tick(cronRequest("cron-secret"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      status: "completed",
      noPublication: true,
      scheduler: {
        status: "active",
        workPerformed: true,
        jobLimit: 5,
        jobsClaimed: 1,
        draftsCreated: 1,
        retriesScheduled: 0,
        failuresRecorded: 0,
        leasesLost: 0,
        timeBudgetReached: false,
      },
      materialization: { rulesScanned: 2, jobsCreated: 1, nextRunsUpdated: 2 },
      jobs: [{ jobId: "job-1", status: "draft_created", draftId: "draft-1" }],
      adAutomations: {
        status: "active",
        deterministicDraftsOnly: true,
        externalExecution: "unavailable",
        materialization: { automationsScanned: 1, runsCreated: 1, nextRunsUpdated: 1, unsafeFlowsSkipped: 0 },
        runsClaimed: 1,
        draftsCreated: 1,
        failuresRecorded: 0,
        leasesLost: 0,
        runs: [{ runId: "ad-run-1", status: "draft_created", draftId: "ad-draft-1" }],
      },
      research: {
        status: "active",
        claimed: 0,
        completed: 0,
        failed: 0,
        released: 0,
        timeBudgetReached: false,
        runs: [],
        noPublication: true,
      },
      dailyKnowledge: {
        status: "idle",
        metadataOnly: true,
        draftsCreated: 0,
        externalExecution: "unavailable",
        materialization: { policiesScanned: 0, jobsCreated: 0 },
        staleCancelled: 0,
        leasesExpired: 0,
        retentionPruned: 0,
        jobsClaimed: 0,
        knowledgeBundlesCreated: 0,
        noQualifyingEvidence: 0,
        retriesScheduled: 0,
        failuresRecorded: 0,
        leasesLost: 0,
        timeBudgetReached: false,
        jobs: [],
        noPublication: true,
      },
      signalProduction: {
        status: "idle",
        privateReviewDraftsOnly: true,
        externalExecution: "unavailable",
        materialization: { qualifiedSignalsScanned: 0, jobsCreated: 0 },
        staleCancelled: 0,
        leasesExpired: 0,
        jobsClaimed: 0,
        reviewDraftsCreated: 0,
        qualityBlocked: 0,
        retriesScheduled: 0,
        failuresRecorded: 0,
        leasesLost: 0,
        timeBudgetReached: false,
        jobs: [],
        noPublication: true,
      },
      quarterlyPlanning: {
        status: "idle",
        privateReviewDraftsOnly: true,
        media: "manual_action_required",
        receiptsClaimed: 0,
        privateDraftsCreated: 0,
        failuresRecorded: 0,
        receipts: [],
        noPublication: true,
      },
      mediaGeneration: {
        status: "idle",
        privateOnly: true,
        dispatcherOnly: true,
        dedicatedCron: "/api/cron/media-generation",
        materialization: { candidatesScanned: 0, jobsCreated: 0 },
        noPublication: true,
      },
    });
    expect(mocks.runWorker).toHaveBeenCalledWith({ maxJobs: 5, timeBudgetMs: 45_000, workerId: "vercel-cron" });
    expect(mocks.runAdWorker).toHaveBeenCalledWith({ maxRuns: 3, timeBudgetMs: 45_000, workerId: "vercel-ad-automation" });
    expect(mocks.runResearch).toHaveBeenCalledWith({ limit: 1, timeBudgetMs: 16_000, workerId: "vercel-saga-news" });
    expect(mocks.runDailyKnowledge).toHaveBeenCalledWith({ maxJobs: 1, timeBudgetMs: 10_000, workerId: "vercel-saga-daily-knowledge" });
    expect(mocks.runSignalProduction).toHaveBeenCalledWith({ maxJobs: 2, timeBudgetMs: 12_000, workerId: "vercel-saga-signal-production" });
    expect(mocks.runQuarterlyPlanning).toHaveBeenCalledWith({ maxBatches: 1, maxJobsPerBatch: 1, timeBudgetMs: 48_000, workerId: "vercel-saga-quarterly-cron" });
    expect(mocks.materializeMedia).toHaveBeenCalledWith({ limit: 5 });
    expect(mocks.claimTickLease).toHaveBeenCalledWith({ leaseSeconds: 75 });
    expect(mocks.completeTickLease).toHaveBeenCalledWith(
      expect.objectContaining({ claimToken: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
      expect.objectContaining({ outcome: "completed", summary: expect.objectContaining({ workPerformed: true, timeBudgetMs: 52_000 }) }),
    );
  });

  it("skips a parallel tick while the durable process lease is still live", async () => {
    process.env.CRON_SECRET = "cron-secret";
    process.env.DATABASE_URL = "postgresql://user:secret@ep-example.neon.tech/neondb?sslmode=require";
    mocks.claimTickLease.mockResolvedValueOnce(null);

    const response = await tick(cronRequest("cron-secret"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      status: "already_running",
      noPublication: true,
      scheduler: {
        status: "already_running",
        workPerformed: false,
        tick: { status: "skipped", retryAfterSeconds: 60, timeBudgetMs: 52_000 },
      },
    });
    expect(mocks.runWorker).not.toHaveBeenCalled();
    expect(mocks.runAdWorker).not.toHaveBeenCalled();
    expect(mocks.completeTickLease).not.toHaveBeenCalled();
  });

  it("reports signal-production unavailability as a completed cron failure without claiming a publication", async () => {
    process.env.CRON_SECRET = "cron-secret";
    process.env.DATABASE_URL = "postgresql://user:secret@ep-example.neon.tech/neondb?sslmode=require";
    mocks.runSignalProduction.mockRejectedValueOnce(new Error("production queue down"));

    const response = await tick(cronRequest("cron-secret"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      status: "completed_with_failures",
      noPublication: true,
      signalProduction: {
        status: "unavailable",
        privateReviewDraftsOnly: true,
        externalExecution: "unavailable",
        noPublication: true,
      },
      mediaGeneration: {
        status: "idle",
        privateOnly: true,
        dispatcherOnly: true,
        dedicatedCron: "/api/cron/media-generation",
        materialization: { candidatesScanned: 0, jobsCreated: 0 },
        noPublication: true,
      },
    });
  });

  it("does not acknowledge an unavailable Neon worker as a completed cron run", async () => {
    process.env.CRON_SECRET = "cron-secret";
    process.env.DATABASE_URL = "postgresql://user:secret@ep-example.neon.tech/neondb?sslmode=require";
    mocks.runWorker.mockRejectedValueOnce(new Error("database down"));

    const response = await tick(cronRequest("cron-secret"));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "scheduler_unavailable",
      noPublication: true,
      scheduler: { status: "unavailable", workPerformed: null, workOutcome: "unknown" },
    });
  });

  it("preserves confirmed drafts when another core worker rejects", async () => {
    process.env.CRON_SECRET = "cron-secret";
    process.env.DATABASE_URL = "postgresql://user:secret@ep-example.neon.tech/neondb?sslmode=require";
    mocks.runWorker.mockRejectedValueOnce(new Error("injected core failure"));
    mocks.runAdWorker.mockResolvedValueOnce({
      materialization: { runsCreated: 1 }, runsClaimed: 1, draftsCreated: 1,
      failuresRecorded: 0, timeBudgetReached: false,
    });
    const response = await tick(cronRequest("cron-secret"));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ scheduler: {
      workPerformed: true, workOutcome: "partial_unknown",
      workers: { studio: { status: "unknown" }, ads: { counters: { draftsCreated: 1 } } },
    } });
    expect(mocks.completeTickLease).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      summary: expect.objectContaining({ workPerformed: true, workOutcome: "partial_unknown" }),
    }));
  });

  it("preserves worker outcomes when heartbeat persistence fails", async () => {
    process.env.CRON_SECRET = "cron-secret";
    process.env.DATABASE_URL = "postgresql://user:secret@ep-example.neon.tech/neondb?sslmode=require";
    mocks.materializeMedia.mockResolvedValueOnce({ candidatesScanned: 1, jobsCreated: 1 });
    mocks.completeTickLease.mockResolvedValueOnce(false);
    const response = await tick(cronRequest("cron-secret"));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "scheduler_lease_unavailable",
      scheduler: { workPerformed: true, completionRecorded: false, workers: { media: { counters: { jobsCreated: 1 } } } },
      mediaGeneration: { status: "queued" },
    });
  });

  it("counts durable retry maintenance as work even without a newly claimed job", async () => {
    process.env.CRON_SECRET = "cron-secret";
    process.env.DATABASE_URL = "postgresql://user:secret@ep-example.neon.tech/neondb?sslmode=require";
    mocks.runWorker.mockResolvedValueOnce({
      materialization: { jobsCreated: 0 }, jobsClaimed: 0, draftsCreated: 0,
      retriesScheduled: 1, failuresRecorded: 0, leasesLost: 0, timeBudgetReached: true, jobs: [],
    });
    const response = await tick(cronRequest("cron-secret"));
    await expect(response.json()).resolves.toMatchObject({ scheduler: { workPerformed: true } });
    expect(mocks.completeTickLease).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      summary: expect.objectContaining({ workPerformed: true, timeBudgetReached: true }),
    }));
  });

  it("cancels in-flight work before the function ceiling and finalizes with a fresh bounded signal", async () => {
    process.env.CRON_SECRET = "cron-secret";
    process.env.DATABASE_URL = "postgresql://user:secret@ep-example.neon.tech/neondb?sslmode=require";
    vi.useFakeTimers();
    const start = Date.now();
    let lateWrite = false;
    let workerCancelled = false;
    mocks.runWorker.mockImplementationOnce(() => new Promise((resolve, reject) => {
      const signal = executionAbortSignal()!;
      const timer = setTimeout(() => { lateWrite = true; resolve({}); }, 70_000);
      signal.addEventListener("abort", () => {
        workerCancelled = true;
        clearTimeout(timer);
        reject(signal.reason);
      }, { once: true });
    }));
    mocks.completeTickLease.mockImplementationOnce(async () => {
      expect(executionAbortSignal()?.aborted).toBe(false);
      return true;
    });
    const pending = tick(cronRequest("cron-secret"));
    await vi.advanceTimersByTimeAsync(45_000);
    const response = await pending;
    expect(workerCancelled).toBe(true);
    expect(Date.now() - start).toBeLessThan(60_000);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ scheduler: { workPerformed: null, workOutcome: "unknown" } });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(lateWrite).toBe(false);
  });

  it("bounds the lease claim before dispatching any worker", async () => {
    process.env.CRON_SECRET = "cron-secret";
    process.env.DATABASE_URL = "postgresql://user:secret@ep-example.neon.tech/neondb?sslmode=require";
    vi.useFakeTimers();
    mocks.claimTickLease.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      const signal = executionAbortSignal()!;
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const pending = tick(cronRequest("cron-secret"));
    await vi.advanceTimersByTimeAsync(5_000);
    const response = await pending;
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ scheduler: { workPerformed: false } });
    expect(mocks.runWorker).not.toHaveBeenCalled();
  });

  it("bounds stalled heartbeat persistence at 56 seconds without discarding confirmed work", async () => {
    process.env.CRON_SECRET = "cron-secret";
    process.env.DATABASE_URL = "postgresql://user:secret@ep-example.neon.tech/neondb?sslmode=require";
    vi.useFakeTimers();
    mocks.materializeMedia.mockResolvedValueOnce({ candidatesScanned: 1, jobsCreated: 1 });
    mocks.completeTickLease.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      const signal = executionAbortSignal()!;
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const pending = tick(cronRequest("cron-secret"));
    await vi.advanceTimersByTimeAsync(56_000);
    const response = await pending;
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ scheduler: {
      workPerformed: true, completionRecorded: false, tick: { elapsedMs: 56_000 },
    } });
  });

  it("makes a missing cron secret a structured setup problem without revealing a value", async () => {
    const response = await tick(cronRequest("anything"));
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      ok: false,
      code: "configuration_required",
      missing: ["CRON_SECRET"],
      scheduler: { status: "not_installed", workPerformed: false },
    });
  });
});
