import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executionAbortSignal } from "@/lib/server/execution-deadline";
import type { NeonSql } from "@/lib/neon/database";
import {
  SagaMediaGenerationError,
  type SagaGeneratedPrivateMedia,
} from "@/lib/services/saga-media-generation";
import type { TrustedStudioBlobPath, UploadedStudioBlob } from "@/lib/vercel/blob-media";
import {
  attachGeneratedSagaAutomationMedia,
  materializeSagaAutomationMediaGenerationJobs,
  runDueSagaAutomationMediaGenerationWorker,
  type ClaimedSagaAutomationMediaJob,
  type SagaAutomationMediaWorkerDependencies,
} from "@/lib/neon/saga-media-generation-worker";

afterEach(() => vi.useRealTimers());

const now = new Date("2026-08-25T10:00:00.000Z");
const workspaceId = "11111111-1111-4111-8111-111111111111";
const draftId = "22222222-2222-4222-8222-222222222222";
const automationId = "33333333-3333-4333-8333-333333333333";
const jobId = "44444444-4444-4444-8444-444444444444";
const claimToken = "55555555-5555-4555-8555-555555555555";
const mediaId = "66666666-6666-4666-8666-666666666666";

function sqlWith(...responses: unknown[]) {
  const query = vi.fn();
  for (const response of responses) query.mockResolvedValueOnce(response);
  return { sql: { query } as unknown as NeonSql, query };
}

function claim(overrides: Partial<ClaimedSagaAutomationMediaJob> = {}): ClaimedSagaAutomationMediaJob {
  return {
    id: jobId,
    workspaceId,
    draftId,
    automationId,
    claimToken,
    attempts: 1,
    maxAttempts: 2,
    payload: {
      version: "saga-automation-media/v1",
      draftRevision: 1,
      creativeBrief: {
        format: "paid_social",
        hook: "System ska ge människor mer tid.",
        value: "Ett enkelt system kan flytta repetitiva uppgifter från människan till en kontrollerad process.",
        offer: { copy: "Ingen verifierad erbjudandetext finns.", terms: "", verification: { status: "unverified", sourceReference: "" } },
        callToAction: "Granska det privata utkastet.",
        visualMetaphor: "day_to_evening",
        customVisualDirection: "Natur, trä och mjukt kvällsljus utan text eller logotyp.",
      },
      output: {
        aspectRatio: "landscape",
        altText: "Illustrativ bild för privat granskning.",
        label: "saga-system",
      },
    },
    ...overrides,
  };
}

function generated(): SagaGeneratedPrivateMedia {
  return {
    runId: jobId,
    source: "ai_gateway",
    privateOnly: true,
    status: "ready",
    storage: {
      pathname: `studio/workspaces/${workspaceId}/drafts/${draftId}/${jobId}-saga-system.png` as TrustedStudioBlobPath,
      contentType: "image/png",
      byteSize: 1024,
    },
    altText: "Illustrativ bild för privat granskning.",
    generation: {
      model: "openai/gpt-image-1.5",
      aspectRatio: "landscape",
      safetyPolicyVersion: "saga-creative-safety/v1",
      artDirectionPolicyVersion: "saga-visual-art-direction/v1",
      editorialFinishVersion: "saga-editorial-image-finish/v1",
    },
  };
}

function uploaded(): UploadedStudioBlob {
  return {
    url: `https://store.private.blob.vercel-storage.com/studio/workspaces/${workspaceId}/drafts/${draftId}/${jobId}-saga-system.png`,
    pathname: generated().storage.pathname,
    contentType: "image/png",
    size: 1024,
  };
}

function dependencies(overrides: Partial<SagaAutomationMediaWorkerDependencies> = {}) {
  const claimDueJobs = vi.fn(async () => [] as ClaimedSagaAutomationMediaJob[]);
  const findAttachedMedia = vi.fn(async () => null as string | null);
  const resolveUploadedBlob = vi.fn(async () => uploaded());
  const attachGeneratedMedia = vi.fn(async () => ({ status: "attached" as const, mediaId }));
  const completeJob = vi.fn(async () => true);
  const failJob = vi.fn(async () => "failed" as const);
  const generate = vi.fn(async () => generated());
  return {
    dependencies: {
      claimDueJobs,
      findAttachedMedia,
      resolveUploadedBlob,
      attachGeneratedMedia,
      completeJob,
      failJob,
      generate,
      ...overrides,
    } satisfies SagaAutomationMediaWorkerDependencies,
    mocks: { claimDueJobs, findAttachedMedia, resolveUploadedBlob, attachGeneratedMedia, completeJob, failJob, generate },
  };
}

