import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@/lib/neon/auth-repository";

const mocks = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock("@/lib/neon/saga-brand-onboarding-repository", () => ({
  listSagaBrandOnboardingOverviews: mocks.list,
}));

import { readSagaBrandApiEligibility } from "@/lib/neon/saga-brand-api-eligibility";

const actor: AppActor = {
  userId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  role: "owner",
  email: null,
  displayName: null,
};

describe("SAGA shared brand API eligibility", () => {
  beforeEach(() => mocks.list.mockReset());

  it("reports zero, one, or multiple active completed brands from the signed actor workspace only", async () => {
    mocks.list.mockResolvedValueOnce([
      { completionState: "in_progress", brandActive: true, brandProfileId: "33333333-3333-4333-8333-333333333333", brandName: "Pågående" },
      { completionState: "completed", brandActive: false, brandProfileId: "44444444-4444-4444-8444-444444444444", brandName: "Vilande" },
    ]);
    await expect(readSagaBrandApiEligibility(actor)).resolves.toEqual({ status: "zero", brands: [] });

    mocks.list.mockResolvedValueOnce([
      { completionState: "completed", brandActive: true, brandProfileId: "55555555-5555-4555-8555-555555555555", brandName: "SAGA" },
    ]);
    await expect(readSagaBrandApiEligibility(actor)).resolves.toEqual({
      status: "single",
      brands: [{ brandProfileId: "55555555-5555-4555-8555-555555555555", brandName: "SAGA" }],
    });

    mocks.list.mockResolvedValueOnce([
      { completionState: "completed", brandActive: true, brandProfileId: "66666666-6666-4666-8666-666666666666", brandName: "Första" },
      { completionState: "completed", brandActive: true, brandProfileId: "77777777-7777-4777-8777-777777777777", brandName: "Andra" },
    ]);
    await expect(readSagaBrandApiEligibility(actor)).resolves.toEqual({
      status: "multiple",
      brands: [
        { brandProfileId: "66666666-6666-4666-8666-666666666666", brandName: "Första" },
        { brandProfileId: "77777777-7777-4777-8777-777777777777", brandName: "Andra" },
      ],
    });

    expect(mocks.list).toHaveBeenNthCalledWith(1, actor);
    expect(mocks.list).toHaveBeenNthCalledWith(2, actor);
    expect(mocks.list).toHaveBeenNthCalledWith(3, actor);
  });
});
