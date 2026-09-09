import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  getAuthenticatedUserId: vi.fn(),
  createAdminClient: vi.fn(() => ({})),
  duplicateContentAutomationRule: vi.fn(),
  getContentAutomationRuleForUser: vi.fn(),
  listContentAutomationJobsForRule: vi.fn(),
  neonConfigurationResponse: vi.fn<(message?: string) => NextResponse | null>(() => null),
  requireNeonActor: vi.fn(),
  neonWriteErrorResponse: vi.fn((error: unknown, fallback: string) => NextResponse.json({ error: error instanceof Error ? error.message : fallback }, { status: 500 })),
  createStudioManualAutomationJob: vi.fn(),
  claimStudioManualAutomationJob: vi.fn(),
  getStudioDraft: vi.fn(),
  processNeonStudioAutomationClaim: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  getAuthenticatedUserId: mocks.getAuthenticatedUserId,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: mocks.createAdminClient,
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
}));
vi.mock("@/lib/neon/studio-automation-worker", () => ({
  processNeonStudioAutomationClaim: mocks.processNeonStudioAutomationClaim,
}));
vi.mock("@/lib/services/content-studio", () => ({
  duplicateContentAutomationRule: mocks.duplicateContentAutomationRule,
  getContentAutomationRuleForUser: mocks.getContentAutomationRuleForUser,
  listContentAutomationJobsForRule: mocks.listContentAutomationJobsForRule,
}));

import { POST as runAutomation } from "@/app/api/content/automations/[id]/run/route";
import { POST as duplicateAutomation } from "@/app/api/content/automations/[id]/duplicate/route";
import { GET as getAutomationJobs } from "@/app/api/content/automations/[id]/jobs/route";

const automationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const idempotencyKey = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const context = (id = automationId) => ({ params: Promise.resolve({ id }) });
const actor = {
  userId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  role: "owner" as const,
  email: "owner@example.test",
  displayName: "Owner",
};
const automation = { id: automationId, active: true, name: "Veckans utkast" };
const queuedJob = {
  id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  contentDraftId: null,
  state: "queued",
};

