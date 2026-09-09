import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const actor = {
  userId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  role: "owner" as const,
  email: null,
  displayName: "Nils Systembyggare",
};
const runId = "33333333-3333-4333-8333-333333333333";
const draftId = "44444444-4444-4444-8444-444444444444";
const key = "66666666-6666-4666-8666-666666666666";
const knowledgeId = "77777777-7777-4777-8777-777777777777";

const mocks = vi.hoisted(() => ({
  requireActor: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  getRun: vi.fn(),
  getReceipt: vi.fn(),
  prepare: vi.fn(),
  select: vi.fn(),
  resolveKnowledge: vi.fn(),
  worker: vi.fn(),
  lens: vi.fn(),
  generate: vi.fn(),
  assess: vi.fn(),
}));

vi.mock("@/lib/services/saga-adobe-authoring-http", () => ({
  requireSagaAdobeAuthoringActor: mocks.requireActor,
  sagaAdobeAuthoringResponse: (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "cache-control": "no-store" } }),
  sagaAdobeAuthoringErrorResponse: (error: unknown) => new Response(JSON.stringify({ error: error instanceof Error ? error.message : "failed" }), { status: 500 }),
  readSagaAdobeAuthoringJson: async (request: Request) => request.json().catch(() => null),
  containsSagaAdobeAuthoringForbiddenSelector: (value: unknown) => JSON.stringify(value).includes("workspaceId") || JSON.stringify(value).includes("authorName") || JSON.stringify(value).includes("canonicalUrl"),
}));
vi.mock("@/lib/neon/saga-adobe-authoring-repository", () => ({
  createSagaAdobeAuthoringRun: mocks.create,
  listSagaAdobeAuthoringRuns: mocks.list,
  getSagaAdobeAuthoringRun: mocks.getRun,
  getSagaAdobeAuthoringGenerationReceipt: mocks.getReceipt,
  prepareSagaAdobeAuthoringRunGeneration: mocks.prepare,
  selectSagaAdobeAuthoringCandidate: mocks.select,
  resolveSagaAdobeAuthoringKnowledgeSnapshots: mocks.resolveKnowledge,
  SagaAdobeAuthoringAccessError: class SagaAdobeAuthoringAccessError extends Error {},
}));
vi.mock("@/lib/neon/saga-adobe-authoring-worker", () => ({ runSagaAdobeAuthoringWorker: mocks.worker }));
vi.mock("@/lib/neon/saga-editorial-lens-repository", () => ({ getSagaEditorialLensPromptContext: mocks.lens }));
vi.mock("@/lib/services/content-generation", () => ({ generateContentDraft: mocks.generate }));
vi.mock("@/lib/services/saga-production-quality", () => ({ assessGeneratedContentQuality: mocks.assess }));

import { POST as createPost } from "@/app/api/saga/authoring-runs/route";
import { POST as generatePost } from "@/app/api/saga/authoring-runs/[runId]/generate/route";
import { POST as previewPost } from "@/app/api/saga/authoring-preview/route";

const run = {
  id: runId,
  revision: 2,
  state: "generating",
  candidateCount: 2,
  candidates: [],
  hasPendingWork: true,
  canContinue: true,
  noPublication: true,
};

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.requireActor.mockResolvedValue({ actor });
});