describe("SAGA durable automation media worker", () => {
  it("adds a Vercel/Neon-only receipt migration with one media job and attachment per draft", () => {
    const migration = readFileSync(resolve(process.cwd(), "db/migrations/202608250017_neon_saga_automation_media_jobs.sql"), "utf8");
    expect(migration).toContain("studio_jobs_saga_media_generation_draft_idx");
    expect(migration).toContain("studio_media_saga_media_generation_job_idx");
    expect(migration).toContain("kind = 'media_generation'");
    expect(migration.toLowerCase()).not.toContain("supabase");
    expect(migration.toLowerCase()).not.toContain("publish_attempt");
  });

  it("materializes only quality-passed initial private automation drafts as idempotent media receipts", async () => {
    const candidate = {
      draft_id: draftId,
      workspace_id: workspaceId,
      author_user_id: "77777777-7777-4777-8777-777777777777",
      source_automation_id: automationId,
      revision: 1,
      title: "System ska ge människor mer tid.",
      body: "Ett enkelt system kan flytta repetitiva uppgifter från människan till en kontrollerad process.",
      publication_channels: ["linkedin"],
      metadata: {
        cta: "Granska det privata utkastet.",
        imagePrompt: "Natur, trä och mjukt kvällsljus utan text eller logotyp.",
        sagaProductionQuality: { version: "saga-production-quality/v1", canCreatePrivateDraft: true },
      },
    };
    const { sql, query } = sqlWith([candidate], [{ id: jobId }]);

    const result = await materializeSagaAutomationMediaGenerationJobs({ now, limit: 1 }, sql);

    expect(result).toEqual({ candidatesScanned: 1, jobsCreated: 1 });
    expect(query.mock.calls[0]?.[0]).toContain("source.kind = 'draft_generation'");
    expect(query.mock.calls[0]?.[0]).toContain("draft.revision = 1");
    expect(query.mock.calls[0]?.[0]).toContain("canCreatePrivateDraft");
    const [insert, params] = query.mock.calls[1] ?? [];
    expect(insert).toContain("'media_generation'");
    expect(insert).toContain("on conflict do nothing");
    expect(params).toEqual(expect.arrayContaining([workspaceId, automationId, draftId, `saga-media-generation:v1:${draftId}`]));
    expect(JSON.parse(params?.[6] as string)).toMatchObject({
      version: "saga-automation-media/v1",
      draftRevision: 1,
      output: { aspectRatio: "landscape" },
    });
  });

  it("attaches exactly one private media row and completes the same live receipt", async () => {
    const { dependencies: workerDependencies, mocks } = dependencies();
    mocks.claimDueJobs.mockResolvedValueOnce([claim()]);

    const result = await runDueSagaAutomationMediaGenerationWorker({ now, maxJobs: 1 }, workerDependencies);

    expect(result).toMatchObject({
      jobsClaimed: 1,
      mediaAttached: 1,
      retriesScheduled: 0,
      failuresRecorded: 0,
      jobs: [{ jobId, status: "media_attached", mediaId }],
    });
    expect(mocks.generate).toHaveBeenCalledWith(expect.objectContaining({
      runId: jobId,
      scope: { workspaceId, draftId },
    }));
    expect(mocks.resolveUploadedBlob).toHaveBeenCalledWith(expect.objectContaining({ workspaceId, draftId }));
    expect(mocks.attachGeneratedMedia).toHaveBeenCalledWith(expect.objectContaining({
      claim: expect.objectContaining({ id: jobId, claimToken }),
      uploaded: expect.objectContaining({ pathname: generated().storage.pathname }),
    }));
    expect(mocks.completeJob).toHaveBeenCalledWith(expect.objectContaining({ mediaId, generated: expect.objectContaining({ privateOnly: true }) }));
  });

  it("reuses an existing attachment after a recovered lease without calling the billable image model again", async () => {
    const { dependencies: workerDependencies, mocks } = dependencies({
      findAttachedMedia: async () => mediaId,
    });
    mocks.claimDueJobs.mockResolvedValueOnce([claim()]);

    const result = await runDueSagaAutomationMediaGenerationWorker({ now }, workerDependencies);

    expect(result).toMatchObject({ mediaAttached: 1, jobs: [{ status: "media_attached", mediaId }] });
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.resolveUploadedBlob).not.toHaveBeenCalled();
    expect(mocks.completeJob).toHaveBeenCalledWith(expect.objectContaining({ mediaId }));
  });

  it("records a retryable Blob failure on the durable receipt without attaching fake media", async () => {
    const blobFailure = new SagaMediaGenerationError("Blob unavailable", {
      status: 502,
      code: "blob_upload_failed",
      retryable: true,
      stage: "blob",
    });
    const failJob = vi.fn(async () => "retry_scheduled" as const);
    const { dependencies: workerDependencies, mocks } = dependencies({
      generate: async () => { throw blobFailure; },
      failJob,
    });
    mocks.claimDueJobs.mockResolvedValueOnce([claim()]);

    const result = await runDueSagaAutomationMediaGenerationWorker({ now }, workerDependencies);

    expect(result).toMatchObject({ retriesScheduled: 1, failuresRecorded: 0, jobs: [{ status: "retry_scheduled", code: "blob_upload_failed" }] });
    expect(mocks.attachGeneratedMedia).not.toHaveBeenCalled();
    expect(failJob).toHaveBeenCalledWith(expect.objectContaining({
      code: "blob_upload_failed",
      retry: true,
      claim: expect.objectContaining({ claimToken }),
    }));
  });

  it("records missing Gateway or Blob configuration as a terminal receipt failure before any fake attachment", async () => {
    const configurationFailure = new SagaMediaGenerationError("Konfiguration saknas", {
      status: 503,
      code: "configuration_required",
      retryable: false,
      missing: ["AI_GATEWAY_API_KEY eller VERCEL_OIDC_TOKEN", "BLOB_READ_WRITE_TOKEN"],
      stage: "configuration",
    });
    const failJob = vi.fn(async () => "failed" as const);
    const { dependencies: workerDependencies, mocks } = dependencies({
      generate: async () => { throw configurationFailure; },
      failJob,
    });
    mocks.claimDueJobs.mockResolvedValueOnce([claim()]);

    const result = await runDueSagaAutomationMediaGenerationWorker({ now }, workerDependencies);

    expect(result).toMatchObject({ failuresRecorded: 1, retriesScheduled: 0, jobs: [{ status: "failed", code: "configuration_required" }] });
    expect(mocks.resolveUploadedBlob).not.toHaveBeenCalled();
    expect(mocks.attachGeneratedMedia).not.toHaveBeenCalled();
    expect(failJob).toHaveBeenCalledWith(expect.objectContaining({ retry: false, code: "configuration_required" }));
  });

  it("writes a server-only Blob URL only through the exact job/draft attachment guard", async () => {
    const { sql, query } = sqlWith([{ id: mediaId }]);
    const result = await attachGeneratedSagaAutomationMedia({ claim: claim(), generated: generated(), uploaded: uploaded(), now }, sql);

    expect(result).toEqual({ status: "attached", mediaId });
    const [statement, params] = query.mock.calls[0] ?? [];
    expect(statement).toContain("job.claim_token = $3::uuid");
    expect(statement).toContain("draft.revision = $10::int");
    expect(statement).toContain("source.kind = 'draft_generation'");
    expect(params?.[3]).toBe(uploaded().url);
    expect(statement).not.toContain("published");
  });

  it("cancels a stalled image stage and uses the reserved live parent signal to record its retry", async () => {
    vi.useFakeTimers();
    let workSignal: AbortSignal | undefined;
    let receiptSignal: AbortSignal | undefined;
    const { dependencies: workerDependencies, mocks } = dependencies({
      generate: async () => {
        workSignal = executionAbortSignal();
        return await new Promise((_, reject) => workSignal!.addEventListener("abort", () => reject(workSignal!.reason), {once:true}));
      },
      failJob: async () => { receiptSignal = executionAbortSignal(); return "retry_scheduled"; },
    });
    mocks.claimDueJobs.mockResolvedValueOnce([claim()]);
    const pending = runDueSagaAutomationMediaGenerationWorker({now,timeBudgetMs:10_000},workerDependencies);
    const asserted = expect(pending).resolves.toMatchObject({jobsClaimed:1,retriesScheduled:1,timeBudgetReached:true,jobs:[{code:"execution_deadline_reached"}]});
    await vi.advanceTimersByTimeAsync(5_001);
    await asserted;
    expect(workSignal?.aborted).toBe(true);
    expect(receiptSignal?.aborted).toBe(false);
    expect(receiptSignal).not.toBe(workSignal);
    expect(mocks.attachGeneratedMedia).not.toHaveBeenCalled();
    expect(mocks.resolveUploadedBlob).not.toHaveBeenCalled();
  });

  it("retains confirmed claim progress when completion and the error receipt cannot be confirmed", async () => {
    const {dependencies:workerDependencies,mocks} = dependencies({
      completeJob:async () => { throw new Error("Unknown commit response"); },
      failJob:async () => { throw new Error("Cannot confirm failure receipt"); },
    });
    mocks.claimDueJobs.mockResolvedValueOnce([claim()]);
    await expect(runDueSagaAutomationMediaGenerationWorker({now},workerDependencies)).rejects.toMatchObject({
      name:"SagaAutomationMediaWorkerError",progress:{jobsClaimed:1,mediaAttached:0},
    });
  });
});
