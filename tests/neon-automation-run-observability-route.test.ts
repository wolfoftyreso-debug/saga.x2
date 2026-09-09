import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  neonConfigurationResponse: vi.fn(),
  requireNeonActor: vi.fn(),
  neonWriteErrorResponse: vi.fn((error: unknown, fallback: string) => NextResponse.json({ error: error instanceof Error ? error.message : fallback }, { status: 500 })),
  getStudioAutomationRunOverview: vi.fn(),
}));

vi.mock("@/lib/neon/http", () => ({
  neonConfigurationResponse: mocks.neonConfigurationResponse,
  neonWriteErrorResponse: mocks.neonWriteErrorResponse,
  requireNeonActor: mocks.requireNeonActor,
}));
vi.mock("@/lib/neon/studio-content-repository", () => ({
  getStudioAutomationRunOverview: mocks.getStudioAutomationRunOverview,
}));

import { GET } from "@/app/api/content/automation-runs/route";

const actor = {
  userId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  role: "owner" as const,
  email: "owner@example.test",
  displayName: "Owner",
};

afterEach(() => {
  mocks.neonConfigurationResponse.mockReset();
  mocks.requireNeonActor.mockReset();
  mocks.neonWriteErrorResponse.mockClear();
  mocks.getStudioAutomationRunOverview.mockReset();
});

describe("Vercel/Neon content automation run monitor route", () => {
  it("stops at the Vercel/Neon configuration fence", async () => {
    mocks.neonConfigurationResponse.mockReturnValueOnce(NextResponse.json({ code: "configuration_required" }, { status: 503 }));
    const response = await GET(new NextRequest("http://localhost/api/content/automation-runs"));
    expect(response.status).toBe(503);
    expect(mocks.requireNeonActor).not.toHaveBeenCalled();
    expect(mocks.getStudioAutomationRunOverview).not.toHaveBeenCalled();
  });

  it("requires the signed actor before reading a workspace", async () => {
    mocks.neonConfigurationResponse.mockReturnValueOnce(null);
    mocks.requireNeonActor.mockResolvedValueOnce({ response: NextResponse.json({ error: "Logga in" }, { status: 401 }) });
    const response = await GET(new NextRequest("http://localhost/api/content/automation-runs"));
    expect(response.status).toBe(401);
    expect(mocks.getStudioAutomationRunOverview).not.toHaveBeenCalled();
  });

  it("reads a bounded overview under the server-resolved actor only", async () => {
    mocks.neonConfigurationResponse.mockReturnValueOnce(null);
    mocks.requireNeonActor.mockResolvedValueOnce({ actor });
    mocks.getStudioAutomationRunOverview.mockResolvedValueOnce({ automations: [], runs: [] });

    const response = await GET(new NextRequest("http://localhost/api/content/automation-runs?limit=37&workspaceId=other-workspace"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ automations: [], runs: [] });
    expect(mocks.getStudioAutomationRunOverview).toHaveBeenCalledWith(actor, { limit: 37 });
  });

  it("rejects an unbounded or malformed limit before querying jobs", async () => {
    mocks.neonConfigurationResponse.mockReturnValueOnce(null);
    mocks.requireNeonActor.mockResolvedValueOnce({ actor });
    const response = await GET(new NextRequest("http://localhost/api/content/automation-runs?limit=101"));
    expect(response.status).toBe(400);
    expect(mocks.getStudioAutomationRunOverview).not.toHaveBeenCalled();
  });
});
