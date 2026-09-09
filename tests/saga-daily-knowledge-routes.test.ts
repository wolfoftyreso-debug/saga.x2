import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { SagaBrandScopeError } from "@/lib/neon/saga-brand-api-eligibility";

const actor = {
  userId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  role: "owner" as const,
  email: null,
  displayName: "Owner",
};
const sourceA = "33333333-3333-4333-8333-333333333333";
const sourceB = "44444444-4444-4444-8444-444444444444";
const brandProfileId = "55555555-5555-4555-8555-555555555555";
const brandActor = { ...actor, brandProfileId };

const mocks = vi.hoisted(() => ({
  requireActor: vi.fn(),
  getPolicy: vi.fn(),
  savePolicy: vi.fn(),
  listEntries: vi.fn(),
  listRuns: vi.fn(),
  resolveBrand: vi.fn(),
}));

vi.mock("@/lib/services/saga-news-http", () => ({
  requireSagaNewsActor: mocks.requireActor,
  sagaNewsNoStore: (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { "cache-control": "no-store" },
  }),
  sagaNewsErrorResponse: (error: unknown) => new Response(JSON.stringify({
    error: error instanceof Error ? error.message : "failed",
  }), { status: 500 }),
  readSagaNewsJson: async (request: Request) => request.json().catch(() => null),
  hasSagaNewsWorkspaceField: (value: unknown) => Boolean(value && typeof value === "object" && ("workspaceId" in value || "workspace_id" in value)),
}));
vi.mock("@/lib/neon/saga-daily-knowledge-repository", () => ({
  getSagaDailyKnowledgePolicy: mocks.getPolicy,
  saveSagaDailyKnowledgePolicy: mocks.savePolicy,
  listSagaDailyKnowledgeEntries: mocks.listEntries,
  listSagaDailyKnowledgeRuns: mocks.listRuns,
}));
vi.mock("@/lib/neon/saga-brand-api-eligibility", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/neon/saga-brand-api-eligibility")>(),
  resolveSagaBrandActor: mocks.resolveBrand,
}));

import { GET as getPolicy, PUT as putPolicy } from "@/app/api/saga/knowledge/policy/route";
import { GET as getEntries } from "@/app/api/saga/knowledge/entries/route";
import { GET as getRuns } from "@/app/api/saga/knowledge/runs/route";

function validPolicy() {
  return {
    enabled: false,
    timezone: "Europe/Stockholm",
    dailyAt: "06:00",
    topics: ["AI och arbete"],
    sourceIds: [sourceA, sourceB],
    minimumIndependentPublishers: 2,
    minimumEvidenceItems: 2,
    maximumEvidenceItems: 4,
    evidenceWindowHours: 72,
    retentionDays: 90,
  };
}

