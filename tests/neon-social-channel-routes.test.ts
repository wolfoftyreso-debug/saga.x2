import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const actor = {
  userId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  role: "owner" as const,
  email: "owner@example.com",
  displayName: "Owner",
};
const connectionId = "33333333-3333-4333-8333-333333333333";

const mocks = vi.hoisted(() => ({
  requireNeonActor: vi.fn(),
  listNeonSocialConnections: vi.fn(),
  disconnectNeonSocialConnection: vi.fn(),
  NeonSocialConnectionAccessError: class NeonSocialConnectionAccessError extends Error {},
}));

vi.mock("@/lib/neon/http", () => ({
  requireNeonActor: mocks.requireNeonActor,
}));
vi.mock("@/lib/neon/social-connections-repository", () => ({
  listNeonSocialConnections: mocks.listNeonSocialConnections,
  disconnectNeonSocialConnection: mocks.disconnectNeonSocialConnection,
  NeonSocialConnectionAccessError: mocks.NeonSocialConnectionAccessError,
}));

import { GET as channelsGet } from "@/app/api/social/channels/route";
import { GET as connectionsGet } from "@/app/api/social/connections/route";
import { GET as connectGet } from "@/app/api/social/connections/[provider]/connect/route";
import { DELETE as disconnect } from "@/app/api/social/connections/id/[connectionId]/route";

const ENV_KEYS = [
  "DATABASE_URL",
  "SOCIAL_TOKEN_ENCRYPTION_KEY",
  "SOCIAL_OAUTH_BASE_URL",
  "META_APP_ID",
  "META_APP_SECRET",
  "LINKEDIN_CLIENT_ID",
  "LINKEDIN_CLIENT_SECRET",
] as const;
const originalEnvironment = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function context(provider = "linkedin") {
  return { params: Promise.resolve({ provider }) };
}

function deleteContext(id = connectionId) {
  return { params: Promise.resolve({ connectionId: id }) };
}

beforeEach(() => {
  process.env.DATABASE_URL = "postgresql://user:secret@ep-example.neon.tech/neondb?sslmode=require";
  process.env.SOCIAL_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.SOCIAL_OAUTH_BASE_URL = "https://brief.example";
  process.env.META_APP_ID = "meta-app";
  process.env.META_APP_SECRET = "meta-secret";
  process.env.LINKEDIN_CLIENT_ID = "linkedin-app";
  process.env.LINKEDIN_CLIENT_SECRET = "linkedin-secret";
  mocks.requireNeonActor.mockReset();
  mocks.listNeonSocialConnections.mockReset();
  mocks.disconnectNeonSocialConnection.mockReset();
  mocks.requireNeonActor.mockResolvedValue({ actor });
  mocks.listNeonSocialConnections.mockResolvedValue([{
    id: connectionId,
    provider: "linkedin",
    providerAccountId: "urn:li:person:abc",
    accountLabel: "Ada Lovelace",
    accountHandle: null,
    state: "active",
    scopes: ["w_member_social"],
    tokenExpiresAt: null,
    lastVerifiedAt: "2026-08-23T10:00:00.000Z",
    lastError: null,
    createdAt: "2026-08-23T10:00:00.000Z",
    updatedAt: "2026-08-23T10:00:00.000Z",
  }]);
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.clearAllMocks();
});

describe.sequential("Neon social channel routes", () => {
  it("returns actual OAuth starts only for configured providers and never calls Supabase", async () => {
    const response = await channelsGet();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      publicationAvailable: false,
      channels: expect.arrayContaining([
        expect.objectContaining({
          channel: "linkedin",
          configured: true,
          connectUrl: "/api/social/connections/linkedin/connect?returnTo=/studio/channels",
          canPublish: false,
        }),
      ]),
    });
    expect(mocks.listNeonSocialConnections).toHaveBeenCalledWith(actor);
  });

  it("starts provider OAuth with a Vercel actor and workspace-bound transaction", async () => {
    const response = await connectGet(
      new NextRequest("https://brief.example/api/social/connections/linkedin/connect?returnTo=/studio/channels"),
      context(),
    );

    expect(response.status).toBe(307);
    const authorizationUrl = new URL(response.headers.get("location") ?? "");
    expect(authorizationUrl.origin).toBe("https://www.linkedin.com");
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe("https://brief.example/api/social/connections/linkedin/callback");
    expect(authorizationUrl.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(response.cookies.get("pdb_social_oauth_linkedin")?.value).not.toContain(actor.workspaceId);
  });

  it("returns configuration_required instead of a fake connect redirect", async () => {
    delete process.env.LINKEDIN_CLIENT_SECRET;

    const response = await connectGet(
      new NextRequest("https://brief.example/api/social/connections/linkedin/connect?returnTo=/studio/channels"),
      context(),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "configuration_required",
      provider: "linkedin",
      missing: expect.arrayContaining(["LINKEDIN_CLIENT_SECRET"]),
    });
  });

  it("reads and deletes connections through the Vercel actor workspace", async () => {
    const read = await connectionsGet();
    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toMatchObject({
      publicationAvailable: false,
      connections: [expect.objectContaining({ id: connectionId, provider: "linkedin" })],
    });

    mocks.disconnectNeonSocialConnection.mockResolvedValueOnce(true);
    const removed = await disconnect(
      new NextRequest(`https://brief.example/api/social/connections/id/${connectionId}`, { method: "DELETE" }),
      deleteContext(),
    );
    expect(removed.status).toBe(200);
    expect(mocks.disconnectNeonSocialConnection).toHaveBeenCalledWith(actor, connectionId);
  });
});
