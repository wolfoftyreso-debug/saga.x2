import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const actor = {
  userId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  role: "owner" as const,
  email: null,
  displayName: null,
};

const mocks = vi.hoisted(() => ({
  requireActor: vi.fn(),
  getPolicy: vi.fn(),
  savePolicy: vi.fn(),
}));

vi.mock("@/lib/services/saga-news-http", () => ({
  requireSagaNewsActor: mocks.requireActor,
  sagaNewsNoStore: (body: unknown, status = 200) => new Response(JSON.stringify(body), { status }),
  sagaNewsErrorResponse: (error: unknown) => new Response(JSON.stringify({ error: error instanceof Error ? error.message : "failed" }), { status: 500 }),
  readSagaNewsJson: async (request: Request) => request.json().catch(() => null),
  hasSagaNewsWorkspaceField: (value: unknown) => Boolean(value && typeof value === "object" && ("workspaceId" in value || "workspace_id" in value)),
}));

vi.mock("@/lib/neon/saga-signal-production-repository", () => ({
  getSagaSignalProductionPolicy: mocks.getPolicy,
  saveSagaSignalProductionPolicy: mocks.savePolicy,
}));

import { GET, PUT } from "@/app/api/saga/news/production-policy/route";

describe("SAGA signal production policy API", () => {
  it("returns only the signed workspace policy and reports absent policy as no opt-in", async () => {
    mocks.requireActor.mockResolvedValue({ actor });
    mocks.getPolicy.mockResolvedValue(null);

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: null });
    expect(mocks.getPolicy).toHaveBeenCalledWith(actor);
  });

  it("rejects tenant injection and saves an explicit private-review policy", async () => {
    mocks.requireActor.mockResolvedValue({ actor });
    const rejected = await PUT(new NextRequest("https://example.test/api/saga/news/production-policy", {
      method: "PUT",
      body: JSON.stringify({ enabled: true, workspaceId: "foreign" }),
      headers: { "content-type": "application/json" },
    }));
    expect(rejected.status).toBe(422);
    expect(mocks.savePolicy).not.toHaveBeenCalled();

    mocks.savePolicy.mockResolvedValue({ enabled: true, calendarEnabled: false, revision: 1 });
    const accepted = await PUT(new NextRequest("https://example.test/api/saga/news/production-policy", {
      method: "PUT",
      body: JSON.stringify({
        enabled: true,
        calendarEnabled: false,
        calendarDelayMinutes: 1440,
        timezone: "Europe/Stockholm",
        maxDraftsPerTick: 2,
      }),
      headers: { "content-type": "application/json" },
    }));
    expect(accepted.status).toBe(200);
    expect(mocks.savePolicy).toHaveBeenCalledWith(actor, expect.objectContaining({ enabled: true, calendarEnabled: false }));
    await expect(accepted.json()).resolves.toEqual({ data: { enabled: true, calendarEnabled: false, revision: 1 } });
  });
});
