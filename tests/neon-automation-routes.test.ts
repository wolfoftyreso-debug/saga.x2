import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  isNeonDatabaseConfigured: vi.fn(() => true),
  neonConfigurationResponse: vi.fn<(message?: string) => NextResponse | null>(() => null),
  requireNeonActor: vi.fn(),
  neonWriteErrorResponse: vi.fn((error: unknown, fallback: string) => NextResponse.json({ error: error instanceof Error ? error.message : fallback }, { status: 500 })),
  createStudioManualAutomationJob: vi.fn(),
  claimStudioManualAutomationJob: vi.fn(),
  getStudioDraft: vi.fn(),
  getStudioAutomation: vi.fn(),
  listStudioAutomationJobs: vi.fn(),
  processNeonStudioAutomationClaim: vi.fn(),
}));

vi.mock("@/lib/neon/config", () => ({
  isNeonDatabaseConfigured: mocks.isNeonDatabaseConfigured,
}));
vi.mock("@/lib/neon/http", () => ({
  neonConfigurationResponse: mocks.neonConfigurationResponse,
  requireNeonActor: mocks.requireNeonActor,
  neonWriteErrorResponse: mocks.neonWriteErrorResponse,
}));
vi.mock("@/lib/neon/studio-content-repository", () => ({
  createStudioManualAutomationJob: mocks.createStudioManualAutomationJob,
  claimStudioManualAutomationJob: mocks.claimStudioManualAutomationJob,
  getStudioDraft: mocks.getStudioDraft,
  getStudioAutomation: mocks.getStudioAutomation,
  listStudioAutomationJobs: mocks.listStudioAutomationJobs,
}));
vi.mock("@/lib/neon/studio-automation-worker", () => ({
  processNeonStudioAutomationClaim: mocks.processNeonStudioAutomationClaim,
}));

import { POST as runAutomation } from "@/app/api/content/automations/[id]/run/route";
import { GET as getAutomationJobs } from "@/app/api/content/automations/[id]/jobs/route";

const actor = {
  userId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  role: "owner" as const,
  email: "owner@example.test",
  displayName: "Owner",
};
const automationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const idempotencyKey = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const context = (id = automationId) => ({ params: Promise.resolve({ id }) });

const automation = {
  id: automationId,
  active: true,
  name: "Veckans utkast",
};

const queuedJob = {
  id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  contentDraftId: null,
  state: "queued",
};

function post(url: string, body: unknown) {
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  mocks.isNeonDatabaseConfigured.mockReturnValue(true);
  mocks.neonConfigurationResponse.mockReset().mockReturnValue(null);
  mocks.requireNeonActor.mockReset();
  mocks.neonWriteErrorResponse.mockClear();
  mocks.createStudioManualAutomationJob.mockReset();
  mocks.claimStudioManualAutomationJob.mockReset();
  mocks.getStudioDraft.mockReset();
  mocks.getStudioAutomation.mockReset();
  mocks.listStudioAutomationJobs.mockReset();
  mocks.processNeonStudioAutomationClaim.mockReset();
});

