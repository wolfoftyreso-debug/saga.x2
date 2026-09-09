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
  getSagaEditorialLens: vi.fn(),
  upsertSagaEditorialLens: vi.fn(),
  deleteSagaEditorialLens: vi.fn(),
  SagaEditorialLensAccessError: class SagaEditorialLensAccessError extends Error {},
  SagaEditorialLensReferenceError: class SagaEditorialLensReferenceError extends Error {},
  SagaEditorialLensConflictError: class SagaEditorialLensConflictError extends Error {},
  brandEligibility: vi.fn(),
}));

vi.mock("@/lib/neon/http", () => ({ requireNeonActor: mocks.requireNeonActor }));
vi.mock("@/lib/neon/saga-editorial-lens-repository", () => ({
  getSagaEditorialLens: mocks.getSagaEditorialLens,
  upsertSagaEditorialLens: mocks.upsertSagaEditorialLens,
  deleteSagaEditorialLens: mocks.deleteSagaEditorialLens,
  SagaEditorialLensAccessError: mocks.SagaEditorialLensAccessError,
  SagaEditorialLensReferenceError: mocks.SagaEditorialLensReferenceError,
  SagaEditorialLensConflictError: mocks.SagaEditorialLensConflictError,
}));
vi.mock("@/lib/neon/saga-brand-onboarding-repository", () => ({
  listSagaBrandOnboardingOverviews: async () => (await mocks.brandEligibility()).brands.map((brand: { brandProfileId: string; brandName: string }) => ({ ...brand, completionState: "completed", brandActive: true })),
}));

import { DELETE, GET, PUT } from "@/app/api/content-engine/editorial-lens/route";

const originalDatabaseUrl = process.env.DATABASE_URL;

beforeEach(() => {
  process.env.DATABASE_URL = "postgresql://user:secret@ep-example.neon.tech/neondb?sslmode=require";
  mocks.requireNeonActor.mockReset();
  mocks.getSagaEditorialLens.mockReset();
  mocks.upsertSagaEditorialLens.mockReset();
  mocks.deleteSagaEditorialLens.mockReset();
  mocks.brandEligibility.mockReset();
  mocks.requireNeonActor.mockResolvedValue({ actor });
  mocks.brandEligibility.mockResolvedValue({ status: "single", brands: [{ brandProfileId: "33333333-3333-4333-8333-333333333333", brandName: "SAGA" }] });
});

afterEach(() => {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  vi.clearAllMocks();
});

describe.sequential("SAGA Editorial Lens route", () => {
  it("fails closed before auth when Vercel Neon has no configured connection", async () => {
    delete process.env.DATABASE_URL;

    const response = await GET();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: "configuration_required", missing: ["DATABASE_URL"] });
    expect(mocks.requireNeonActor).not.toHaveBeenCalled();
  });

  it("reads only the signed actor workspace doctrine with no cache", async () => {
    mocks.getSagaEditorialLens.mockResolvedValue(null);

    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ data: null });
    expect(mocks.getSagaEditorialLens).toHaveBeenCalledWith({ ...actor, brandProfileId: "33333333-3333-4333-8333-333333333333" });
  });

  it("keeps the one-brand legacy response intact", async () => {
    mocks.brandEligibility.mockResolvedValue({
      status: "single",
      brands: [{ brandProfileId: "33333333-3333-4333-8333-333333333333", brandName: "SAGA" }],
    });
    mocks.getSagaEditorialLens.mockResolvedValue(null);

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: null });
    expect(mocks.getSagaEditorialLens).toHaveBeenCalledWith({ ...actor, brandProfileId: "33333333-3333-4333-8333-333333333333" });
  });

  it("requires an explicit brand selection before returning or changing shared Lens data", async () => {
    mocks.brandEligibility.mockResolvedValue({
      status: "multiple",
      brands: [
        { brandProfileId: "33333333-3333-4333-8333-333333333333", brandName: "Första" },
        { brandProfileId: "44444444-4444-4444-8444-444444444444", brandName: "Andra" },
      ],
    });

    const response = await GET();
    const saveResponse = await PUT(new NextRequest("https://brief.example/api/content-engine/editorial-lens", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{}",
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Välj vilket varumärke innehållet tillhör.",
      code: "brand_selection_required",
    });
    expect(saveResponse.status).toBe(409);
    await expect(saveResponse.json()).resolves.toEqual({
      error: "Välj vilket varumärke innehållet tillhör.",
      code: "brand_selection_required",
    });
    expect(mocks.getSagaEditorialLens).not.toHaveBeenCalled();
    expect(mocks.upsertSagaEditorialLens).not.toHaveBeenCalled();
  });

  it("rejects a caller-supplied workspace field at any nesting level before saving", async () => {
    const response = await PUT(new NextRequest("https://brief.example/api/content-engine/editorial-lens", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mission: "Inte tillåtet", tone: { workspaceId: actor.workspaceId } }),
    }));

    expect(response.status).toBe(422);
    expect(mocks.upsertSagaEditorialLens).not.toHaveBeenCalled();
  });

  it("saves a complete typed doctrine with the workspace derived from the signed actor", async () => {
    const body = {
      name: "SAGA Editorial Lens",
      mission: "Gör bilservice begriplig.",
      strategicPerspective: "Bygg förtroende före räckvidd.",
      industry: "Bilservice",
      audience: "Bilägare i Borås.",
      themes: ["Trygg service"],
      forbiddenThemes: [],
      tone: {},
      construction: {},
      evidenceThreshold: "one_primary_or_two_independent",
      sourceRules: {},
      sourceSelections: [],
      controlMode: "review_required",
      active: true,
    };
    mocks.upsertSagaEditorialLens.mockResolvedValue({ id: "33333333-3333-4333-8333-333333333333", ...body });

    const response = await PUT(new NextRequest("https://brief.example/api/content-engine/editorial-lens", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }));

    expect(response.status).toBe(200);
    expect(mocks.upsertSagaEditorialLens).toHaveBeenCalledWith({ ...actor, brandProfileId: "33333333-3333-4333-8333-333333333333" }, expect.objectContaining({ mission: body.mission }));
    expect(mocks.upsertSagaEditorialLens.mock.calls[0]?.[1]).not.toHaveProperty("workspaceId");
  });

  it("deletes only via the signed actor workspace boundary", async () => {
    mocks.deleteSagaEditorialLens.mockResolvedValue(true);

    const response = await DELETE();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ deleted: true });
    expect(mocks.deleteSagaEditorialLens).toHaveBeenCalledWith({ ...actor, brandProfileId: "33333333-3333-4333-8333-333333333333" });
  });
});
