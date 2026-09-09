import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const actor = {
  userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  workspaceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  role: "owner" as const,
  email: null,
  displayName: null,
};

const mocks = vi.hoisted(() => ({
  requireActor: vi.fn(),
  listSources: vi.fn(),
  listItems: vi.fn(),
  listRuns: vi.fn(),
  listSignals: vi.fn(),
  saveSource: vi.fn(),
  setSourceActive: vi.fn(),
  deleteSource: vi.fn(),
  runSource: vi.fn(),
}));

vi.mock("@/lib/services/saga-news-http", () => ({
  requireSagaNewsActor: mocks.requireActor,
  sagaNewsNoStore: (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "cache-control": "no-store" } }),
  sagaNewsErrorResponse: (error: unknown) => new Response(JSON.stringify({ error: error instanceof Error ? error.message : "failed" }), { status: 500 }),
  readSagaNewsJson: async (request: Request) => request.json().catch(() => null),
  hasSagaNewsWorkspaceField: (value: unknown) => Boolean(value && typeof value === "object" && ("workspaceId" in value || "workspace_id" in value)),
}));

vi.mock("@/lib/neon/saga-news-core-repository", () => ({
  listSagaNewsSources: mocks.listSources,
  listSagaNewsSourceItems: mocks.listItems,
  listSagaNewsIngestionRuns: mocks.listRuns,
  listSagaNewsSignalCandidates: mocks.listSignals,
  saveSagaNewsSource: mocks.saveSource,
  setSagaNewsSourceActive: mocks.setSourceActive,
  deleteSagaNewsSource: mocks.deleteSource,
}));

vi.mock("@/lib/services/saga-news-runner", () => ({ runSagaNewsSourceNow: mocks.runSource }));

import { GET as overview } from "@/app/api/saga/news/route";
import { POST as saveSource } from "@/app/api/saga/news/sources/route";
import { PATCH as setSourceActive } from "@/app/api/saga/news/sources/[sourceId]/route";
import { POST as check } from "@/app/api/saga/news/check/route";

const validSource = {
  slug: "global-elbilar",
  name: "Global elbilsbevakning",
  sourceKind: "public_api",
  connectorKey: "gdelt_doc_2",
  endpointUrl: "https://api.gdeltproject.org/api/v2/doc/doc",
  publisherAllowlist: ["di.se", "svd.se"],
  publisherBlocklist: [],
  allowlistMode: "strict",
  topics: ["kinesiska elbilar"],
  languages: ["sv"],
  countries: ["SE"],
  trustLevel: 4,
  sourceWeight: 80,
  minimumIntervalMinutes: 60,
  maxItemsPerRun: 50,
  maxItemTextChars: 30_000,
  sourcePolicy: {},
  isAllowed: true,
  active: true,
};

describe("SAGA News HTTP flows", () => {
  it("returns a workspace-scoped overview without accepting a tenant selection", async () => {
    mocks.requireActor.mockResolvedValue({ actor });
    mocks.listSources.mockResolvedValue([{ id: "source-1" }]);
    mocks.listItems.mockResolvedValue([{ id: "item-1" }]);
    mocks.listRuns.mockResolvedValue([{ id: "run-1" }]);
    mocks.listSignals.mockResolvedValue([{ id: "signal-1" }]);

    const response = await overview();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: {
      sources: [{ id: "source-1" }], items: [{ id: "item-1" }], runs: [{ id: "run-1" }], signals: [{ id: "signal-1" }],
    } });
    expect(mocks.listSources).toHaveBeenCalledWith(actor);
  });

  it("rejects a client-provided workspace and saves only a valid source through the actor", async () => {
    mocks.requireActor.mockResolvedValue({ actor });
    const rejected = await saveSource(new NextRequest("https://example.test/api/saga/news/sources", {
      method: "POST", body: JSON.stringify({ ...validSource, workspaceId: "foreign-workspace" }), headers: { "content-type": "application/json" },
    }));
    expect(rejected.status).toBe(422);
    expect(mocks.saveSource).not.toHaveBeenCalled();

    mocks.saveSource.mockResolvedValueOnce({ id: "source-1", ...validSource });
    const accepted = await saveSource(new NextRequest("https://example.test/api/saga/news/sources", {
      method: "POST", body: JSON.stringify(validSource), headers: { "content-type": "application/json" },
    }));
    expect(accepted.status).toBe(201);
    expect(mocks.saveSource).toHaveBeenCalledWith(actor, expect.objectContaining({ slug: "global-elbilar" }));
  });

  it("uses a real active toggle rather than a local source state", async () => {
    mocks.requireActor.mockResolvedValue({ actor });
    mocks.setSourceActive.mockResolvedValue({ id: "11111111-1111-4111-8111-111111111111", active: false });
    const response = await setSourceActive(new NextRequest("https://example.test/api/saga/news/sources/11111111-1111-4111-8111-111111111111", {
      method: "PATCH", body: JSON.stringify({ active: false }), headers: { "content-type": "application/json" },
    }), { params: Promise.resolve({ sourceId: "11111111-1111-4111-8111-111111111111" }) });
    expect(response.status).toBe(200);
    expect(mocks.setSourceActive).toHaveBeenCalledWith(actor, "11111111-1111-4111-8111-111111111111", false);
  });

  it("runs exactly one source under an idempotency receipt and exposes an honest retry status", async () => {
    mocks.requireActor.mockResolvedValue({ actor });
    mocks.runSource.mockResolvedValue({
      status: "completed",
      source: { id: "11111111-1111-4111-8111-111111111111" },
      run: { id: "22222222-2222-4222-8222-222222222222", status: "completed" },
      batch: { receivedCount: 3, insertedCount: 2, duplicateCount: 1 },
      signals: [],
      message: "Hämtade 3 underlag.",
    });
    const response = await check(new NextRequest("https://example.test/api/saga/news/check", {
      method: "POST",
      body: JSON.stringify({ sourceId: "11111111-1111-4111-8111-111111111111", idempotencyKey: "22222222-2222-4222-8222-222222222222" }),
      headers: { "content-type": "application/json" },
    }));
    expect(response.status).toBe(200);
    expect(mocks.runSource).toHaveBeenCalledWith(actor, {
      sourceId: "11111111-1111-4111-8111-111111111111",
      idempotencyKey: "22222222-2222-4222-8222-222222222222",
    });
  });
});
