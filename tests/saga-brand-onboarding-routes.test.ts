import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  neonConfigurationResponse: vi.fn(),
  requireNeonActor: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  get: vi.fn(),
  update: vi.fn(),
  generateAdvice: vi.fn(),
}));

vi.mock("@/lib/neon/http", () => ({
  neonConfigurationResponse: mocks.neonConfigurationResponse,
  requireNeonActor: mocks.requireNeonActor,
}));
vi.mock("@/lib/neon/saga-brand-onboarding-repository", () => ({
  listSagaBrandOnboardingOverviews: mocks.list,
  createSagaBrandOnboarding: mocks.create,
  getSagaBrandOnboarding: mocks.get,
  updateSagaBrandOnboarding: mocks.update,
  SagaBrandOnboardingAccessError: class SagaBrandOnboardingAccessError extends Error {},
  SagaBrandOnboardingNotFoundError: class SagaBrandOnboardingNotFoundError extends Error {},
  SagaBrandOnboardingConflictError: class SagaBrandOnboardingConflictError extends Error {},
  SagaBrandOnboardingValidationError: class SagaBrandOnboardingValidationError extends Error {},
}));
vi.mock("@/lib/services/saga-brand-onboarding-advice", () => ({
  generateSagaBrandOnboardingAdvice: mocks.generateAdvice,
  SagaBrandOnboardingAdviceError: class SagaBrandOnboardingAdviceError extends Error {},
}));

import { GET as overview, POST as create } from "@/app/api/saga/brand-onboarding/route";
import { GET as readOne, PATCH as update } from "@/app/api/saga/brand-onboarding/[brandProfileId]/route";
import { POST as advice } from "@/app/api/saga/brand-onboarding/advice/route";

const actor = {
  userId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  role: "owner" as const,
  email: null,
  displayName: null,
};
const brandProfileId = "33333333-3333-4333-8333-333333333333";

const base = {
  completionState: "completed",
  makeDefaultOnCompletion: true,
  brand: {
    slug: "systembyggarna",
    name: "Systembyggarna",
    organizationName: "Systembyggarna AB",
    summary: "System som frigör tid för mänskligt omdöme och arbete med verklig mening.",
    defaultLanguage: "sv",
    voice: { positioning: "Frigör tid", audience: "Byggare", toneTraits: ["rak"], vocabulary: [], avoidPhrases: [], writingSamples: [] },
    profileConfig: {},
  },
  annualPlan: {
    planYear: 2026,
    primaryObjective: "awareness",
    objectiveStatement: "Göra systembyggande begripligt för fler som vill frigöra tid.",
    objectives: [{ id: "kannedom", kind: "awareness", statement: "Öka igenkänning för tanken att system ska frigöra mänsklig tid.", measurement: { metric: "relevant räckvidd", unit: "count", baseline: null, target: null, provenance: "unknown" } }],
    audience: { description: "Människor som bygger verksamheter och vill automatisera repetitiva arbetsuppgifter.", geography: "Sverige", sizeEvidence: "unknown" },
    marketContext: { productReadiness: "early", demandEvidence: "hypothesis", historicalPerformance: "none", conversionMeasurement: "none", competitiveContext: "unknown", timingConfidence: "unknown" },
    channels: ["organic_social", "website"],
    activity: { alwaysOn: true, campaignBurstsPerYear: 2, contentPiecesPerMonth: 4, reviewCadence: "monthly", seasonalWindows: [] },
    budget: { currency: "SEK", status: "provisional", annualBudgetMinor: 1_000_000, fixedCommitmentsMinor: 0, allocationIntent: "learning_first" },
  },
};

function request(method: string, body: unknown) {
  return new NextRequest("http://localhost/api/saga/brand-onboarding", {
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

describe("SAGA Brand Onboarding routes", () => {
  it("fails closed before any brand lookup when Neon is unavailable", async () => {
    mocks.neonConfigurationResponse.mockReturnValueOnce(NextResponse.json({ code: "configuration_required" }, { status: 503 }));
    const response = await overview();
    expect(response.status).toBe(503);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("creates a brand only from a complete idempotent onboarding document", async () => {
    mocks.create.mockResolvedValueOnce({ onboarding: { id: "onboarding", brandProfileId, revision: 1 }, reused: false });
    const response = await create(request("POST", { ...base, createIdempotencyKey: "44444444-4444-4444-8444-444444444444" }));
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({ onboarding: { id: "onboarding", brandProfileId, revision: 1 }, reused: false });
    expect(mocks.create).toHaveBeenCalledWith(actor, expect.objectContaining({ createIdempotencyKey: "44444444-4444-4444-8444-444444444444" }));
  });

  it("rejects a client-controlled workspace/profile activation selector before persistence", async () => {
    const response = await create(request("POST", { ...base, createIdempotencyKey: "44444444-4444-4444-8444-444444444444", workspaceId: actor.workspaceId, active: true }));
    expect(response.status).toBe(422);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("requires the current revision for a full plan replacement", async () => {
    const response = await update(request("PATCH", base), { params: Promise.resolve({ brandProfileId }) });
    expect(response.status).toBe(422);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("returns a full actor-owned onboarding only from the opaque route parameter", async () => {
    mocks.get.mockResolvedValueOnce({ id: "onboarding", brandProfileId, revision: 1 });
    const response = await readOne(new NextRequest("http://localhost/api/saga/brand-onboarding/brand", { method: "GET" }), { params: Promise.resolve({ brandProfileId }) });
    expect(response.status).toBe(200);
    expect(mocks.get).toHaveBeenCalledWith(actor, brandProfileId);
  });

  it("keeps AI advice transient and never routes it through the save method", async () => {
    mocks.generateAdvice.mockResolvedValueOnce({ saved: false, summary: "Ställ en fråga innan ni skalar.", suppliedFacts: [], assumptions: [], unknowns: [], recommendations: [], questions: [] });
    const response = await advice(request("POST", { draft: base }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ saved: false, advice: { saved: false } });
    expect(mocks.generateAdvice).toHaveBeenCalledWith({ draft: expect.objectContaining({ completionState: "completed" }) });
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
