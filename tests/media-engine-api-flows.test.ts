import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const ids = {
  tenant: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  otherTenant: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  source: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  rule: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  cluster: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  handoff: "ffffffff-ffff-4fff-8fff-ffffffffffff",
  member: "11111111-1111-4111-8111-111111111111",
  idempotency: "22222222-2222-4222-8222-222222222222",
};

const mocks = vi.hoisted(() => ({
  config: {
    resolve: vi.fn(),
    error: vi.fn((error: unknown) => Response.json({ error: error instanceof Error ? error.message : "fel" }, { status: 500 })),
  },
  runtime: {
    resolve: vi.fn(),
    error: vi.fn((error: unknown) => Response.json({ error: error instanceof Error ? error.message : "fel" }, { status: 500 })),
  },
  service: {
    createTenant: vi.fn(), listTenants: vi.fn(), getTenant: vi.fn(), updateTenant: vi.fn(), deleteTenant: vi.fn(),
    listMembers: vi.fn(), upsertMember: vi.fn(), removeMember: vi.fn(),
    createSource: vi.fn(), listSources: vi.fn(), getSource: vi.fn(), updateSource: vi.fn(), deleteSource: vi.fn(),
    createRule: vi.fn(), listRules: vi.fn(), getRule: vi.fn(), updateRule: vi.fn(), deleteRule: vi.fn(), listClusters: vi.fn(),
  },
  pipeline: {
    overview: vi.fn(), check: vi.fn(), research: vi.fn(), updateCluster: vi.fn(), createDraft: vi.fn(), updateHandoff: vi.fn(),
    runDue: vi.fn(), runLimit: vi.fn(), configuration: vi.fn(),
  },
  cron: {
    configured: vi.fn(), missing: vi.fn(), admin: vi.fn(),
  },
}));