function post(url: string, body?: unknown) {
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

afterEach(() => {
  mocks.getAuthenticatedUserId.mockReset();
  mocks.createAdminClient.mockClear();
  mocks.duplicateContentAutomationRule.mockReset();
  mocks.getContentAutomationRuleForUser.mockReset();
  mocks.listContentAutomationJobsForRule.mockReset();
  mocks.neonConfigurationResponse.mockReset().mockReturnValue(null);
  mocks.requireNeonActor.mockReset();
  mocks.neonWriteErrorResponse.mockClear();
  mocks.createStudioManualAutomationJob.mockReset();
  mocks.claimStudioManualAutomationJob.mockReset();
  mocks.getStudioDraft.mockReset();
  mocks.processNeonStudioAutomationClaim.mockReset();
});

describe("automations-API", () => {
  it("fäster Kör nu vid Vercel/Neon och kräver både session och giltig idempotensnyckel", async () => {
    mocks.neonConfigurationResponse.mockReturnValueOnce(
      NextResponse.json({ code: "configuration_required" }, { status: 503 }),
    );
    const unconfigured = await runAutomation(post("http://localhost/api/content/automations/id/run", { idempotencyKey }), context());
    expect(unconfigured.status).toBe(503);
    expect(mocks.requireNeonActor).not.toHaveBeenCalled();

    mocks.requireNeonActor.mockResolvedValueOnce({
      response: NextResponse.json({ error: "Logga in för att köra automationen." }, { status: 401 }),
    });
    const anonymous = await runAutomation(post("http://localhost/api/content/automations/id/run", { idempotencyKey }), context());
    expect(anonymous.status).toBe(401);
    expect(mocks.createStudioManualAutomationJob).not.toHaveBeenCalled();

    mocks.requireNeonActor.mockResolvedValueOnce({ actor });
    const invalid = await runAutomation(post("http://localhost/api/content/automations/id/run", { idempotencyKey: "not-a-uuid" }), context());
    expect(invalid.status).toBe(400);
    expect(mocks.createStudioManualAutomationJob).not.toHaveBeenCalled();
  });

  it("mappar en saknad automation, ett privat utkast, kö och terminalt fel ärligt", async () => {
    mocks.requireNeonActor.mockResolvedValue({ actor });
    mocks.createStudioManualAutomationJob.mockResolvedValueOnce(null);
    expect((await runAutomation(post("http://localhost/api/content/automations/id/run", { idempotencyKey }), context())).status).toBe(404);

    mocks.createStudioManualAutomationJob.mockResolvedValueOnce({
      rule: automation,
      job: { ...queuedJob, state: "completed", contentDraftId: "draft-a" },
      reused: true,
    });
    mocks.getStudioDraft.mockResolvedValueOnce({ id: "draft-a", status: "draft", scheduledAt: null });
    const created = await runAutomation(post("http://localhost/api/content/automations/id/run", { idempotencyKey }), context());
    expect(created.status).toBe(201);
    await expect(created.json()).resolves.toMatchObject({ status: "draft_created", draft: { id: "draft-a", status: "draft", scheduledAt: null } });

    mocks.createStudioManualAutomationJob.mockResolvedValueOnce({ rule: automation, job: queuedJob, reused: false });
    mocks.claimStudioManualAutomationJob.mockResolvedValueOnce(null);
    expect((await runAutomation(post("http://localhost/api/content/automations/id/run", { idempotencyKey }), context())).status).toBe(202);

    mocks.createStudioManualAutomationJob.mockResolvedValueOnce({
      rule: automation,
      job: { ...queuedJob, state: "failed", lastError: "AI-skrivningen avvisades." },
      reused: false,
    });
    const failed = await runAutomation(post("http://localhost/api/content/automations/id/run", { idempotencyKey }), context());
    expect(failed.status).toBe(502);
    await expect(failed.json()).resolves.toMatchObject({ status: "failed", message: "AI-skrivningen avvisades." });
  });

  it("kopierar endast ägda automationer och svarar med ett pausat nytt objekt", async () => {
    mocks.getAuthenticatedUserId.mockResolvedValueOnce(null);
    expect((await duplicateAutomation(post("http://localhost/api/content/automations/id/duplicate"), context())).status).toBe(401);

    mocks.getAuthenticatedUserId.mockResolvedValueOnce("owner-a");
    expect((await duplicateAutomation(post("http://localhost/api/content/automations/id/duplicate"), context("not-a-uuid"))).status).toBe(400);

    mocks.getAuthenticatedUserId.mockResolvedValueOnce("owner-a");
    mocks.duplicateContentAutomationRule.mockResolvedValueOnce(null);
    expect((await duplicateAutomation(post("http://localhost/api/content/automations/id/duplicate"), context())).status).toBe(404);

    mocks.getAuthenticatedUserId.mockResolvedValueOnce("owner-a");
    mocks.duplicateContentAutomationRule.mockResolvedValueOnce({ id: "copy-a", active: false, name: "Veckobrev – kopia" });
    const copied = await duplicateAutomation(post("http://localhost/api/content/automations/id/duplicate"), context());
    expect(copied.status).toBe(201);
    await expect(copied.json()).resolves.toMatchObject({ automation: { id: "copy-a", active: false } });
    expect(mocks.duplicateContentAutomationRule).toHaveBeenLastCalledWith({}, "owner-a", automationId);
  });

  it("håller körhistorik privat och validerar både id och gräns", async () => {
    mocks.getAuthenticatedUserId.mockResolvedValueOnce(null);
    expect((await getAutomationJobs(new NextRequest("http://localhost/api/content/automations/id/jobs"), context())).status).toBe(401);

    mocks.getAuthenticatedUserId.mockResolvedValueOnce("owner-a");
    expect((await getAutomationJobs(new NextRequest("http://localhost/api/content/automations/id/jobs?limit=zero"), context())).status).toBe(400);

    mocks.getAuthenticatedUserId.mockResolvedValueOnce("owner-a");
    mocks.getContentAutomationRuleForUser.mockResolvedValueOnce(null);
    expect((await getAutomationJobs(new NextRequest("http://localhost/api/content/automations/id/jobs"), context())).status).toBe(404);

    mocks.getAuthenticatedUserId.mockResolvedValueOnce("owner-a");
    mocks.getContentAutomationRuleForUser.mockResolvedValueOnce({ id: automationId });
    mocks.listContentAutomationJobsForRule.mockResolvedValueOnce([{ id: "job-a", state: "failed", lastError: "Modellet gick inte att nå." }]);
    const history = await getAutomationJobs(new NextRequest("http://localhost/api/content/automations/id/jobs?limit=5"), context());
    expect(history.status).toBe(200);
    await expect(history.json()).resolves.toMatchObject({ jobs: [{ id: "job-a", state: "failed" }] });
    expect(mocks.listContentAutomationJobsForRule).toHaveBeenCalledWith({}, "owner-a", automationId, { limit: 5 });
  });
});
