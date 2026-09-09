import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@/lib/neon/auth-repository";

const mocks = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock("@/lib/neon/saga-brand-onboarding-repository", () => ({
  listSagaBrandOnboardingOverviews: mocks.list,
}));

import { readSagaBrandEntryState } from "@/lib/neon/saga-brand-entry-state";

const actor: AppActor = {
  userId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  role: "owner",
  email: null,
  displayName: null,
};

describe("SAGA brand entry state", () => {
  beforeEach(() => mocks.list.mockReset());

  it("admits only an actor-owned onboarding that is both completed and active", async () => {
    mocks.list.mockResolvedValueOnce([
      { completionState: "completed", brandActive: false, brandProfileId: "33333333-3333-4333-8333-333333333333", brandName: "Vilande" },
      { completionState: "in_progress", brandActive: true, brandProfileId: "44444444-4444-4444-8444-444444444444", brandName: "Pågående" },
      { completionState: "completed", brandActive: true, brandProfileId: "55555555-5555-4555-8555-555555555555", brandName: "Klar" },
    ]);

    await expect(readSagaBrandEntryState(actor)).resolves.toEqual({
      status: "completed",
      brandProfileId: "55555555-5555-4555-8555-555555555555",
      brandName: "Klar",
    });
    expect(mocks.list).toHaveBeenCalledWith(actor);
  });

  it("requires a person to select among multiple completed active brands", async () => {
    mocks.list.mockResolvedValueOnce([
      { completionState: "completed", brandActive: true, brandProfileId: "33333333-3333-4333-8333-333333333333", brandName: "Första" },
      { completionState: "completed", brandActive: true, brandProfileId: "44444444-4444-4444-8444-444444444444", brandName: "Andra" },
    ]);

    await expect(readSagaBrandEntryState(actor)).resolves.toEqual({
      status: "selection_required",
      brands: [
        { brandProfileId: "33333333-3333-4333-8333-333333333333", brandName: "Första" },
        { brandProfileId: "44444444-4444-4444-8444-444444444444", brandName: "Andra" },
      ],
    });
  });

  it("accepts a URL choice only when that actor owns an active completed onboarding", async () => {
    mocks.list.mockResolvedValueOnce([
      { completionState: "completed", brandActive: true, brandProfileId: "33333333-3333-4333-8333-333333333333", brandName: "Klar" },
      { completionState: "completed", brandActive: false, brandProfileId: "44444444-4444-4444-8444-444444444444", brandName: "Vilande" },
      { completionState: "in_progress", brandActive: true, brandProfileId: "55555555-5555-4555-8555-555555555555", brandName: "Ej klar" },
    ]);

    await expect(readSagaBrandEntryState(actor, "33333333-3333-4333-8333-333333333333")).resolves.toEqual({
      status: "completed",
      brandProfileId: "33333333-3333-4333-8333-333333333333",
      brandName: "Klar",
    });

    mocks.list.mockResolvedValueOnce([
      { completionState: "completed", brandActive: true, brandProfileId: "33333333-3333-4333-8333-333333333333", brandName: "Klar" },
      { completionState: "completed", brandActive: false, brandProfileId: "44444444-4444-4444-8444-444444444444", brandName: "Vilande" },
    ]);
    await expect(readSagaBrandEntryState(actor, "44444444-4444-4444-8444-444444444444")).resolves.toEqual({
      status: "selection_required",
      brands: [{ brandProfileId: "33333333-3333-4333-8333-333333333333", brandName: "Klar" }],
    });
  });

  it("keeps the entry distinct when no usable onboarding exists or its read fails", async () => {
    mocks.list.mockResolvedValueOnce([{ completionState: "in_progress", brandActive: false }]);
    await expect(readSagaBrandEntryState(actor)).resolves.toEqual({ status: "missing" });

    mocks.list.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(readSagaBrandEntryState(actor)).resolves.toEqual({ status: "unavailable" });
  });
});
