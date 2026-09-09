import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  neonConfigurationResponse: vi.fn(),
  requireNeonActor: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  get: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("@/lib/neon/http", () => ({
  neonConfigurationResponse: mocks.neonConfigurationResponse,
  requireNeonActor: mocks.requireNeonActor,
}));
vi.mock("@/lib/neon/saga-ad-creative-project-repository", () => ({
  listSagaAdCreativeProjects: mocks.list,
  createSagaAdCreativeProject: mocks.create,
  getSagaAdCreativeProject: mocks.get,
  updateSagaAdCreativeProject: mocks.update,
  deleteSagaAdCreativeProject: mocks.remove,
  SagaAdCreativeProjectAccessError: class SagaAdCreativeProjectAccessError extends Error {},
  SagaAdCreativeProjectNotFoundError: class SagaAdCreativeProjectNotFoundError extends Error {},
  SagaAdCreativeProjectConflictError: class SagaAdCreativeProjectConflictError extends Error {},
  SagaAdCreativeProjectValidationError: class SagaAdCreativeProjectValidationError extends Error {},
}));

import { GET as list, POST as create } from "@/app/api/saga/ad-creative-projects/route";
import { PATCH as update } from "@/app/api/saga/ad-creative-projects/[projectId]/route";

const actor = {
  userId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  role: "owner" as const,
  email: null,
  displayName: null,
};
const projectId = "33333333-3333-4333-8333-333333333333";
const valid = {
  name: "System som frigör tid",
  createIdempotencyKey: "44444444-4444-4444-8444-444444444444",
  masterBrief: { objective: "awareness", audience: "Byggare", message: "Automatisera det repetitiva", callToAction: "Utforska", sourceReference: "" },
  variants: [{
    id: "55555555-5555-4555-8555-555555555555", label: "Meta kvadrat", status: "private_draft",
    format: { kind: "preset", presetId: "meta_feed_square_v1" },
    copy: { headline: "Automatisera", primaryText: "Behåll det mänskliga", description: "", callToAction: "Läs", destinationUrl: null, legalText: "" }, assetDirection: "",
  }],
};
const project = { id: projectId, name: valid.name, masterBrief: valid.masterBrief, variants: [], revision: 1, createdAt: "2026-08-26T09:00:00.000Z", updatedAt: "2026-08-26T09:00:00.000Z" };
const context = () => ({ params: Promise.resolve({ projectId }) });
const request = (method: string, body: unknown) => new NextRequest("http://localhost/api/saga/ad-creative-projects", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.neonConfigurationResponse.mockReturnValue(null);
  mocks.requireNeonActor.mockResolvedValue({ actor });
});

describe("SAGA Ad Creative routes", () => {
  it("fails closed when Neon is not configured", async () => {
    mocks.neonConfigurationResponse.mockReturnValueOnce(NextResponse.json({ code: "configuration_required" }, { status: 503 }));
    const response = await list();
    expect(response.status).toBe(503);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("rejects client-controlled publishing/account selectors", async () => {
    const response = await create(request("POST", { ...valid, publish: true, accountId: "not-accepted" }));
    expect(response.status).toBe(422);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("creates only a private material project and returns no-store", async () => {
    mocks.create.mockResolvedValueOnce({ project, reused: false });
    const response = await create(request("POST", valid));
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({ project, reused: false });
    expect(mocks.create).toHaveBeenCalledWith(actor, expect.objectContaining({ name: valid.name }));
  });

  it("requires a revision for a canvas update", async () => {
    const response = await update(request("PATCH", { name: "Nytt namn" }), context());
    expect(response.status).toBe(422);
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
