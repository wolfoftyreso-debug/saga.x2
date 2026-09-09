import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  resolveContext: vi.fn(),
  createSource: vi.fn(),
  listSources: vi.fn(),
}));

vi.mock("@/lib/services/media-engine-config-http", () => ({
  resolveMediaEngineConfigRequestContext: mocks.resolveContext,
  mediaEngineConfigErrorResponse: (error: unknown) => Response.json({ error: error instanceof Error ? error.message : "fel" }, { status: 500 }),
  noStore: (body: unknown, status = 200) => Response.json(body, { status }),
  readJson: async (request: Request) => {
    try { return await request.json(); } catch { return null; }
  },
}));
vi.mock("@/lib/services/media-engine", () => ({
  createMediaSourceConnection: mocks.createSource,
  listMediaSourceConnections: mocks.listSources,
}));

import { GET, POST } from "@/app/api/media-engine/sources/route";

const tenantId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

afterEach(() => {
  mocks.resolveContext.mockReset();
  mocks.createSource.mockReset();
  mocks.listSources.mockReset();
});

describe("media engine source routes", () => {
  it("requires a tenant id before touching a data client", async () => {
    const response = await GET(new NextRequest("http://localhost/api/media-engine/sources"));
    expect(response.status).toBe(400);
    expect(mocks.resolveContext).not.toHaveBeenCalled();
  });

  it("refuses a raw credential in public connector config", async () => {
    mocks.resolveContext.mockResolvedValue({ ok: true, value: { userId: "user-a", database: {} } });
    const response = await POST(new NextRequest("http://localhost/api/media-engine/sources", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tenantId,
        kind: "api",
        provider: "NewsAPI",
        displayName: "News API",
        baseUrl: "https://example.com/api",
        configPublic: { token: "plain-secret" },
      }),
    }));
    expect(response.status).toBe(400);
    expect(mocks.createSource).not.toHaveBeenCalled();
  });

  it("rejects tenant-controlled credential references", async () => {
    mocks.resolveContext.mockResolvedValue({ ok: true, value: { userId: "user-a", database: {} } });
    const response = await POST(new NextRequest("http://localhost/api/media-engine/sources", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tenantId,
        kind: "api",
        provider: "NewsAPI",
        displayName: "News API",
        baseUrl: "https://example.com/api",
        credentialRef: "MEDIA_ENGINE_API_TOKEN_NEWSAPI",
      }),
    }));
    expect(response.status).toBe(400);
    expect(mocks.createSource).not.toHaveBeenCalled();
  });

  it("creates a public API source without exposing or attaching a credential", async () => {
    mocks.resolveContext.mockResolvedValue({ ok: true, value: { userId: "user-a", database: {} } });
    mocks.createSource.mockResolvedValue({
      id: "source-a", tenantId, kind: "api", provider: "NewsAPI", displayName: "News API",
      baseUrl: "https://example.com/api", configPublic: { queryParameter: "q" },
      active: true, syncIntervalMinutes: 60, lastSyncedAt: null, lastError: null, metadata: {},
      createdAt: "2026-08-23T00:00:00.000Z", updatedAt: "2026-08-23T00:00:00.000Z",
    });
    const response = await POST(new NextRequest("http://localhost/api/media-engine/sources", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tenantId,
        kind: "api",
        provider: "NewsAPI",
        displayName: "News API",
        baseUrl: "https://example.com/api",
        configPublic: { queryParameter: "q" },
      }),
    }));
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ source: { provider: "NewsAPI" } });
    expect(mocks.createSource).toHaveBeenCalledWith({}, "user-a", expect.not.objectContaining({ credentialRef: expect.anything() }));
  });
});
