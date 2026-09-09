import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  mediaResearchRuleCreateSchema,
  mediaSourceConnectionCreateSchema,
  mediaTenantCreateSchema,
  mediaTenantRoleAllows,
} from "@/lib/domain/media-engine";
import { getMediaResearchClusterForUser, toMediaSourceConnectionView } from "@/lib/services/media-engine";

const tenantId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

type RecordedFilter = { kind: "eq" | "is" | "in"; column: string; value: unknown };

/** Minimal thenable Supabase double for asserting revision-scoped service reads. */
function currentRevisionClient() {
  const userId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const clusterId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const currentLease = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const calls = new Map<string, RecordedFilter[]>();
  const rows: Record<string, Record<string, unknown>[]> = {
    media_tenant_members: [{ tenant_id: tenantId, user_id: userId, role: "owner" }],
    media_tenants: [{ id: tenantId, name: "Eriks arbetsyta", slug: "erik", timezone: "Europe/Stockholm", is_default: true }],
    media_research_clusters: [{
      id: clusterId, tenant_id: tenantId, canonical_key: "topic-current", title: "Aktuell händelse", status: "ready",
      mention_count: 2, unique_domain_count: 2, first_seen_at: "2026-08-23T08:00:00.000Z", last_seen_at: "2026-08-23T09:00:00.000Z",
    }],
    media_research_dossiers: [
      {
        id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", tenant_id: tenantId, cluster_id: clusterId, status: "failed", is_current: false,
        research_lease_token: "ffffffff-ffff-4fff-8fff-ffffffffffff", what_we_know: ["Gammal version"], what_we_dont_know: [],
        why_it_matters: "", suggested_angle: "", transparent_reflection: "", uncertainties: [], conflicts: [], source_synthesis: "", structured_data: {},
        evidence_count: 1, model_metadata: {}, created_at: "2026-08-23T08:00:00.000Z", updated_at: "2026-08-23T08:00:00.000Z",
      },
      {
        id: "99999999-9999-4999-8999-999999999999", tenant_id: tenantId, cluster_id: clusterId, status: "ready", is_current: true,
        research_lease_token: currentLease, what_we_know: ["Aktuell version"], what_we_dont_know: [],
        why_it_matters: "", suggested_angle: "", transparent_reflection: "", uncertainties: [], conflicts: [], source_synthesis: "", structured_data: {},
        evidence_count: 1, model_metadata: {}, created_at: "2026-08-23T09:00:00.000Z", updated_at: "2026-08-23T09:00:00.000Z",
      },
    ],
    media_content_handoffs: [],
    media_research_evidence: [
      {
        id: "11111111-1111-4111-8111-111111111111", tenant_id: tenantId, cluster_id: clusterId,
        research_lease_token: "ffffffff-ffff-4fff-8fff-ffffffffffff", source_name: "Gammal källa", source_url: "https://old.example/story",
        source_domain: "old.example", source_type: "secondary", published_at: null, event_date: null, claim: "Gammal evidens", stance: "supports", confidence: 70,
      },
      {
        id: "22222222-2222-4222-8222-222222222222", tenant_id: tenantId, cluster_id: clusterId,
        research_lease_token: currentLease, source_name: "Aktuell källa", source_url: "https://current.example/story",
        source_domain: "current.example", source_type: "secondary", published_at: null, event_date: null, claim: "Aktuell evidens", stance: "supports", confidence: 70,
      },
    ],
  };
  const client = {
    from(table: string) {
      const filters: RecordedFilter[] = [];
      calls.set(table, filters);
      const dataForFilters = () => (rows[table] ?? []).filter((row) => filters.every((filter) => {
        const value = row[filter.column];
        if (filter.kind === "eq") return value === filter.value;
        if (filter.kind === "is") return value === filter.value;
        return Array.isArray(filter.value) && filter.value.includes(value);
      }));
      const query = {
        select: () => query,
        eq: (column: string, value: unknown) => { filters.push({ kind: "eq", column, value }); return query; },
        is: (column: string, value: unknown) => { filters.push({ kind: "is", column, value }); return query; },
        in: (column: string, value: unknown[]) => { filters.push({ kind: "in", column, value }); return query; },
        order: () => query,
        maybeSingle: async () => ({ data: dataForFilters()[0] ?? null, error: null }),
        then: <TResult1 = { data: Record<string, unknown>[]; error: null }, TResult2 = never>(
          resolve?: ((value: { data: Record<string, unknown>[]; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
          reject?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
        ) => Promise.resolve({ data: dataForFilters(), error: null }).then(resolve, reject),
      };
      return query;
    },
  };
  return { client, calls, userId, clusterId, currentLease };
}

describe("media engine tenant foundation", () => {
  it("accepts only public connector configuration in V1", () => {
    const parsed = mediaSourceConnectionCreateSchema.parse({
      tenantId,
      kind: "api",
      provider: "NewsAPI",
      displayName: "Nyhets-API",
      baseUrl: "https://example.com/v1/search",
      configPublic: { queryParameter: "q", resultPath: "articles" },
    });
    expect(() => mediaSourceConnectionCreateSchema.parse({
      ...parsed,
      configPublic: { apiKey: "this-must-never-be-stored" },
    })).toThrow(/Hemliga uppgifter/);
    expect(() => mediaSourceConnectionCreateSchema.parse({
      ...parsed,
      credentialRef: "MEDIA_ENGINE_API_TOKEN_NEWSAPI",
    })).toThrow();
    expect(() => mediaSourceConnectionCreateSchema.parse({
      ...parsed,
      baseUrl: "https://example.com/v1/search?token=this-must-never-be-stored",
    })).toThrow(/hemlig query-parameter/);
    expect(() => mediaSourceConnectionCreateSchema.parse({
      ...parsed,
      baseUrl: "https://user:password@example.com/v1/search",
    })).toThrow(/inloggningsuppgifter/);
    expect(() => mediaSourceConnectionCreateSchema.parse({
      ...parsed,
      configPublic: { endpoint: "https://example.com/v1/search?api_key=this-must-never-be-stored" },
    })).toThrow(/hemlig query-parameter/);
    expect(() => mediaSourceConnectionCreateSchema.parse({
      ...parsed,
      configPublic: { endpoint: "https://example.com/v1/search?client_secret=this-must-never-be-stored" },
    })).toThrow(/hemlig query-parameter/);
    expect(() => mediaSourceConnectionCreateSchema.parse({
      ...parsed,
      configPublic: { key: "this-must-never-be-stored" },
    })).toThrow(/Hemliga uppgifter/);
    expect(() => mediaSourceConnectionCreateSchema.parse({
      ...parsed,
      kind: "rss",
      baseUrl: null,
    })).toThrow(/feed-URL/);
    expect(mediaSourceConnectionCreateSchema.parse({
      ...parsed,
      kind: "web_search",
      baseUrl: null,
    })).toMatchObject({ kind: "web_search", baseUrl: null });
    expect(mediaSourceConnectionCreateSchema.parse({
      ...parsed,
      kind: "api",
      baseUrl: null,
      configPublic: { endpoint: "https://example.com/v1/search" },
    })).toMatchObject({ kind: "api", baseUrl: null });
    expect(() => mediaSourceConnectionCreateSchema.parse({ ...parsed, kind: "webhook" })).toThrow();
    expect(() => mediaSourceConnectionCreateSchema.parse({ ...parsed, kind: "manual" })).toThrow();

    const safe = toMediaSourceConnectionView({
      id: "source-a",
      tenant_id: tenantId,
      kind: "api",
      provider: "NewsAPI",
      display_name: "Nyhets-API",
      base_url: "https://example.com/v1/search",
      config_public: { queryParameter: "q" },
      credential_ref: "MEDIA_ENGINE_API_TOKEN_NEWSAPI",
      active: true,
      sync_interval_minutes: 30,
      metadata: {},
      created_at: "2026-08-23T00:00:00.000Z",
      updated_at: "2026-08-23T00:00:00.000Z",
    });
    expect(safe).toMatchObject({ provider: "NewsAPI" });
    expect(JSON.stringify(safe)).not.toContain("MEDIA_ENGINE_API_TOKEN_NEWSAPI");
    expect(safe).not.toHaveProperty("credentialRef");
    expect(safe).not.toHaveProperty("hasCredential");

    const legacyUnsafe = toMediaSourceConnectionView({
      id: "source-b",
      tenant_id: tenantId,
      kind: "api",
      provider: "Legacy API",
      display_name: "Legacy API",
      base_url: "https://example.com/v1/search?%74oken=do-not-return",
      config_public: { endpoint: "https://example.com/v1?client_secret=do-not-return", key: "do-not-return", scope: "ai" },
      metadata: { authorization: "Bearer do-not-return", label: "legacy" },
      active: false,
      created_at: "2026-08-23T00:00:00.000Z",
      updated_at: "2026-08-23T00:00:00.000Z",
    });
    expect(JSON.stringify(legacyUnsafe)).not.toContain("do-not-return");
    expect(legacyUnsafe).toMatchObject({ baseUrl: null, configPublic: { scope: "ai" }, metadata: { label: "legacy" } });
  });

  it("models the real trigger threshold and refuses misleading schedule combinations", () => {
    const base = {
      tenantId,
      name: "När AI-regler ändras",
      query: "AI regulation",
      minMentions: 3,
      minUniqueDomains: 2,
      windowHours: 72,
      contentType: "social_post" as const,
      channels: ["linkedin"] as const,
      scheduleMode: "threshold" as const,
      cadence: "hourly" as const,
      approvalRequired: true,
    };
    expect(mediaResearchRuleCreateSchema.parse(base)).toMatchObject({ scheduleMode: "threshold", minUniqueDomains: 2 });
    expect(() => mediaResearchRuleCreateSchema.parse({ ...base, cronExpression: "0 8 * * *" })).toThrow(/cron-uttryck/);
    expect(mediaResearchRuleCreateSchema.parse({
      ...base,
      scheduleMode: "cron",
      cadence: "cron",
      cronExpression: "0 8 * * 1",
    })).toMatchObject({ scheduleMode: "cron" });
    expect(() => mediaResearchRuleCreateSchema.parse({
      ...base,
      cadence: "cron",
      cronExpression: "0 8 * * 1",
    })).toThrow(/Cron-läge kräver frekvensen/);
    expect(() => mediaResearchRuleCreateSchema.parse({
      ...base,
      scheduleMode: "cron",
      cronExpression: "0 8 * * 1",
    })).toThrow(/Cron-läge kräver frekvensen/);
    expect(() => mediaResearchRuleCreateSchema.parse({ ...base, contentType: "newsletter", channels: ["linkedin"] })).toThrow(/Nyhetsbrev/);
    expect(() => mediaResearchRuleCreateSchema.parse({
      ...base,
      sourceIds: Array.from({ length: 13 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`),
    })).toThrow();
  });

  it("enforces the same owner/admin/editor/viewer boundary in server code", () => {
    expect(mediaTenantRoleAllows("owner", "admin")).toBe(true);
    expect(mediaTenantRoleAllows("admin", "editor")).toBe(true);
    expect(mediaTenantRoleAllows("editor", "viewer")).toBe(true);
    expect(mediaTenantRoleAllows("viewer", "editor")).toBe(false);
    expect(mediaTenantRoleAllows("editor", "admin")).toBe(false);
  });

  it("rejects an invalid workspace timezone before a cron rule can depend on it", () => {
    expect(mediaTenantCreateSchema.parse({ name: "Eriks arbetsyta", timezone: "Europe/Stockholm" }).timezone)
      .toBe("Europe/Stockholm");
    expect(() => mediaTenantCreateSchema.parse({ name: "Eriks arbetsyta", timezone: "Europe/Stockholmm" }))
      .toThrow(/IANA-tidszon/);
  });

  it("shows only the current dossier revision and its matching evidence chain", async () => {
    const { client, calls, userId, clusterId, currentLease } = currentRevisionClient();
    const cluster = await getMediaResearchClusterForUser(client as never, userId, tenantId, clusterId);
    expect(cluster?.dossier).toMatchObject({ status: "ready", whatWeKnow: ["Aktuell version"] });
    expect(cluster?.evidence).toHaveLength(1);
    expect(cluster?.evidence?.[0]).toMatchObject({ claim: "Aktuell evidens", sourceUrl: "https://current.example/story" });
    expect(calls.get("media_research_dossiers")).toContainEqual({ kind: "eq", column: "is_current", value: true });
    expect(calls.get("media_research_evidence")).toContainEqual({ kind: "eq", column: "research_lease_token", value: currentLease });
  });

  it("ships a tenant-scoped migration with bootstrap, source-domain thresholds and RLS", () => {
    const sql = readFileSync(resolve(process.cwd(), "supabase/migrations/202608230020_media_engine_multitenancy.sql"), "utf8");
    expect(sql).toContain("create table if not exists public.media_tenants");
    expect(sql).toContain("create table if not exists public.media_research_dossiers");
    expect(sql).toContain("min_unique_domains");
    expect(sql).toContain("ensure_default_media_tenant");
    expect(sql).toContain("validate_media_content_handoff_scope");
    expect(sql).toContain("media_tenant_has_role");
    const securityMigration = readFileSync(resolve(process.cwd(), "supabase/migrations/202608230021_media_engine_public_sources_only.sql"), "utf8");
    expect(securityMigration).toContain("credential_ref is null");
    const urlCleanupMigration = readFileSync(resolve(process.cwd(), "supabase/migrations/202608230023_media_engine_public_url_cleanup.sql"), "utf8");
    expect(urlCleanupMigration).toContain("media_source_connections_public_base_url");
    expect(urlCleanupMigration).toContain("Källan pausades");
    const sourceKindsMigration = readFileSync(resolve(process.cwd(), "supabase/migrations/202608230022_media_engine_supported_source_kinds.sql"), "utf8");
    expect(sourceKindsMigration).toContain("kind in ('rss', 'api', 'web_search')");
    expect(sourceKindsMigration).toContain("kind in ('webhook', 'manual')");
    const freshnessMigration = readFileSync(resolve(process.cwd(), "supabase/migrations/202608230024_media_engine_item_first_observed.sql"), "utf8");
    expect(freshnessMigration).toContain("first_observed_at");
    const cadenceMigration = readFileSync(resolve(process.cwd(), "supabase/migrations/202608230025_media_engine_rule_only_cadence.sql"), "utf8");
    expect(cadenceMigration).toContain("drop column if exists sync_interval_minutes");
    const clusterFenceMigration = readFileSync(resolve(process.cwd(), "supabase/migrations/202608230026_media_engine_cluster_fencing.sql"), "utf8");
    expect(clusterFenceMigration).toContain("research_lease_token");
    expect(clusterFenceMigration).toContain("validate_media_research_write_lease");
    const revisionMigration = readFileSync(resolve(process.cwd(), "supabase/migrations/202608230027_media_engine_run_leases_and_dossier_revisions.sql"), "utf8");
    expect(revisionMigration).toContain("lease_token");
    expect(revisionMigration).toContain("is_current");
    expect(revisionMigration).toContain("activate_media_research_dossier_revision");
    expect(revisionMigration).toContain("revoke all on function public.activate_media_research_dossier_revision");
    expect(revisionMigration).toContain("grant execute on function public.activate_media_research_dossier_revision");
    const fencedRuleMigration = readFileSync(resolve(process.cwd(), "supabase/migrations/202608230028_media_engine_fenced_rule_touch.sql"), "utf8");
    expect(fencedRuleMigration).toContain("touch_media_research_rule_from_run");
    expect(fencedRuleMigration).toContain("for update");
    expect(fencedRuleMigration).toContain("revoke all on function public.touch_media_research_rule_from_run");
    expect(fencedRuleMigration).toContain("grant execute on function public.touch_media_research_rule_from_run");
    const atomicFinalizeMigration = readFileSync(resolve(process.cwd(), "supabase/migrations/202608230029_media_engine_atomic_research_finalize.sql"), "utf8");
    expect(atomicFinalizeMigration).toContain("finalize_media_research_dossier_revision");
    expect(atomicFinalizeMigration).toContain("for update");
    expect(atomicFinalizeMigration).toContain("research_lease_token = null");
    expect(atomicFinalizeMigration).toContain("revoke all on function public.finalize_media_research_dossier_revision");
    expect(sql).toContain("revoke all on table public.media_tenants");
  });
});
