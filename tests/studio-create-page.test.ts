import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  configured: vi.fn(),
  actor: vi.fn(),
  readBrandEntry: vi.fn(),
  appShell: () => null,
  authoringWorkspace: () => null,
}));

vi.mock("@/components/app-shell", () => ({ AppShell: mocks.appShell }));
vi.mock("@/components/saga-authoring-workspace", () => ({ SagaAuthoringWorkspace: mocks.authoringWorkspace }));
vi.mock("@/lib/neon/config", () => ({ isNeonDatabaseConfigured: mocks.configured }));
vi.mock("@/lib/neon/auth-repository", () => ({ getCurrentActor: mocks.actor }));
vi.mock("@/lib/neon/saga-brand-entry-state", () => ({ readSagaBrandEntryState: mocks.readBrandEntry }));

import StudioCreatePage from "@/app/studio/create/page";

const actor = {
  userId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  role: "owner" as const,
  email: null,
  displayName: null,
};

describe("Studio create route", () => {
  beforeEach(() => {
    mocks.configured.mockReset();
    mocks.actor.mockReset();
    mocks.readBrandEntry.mockReset();
    mocks.configured.mockReturnValue(true);
    mocks.actor.mockResolvedValue(actor);
  });

  it("passes a requested brand ID to the actor-scoped server validator", async () => {
    const brandContext = {
      status: "completed" as const,
      brandProfileId: "33333333-3333-4333-8333-333333333333",
      brandName: "Systembyggarna",
    };
    mocks.readBrandEntry.mockResolvedValue(brandContext);

    const page = await StudioCreatePage({
      searchParams: Promise.resolve({ brandProfileId: brandContext.brandProfileId }),
    });

    expect(mocks.readBrandEntry).toHaveBeenCalledWith(actor, brandContext.brandProfileId);
    expect(page.type).toBe(mocks.appShell);
    expect(page.props.children.type).toBe(mocks.authoringWorkspace);
    expect(page.props.children.props.brandContext).toEqual(brandContext);
  });

  it("does not accept repeated query values as an implicit profile choice", async () => {
    const brandContext = {
      status: "selection_required" as const,
      brands: [{ brandProfileId: "33333333-3333-4333-8333-333333333333", brandName: "Systembyggarna" }],
    };
    mocks.readBrandEntry.mockResolvedValue(brandContext);

    const page = await StudioCreatePage({
      searchParams: Promise.resolve({ brandProfileId: ["33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444"] }),
    });

    expect(mocks.readBrandEntry).toHaveBeenCalledWith(actor, null);
    expect(page.props.children.props.brandContext).toEqual(brandContext);
  });
});
