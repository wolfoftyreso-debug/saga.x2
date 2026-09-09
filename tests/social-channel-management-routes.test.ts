import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getAuthenticatedUserId: vi.fn(),
  createAdminClient: vi.fn(() => ({ marker: "admin" })),
  listSocialConnections: vi.fn(),
  disconnectSocialConnection: vi.fn(),
  getSocialProviderAvailability: vi.fn(),
  missingSupabaseServiceConfiguration: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  getAuthenticatedUserId: mocks.getAuthenticatedUserId,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: mocks.createAdminClient,
}));
vi.mock("@/lib/services/social-connections", () => ({
  listSocialConnections: mocks.listSocialConnections,
  disconnectSocialConnection: mocks.disconnectSocialConnection,
}));
vi.mock("@/lib/services/social-config", () => ({
  getSocialProviderAvailability: mocks.getSocialProviderAvailability,
}));
vi.mock("@/lib/supabase/config", () => ({
  MissingSupabaseConfigurationError: class MissingSupabaseConfigurationError extends Error {},
  missingSupabaseServiceConfiguration: mocks.missingSupabaseServiceConfiguration,
}));

import { GET as channelsGet } from "@/app/api/social/channels/route";
import { GET as connectionsGet } from "@/app/api/social/connections/route";
import { DELETE as disconnect } from "@/app/api/social/connections/id/[connectionId]/route";

const connectionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const context = (id = connectionId) => ({ params: Promise.resolve({ connectionId: id }) });

beforeEach(() => {
  mocks.getAuthenticatedUserId.mockReset();
  mocks.createAdminClient.mockClear();
  mocks.listSocialConnections.mockReset();
  mocks.disconnectSocialConnection.mockReset();
  mocks.getSocialProviderAvailability.mockReset();
  mocks.missingSupabaseServiceConfiguration.mockReset();
  mocks.getAuthenticatedUserId.mockResolvedValue("owner-a");
  mocks.missingSupabaseServiceConfiguration.mockReturnValue([]);
  mocks.listSocialConnections.mockResolvedValue([]);
  mocks.getSocialProviderAvailability.mockReturnValue({ configured: true, missing: [] });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("Studio channel-management routes", () => {
  it("returns OAuth starts that land back on the channels page", async () => {
    const channelsResponse = await channelsGet();
    expect(channelsResponse.status).toBe(200);
    await expect(channelsResponse.json()).resolves.toMatchObject({
      channels: expect.arrayContaining([
        expect.objectContaining({
          channel: "linkedin",
          connectUrl: "/api/social/connections/linkedin/connect?returnTo=/studio/channels",
        }),
      ]),
    });

    const connectionsResponse = await connectionsGet();
    expect(connectionsResponse.status).toBe(200);
    await expect(connectionsResponse.json()).resolves.toMatchObject({
      providers: expect.arrayContaining([
        expect.objectContaining({
          provider: "linkedin",
          connectUrl: "/api/social/connections/linkedin/connect?returnTo=/studio/channels",
        }),
      ]),
    });
  });

  it("keeps disconnecting a connected account authenticated and user-scoped", async () => {
    mocks.getAuthenticatedUserId.mockResolvedValueOnce(null);
    expect((await disconnect(new NextRequest("http://localhost/api/social/connections/id/" + connectionId, { method: "DELETE" }), context())).status).toBe(401);
    expect(mocks.disconnectSocialConnection).not.toHaveBeenCalled();

    mocks.getAuthenticatedUserId.mockResolvedValueOnce("owner-a");
    mocks.disconnectSocialConnection.mockResolvedValueOnce(true);
    const response = await disconnect(new NextRequest("http://localhost/api/social/connections/id/" + connectionId, { method: "DELETE" }), context());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(mocks.disconnectSocialConnection).toHaveBeenCalledWith({ marker: "admin" }, "owner-a", connectionId);
  });

  it("rejects malformed account IDs before invoking an authenticated disconnect", async () => {
    const response = await disconnect(new NextRequest("http://localhost/api/social/connections/id/nope", { method: "DELETE" }), context("nope"));
    expect(response.status).toBe(400);
    expect(mocks.getAuthenticatedUserId).not.toHaveBeenCalled();
    expect(mocks.disconnectSocialConnection).not.toHaveBeenCalled();
  });
});