function noStore(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

async function readJson(request: Request): Promise<unknown | null> {
  try { return await request.json(); } catch { return null; }
}

vi.mock("@/lib/services/media-engine-config-http", () => ({
  resolveMediaEngineConfigRequestContext: mocks.config.resolve,
  mediaEngineConfigErrorResponse: mocks.config.error,
  noStore,
  readJson,
}));

vi.mock("@/lib/services/media-engine-http", () => ({
  resolveMediaEngineRequestContext: mocks.runtime.resolve,
  mediaEngineErrorResponse: mocks.runtime.error,
  noStore,
  readJson,
}));

vi.mock("@/lib/services/media-engine", () => ({
  createMediaTenant: mocks.service.createTenant,
  listMediaTenants: mocks.service.listTenants,
  getMediaTenantForUser: mocks.service.getTenant,
  updateMediaTenant: mocks.service.updateTenant,
  deleteMediaTenant: mocks.service.deleteTenant,
  listMediaTenantMembers: mocks.service.listMembers,
  upsertMediaTenantMember: mocks.service.upsertMember,
  removeMediaTenantMember: mocks.service.removeMember,
  createMediaSourceConnection: mocks.service.createSource,
  listMediaSourceConnections: mocks.service.listSources,
  getMediaSourceConnectionForUser: mocks.service.getSource,
  updateMediaSourceConnection: mocks.service.updateSource,
  deleteMediaSourceConnection: mocks.service.deleteSource,
  createMediaResearchRule: mocks.service.createRule,
  listMediaResearchRules: mocks.service.listRules,
  getMediaResearchRuleForUser: mocks.service.getRule,
  updateMediaResearchRule: mocks.service.updateRule,
  deleteMediaResearchRule: mocks.service.deleteRule,
  listMediaResearchClusters: mocks.service.listClusters,
}));

vi.mock("@/lib/services/media-engine-pipeline", () => ({
  getMediaEngineOverview: mocks.pipeline.overview,
  runMediaEngineCheck: mocks.pipeline.check,
  researchMediaClusterNow: mocks.pipeline.research,
  updateMediaClusterState: mocks.pipeline.updateCluster,
  createDraftFromMediaHandoff: mocks.pipeline.createDraft,
  updateMediaHandoffState: mocks.pipeline.updateHandoff,
  runDueMediaEngineResearch: mocks.pipeline.runDue,
  getMediaEngineCronRunLimit: mocks.pipeline.runLimit,
  getMediaEngineConfiguration: mocks.pipeline.configuration,
}));

vi.mock("@/lib/supabase/config", () => ({
  isSupabaseServiceConfigured: mocks.cron.configured,
  missingSupabaseServiceConfiguration: mocks.cron.missing,
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.cron.admin }));

import { GET as rootGet } from "@/app/api/media-engine/route";
import { POST as checkPost } from "@/app/api/media-engine/check/route";
import { GET as clustersGet } from "@/app/api/media-engine/clusters/route";
import { GET as clusterGet, PATCH as clusterPatch } from "@/app/api/media-engine/clusters/[id]/route";
import { POST as clusterResearchPost } from "@/app/api/media-engine/clusters/[id]/research/route";
import { PATCH as handoffPatch } from "@/app/api/media-engine/handoffs/[id]/route";
import { POST as handoffDraftPost } from "@/app/api/media-engine/handoffs/[id]/draft/route";
import { POST as rulesPost } from "@/app/api/media-engine/rules/route";
import { GET as ruleGet, PATCH as rulePatch, DELETE as ruleDelete } from "@/app/api/media-engine/rules/[id]/route";
import { GET as runsGet } from "@/app/api/media-engine/runs/route";
import { GET as sourcesGet, POST as sourcesPost } from "@/app/api/media-engine/sources/route";
import { GET as sourceGet, PATCH as sourcePatch, DELETE as sourceDelete } from "@/app/api/media-engine/sources/[id]/route";
import { GET as tenantsGet, POST as tenantsPost } from "@/app/api/media-engine/tenants/route";
import { GET as tenantGet, PATCH as tenantPatch, DELETE as tenantDelete } from "@/app/api/media-engine/tenants/[id]/route";
import { GET as membersGet, PUT as membersPut } from "@/app/api/media-engine/tenants/[id]/members/route";
import { DELETE as memberDelete } from "@/app/api/media-engine/tenants/[id]/members/[memberUserId]/route";
import { GET as cronGet } from "@/app/api/cron/media-engine/route";

const database = { marker: "database" };
const userId = "33333333-3333-4333-8333-333333333333";
const tenant = { id: ids.tenant, slug: "erik", name: "Erik", timezone: "Europe/Stockholm", role: "owner" };
const configContext = { ok: true as const, value: { userId, database } };
const runtimeContext = { ok: true as const, value: { userId, database, tenant } };
const context = (id: string) => ({ params: Promise.resolve({ id }) });
const memberContext = (id: string, memberUserId: string) => ({ params: Promise.resolve({ id, memberUserId }) });
const jsonRequest = (url: string, method: string, body: unknown) => new NextRequest(url, {
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

function overview() {
  return {
    tenant,
    configuration: { ready: true, missing: [], issues: [] },
    sources: [], rules: [], clusters: [], dossiers: [], handoffs: [], runs: [],
  };
}

function runResult(status: "completed" | "already_running" | "failed" = "completed") {
  return {
    status,
    run: { id: "run", state: status === "failed" ? "failed" : "completed" },
    clusters: [], dossiers: [], message: "klart",
  };
}

beforeEach(() => {
  for (const group of Object.values(mocks)) {
    for (const value of Object.values(group)) {
      if (typeof value === "function") value.mockReset();
    }
  }
  mocks.config.resolve.mockResolvedValue(configContext);
  mocks.runtime.resolve.mockResolvedValue(runtimeContext);
  mocks.pipeline.overview.mockResolvedValue(overview());
  mocks.pipeline.check.mockResolvedValue([runResult()]);
  mocks.pipeline.research.mockResolvedValue(runResult());
  mocks.pipeline.updateCluster.mockResolvedValue({ id: ids.cluster, status: "dismissed" });
  mocks.pipeline.updateHandoff.mockResolvedValue({ id: ids.handoff, state: "queued" });
  mocks.pipeline.createDraft.mockResolvedValue({ handoff: { id: ids.handoff, state: "drafted" }, contentDraftId: "draft", message: "inte publicerat" });
  mocks.pipeline.runLimit.mockReturnValue(1);
  mocks.pipeline.configuration.mockReturnValue({ ready: true, missing: [], issues: [] });
  mocks.pipeline.runDue.mockResolvedValue([]);
  mocks.cron.configured.mockReturnValue(true);
  mocks.cron.missing.mockReturnValue([]);
  mocks.cron.admin.mockReturnValue(database);
  mocks.service.listTenants.mockResolvedValue([tenant]);
  mocks.service.listSources.mockResolvedValue([]);
  mocks.service.listRules.mockResolvedValue([]);
  mocks.service.listClusters.mockResolvedValue([]);
  mocks.service.listMembers.mockResolvedValue([]);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Media Engine API error boundaries", () => {
  it("returns the explicit Supabase setup and login responses without touching a configuration service", async () => {
    const setupResponse = noStore({ error: "Researchmotorns arbetsyta är inte ansluten till Supabase ännu." }, 503);
    mocks.config.resolve.mockResolvedValueOnce({ ok: false, response: setupResponse });
    const setup = await tenantsGet();
    expect(setup.status).toBe(503);
    expect(mocks.service.listTenants).not.toHaveBeenCalled();

    const loginResponse = noStore({ error: "Logga in för att hantera researchmotorn." }, 401);
    mocks.config.resolve.mockResolvedValueOnce({ ok: false, response: loginResponse });
    const login = await tenantsPost(jsonRequest("http://localhost/api/media-engine/tenants", "POST", { name: "Erik" }));
    expect(login.status).toBe(401);
    expect(mocks.service.createTenant).not.toHaveBeenCalled();
  });

  it("rejects malformed public requests before resolving an account or database client", async () => {
    const source = await sourcesGet(new NextRequest("http://localhost/api/media-engine/sources"));
    const rule = await ruleGet(new NextRequest("http://localhost/api/media-engine/rules/not-a-uuid?tenantId=nope"), context("not-a-uuid"));
    const cluster = await clusterGet(new NextRequest("http://localhost/api/media-engine/clusters/not-a-uuid"), context("not-a-uuid"));
    const member = await memberDelete(new NextRequest("http://localhost/api/media-engine/tenants/not-a-uuid/members/nope", { method: "DELETE" }), memberContext("not-a-uuid", "nope"));
    expect([source.status, rule.status, cluster.status, member.status]).toEqual([400, 400, 400, 400]);
    expect(mocks.config.resolve).not.toHaveBeenCalled();
    expect(mocks.runtime.resolve).not.toHaveBeenCalled();
  });
});

describe("Media Engine configuration ownership routes", () => {
  it("creates, reads and updates tenants only after configuration context is authenticated", async () => {
    mocks.service.createTenant.mockResolvedValue({ ...tenant, id: ids.otherTenant, name: "Nordic" });
    const created = await tenantsPost(jsonRequest("http://localhost/api/media-engine/tenants", "POST", { name: "Nordic", timezone: "Europe/Stockholm" }));
    expect(created.status).toBe(201);
    expect(mocks.service.createTenant).toHaveBeenCalledWith(database, userId, expect.objectContaining({ name: "Nordic" }));

    mocks.service.getTenant.mockResolvedValue(tenant);
    const read = await tenantGet(new NextRequest(`http://localhost/api/media-engine/tenants/${ids.tenant}`), context(ids.tenant));
    expect(read.status).toBe(200);
    expect(mocks.service.getTenant).toHaveBeenCalledWith(database, userId, ids.tenant);

    const emptyPatch = await tenantPatch(jsonRequest(`http://localhost/api/media-engine/tenants/${ids.tenant}`, "PATCH", {}), context(ids.tenant));
    expect(emptyPatch.status).toBe(400);
    expect(mocks.service.updateTenant).not.toHaveBeenCalled();

    mocks.service.updateTenant.mockResolvedValue({ ...tenant, name: "Ny titel" });
    const changed = await tenantPatch(jsonRequest(`http://localhost/api/media-engine/tenants/${ids.tenant}`, "PATCH", { name: "Ny titel" }), context(ids.tenant));
    expect(changed.status).toBe(200);
    expect(mocks.service.updateTenant).toHaveBeenCalledWith(database, userId, ids.tenant, { name: "Ny titel" });

    mocks.service.deleteTenant.mockResolvedValue(true);
    const removed = await tenantDelete(new NextRequest(`http://localhost/api/media-engine/tenants/${ids.tenant}`, { method: "DELETE" }), context(ids.tenant));
    expect(removed.status).toBe(200);
    expect(mocks.service.deleteTenant).toHaveBeenCalledWith(database, userId, ids.tenant);
  });

  it("keeps member, source and rule operations tenant-scoped and validates their payloads", async () => {
    mocks.service.upsertMember.mockResolvedValue({ tenantId: ids.tenant, userId: ids.member, role: "editor" });
    const member = await membersPut(jsonRequest(`http://localhost/api/media-engine/tenants/${ids.tenant}/members`, "PUT", { userId: ids.member, role: "editor" }), context(ids.tenant));
    expect(member.status).toBe(200);
    expect(mocks.service.upsertMember).toHaveBeenCalledWith(database, userId, ids.tenant, { userId: ids.member, role: "editor" });

    mocks.service.createSource.mockResolvedValue({ id: ids.source, provider: "RSS" });
    const source = await sourcesPost(jsonRequest("http://localhost/api/media-engine/sources", "POST", {
      tenantId: ids.tenant, kind: "rss", provider: "Reuters", displayName: "Reuters", baseUrl: "https://example.com/feed.xml",
    }));
    expect(source.status).toBe(201);
    expect(mocks.service.createSource).toHaveBeenCalledWith(database, userId, expect.objectContaining({ tenantId: ids.tenant, kind: "rss" }));

    const missingUrl = await sourcesPost(jsonRequest("http://localhost/api/media-engine/sources", "POST", {
      tenantId: ids.tenant, kind: "rss", provider: "RSS", displayName: "RSS utan URL",
    }));
    expect(missingUrl.status).toBe(400);
    expect(mocks.service.createSource).toHaveBeenCalledTimes(1);

    const unsafeSource = await sourcesPost(jsonRequest("http://localhost/api/media-engine/sources", "POST", {
      tenantId: ids.tenant, kind: "api", provider: "API", displayName: "API", baseUrl: "https://example.com/?token=secret",
    }));
    expect(unsafeSource.status).toBe(400);
    expect(mocks.service.createSource).toHaveBeenCalledTimes(1);

    const invalidRule = await rulesPost(jsonRequest("http://localhost/api/media-engine/rules", "POST", {
      tenantId: ids.tenant, name: "Fel regel", query: "AI", contentType: "newsletter", channels: ["linkedin"],
    }));
    expect(invalidRule.status).toBe(400);
    expect(mocks.service.createRule).not.toHaveBeenCalled();

    mocks.service.createRule.mockResolvedValue({ id: ids.rule, name: "AI", tenantId: ids.tenant });
    const validRule = await rulesPost(jsonRequest("http://localhost/api/media-engine/rules", "POST", {
      tenantId: ids.tenant, name: "AI", query: "AI", channels: ["linkedin"], scheduleMode: "threshold", cadence: "hourly",
    }));
    expect(validRule.status).toBe(201);
    expect(mocks.service.createRule).toHaveBeenCalledWith(database, userId, expect.objectContaining({ tenantId: ids.tenant, name: "AI" }));
  });

  it("handles source/rule/member read-update-delete contracts without crossing the query tenant", async () => {
    mocks.service.getSource.mockResolvedValue({ id: ids.source });
    mocks.service.updateSource.mockResolvedValue({ id: ids.source, active: false });
    mocks.service.deleteSource.mockResolvedValue(true);
    mocks.service.getRule.mockResolvedValue({ id: ids.rule });
    mocks.service.updateRule.mockResolvedValue({ id: ids.rule, active: false });
    mocks.service.deleteRule.mockResolvedValue(true);
    mocks.service.removeMember.mockResolvedValue(true);

    expect((await sourceGet(new NextRequest(`http://localhost/api/media-engine/sources/${ids.source}?tenantId=${ids.tenant}`), context(ids.source))).status).toBe(200);
    expect((await sourcePatch(jsonRequest(`http://localhost/api/media-engine/sources/${ids.source}?tenantId=${ids.tenant}`, "PATCH", { active: false }), context(ids.source))).status).toBe(200);
    expect((await sourceDelete(new NextRequest(`http://localhost/api/media-engine/sources/${ids.source}?tenantId=${ids.tenant}`, { method: "DELETE" }), context(ids.source))).status).toBe(200);
    expect(mocks.service.updateSource).toHaveBeenCalledWith(database, userId, ids.tenant, ids.source, { active: false });

    expect((await ruleGet(new NextRequest(`http://localhost/api/media-engine/rules/${ids.rule}?tenantId=${ids.tenant}`), context(ids.rule))).status).toBe(200);
    expect((await rulePatch(jsonRequest(`http://localhost/api/media-engine/rules/${ids.rule}?tenantId=${ids.tenant}`, "PATCH", { active: false }), context(ids.rule))).status).toBe(200);
    expect((await ruleDelete(new NextRequest(`http://localhost/api/media-engine/rules/${ids.rule}?tenantId=${ids.tenant}`, { method: "DELETE" }), context(ids.rule))).status).toBe(200);
    expect(mocks.service.updateRule).toHaveBeenCalledWith(database, userId, ids.tenant, ids.rule, { active: false });

    expect((await membersGet(new NextRequest(`http://localhost/api/media-engine/tenants/${ids.tenant}/members`), context(ids.tenant))).status).toBe(200);
    expect((await memberDelete(new NextRequest(`http://localhost/api/media-engine/tenants/${ids.tenant}/members/${ids.member}`, { method: "DELETE" }), memberContext(ids.tenant, ids.member))).status).toBe(200);
    expect(mocks.service.removeMember).toHaveBeenCalledWith(database, userId, ids.tenant, ids.member);
  });
});

describe("Media Engine execution and publication boundaries", () => {
  it("lets the overview select a tenant only through the authenticated overview service", async () => {
    const root = await rootGet(new NextRequest(`http://localhost/api/media-engine?tenantId=${ids.otherTenant}`));
    expect(root.status).toBe(200);
    expect(mocks.pipeline.overview).toHaveBeenCalledWith({ database, userId, tenantId: ids.otherTenant });

    const clusters = await clustersGet(new NextRequest(`http://localhost/api/media-engine/clusters?tenantId=${ids.tenant}`));
    expect(clusters.status).toBe(200);
    expect(mocks.service.listSources).not.toHaveBeenCalled();

    mocks.pipeline.overview.mockResolvedValueOnce({ ...overview(), clusters: [{ id: ids.cluster }], dossiers: [], handoffs: [] });
    const read = await clusterGet(new NextRequest(`http://localhost/api/media-engine/clusters/${ids.cluster}?tenantId=${ids.otherTenant}`), context(ids.cluster));
    expect(read.status).toBe(200);
    expect(mocks.pipeline.overview).toHaveBeenLastCalledWith({ database, userId, tenantId: ids.tenant });

    const changed = await clusterPatch(jsonRequest(`http://localhost/api/media-engine/clusters/${ids.cluster}`, "PATCH", { tenantId: ids.otherTenant, action: "dismiss" }), context(ids.cluster));
    expect(changed.status).toBe(200);
    expect(mocks.pipeline.updateCluster).toHaveBeenCalledWith(expect.objectContaining({ tenantId: ids.tenant, clusterId: ids.cluster, action: "dismiss" }));
  });

  it("returns an empty authenticated overview so the first tenant can be created", async () => {
    mocks.pipeline.overview.mockResolvedValueOnce({
      tenant: null,
      configuration: { ready: false, missing: [], issues: ["Skapa eller anslut en tenant innan researchmotorn kan köras."] },
      sources: [], rules: [], clusters: [], dossiers: [], handoffs: [], runs: [],
    });

    const root = await rootGet(new NextRequest("http://localhost/api/media-engine"));

    expect(root.status).toBe(200);
    await expect(root.json()).resolves.toMatchObject({ tenant: null, sources: [], rules: [] });
    expect(mocks.config.resolve).toHaveBeenCalledTimes(1);
    expect(mocks.pipeline.overview).toHaveBeenLastCalledWith({ database, userId, tenantId: null });
  });

  it("rejects an invalid overview tenant before resolving the authenticated context", async () => {
    const root = await rootGet(new NextRequest("http://localhost/api/media-engine?tenantId=not-a-uuid"));

    expect(root.status).toBe(400);
    expect(mocks.config.resolve).not.toHaveBeenCalled();
    expect(mocks.pipeline.overview).not.toHaveBeenCalled();
  });

  it("requires idempotency keys, returns honest in-progress statuses, and never describes research as publishing", async () => {
    const badCheck = await checkPost(jsonRequest("http://localhost/api/media-engine/check", "POST", { tenantId: ids.tenant, idempotencyKey: "bad" }));
    const badResearch = await clusterResearchPost(jsonRequest(`http://localhost/api/media-engine/clusters/${ids.cluster}/research`, "POST", { idempotencyKey: "bad" }), context(ids.cluster));
    const badDraft = await handoffDraftPost(jsonRequest(`http://localhost/api/media-engine/handoffs/${ids.handoff}/draft`, "POST", { idempotencyKey: "bad" }), context(ids.handoff));
    expect([badCheck.status, badResearch.status, badDraft.status]).toEqual([400, 400, 400]);
    expect(mocks.pipeline.check).not.toHaveBeenCalled();
    expect(mocks.pipeline.research).not.toHaveBeenCalled();
    expect(mocks.pipeline.createDraft).not.toHaveBeenCalled();

    mocks.pipeline.check.mockResolvedValueOnce([runResult("already_running")]);
    const check = await checkPost(jsonRequest("http://localhost/api/media-engine/check", "POST", { tenantId: ids.otherTenant, idempotencyKey: ids.idempotency }));
    expect(check.status).toBe(202);
    await expect(check.json()).resolves.toMatchObject({ noPublication: true, status: "already_running" });
    expect(mocks.pipeline.check).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ tenantId: ids.tenant }) }));

    const research = await clusterResearchPost(jsonRequest(`http://localhost/api/media-engine/clusters/${ids.cluster}/research`, "POST", { idempotencyKey: ids.idempotency }), context(ids.cluster));
    expect(research.status).toBe(200);
    await expect(research.json()).resolves.toMatchObject({ noPublication: true });

    const draft = await handoffDraftPost(jsonRequest(`http://localhost/api/media-engine/handoffs/${ids.handoff}/draft`, "POST", { idempotencyKey: ids.idempotency }), context(ids.handoff));
    expect(draft.status).toBe(201);
    await expect(draft.json()).resolves.toMatchObject({ noPublication: true, contentDraftId: "draft" });
  });

  it("limits handoff operations to reject or private draft queueing", async () => {
    const unsafe = await handoffPatch(jsonRequest(`http://localhost/api/media-engine/handoffs/${ids.handoff}`, "PATCH", { action: "published" }), context(ids.handoff));
    expect(unsafe.status).toBe(400);
    expect(mocks.pipeline.updateHandoff).not.toHaveBeenCalled();

    const queued = await handoffPatch(jsonRequest(`http://localhost/api/media-engine/handoffs/${ids.handoff}`, "PATCH", { action: "queue_draft" }), context(ids.handoff));
    expect(queued.status).toBe(200);
    await expect(queued.json()).resolves.toMatchObject({ noPublication: true });
    expect(mocks.pipeline.updateHandoff).toHaveBeenCalledWith(expect.objectContaining({ tenantId: ids.tenant, handoffId: ids.handoff, action: "queue_draft" }));
  });

  it("keeps run history and cron dispatch separate from browser authentication and publication", async () => {
    const runs = await runsGet(new NextRequest(`http://localhost/api/media-engine/runs?tenantId=${ids.otherTenant}`));
    expect(runs.status).toBe(200);
    await expect(runs.json()).resolves.toMatchObject({ tenant, runs: [], configuration: { ready: true } });

    vi.stubEnv("CRON_SECRET", "cron-secret");
    const unauthorized = await cronGet(new NextRequest("http://localhost/api/cron/media-engine"));
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("cache-control")).toBe("no-store");
    expect(mocks.pipeline.runDue).not.toHaveBeenCalled();

    mocks.cron.configured.mockReturnValueOnce(false);
    mocks.cron.missing.mockReturnValueOnce(["SUPABASE_SERVICE_ROLE_KEY"]);
    const setup = await cronGet(new NextRequest("http://localhost/api/cron/media-engine", { headers: { authorization: "Bearer cron-secret" } }));
    expect(setup.status).toBe(503);

    mocks.pipeline.configuration.mockReturnValueOnce({ ready: false, missing: ["OPENAI_API_KEY"], issues: ["Lägg till OPENAI_API_KEY och starta om tjänsten."] });
    const modelSetup = await cronGet(new NextRequest("http://localhost/api/cron/media-engine", { headers: { authorization: "Bearer cron-secret" } }));
    expect(modelSetup.status).toBe(503);
    await expect(modelSetup.json()).resolves.toMatchObject({ noPublication: true, configuration: { missing: ["OPENAI_API_KEY"] } });
    expect(mocks.pipeline.runDue).not.toHaveBeenCalled();

    mocks.pipeline.runDue.mockResolvedValueOnce([runResult()]);
    const cron = await cronGet(new NextRequest("http://localhost/api/cron/media-engine", { headers: { authorization: "Bearer cron-secret" } }));
    expect(cron.status).toBe(200);
    await expect(cron.json()).resolves.toMatchObject({ noPublication: true, processed: 1, runLimit: 1 });
    expect(mocks.pipeline.runDue).toHaveBeenCalledWith({ database, limit: 1 });
  });
});
