import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class ServiceError extends Error {
    constructor(message: string, readonly status = 500, readonly code = "unknown") { super(message); }
  }
  class PipelineError extends Error {
    constructor(message: string, readonly status = 500, readonly code = "unknown") { super(message); }
  }
  return {
    ServiceError,
    PipelineError,
    supabase: { configured: vi.fn(), missing: vi.fn(), admin: vi.fn(), userId: vi.fn() },
    pipeline: { configuration: vi.fn(), overview: vi.fn() },
  };
});

vi.mock("@/lib/supabase/config", () => ({
  isSupabaseServiceConfigured: mocks.supabase.configured,
  missingSupabaseServiceConfiguration: mocks.supabase.missing,
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.supabase.admin }));
vi.mock("@/lib/supabase/server", () => ({ getAuthenticatedUserId: mocks.supabase.userId }));
vi.mock("@/lib/services/media-engine", () => ({ MediaEngineServiceError: mocks.ServiceError }));
vi.mock("@/lib/services/media-engine-pipeline", () => ({
  MediaEnginePipelineError: mocks.PipelineError,
  getMediaEngineConfiguration: mocks.pipeline.configuration,
  getMediaEngineOverview: mocks.pipeline.overview,
}));

import { resolveMediaEngineConfigRequestContext } from "@/lib/services/media-engine-config-http";
import { resolveMediaEngineRequestContext } from "@/lib/services/media-engine-http";

const database = { marker: "admin" };
const userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const tenantId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const tenant = { id: tenantId, slug: "erik", name: "Erik", timezone: "Europe/Stockholm", role: "owner" };

beforeEach(() => {
  mocks.supabase.configured.mockReset().mockReturnValue(true);
  mocks.supabase.missing.mockReset().mockReturnValue([]);
  mocks.supabase.admin.mockReset().mockReturnValue(database);
  mocks.supabase.userId.mockReset().mockResolvedValue(userId);
  mocks.pipeline.configuration.mockReset().mockReturnValue({ ready: true, missing: [], issues: [] });
  mocks.pipeline.overview.mockReset().mockResolvedValue({
    tenant,
    configuration: { ready: true, missing: [], issues: [] },
    sources: [], rules: [], clusters: [], dossiers: [], handoffs: [], runs: [],
  });
});

afterEach(() => vi.clearAllMocks());

describe("Media Engine request contexts", () => {
  it("returns a recoverable setup response before trying authentication", async () => {
    mocks.supabase.configured.mockReturnValue(false);
    mocks.supabase.missing.mockReturnValue(["SUPABASE_SERVICE_ROLE_KEY"]);

    const config = await resolveMediaEngineConfigRequestContext();
    const runtime = await resolveMediaEngineRequestContext(null);

    expect(config.ok).toBe(false);
    expect(runtime.ok).toBe(false);
    if (!config.ok) expect(config.response.status).toBe(503);
    if (!runtime.ok) expect(runtime.response.status).toBe(503);
    expect(mocks.supabase.userId).not.toHaveBeenCalled();
    expect(mocks.supabase.admin).not.toHaveBeenCalled();
  });

  it("turns an absent or failed session into explicit unauthenticated/unavailable responses", async () => {
    mocks.supabase.userId.mockResolvedValueOnce(null);
    const configAnonymous = await resolveMediaEngineConfigRequestContext();
    expect(configAnonymous.ok).toBe(false);
    if (!configAnonymous.ok) expect(configAnonymous.response.status).toBe(401);
    expect(mocks.supabase.admin).not.toHaveBeenCalled();

    mocks.supabase.userId.mockRejectedValueOnce(new Error("auth unavailable"));
    const runtimeUnavailable = await resolveMediaEngineRequestContext(null);
    expect(runtimeUnavailable.ok).toBe(false);
    if (!runtimeUnavailable.ok) expect(runtimeUnavailable.response.status).toBe(503);
    expect(mocks.supabase.admin).not.toHaveBeenCalled();
  });

  it("rejects malformed tenant ids before using a session or data client", async () => {
    const result = await resolveMediaEngineRequestContext("not-a-uuid");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(400);
    expect(mocks.supabase.userId).not.toHaveBeenCalled();
    expect(mocks.supabase.admin).not.toHaveBeenCalled();
    expect(mocks.pipeline.overview).not.toHaveBeenCalled();
  });

  it("uses the authenticated user and resolved tenant for runtime-only operations", async () => {
    const result = await resolveMediaEngineRequestContext(tenantId);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ userId, database, tenant });
    expect(mocks.pipeline.overview).toHaveBeenCalledWith({ database, userId, tenantId });
  });

  it("distinguishes a missing tenant from a runtime configuration gap", async () => {
    mocks.pipeline.overview.mockResolvedValueOnce({
      tenant: null,
      configuration: { ready: false, missing: [], issues: ["Skapa eller anslut en tenant innan researchmotorn kan köras."] },
      sources: [], rules: [], clusters: [], dossiers: [], handoffs: [], runs: [],
    });
    const absentTenant = await resolveMediaEngineRequestContext(null);
    expect(absentTenant.ok).toBe(false);
    if (!absentTenant.ok) expect(absentTenant.response.status).toBe(422);

    mocks.pipeline.overview.mockResolvedValueOnce({
      tenant: null,
      configuration: { ready: false, missing: ["OPENAI_API_KEY"], issues: ["Lägg till OPENAI_API_KEY och starta om tjänsten."] },
      sources: [], rules: [], clusters: [], dossiers: [], handoffs: [], runs: [],
    });
    const unavailableWorker = await resolveMediaEngineRequestContext(null);
    expect(unavailableWorker.ok).toBe(false);
    if (!unavailableWorker.ok) expect(unavailableWorker.response.status).toBe(503);
  });
});
