import { beforeEach, describe, expect, it, vi } from "vitest";
const actor = { userId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222", role: "owner" as const, email: null, displayName: "Owner" };
const brandA = "33333333-3333-4333-8333-333333333333";
const brandB = "44444444-4444-4444-8444-444444444444";
const mocks = vi.hoisted(() => ({ configuration: vi.fn(), requireActor: vi.fn(), list: vi.fn() }));
vi.mock("@/lib/neon/http", () => ({ neonConfigurationResponse: mocks.configuration, requireNeonActor: mocks.requireActor }));
vi.mock("@/lib/neon/saga-brand-onboarding-repository", () => ({ listSagaBrandOnboardingOverviews: mocks.list }));
import { requireSagaAdobeAuthoringActor } from "@/lib/services/saga-adobe-authoring-http";
import { readSagaBrandEntryState } from "@/lib/neon/saga-brand-entry-state";

describe("SAGA authoring entry and API brand scope", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.configuration.mockReturnValue(null);
    mocks.requireActor.mockResolvedValue({ actor });
    mocks.list.mockResolvedValue([]);
  });
  const brand = (id: string) => ({ brandProfileId: id, brandName: id, completionState: "completed", brandActive: true });
  it("blocks direct API access when onboarding is absent or incomplete, matching the UI", async () => {
    mocks.list.mockResolvedValue([{ ...brand(brandA), completionState: "in_progress" }]);
    expect(await readSagaBrandEntryState(actor)).toEqual({ status: "missing" });
    const resolved = await requireSagaAdobeAuthoringActor("Logga in.");
    expect(resolved.response?.status).toBe(409);
    expect(await resolved.response?.json()).toMatchObject({ code: "brand_onboarding_required" });
  });
  it("opens both UI and real API for an explicitly selected tenant-owned brand among two", async () => {
    mocks.list.mockResolvedValue([brand(brandA), brand(brandB)]);
    expect(await readSagaBrandEntryState(actor, brandB)).toMatchObject({ status: "completed", brandProfileId: brandB });
    const resolved = await requireSagaAdobeAuthoringActor("Logga in.", new Request(`https://test.invalid/api/saga/authoring-runs?brandProfileId=${brandB}`));
    expect(resolved).toEqual({ actor: { ...actor, brandProfileId: brandB } });
  });
  it("requires a choice for multiple brands and never substitutes an invalid explicit choice", async () => {
    mocks.list.mockResolvedValue([brand(brandA), brand(brandB)]);
    expect((await requireSagaAdobeAuthoringActor("Logga in.")).response?.status).toBe(409);
    mocks.list.mockResolvedValue([brand(brandA)]);
    const result = await requireSagaAdobeAuthoringActor("Logga in.", new Request(`https://test.invalid/api/saga/authoring-runs?brandProfileId=${brandB}`));
    expect(result.response?.status).toBe(404);
    expect(await result.response?.json()).toMatchObject({ code: "brand_not_found" });
  });
  it("resolves one complete active brand and fails closed when its repository is unavailable", async () => {
    mocks.list.mockResolvedValue([brand(brandA)]);
    expect(await requireSagaAdobeAuthoringActor("Logga in.")).toEqual({ actor: { ...actor, brandProfileId: brandA } });
    mocks.list.mockRejectedValue(new Error("private database failure"));
    const result = await requireSagaAdobeAuthoringActor("Logga in.");
    expect(result.response?.status).toBe(503);
    expect(await result.response?.text()).not.toContain("private database failure");
  });
});
