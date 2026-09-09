import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  neonConfigurationResponse: vi.fn(),
  requireNeonActor: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  revoke: vi.fn(),
  rotate: vi.fn(),
  authenticate: vi.fn(),
  read: vi.fn(),
}));

vi.mock("@/lib/neon/http", () => ({
  neonConfigurationResponse: mocks.neonConfigurationResponse,
  requireNeonActor: mocks.requireNeonActor,
}));
vi.mock("@/lib/neon/saga-outgoing-api-repository", () => ({
  listSagaOutgoingApis: mocks.list,
  createSagaOutgoingApi: mocks.create,
  updateSagaOutgoingApi: mocks.update,
  revokeSagaOutgoingApi: mocks.revoke,
  rotateSagaOutgoingApiSecret: mocks.rotate,
  authenticateSagaOutgoingApiSecret: mocks.authenticate,
  readSagaOutgoingContent: mocks.read,
  SagaOutgoingApiAccessError: class SagaOutgoingApiAccessError extends Error {},
  SagaOutgoingApiNotFoundError: class SagaOutgoingApiNotFoundError extends Error {},
  SagaOutgoingApiConflictError: class SagaOutgoingApiConflictError extends Error {},
  SagaOutgoingApiValidationError: class SagaOutgoingApiValidationError extends Error {},
}));

import { GET as list, POST as create } from "@/app/api/saga/outgoing-apis/route";
import { DELETE as revoke, PATCH as update } from "@/app/api/saga/outgoing-apis/[apiId]/route";
import { POST as rotate } from "@/app/api/saga/outgoing-apis/[apiId]/rotate/route";
import { GET as externalRead } from "@/app/api/saga/outgoing-content/route";

const actor = {
  userId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  role: "owner" as const,
  email: null,
  displayName: null,
};
const apiId = "33333333-3333-4333-8333-333333333333";
const context = () => ({ params: Promise.resolve({ apiId }) });
const exportView = {
  id: apiId,
  name: "Publicerat innehåll",
  contentTypes: "all" as const,
  visibility: "published_only" as const,
  keyPrefix: "saga_out_live_AbCdEfGhIjKl",
  status: "active" as const,
  expiresAt: null,
  lastUsedAt: null,
  revision: 1,
  createdAt: "2026-08-26T08:00:00.000Z",
  updatedAt: "2026-08-26T08:00:00.000Z",
};

function jsonRequest(url: string, method: string, body: unknown) {
  return new NextRequest(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.neonConfigurationResponse.mockReturnValue(null);
  mocks.requireNeonActor.mockResolvedValue({ actor });
});