describe("SAGA Daily Knowledge brand API gate", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.requireActor.mockResolvedValue({ actor });
    mocks.resolveBrand.mockResolvedValue(brandActor);
  });

  it("keeps the one-brand policy and receipt responses intact", async () => {
    mocks.getPolicy.mockResolvedValue(null);
    mocks.savePolicy.mockResolvedValue({ enabled: false, revision: 1 });
    mocks.listEntries.mockResolvedValue([]);
    mocks.listRuns.mockResolvedValue([]);

    const [policy, saved, entries, runs] = await Promise.all([
      getPolicy(new NextRequest("https://example.test/api/saga/knowledge/policy")),
      putPolicy(new NextRequest("https://example.test/api/saga/knowledge/policy", {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(validPolicy()),
      })),
      getEntries(new NextRequest("https://example.test/api/saga/knowledge/entries")),
      getRuns(new NextRequest("https://example.test/api/saga/knowledge/runs")),
    ]);

    await expect(policy.json()).resolves.toEqual({ data: null });
    await expect(saved.json()).resolves.toEqual({ data: { enabled: false, revision: 1 } });
    await expect(entries.json()).resolves.toEqual({ data: [] });
    await expect(runs.json()).resolves.toEqual({ data: [] });
    expect(mocks.getPolicy).toHaveBeenCalledWith(brandActor);
    expect(mocks.savePolicy).toHaveBeenCalledWith(brandActor, expect.objectContaining({ topics: ["AI och arbete"] }));
    expect(mocks.listEntries).toHaveBeenCalledWith(brandActor, { date: undefined, limit: 20 });
    expect(mocks.listRuns).toHaveBeenCalledWith(brandActor, { limit: 20 });
  });

  it("returns 409 without policy, entry, or run data when a brand choice is required", async () => {
    mocks.resolveBrand.mockRejectedValue(new SagaBrandScopeError("brand_selection_required", "Välj varumärke."));

    const [policy, saved, entries, runs] = await Promise.all([
      getPolicy(new NextRequest("https://example.test/api/saga/knowledge/policy")),
      putPolicy(new NextRequest("https://example.test/api/saga/knowledge/policy", {
        method: "PUT", headers: { "content-type": "application/json" }, body: "{}",
      })),
      getEntries(new NextRequest("https://example.test/api/saga/knowledge/entries?limit=20")),
      getRuns(new NextRequest("https://example.test/api/saga/knowledge/runs?limit=20")),
    ]);

    for (const response of [policy, saved, entries, runs]) {
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        error: "Välj varumärke.",
        code: "brand_selection_required",
      });
    }
    expect(mocks.getPolicy).not.toHaveBeenCalled();
    expect(mocks.savePolicy).not.toHaveBeenCalled();
    expect(mocks.listEntries).not.toHaveBeenCalled();
    expect(mocks.listRuns).not.toHaveBeenCalled();
  });

  it("uses the selected brand on every knowledge endpoint without accepting tenant scope", async () => {
    mocks.getPolicy.mockResolvedValue(null);
    mocks.savePolicy.mockResolvedValue({ revision: 1 });
    mocks.listEntries.mockResolvedValue([]);
    mocks.listRuns.mockResolvedValue([]);
    const query = `?brandProfileId=${brandProfileId}`;
    const responses = await Promise.all([
      getPolicy(new NextRequest(`https://example.test/api/saga/knowledge/policy${query}`)),
      putPolicy(new NextRequest(`https://example.test/api/saga/knowledge/policy${query}`, { method: "PUT", body: JSON.stringify(validPolicy()) })),
      getEntries(new NextRequest(`https://example.test/api/saga/knowledge/entries${query}`)),
      getRuns(new NextRequest(`https://example.test/api/saga/knowledge/runs${query}`)),
    ]);
    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(mocks.resolveBrand).toHaveBeenCalledTimes(4);
    for (const call of mocks.resolveBrand.mock.calls) expect(call).toEqual([actor, brandProfileId]);
    const rejected = await putPolicy(new NextRequest(`https://example.test/api/saga/knowledge/policy${query}`, {
      method: "PUT", body: JSON.stringify({ ...validPolicy(), workspaceId: actor.workspaceId }),
    }));
    expect(rejected.status).toBe(422);
  });

  it.each(["brand_onboarding_required", "brand_not_found"] as const)("rejects %s before any data access", async (code) => {
    mocks.resolveBrand.mockRejectedValue(new SagaBrandScopeError(code, "Välj ett färdigställt varumärke."));
    const response = await getPolicy(new NextRequest("https://example.test/api/saga/knowledge/policy"));
    expect(response.status).toBe(code === "brand_not_found" ? 404 : 409);
    expect(mocks.getPolicy).not.toHaveBeenCalled();
  });

  it("rejects empty, malformed and duplicate brand parameters without silently falling back", async () => {
    for (const query of ["brandProfileId=", "brandProfileId=invalid", `brandProfileId=${brandProfileId}&brandProfileId=${brandProfileId}`]) {
      expect((await getPolicy(new NextRequest(`https://example.test/api/saga/knowledge/policy?${query}`))).status).toBe(404);
    }
    expect(mocks.resolveBrand).not.toHaveBeenCalled();
    expect(mocks.getPolicy).not.toHaveBeenCalled();
  });

  it("does not leak raw infrastructure failure details", async () => {
    mocks.getPolicy.mockRejectedValue(new Error("postgresql://private-secret@db.test/private-policy"));
    const response = await getPolicy(new NextRequest("https://example.test/api/saga/knowledge/policy"));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private-secret");
  });
});