describe("SAGA Adobe authoring routes", () => {
  it("honors the shared brand gate before preview, durable-run creation, or candidate production", async () => {
    mocks.requireActor.mockImplementation(async () => ({
      response: new Response(JSON.stringify({
        error: "Välj varumärke innan den här arbetsytans gemensamma AI- och kunskapsinställning används.",
        code: "brand_selection_required",
      }), { status: 409 }),
    }));
    const request = new NextRequest("https://example.test/api/saga/authoring-runs", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });

    const [created, previewed, generated] = await Promise.all([
      createPost(request),
      previewPost(new NextRequest("https://example.test/api/saga/authoring-preview", {
        method: "POST", headers: { "content-type": "application/json" }, body: "{}",
      })),
      generatePost(new NextRequest(`https://example.test/api/saga/authoring-runs/${runId}/generate`, {
        method: "POST", headers: { "content-type": "application/json" }, body: "{}",
      }), { params: Promise.resolve({ runId }) }),
    ]);

    for (const response of [created, previewed, generated]) {
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        error: "Välj varumärke innan den här arbetsytans gemensamma AI- och kunskapsinställning används.",
        code: "brand_selection_required",
      });
    }
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.resolveKnowledge).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.worker).not.toHaveBeenCalled();
  });

  it("rejects a client author identity rather than silently ignoring it", async () => {
    const response = await createPost(new NextRequest("https://example.test/api/saga/authoring-runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: key,
        referenceDraftId: draftId,
        expectedReferenceDraftRevision: 2,
        objective: "Förklara hur system frigör mänsklig tid.",
        prompt: "Skriv lugnt och konkret.",
        authorName: "Felaktigt klientnamn",
        includeAuthorName: true,
        selectedKnowledgeEntryIds: [],
        candidateCount: 2,
      }),
    }));
    expect(response.status).toBe(422);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("creates a run from opaque saved IDs only", async () => {
    mocks.create.mockResolvedValue({ run, reused: false });
    const response = await createPost(new NextRequest("https://example.test/api/saga/authoring-runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: key,
        referenceDraftId: draftId,
        expectedReferenceDraftRevision: 2,
        objective: "Förklara hur system frigör mänsklig tid.",
        prompt: "Skriv lugnt och konkret.",
        includeAuthorName: true,
        selectedKnowledgeEntryIds: [knowledgeId],
        candidateCount: 2,
      }),
    }));
    expect(response.status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith(actor, expect.objectContaining({ referenceDraftId: draftId, selectedKnowledgeEntryIds: [knowledgeId] }));
    expect(mocks.create.mock.calls[0]?.[1]).not.toHaveProperty("authorName");
  });

  it("processes a fresh key attached to an active durable receipt exactly once", async () => {
    // `reused: true` here models a fresh post-reload key attaching to an
    // existing receipt. The durable command, not receipt reuse, decides work.
    const receipt = { id: "88888888-8888-4888-8888-888888888888", state: "running", reused: true };
    const command = {
      id: "99999999-9999-4999-8999-999999999999",
      claimToken: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      shouldProcess: true,
    };
    const freshKey = "abababab-abab-4bab-8bab-abababababab";
    mocks.prepare.mockResolvedValue({ run, receipt, command });
    mocks.worker.mockResolvedValue({ runId, receiptId: receipt.id, candidatesReady: 1, studioDraftsCreated: 0, noPublication: true });
    mocks.getRun.mockResolvedValue({ ...run, hasPendingWork: true, canContinue: true });
    mocks.getReceipt.mockResolvedValue({ ...receipt, jobCount: 2, completedJobCount: 1, failedJobCount: 0 });
    const response = await generatePost(new NextRequest(`https://example.test/api/saga/authoring-runs/${runId}/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: freshKey, expectedRunRevision: 2, retryFailed: false }),
    }), { params: Promise.resolve({ runId }) });
    expect(response.status).toBe(200);
    expect(mocks.prepare).toHaveBeenCalledWith(actor, runId, expect.objectContaining({
      idempotencyKey: freshKey,
      expectedRunRevision: 2,
    }));
    expect(mocks.worker).toHaveBeenCalledWith(expect.objectContaining({
      runId,
      receiptId: receipt.id,
      commandId: command.id,
      commandClaimToken: command.claimToken,
    }));
    await expect(response.json()).resolves.toMatchObject({ noPublication: true, studioDraftsCreated: 0, run: { canContinue: true } });
  });

  it("returns current receipt status for a replayed command without advancing another candidate", async () => {
    const receipt = { id: "88888888-8888-4888-8888-888888888888", state: "running", reused: true };
    mocks.prepare.mockResolvedValue({
      run,
      receipt,
      command: { id: "99999999-9999-4999-8999-999999999999", claimToken: null, shouldProcess: false },
    });
    mocks.getRun.mockResolvedValue({ ...run, hasPendingWork: true, canContinue: true });
    mocks.getReceipt.mockResolvedValue({ ...receipt, jobCount: 2, completedJobCount: 1, failedJobCount: 0 });

    const response = await generatePost(new NextRequest(`https://example.test/api/saga/authoring-runs/${runId}/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: key, expectedRunRevision: 2, retryFailed: false }),
    }), { params: Promise.resolve({ runId }) });

    expect(response.status).toBe(200);
    expect(mocks.worker).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      worker: { jobsClaimed: 0, candidatesReady: 0, studioDraftsCreated: 0, noPublication: true },
      run: { canContinue: true },
    });
  });

  it("resolves opaque Daily Knowledge IDs server-side for a transient preview and saves nothing", async () => {
    mocks.resolveKnowledge.mockResolvedValue([{
      entryId: knowledgeId, topic: "AI och arbete", headline: "Arbetet flyttas", summary: "En säker sammanfattning.",
    }]);
    mocks.lens.mockResolvedValue(null);
    mocks.generate.mockResolvedValue({ draft: { title: "T", headline: "H", subject: "S", previewText: "P", body: "B", callToAction: "C", hashtags: [], imagePrompt: "I", altText: "A" } });
    mocks.assess.mockReturnValue({ version: "quality/v1", decision: "review_required", score: 90, findings: [], canCreatePrivateDraft: true, canEnterCalendar: false, canDeliver: false });
    const response = await previewPost(new NextRequest("https://example.test/api/saga/authoring-preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contentType: "social_post", channels: ["linkedin"], topic: "System som frigör tid", brief: "En konkret tanke.",
        voice: "Rak svenska.", targetLength: "medium", templateInstructions: "", desiredCallToAction: "", avoid: "", imageDirection: "Dokumentärt.", language: "sv",
        selectedKnowledgeEntryIds: [knowledgeId],
      }),
    }));
    expect(response.status).toBe(200);
    expect(mocks.resolveKnowledge).toHaveBeenCalledWith(actor, [knowledgeId]);
    await expect(response.json()).resolves.toMatchObject({ saved: false, noPublication: true, selectedKnowledgeEntryIds: [knowledgeId] });
  });
});
