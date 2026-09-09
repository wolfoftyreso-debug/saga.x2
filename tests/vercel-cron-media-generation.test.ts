import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ runWorker: vi.fn() }));

vi.mock("@/lib/neon/saga-media-generation-worker", async (original) => ({
  ...await original<typeof import("@/lib/neon/saga-media-generation-worker")>(),
  runDueSagaAutomationMediaGenerationWorker: mocks.runWorker,
}));

import { GET as mediaCron } from "@/app/api/cron/media-generation/route";
import { SagaAutomationMediaWorkerError } from "@/lib/neon/saga-media-generation-worker";

const originalCronSecret = process.env.CRON_SECRET;
const originalDatabaseUrl = process.env.DATABASE_URL;

function request(secret?: string): NextRequest {
  return new NextRequest("http://localhost/api/cron/media-generation", {
    headers: secret ? { authorization: `Bearer ${secret}` } : undefined,
  });
}

beforeEach(() => {
  delete process.env.CRON_SECRET;
  delete process.env.DATABASE_URL;
  mocks.runWorker.mockReset();
  mocks.runWorker.mockResolvedValue({
    jobsClaimed: 0,
    mediaAttached: 0,
    retriesScheduled: 0,
    failuresRecorded: 0,
    draftsRevised: 0,
    leasesLost: 0,
    timeBudgetReached: false,
    jobs: [],
  });
});

afterEach(() => {
  if (originalCronSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = originalCronSecret;
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

describe.sequential("Vercel dedicated SAGA media cron", () => {
  it("requires cron authentication and a Neon connection before it can claim a private image receipt", async () => {
    process.env.CRON_SECRET = "cron-secret";

    const unauthorized = await mediaCron(request("wrong"));
    expect(unauthorized.status).toBe(401);
    await expect(unauthorized.json()).resolves.toEqual({ ok: false, code: "unauthorized", error: "Otillåten cron-förfrågan." });

    const missingDatabase = await mediaCron(request("cron-secret"));
    expect(missingDatabase.status).toBe(503);
    await expect(missingDatabase.json()).resolves.toMatchObject({
      ok: false,
      code: "configuration_required",
      missing: ["DATABASE_URL"],
      mediaGeneration: { status: "not_installed", privateOnly: true, workPerformed: false },
    });
    expect(mocks.runWorker).not.toHaveBeenCalled();
  });

  it("runs one dedicated private media lease and never represents it as publication", async () => {
    process.env.CRON_SECRET = "cron-secret";
    process.env.DATABASE_URL = "postgresql://user:secret@ep-example.neon.tech/neondb?sslmode=require";
    mocks.runWorker.mockResolvedValueOnce({
      jobsClaimed: 1,
      mediaAttached: 1,
      retriesScheduled: 0,
      failuresRecorded: 0,
      draftsRevised: 0,
      leasesLost: 0,
      timeBudgetReached: false,
      jobs: [{ jobId: "job", status: "media_attached", mediaId: "media" }],
    });

    const response = await mediaCron(request("cron-secret"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      status: "completed",
      noPublication: true,
      mediaGeneration: {
        status: "active",
        privateOnly: true,
        jobLimit: 1,
        jobsClaimed: 1,
        mediaAttached: 1,
      },
    });
    expect(mocks.runWorker).toHaveBeenCalledWith({ maxJobs: 1, timeBudgetMs: 50_000, workerId: "vercel-saga-media" });
  });

  it("returns a completed failure when the worker durably records missing Gateway/Blob configuration", async () => {
    process.env.CRON_SECRET = "cron-secret";
    process.env.DATABASE_URL = "postgresql://user:secret@ep-example.neon.tech/neondb?sslmode=require";
    mocks.runWorker.mockResolvedValueOnce({
      jobsClaimed: 1,
      mediaAttached: 0,
      retriesScheduled: 0,
      failuresRecorded: 1,
      draftsRevised: 0,
      leasesLost: 0,
      timeBudgetReached: false,
      jobs: [{ jobId: "job", status: "failed", code: "configuration_required" }],
    });

    const response = await mediaCron(request("cron-secret"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      status: "completed_with_failures",
      noPublication: true,
      mediaGeneration: {
        status: "completed_with_failures",
        privateOnly: true,
        failuresRecorded: 1,
        jobs: [{ code: "configuration_required" }],
      },
    });
  });

  it("never reports no work after an unconfirmed write and retains confirmed claims", async () => {
    process.env.CRON_SECRET="cron-secret";
    process.env.DATABASE_URL="postgresql://user:secret@ep-example.neon.tech/neondb?sslmode=require";
    mocks.runWorker.mockRejectedValueOnce(new Error("Unknown database response"));
    await expect((await mediaCron(request("cron-secret"))).json()).resolves.toMatchObject({
      ok:false,mediaGeneration:{workPerformed:null,workOutcome:"unknown"},
    });
    mocks.runWorker.mockRejectedValueOnce(new SagaAutomationMediaWorkerError({
      jobsClaimed:1,mediaAttached:0,retriesScheduled:0,failuresRecorded:0,draftsRevised:0,leasesLost:0,timeBudgetReached:true,jobs:[],
    }));
    await expect((await mediaCron(request("cron-secret"))).json()).resolves.toMatchObject({
      ok:false,mediaGeneration:{workPerformed:true,workOutcome:"partial_unknown",jobsClaimed:1,timeBudgetReached:true},
    });
  });
});
