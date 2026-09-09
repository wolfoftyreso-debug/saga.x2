import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const actor = {
  userId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  role: "owner" as const,
  email: null,
  displayName: null,
};
const seriesId = "33333333-3333-4333-8333-333333333333";
const sourceDraftId = "44444444-4444-4444-8444-444444444444";

const mocks = vi.hoisted(() => ({
  requireActor: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  patch: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("@/lib/services/saga-series-reference-http", () => ({
  requireSagaSeriesReferenceActor: mocks.requireActor,
  sagaSeriesReferenceNoStore: (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { "cache-control": "no-store", "x-robots-tag": "noindex" },
  }),
  sagaSeriesReferenceErrorResponse: (error: unknown) => new Response(JSON.stringify({ error: error instanceof Error ? error.message : "failed" }), { status: 500 }),
  readSagaSeriesReferenceJson: async (request: Request) => request.json().catch(() => null),
  containsSagaSeriesReferenceWorkspaceId: (value: unknown) => JSON.stringify(value).includes("workspaceId") || JSON.stringify(value).includes("workspace_id"),
}));
vi.mock("@/lib/neon/saga-series-reference-repository", () => ({
  listSagaSeriesReferences: mocks.list,
  createSagaSeriesReference: mocks.create,
  patchSagaSeriesReference: mocks.patch,
  deleteSagaSeriesReference: mocks.remove,
}));

import { DELETE, GET, PATCH, POST } from "@/app/api/saga/series/route";

const controls = {
  objective: "educate",
  audience: "Företagare",
  tone: "direct",
  requiredElements: [],
  forbiddenElements: [],
  defaultChannels: ["linkedin"],
  reviewRequired: true,
};

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.requireActor.mockResolvedValue({ actor });
});

describe("SAGA Series Reference route contract", () => {
  it("lists only the signed actor's workspace with no cache", async () => {
    mocks.list.mockResolvedValue([{ id: seriesId }]);
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ series: [{ id: seriesId }] });
    expect(mocks.list).toHaveBeenCalledWith(actor);
  });

  it("rejects a nested client workspace selector before a create", async () => {
    const response = await POST(new NextRequest("https://example.test/api/saga/series", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        slug: "frigjord-tid", name: "Frigjord tid", referenceDraftId: sourceDraftId,
        controls: { ...controls, nested: { workspaceId: actor.workspaceId } },
      }),
    }));
    expect(response.status).toBe(422);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("creates with a server-derived workspace and only a saved draft ID", async () => {
    mocks.create.mockResolvedValue({ id: seriesId, controls });
    const response = await POST(new NextRequest("https://example.test/api/saga/series", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "frigjord-tid", name: "Frigjord tid", active: false, referenceDraftId: sourceDraftId, controls }),
    }));
    expect(response.status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith(actor, expect.objectContaining({ referenceDraftId: sourceDraftId, controls }));
    expect(mocks.create.mock.calls[0]?.[1]).not.toHaveProperty("workspaceId");
  });

  it("requires expectedRevision for patch and delete", async () => {
    const invalidPatch = await PATCH(new NextRequest("https://example.test/api/saga/series", {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: seriesId, active: true }),
    }));
    expect(invalidPatch.status).toBe(422);
    expect(mocks.patch).not.toHaveBeenCalled();

    mocks.remove.mockResolvedValue(undefined);
    const deleted = await DELETE(new NextRequest("https://example.test/api/saga/series", {
      method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: seriesId, expectedRevision: 3 }),
    }));
    expect(deleted.status).toBe(200);
    expect(mocks.remove).toHaveBeenCalledWith(actor, { id: seriesId, expectedRevision: 3 });
  });
});
