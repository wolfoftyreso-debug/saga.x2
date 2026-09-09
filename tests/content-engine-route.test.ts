import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const actor = {
  userId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  role: "owner" as const,
  email: "owner@example.com",
  displayName: "Owner",
};

const mocks = vi.hoisted(() => ({
  requireNeonActor: vi.fn(),
  readContentEngineWorkspace: vi.fn(),
  upsertContentEngineEntity: vi.fn(),
  patchContentEngineEntity: vi.fn(),
  deleteContentEngineEntity: vi.fn(),
  ContentEngineAccessError: class ContentEngineAccessError extends Error {},
  ContentEngineNotFoundError: class ContentEngineNotFoundError extends Error {},
  ContentEngineReferenceError: class ContentEngineReferenceError extends Error {},
  ContentEngineConflictError: class ContentEngineConflictError extends Error {},
}));

vi.mock("@/lib/neon/http", () => ({ requireNeonActor: mocks.requireNeonActor }));
vi.mock("@/lib/neon/content-engine-repository", () => ({
  readContentEngineWorkspace: mocks.readContentEngineWorkspace,
  upsertContentEngineEntity: mocks.upsertContentEngineEntity,
  patchContentEngineEntity: mocks.patchContentEngineEntity,
  deleteContentEngineEntity: mocks.deleteContentEngineEntity,
  ContentEngineAccessError: mocks.ContentEngineAccessError,
  ContentEngineNotFoundError: mocks.ContentEngineNotFoundError,
  ContentEngineReferenceError: mocks.ContentEngineReferenceError,
  ContentEngineConflictError: mocks.ContentEngineConflictError,
}));

import { GET, POST } from "@/app/api/content-engine/route";

const originalDatabaseUrl = process.env.DATABASE_URL;

beforeEach(() => {
  process.env.DATABASE_URL = "postgresql://user:secret@ep-example.neon.tech/neondb?sslmode=require";
  mocks.requireNeonActor.mockReset();
  mocks.readContentEngineWorkspace.mockReset();
  mocks.upsertContentEngineEntity.mockReset();
  mocks.patchContentEngineEntity.mockReset();
  mocks.deleteContentEngineEntity.mockReset();
  mocks.requireNeonActor.mockResolvedValue({ actor });
});

afterEach(() => {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  vi.clearAllMocks();
});

describe.sequential("Content Engine route", () => {
  it("fails closed before auth or database work when the Vercel Neon connection is absent", async () => {
    delete process.env.DATABASE_URL;

    const response = await GET();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: "configuration_required", missing: ["DATABASE_URL"] });
    expect(mocks.requireNeonActor).not.toHaveBeenCalled();
    expect(mocks.readContentEngineWorkspace).not.toHaveBeenCalled();
  });

  it("returns only the authenticated actor workspace aggregate with no cache", async () => {
    mocks.readContentEngineWorkspace.mockResolvedValue({
      brandProfiles: [], sources: [], modelPresets: [], modelPolicies: [], recipes: [], destinations: [], distributionRules: [],
      availableDestinations: { socialConnections: [], newsletterAudiences: [] },
    });

    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({ data: { availableDestinations: { socialConnections: [] } } });
    expect(mocks.readContentEngineWorkspace).toHaveBeenCalledWith(actor);
  });

  it("rejects a caller-supplied workspaceId at any nesting level before invoking a write", async () => {
    const response = await POST(new NextRequest("https://brief.example/api/content-engine", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
    }));

    expect(response.status).toBe(422);
    expect(mocks.upsertContentEngineEntity).not.toHaveBeenCalled();

    const nested = await POST(new NextRequest("https://brief.example/api/content-engine", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entity: "brandProfile", input: { workspaceId: actor.workspaceId } }),
    }));
    expect(nested.status).toBe(422);
    expect(mocks.upsertContentEngineEntity).not.toHaveBeenCalled();
  });

  it("requires every new brand profile to enter through the atomic brand onboarding boundary", async () => {
    const body = {
      entity: "brandProfile",
      input: {
        slug: "min-verkstad",
        name: "Min verkstad",
        organizationName: "Min verkstad AB",
        summary: "Bilservice i Borås.",
        defaultLanguage: "sv",
        voice: {
          positioning: "Trygg bilservice.",
          audience: "Bilägare i Borås.",
          toneTraits: ["rak"],
          vocabulary: [],
          avoidPhrases: [],
          writingSamples: [],
        },
        profileConfig: {},
        active: true,
        isDefault: true,
      },
    };
    const response = await POST(new NextRequest("https://brief.example/api/content-engine", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      code: "brand_onboarding_required",
      path: "/api/saga/brand-onboarding",
    });
    expect(mocks.upsertContentEngineEntity).not.toHaveBeenCalled();
  });
});