describe("SAGA outgoing API configuration routes", () => {
  it("requires a signed owner before listing configuration", async () => {
    mocks.requireNeonActor.mockResolvedValueOnce({ response: NextResponse.json({ error: "Logga in" }, { status: 401 }) });
    const response = await list();
    expect(response.status).toBe(401);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("lists only safe export views, never a plaintext secret or its hash", async () => {
    mocks.list.mockResolvedValueOnce([exportView]);
    const response = await list();
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toEqual({ exports: [exportView] });
    expect(JSON.stringify(body)).not.toMatch(/secret|hash/i);
  });

  it("rejects client workspace/token selectors before an API is created", async () => {
    const response = await create(jsonRequest("http://localhost/api/saga/outgoing-apis", "POST", {
      name: "Felaktig utgåva",
      contentTypes: "all",
      visibility: "published_only",
      workspaceId: "other-workspace",
      secret: "must-not-be-accepted",
    }));
    expect(response.status).toBe(422);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("returns a plaintext secret once at creation but never a hash", async () => {
    mocks.create.mockResolvedValueOnce({ export: exportView, secret: "saga_out_live_AbCdEfGhIjKl_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
    const response = await create(jsonRequest("http://localhost/api/saga/outgoing-apis", "POST", {
      name: "Publicerat innehåll",
      contentTypes: "all",
      visibility: "published_only",
    }));
    const body = await response.json() as { secret: string; endpoint: string; export: typeof exportView };
    expect(response.status).toBe(201);
    expect(body.secret).toMatch(/^saga_out_live_/);
    expect(body.endpoint).toBe("/api/saga/outgoing-content");
    expect(JSON.stringify(body)).not.toContain("secret_hash");
    expect(mocks.create).toHaveBeenCalledWith(actor, expect.objectContaining({ contentTypes: "all" }));
  });

  it("requires expectedRevision for an update and scopes revoke to actor-owned API id", async () => {
    const invalid = await update(jsonRequest(`http://localhost/api/saga/outgoing-apis/${apiId}`, "PATCH", {
      visibility: "publication_ready",
    }), context());
    expect(invalid.status).toBe(422);
    expect(mocks.update).not.toHaveBeenCalled();

    mocks.revoke.mockResolvedValueOnce({ ...exportView, status: "revoked" });
    const response = await revoke(new NextRequest(`http://localhost/api/saga/outgoing-apis/${apiId}`, { method: "DELETE" }), context());
    expect(response.status).toBe(200);
    expect(mocks.revoke).toHaveBeenCalledWith(actor, apiId);
  });

  it("returns another plaintext secret only at rotation", async () => {
    mocks.rotate.mockResolvedValueOnce({ export: { ...exportView, revision: 2 }, secret: "saga_out_live_ZyXwVuTsRqPo_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" });
    const response = await rotate(new NextRequest(`http://localhost/api/saga/outgoing-apis/${apiId}/rotate`, { method: "POST" }), context());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ secret: expect.stringMatching(/^saga_out_live_/), endpoint: "/api/saga/outgoing-content" });
  });
});

describe("SAGA external outgoing content route", () => {
  it("requires Authorization Bearer and rejects any URL-token attempt", async () => {
    const queryToken = await externalRead(new NextRequest("http://localhost/api/saga/outgoing-content?token=saga_out_live_secret"));
    expect(queryToken.status).toBe(400);
    expect(mocks.authenticate).not.toHaveBeenCalled();

    const missing = await externalRead(new NextRequest("http://localhost/api/saga/outgoing-content"));
    expect(missing.status).toBe(401);
    expect(mocks.authenticate).not.toHaveBeenCalled();
  });

  it("uses a token-authenticated, bounded no-store response without CORS", async () => {
    mocks.authenticate.mockResolvedValueOnce({
      apiId,
      workspaceId: actor.workspaceId,
      contentTypes: ["article"],
      visibility: "published_only",
      revision: 1,
      secretHash: "a".repeat(64),
    });
    mocks.read.mockResolvedValueOnce({ version: "v1", generatedAt: "2026-08-26T09:00:00.000Z", items: [], nextCursor: null, hasMore: false });
    const response = await externalRead(new NextRequest("http://localhost/api/saga/outgoing-content?limit=10", {
      headers: { authorization: "Bearer saga_out_live_AbCdEfGhIjKl_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("vary")).toBe("Authorization");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(mocks.read).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: actor.workspaceId }), {
      cursor: null,
      limit: 10,
    });
  });

  it("rejects malformed cursor and an out-of-range limit without calling the content reader", async () => {
    mocks.authenticate.mockResolvedValue({
      apiId,
      workspaceId: actor.workspaceId,
      contentTypes: ["article"],
      visibility: "published_only",
      revision: 1,
      secretHash: "a".repeat(64),
    });
    const headers = { authorization: "Bearer saga_out_live_AbCdEfGhIjKl_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
    const badLimit = await externalRead(new NextRequest("http://localhost/api/saga/outgoing-content?limit=11", { headers }));
    const badCursor = await externalRead(new NextRequest("http://localhost/api/saga/outgoing-content?cursor=not-a-cursor", { headers }));
    expect(badLimit.status).toBe(400);
    expect(badCursor.status).toBe(400);
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("does not disclose whether a revoked key ever existed", async () => {
    mocks.authenticate.mockResolvedValueOnce(null);
    const response = await externalRead(new NextRequest("http://localhost/api/saga/outgoing-content", {
      headers: { authorization: "Bearer saga_out_live_AbCdEfGhIjKl_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Otillåten API-hemlighet." });
  });
});
