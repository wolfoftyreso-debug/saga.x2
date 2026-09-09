import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  configuration: vi.fn(), state: vi.fn(), requireActor: vi.fn(), list: vi.fn(),
  lens: vi.fn(), generate: vi.fn(), vercelOnly: vi.fn(), legacyConfigured: vi.fn(), legacyUser: vi.fn(),
}));
vi.mock("@/lib/neon/http", () => ({ neonConfigurationResponse: mocks.configuration, requireNeonActor: mocks.requireActor }));
vi.mock("@/lib/neon/config", () => ({ getNeonDatabaseConfigurationState: mocks.state }));
vi.mock("@/lib/neon/saga-brand-onboarding-repository", () => ({ listSagaBrandOnboardingOverviews: mocks.list }));
vi.mock("@/lib/neon/saga-editorial-lens-repository", () => ({ getSagaEditorialLensPromptContext: mocks.lens }));
vi.mock("@/lib/runtime/vercel-only", () => ({ isVercelOnlyMode: mocks.vercelOnly }));
vi.mock("@/lib/services/content-generation", () => ({
  generateContentDraft: mocks.generate,
  ContentGenerationError: class extends Error { constructor(message: string, readonly status: number) { super(message); } },
}));
vi.mock("@/lib/supabase/config", () => ({ isSupabasePublicConfigured: mocks.legacyConfigured, MissingSupabaseConfigurationError: class extends Error {} }));
vi.mock("@/lib/supabase/server", () => ({ getAuthenticatedUserId: mocks.legacyUser }));
import { POST } from "@/app/api/content/generate/route";
import { ContentGenerationError } from "@/lib/services/content-generation";

const actor = { userId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222", role: "editor", email: null, displayName: "Editor" };
const brandA = "33333333-3333-4333-8333-333333333333";
const brandB = "44444444-4444-4444-8444-444444444444";
const brand = (id: string) => ({ brandProfileId: id, brandName: id, completionState: "completed", brandActive: true });
function request(selected?: string, body: unknown = { contentType: "social_post", channels: ["linkedin"], topic: "Mänsklig automation" }) {
  return new NextRequest(`https://test.invalid/api/content/generate${selected ? `?brandProfileId=${selected}` : ""}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

describe("manual editor generation brand boundary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.state.mockReturnValue("configured");
    mocks.configuration.mockReturnValue(null);
    mocks.requireActor.mockResolvedValue({ actor });
    mocks.list.mockResolvedValue([brand(brandA)]);
    mocks.lens.mockResolvedValue({ mission: "Only the selected brand's writing frame" });
    mocks.generate.mockResolvedValue({ draft: { title: "Privat förslag" }, model: "test", responseId: "test-response", inputTokens: 1, outputTokens: 2 });
  });

  it("uses the selected owned brand and its server-only Lens in a multibrand workspace", async () => {
    mocks.list.mockResolvedValue([brand(brandA), brand(brandB)]);
    const response = await POST(request(brandB));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.lens).toHaveBeenCalledWith({ ...actor, brandProfileId: brandB });
    expect(mocks.generate).toHaveBeenCalledWith(expect.objectContaining({ topic: "Mänsklig automation" }), {
      editorialLens: { mission: "Only the selected brand's writing frame" },
    });
    await expect(response.json()).resolves.toMatchObject({ draft: { title: "Privat förslag" } });
    expect(mocks.legacyUser).not.toHaveBeenCalled();
  });

  it("requires a choice for multiple brands and completed onboarding for an empty workspace", async () => {
    mocks.list.mockResolvedValue([brand(brandA), brand(brandB)]);
    expect((await POST(request())).status).toBe(409);
    mocks.list.mockResolvedValue([]);
    const missing = await POST(request());
    expect(missing.status).toBe(409);
    await expect(missing.json()).resolves.toMatchObject({ code: "brand_onboarding_required" });
    expect(mocks.lens).not.toHaveBeenCalled();
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it("does not replace a foreign or inactive explicit brand with the eligible default", async () => {
    expect((await POST(request(brandB))).status).toBe(404);
    mocks.list.mockResolvedValue([brand(brandA), { ...brand(brandB), brandActive: false }]);
    expect((await POST(request(brandB))).status).toBe(404);
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it("blocks viewers before brand lookup, Lens lookup or a paid model request", async () => {
    mocks.requireActor.mockResolvedValue({ actor: { ...actor, role: "viewer" } });
    expect((await POST(request(brandA))).status).toBe(403);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.lens).not.toHaveBeenCalled();
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it("propagates an authentication rejection before reading brand data", async () => {
    mocks.requireActor.mockResolvedValue({ response: NextResponse.json({ code: "authentication_required" }, { status: 401 }) });
    expect((await POST(request())).status).toBe(401);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it("fails closed and sanitizes failures in brand and Lens reads", async () => {
    mocks.list.mockRejectedValueOnce(new Error("private database secret"));
    const brandFailure = await POST(request());
    expect(brandFailure.status).toBe(503);
    expect(await brandFailure.text()).not.toContain("private database secret");
    mocks.lens.mockRejectedValueOnce(new Error("private Lens query"));
    const lensFailure = await POST(request());
    expect(lensFailure.status).toBe(503);
    await expect(lensFailure.json()).resolves.toMatchObject({ code: "editorial_lens_unavailable" });
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it("allows a missing optional Lens without borrowing another brand's context", async () => {
    mocks.lens.mockResolvedValue(null);
    expect((await POST(request())).status).toBe(200);
    expect(mocks.lens).toHaveBeenCalledWith({ ...actor, brandProfileId: brandA });
    expect(mocks.generate).toHaveBeenCalledWith(expect.any(Object), { editorialLens: null });
  });

  it("rejects invalid generation input and preserves known provider failure status", async () => {
    expect((await POST(request(undefined, { topic: "" }))).status).toBe(400);
    expect(mocks.generate).not.toHaveBeenCalled();
    mocks.generate.mockRejectedValueOnce(new ContentGenerationError("AI är inte konfigurerad.", 503));
    expect((await POST(request())).status).toBe(503);
  });

  it("never uses legacy credentials when Vercel Neon is absent or a Neon URL is invalid", async () => {
    mocks.legacyConfigured.mockReturnValue(true);
    mocks.configuration.mockReturnValue(NextResponse.json({ code: "configuration_required" }, { status: 503 }));
    mocks.state.mockReturnValue("missing");
    mocks.vercelOnly.mockReturnValue(true);
    expect((await POST(request())).status).toBe(503);
    mocks.vercelOnly.mockReturnValue(false);
    mocks.state.mockReturnValue("invalid");
    expect((await POST(request())).status).toBe(503);
    expect(mocks.legacyUser).not.toHaveBeenCalled();
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it("retains the explicitly allowed non-Vercel legacy path without inventing a Neon brand", async () => {
    mocks.state.mockReturnValue("missing");
    mocks.vercelOnly.mockReturnValue(false);
    mocks.legacyConfigured.mockReturnValue(true);
    mocks.legacyUser.mockResolvedValue("legacy-user");
    expect((await POST(request())).status).toBe(200);
    expect(mocks.requireActor).not.toHaveBeenCalled();
    expect(mocks.lens).not.toHaveBeenCalled();
    expect(mocks.generate).toHaveBeenCalledWith(expect.any(Object), undefined);
  });
});