describe("Vercel/Neon automation routes", () => {
  it("fails closed at the Vercel/Neon configuration boundary", async () => {
    mocks.neonConfigurationResponse.mockReturnValueOnce(
      NextResponse.json({ code: "configuration_required" }, { status: 503 }),
    );

    const response = await runAutomation(post("http://localhost/api/content/automations/id/run", { idempotencyKey }), context());

    expect(response.status).toBe(503);
    expect(mocks.requireNeonActor).not.toHaveBeenCalled();
    expect(mocks.createStudioManualAutomationJob).not.toHaveBeenCalled();
  });

  it("never accepts a manual run without the signed app actor", async () => {
    mocks.requireNeonActor.mockResolvedValueOnce({
      response: NextResponse.json({ error: "Logga in för att köra automationen." }, { status: 401 }),
    });

    const response = await runAutomation(post("http://localhost/api/content/automations/id/run", { idempotencyKey }), context());

    expect(response.status).toBe(401);
    expect(mocks.createStudioManualAutomationJob).not.toHaveBeenCalled();
  });

  it("creates a durable private manual receipt and reports a concurrent identical run honestly", async () => {
    mocks.requireNeonActor.mockResolvedValueOnce({ actor });
    mocks.createStudioManualAutomationJob.mockResolvedValueOnce({ rule: automation, job: queuedJob, reused: false });
    mocks.claimStudioManualAutomationJob.mockResolvedValueOnce(null);

    const response = await runAutomation(post("http://localhost/api/content/automations/id/run", { idempotencyKey }), context());

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      status: "processing",
      automation: { id: automationId },
      job: { id: queuedJob.id, state: "queued" },
      draft: null,
    });
    expect(mocks.createStudioManualAutomationJob).toHaveBeenCalledWith(actor, { automationId, idempotencyKey });
    expect(mocks.claimStudioManualAutomationJob).toHaveBeenCalledWith(actor, {
      automationId,
      idempotencyKey,
      workerId: "studio-manual",
    });
    expect(mocks.getStudioDraft).not.toHaveBeenCalled();
  });

  it("processes its own claimed receipt now and returns only a private draft", async () => {
    const draftId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const claim = { id: queuedJob.id, claimToken: "ffffffff-ffff-4fff-8fff-ffffffffffff" };
    mocks.requireNeonActor.mockResolvedValueOnce({ actor });
    mocks.createStudioManualAutomationJob.mockResolvedValueOnce({ rule: automation, job: queuedJob, reused: false });
    mocks.claimStudioManualAutomationJob.mockResolvedValueOnce(claim);
    mocks.processNeonStudioAutomationClaim.mockResolvedValueOnce({ jobId: queuedJob.id, status: "draft_created", draftId });
    mocks.getStudioDraft.mockResolvedValueOnce({ id: draftId, status: "draft", scheduledAt: null });

    const response = await runAutomation(post("http://localhost/api/content/automations/id/run", { idempotencyKey }), context());

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      status: "draft_created",
      draft: { id: draftId, status: "draft", scheduledAt: null },
    });
    expect(mocks.processNeonStudioAutomationClaim).toHaveBeenCalledWith(claim);
  });

  it("keeps the same manual key during a backoff instead of consuming another AI attempt", async () => {
    mocks.requireNeonActor.mockResolvedValueOnce({ actor });
    mocks.createStudioManualAutomationJob.mockResolvedValueOnce({
      rule: automation,
      job: { ...queuedJob, scheduledFor: "2099-01-01T00:00:00.000Z" },
      reused: true,
    });
    mocks.claimStudioManualAutomationJob.mockResolvedValueOnce(null);

    const response = await runAutomation(post("http://localhost/api/content/automations/id/run", { idempotencyKey }), context());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ status: "failed" });
    expect(mocks.processNeonStudioAutomationClaim).not.toHaveBeenCalled();
  });

  it("reuses an already materialized receipt instead of making another draft", async () => {
    const draftId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    mocks.requireNeonActor.mockResolvedValueOnce({ actor });
    mocks.createStudioManualAutomationJob.mockResolvedValueOnce({
      rule: automation,
      job: { ...queuedJob, state: "completed", contentDraftId: draftId },
      reused: true,
    });
    mocks.getStudioDraft.mockResolvedValueOnce({ id: draftId, status: "draft", scheduledAt: null });

    const response = await runAutomation(post("http://localhost/api/content/automations/id/run", { idempotencyKey }), context());

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      status: "draft_created",
      draft: { id: draftId, status: "draft", scheduledAt: null },
    });
  });

  it("keeps job history inside the signed actor workspace", async () => {
    mocks.requireNeonActor.mockResolvedValueOnce({ actor });
    mocks.getStudioAutomation.mockResolvedValueOnce(automation);
    mocks.listStudioAutomationJobs.mockResolvedValueOnce([{ ...queuedJob, state: "failed", lastError: "AI Gateway saknas." }]);

    const response = await getAutomationJobs(new NextRequest("http://localhost/api/content/automations/id/jobs?limit=5"), context());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ jobs: [{ id: queuedJob.id, state: "failed" }] });
    expect(mocks.getStudioAutomation).toHaveBeenCalledWith(actor, automationId);
    expect(mocks.listStudioAutomationJobs).toHaveBeenCalledWith(actor, automationId, { limit: 5 });
  });
});
