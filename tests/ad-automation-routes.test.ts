import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { validAdAutomationCreateInput, validAdAutomationInput } from "@/tests/fixtures/ad-automation";

const mocks = vi.hoisted(() => ({
  neonConfigurationResponse: vi.fn(),
  requireNeonActor: vi.fn(),
  neonWriteErrorResponse: vi.fn((error: unknown, fallback: string) => NextResponse.json({ error: error instanceof Error ? error.message : fallback }, { status: 500 })),
  createAdAutomation: vi.fn(),
  listAdAutomations: vi.fn(),
  getAdAutomation: vi.fn(),
  updateAdAutomation: vi.fn(),
  deleteAdAutomation: vi.fn(),
  runAdAutomationManualTest: vi.fn(),
}));

vi.mock("@/lib/neon/http", () => ({
  neonConfigurationResponse: mocks.neonConfigurationResponse,
  requireNeonActor: mocks.requireNeonActor,
  neonWriteErrorResponse: mocks.neonWriteErrorResponse,
}));
vi.mock("@/lib/neon/ad-automation-repository", () => ({
  createAdAutomation: mocks.createAdAutomation,
  listAdAutomations: mocks.listAdAutomations,
  getAdAutomation: mocks.getAdAutomation,
  updateAdAutomation: mocks.updateAdAutomation,
  deleteAdAutomation: mocks.deleteAdAutomation,
  runAdAutomationManualTest: mocks.runAdAutomationManualTest,
}));

import { GET as listAdAutomations, POST as createAdAutomation } from "@/app/api/ad-automations/route";
import { PATCH as patchAdAutomation } from "@/app/api/ad-automations/[id]/route";
import { POST as testAdAutomation } from "@/app/api/ad-automations/[id]/test/route";

const actor = {
  userId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  role: "owner" as const,
  email: "owner@example.test",
  displayName: "Owner",
};
const automationId = "33333333-3333-4333-8333-333333333333";
const idempotencyKey = "55555555-5555-4555-8555-555555555555";
const context = () => ({ params: Promise.resolve({ id: automationId }) });

function request(url: string, method: string, body?: unknown) {
  return new NextRequest(url, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

afterEach(() => {
  mocks.neonConfigurationResponse.mockReset();
  mocks.requireNeonActor.mockReset();
  mocks.neonWriteErrorResponse.mockClear();
  mocks.createAdAutomation.mockReset();
  mocks.listAdAutomations.mockReset();
  mocks.getAdAutomation.mockReset();
  mocks.updateAdAutomation.mockReset();
  mocks.deleteAdAutomation.mockReset();
  mocks.runAdAutomationManualTest.mockReset();
});

describe("Vercel/Neon ad automation routes", () => {
  it("does not read workflows without a signed app actor", async () => {
    mocks.neonConfigurationResponse.mockReturnValueOnce(null);
    mocks.requireNeonActor.mockResolvedValueOnce({ response: NextResponse.json({ error: "Logga in" }, { status: 401 }) });
    const response = await listAdAutomations();
    expect(response.status).toBe(401);
    expect(mocks.listAdAutomations).not.toHaveBeenCalled();
  });

  it("saves a valid canvas only through the signed actor", async () => {
    const input = validAdAutomationCreateInput();
    mocks.neonConfigurationResponse.mockReturnValueOnce(null);
    mocks.requireNeonActor.mockResolvedValueOnce({ actor });
    mocks.createAdAutomation.mockResolvedValueOnce({ reused: false, automation: { id: automationId, ...input, revision: 1, destinations: [] } });
    const response = await createAdAutomation(request("http://localhost/api/ad-automations", "POST", input));
    expect(response.status).toBe(201);
    expect(mocks.createAdAutomation).toHaveBeenCalledWith(actor, expect.objectContaining({ name: input.name }));
  });

  it("requires a revision for a canvas update", async () => {
    mocks.neonConfigurationResponse.mockReturnValueOnce(null);
    mocks.requireNeonActor.mockResolvedValueOnce({ actor });
    const response = await patchAdAutomation(request("http://localhost/api/ad-automations/id", "PATCH", { name: "Sen ändring" }), context());
    expect(response.status).toBe(400);
    expect(mocks.updateAdAutomation).not.toHaveBeenCalled();
  });

  it("returns a private receipt, never an external campaign result", async () => {
    mocks.neonConfigurationResponse.mockReturnValueOnce(null);
    mocks.requireNeonActor.mockResolvedValueOnce({ actor });
    mocks.runAdAutomationManualTest.mockResolvedValueOnce({
      reused: false,
      automation: { id: automationId, name: "Sätra", active: false, revision: 1, workflow: validAdAutomationInput().workflow, destinations: [] },
      receipt: { id: "receipt", automationId, idempotencyKey, state: "completed", draftId: "draft", createdAt: "2026-08-25T09:00:00.000Z", updatedAt: "2026-08-25T09:00:00.000Z" },
      draft: { id: "draft", title: "Annonsutkast: Sätra", status: "draft", scheduledAt: null },
    });
    const response = await testAdAutomation(request("http://localhost/api/ad-automations/id/test", "POST", { idempotencyKey }), context());
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      status: "private_draft_created",
      externalExecution: "unavailable",
      receipt: { state: "completed", draftId: "draft" },
      draft: { status: "draft", scheduledAt: null },
    });
    expect(mocks.runAdAutomationManualTest).toHaveBeenCalledWith(actor, { automationId, idempotencyKey });
  });
});
