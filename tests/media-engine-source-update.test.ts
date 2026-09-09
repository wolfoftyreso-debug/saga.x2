import { describe, expect, it } from "vitest";
import { updateMediaSourceConnection } from "@/lib/services/media-engine";

const tenantId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const userId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const sourceId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

/**
 * Small Supabase double for the source PATCH read-before-write contract. It
 * deliberately records updates so a rejected runtime connector configuration
 * cannot silently reach the database.
 */
function sourceUpdateClient() {
  const updates: Array<Record<string, unknown>> = [];
  const source = {
    id: sourceId,
    tenant_id: tenantId,
    kind: "rss",
    provider: "RSS",
    display_name: "Testfeed",
    base_url: "https://example.com/feed.xml",
    config_public: {},
    active: true,
    metadata: {},
    created_at: "2026-08-23T00:00:00.000Z",
    updated_at: "2026-08-23T00:00:00.000Z",
  };
  const client = {
    from(table: string) {
      let update: Record<string, unknown> | null = null;
      const query = {
        select: () => query,
        eq: () => query,
        update: (values: Record<string, unknown>) => {
          update = values;
          updates.push(values);
          return query;
        },
        maybeSingle: async () => {
          if (table === "media_tenant_members") return { data: { tenant_id: tenantId, role: "owner" }, error: null };
          if (table === "media_tenants") return { data: { id: tenantId, slug: "erik", name: "Erik", timezone: "Europe/Stockholm", is_default: true }, error: null };
          if (table === "media_source_connections") return { data: update ? { ...source, ...update } : source, error: null };
          return { data: null, error: null };
        },
      };
      return query;
    },
  };
  return { client, updates };
}

describe("Media Engine source PATCH safety", () => {
  it("never leaves an active RSS/API connector without its public URL", async () => {
    const { client, updates } = sourceUpdateClient();
    await expect(updateMediaSourceConnection(client as never, userId, tenantId, sourceId, { baseUrl: null }))
      .rejects.toThrow(/feed-URL/);
    expect(updates).toEqual([]);
  });

  it("still lets an editor pause an invalid connector to safely contain it", async () => {
    const { client, updates } = sourceUpdateClient();
    const source = await updateMediaSourceConnection(client as never, userId, tenantId, sourceId, { active: false, baseUrl: null });
    expect(source).toMatchObject({ active: false, baseUrl: null });
    expect(updates).toEqual([{ active: false, base_url: null }]);
  });
});
