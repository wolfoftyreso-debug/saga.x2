import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { AppActor } from "@/lib/neon/auth-repository";
import type { NeonSql } from "@/lib/neon/database";
import {
  normalizeSagaOutgoingApiContentTypes,
  sagaOutgoingApiCreateSchema,
  sagaOutgoingApiUpdateSchema,
} from "@/lib/domain/saga-outgoing-api";
import {
  authenticateSagaOutgoingApiSecret,
  createSagaOutgoingApi,
  readSagaOutgoingContent,
  revokeSagaOutgoingApi,
  rotateSagaOutgoingApiSecret,
  updateSagaOutgoingApi,
  SagaOutgoingApiAccessError,
  SagaOutgoingApiNotFoundError,
} from "@/lib/neon/saga-outgoing-api-repository";

const actor: AppActor = {
  userId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  role: "owner",
  email: "owner@example.test",
  displayName: "Owner",
};
const apiId = "33333333-3333-4333-8333-333333333333";
const draftId = "44444444-4444-4444-8444-444444444444";
const keyPrefix = "saga_out_live_AbCdEfGhIjKl";
const token = `${keyPrefix}_${"a".repeat(43)}`;
const secretHash = "a".repeat(64);

function apiRow(overrides: Record<string, unknown> = {}) {
  return {
    id: apiId,
    workspace_id: actor.workspaceId,
    name: "SAGA till datalagret",
    content_type_scope: "selected",
    content_types: ["article"],
    visibility: "published_only",
    key_prefix: keyPrefix,
    secret_hash: secretHash,
    expires_at: null,
    last_used_at: null,
    revoked_at: null,
    revision: 1,
    created_at: "2026-08-26T08:00:00.000Z",
    updated_at: "2026-08-26T08:00:00.000Z",
    ...overrides,
  };
}

function sqlWith(...responses: unknown[]) {
  const query = vi.fn();
  for (const response of responses) query.mockResolvedValueOnce(response);
  return { sql: { query } as unknown as NeonSql, query };
}

describe("SAGA outgoing API domain", () => {
  it("keeps published_only conservative and requires a revision on updates", () => {
    expect(sagaOutgoingApiCreateSchema.parse({
      name: "Dataplattform",
      contentTypes: "all",
    }).visibility).toBe("published_only");
    expect(sagaOutgoingApiUpdateSchema.safeParse({ name: "Ny etikett" }).success).toBe(false);
    expect(sagaOutgoingApiUpdateSchema.safeParse({ name: "Ny etikett", expectedRevision: 1 }).success).toBe(true);
    expect(normalizeSagaOutgoingApiContentTypes("all")).toEqual({
      scope: "all",
      contentTypes: ["social_post", "newsletter", "article"],
    });
  });
});

describe("SAGA outgoing API Neon repository", () => {
  it("denies non-owners before any configuration query", async () => {
    const { sql, query } = sqlWith();
    await expect(createSagaOutgoingApi({ ...actor, role: "editor" }, {
      name: "Extern läsning",
      contentTypes: "all",
      visibility: "published_only",
    }, sql)).rejects.toBeInstanceOf(SagaOutgoingApiAccessError);
    expect(query).not.toHaveBeenCalled();
  });

  it("generates a server secret, stores only a hash and binds creation to actor workspace/user", async () => {
    const { sql, query } = sqlWith([apiRow({ content_type_scope: "all", content_types: ["social_post", "newsletter", "article"] })]);
    const created = await createSagaOutgoingApi(actor, {
      name: "Hela innehållsflödet",
      contentTypes: "all",
      visibility: "published_only",
    }, sql, new Date("2026-08-26T09:00:00.000Z"));

    expect(created.secret).toMatch(/^saga_out_live_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{43}$/);
    expect(created.export).toMatchObject({ id: apiId, contentTypes: "all", visibility: "published_only" });
    expect(JSON.stringify(created.export)).not.toContain("secret_hash");
    const [statement, params] = query.mock.calls[0] ?? [];
    expect(statement).toContain("insert into saga_outgoing_content_apis");
    expect(params?.slice(0, 2)).toEqual([actor.workspaceId, actor.userId]);
    expect(params?.[7]).toMatch(/^[a-f0-9]{64}$/);
    expect(params?.[7]).not.toBe(created.secret);
    expect(params?.[6]).not.toBe(created.secret);
  });

  it("never lets an expired secret revive through PATCH or rotate", async () => {
    const { sql: updateSql, query: updateQuery } = sqlWith([]);
    await expect(updateSagaOutgoingApi(actor, apiId, {
      expectedRevision: 1,
      expiresAt: "2026-12-01T00:00:00.000Z",
    }, updateSql)).rejects.toBeInstanceOf(SagaOutgoingApiNotFoundError);
    expect(updateQuery.mock.calls[0]?.[0]).toContain("expires_at is null or expires_at > now()");

    // Even when the record expires between the initial read and write, the
    // UPDATE's own predicate rejects the attempted revival of its old secret.
    const { sql: raceSql, query: raceQuery } = sqlWith([apiRow()], []);
    await expect(updateSagaOutgoingApi(actor, apiId, {
      expectedRevision: 1,
      expiresAt: "2026-12-01T00:00:00.000Z",
    }, raceSql)).rejects.toThrow();
    expect(raceQuery.mock.calls[1]?.[0]).toContain("expires_at is null or expires_at > now()");

    const { sql: rotateSql, query: rotateQuery } = sqlWith([]);
    await expect(rotateSagaOutgoingApiSecret(actor, apiId, rotateSql)).rejects.toBeInstanceOf(SagaOutgoingApiNotFoundError);
    expect(rotateQuery.mock.calls[0]?.[0]).toContain("expires_at is null or expires_at > now()");
  });

  it("does not find, update or revoke a foreign API id outside the actor workspace", async () => {
    const { sql, query } = sqlWith([]);
    await expect(revokeSagaOutgoingApi(actor, apiId, sql)).rejects.toBeInstanceOf(SagaOutgoingApiNotFoundError);
    expect(query.mock.calls[0]?.[0]).toContain("workspace_id = $1::uuid");
    expect(query.mock.calls[0]?.[1]).toEqual([actor.workspaceId, apiId]);
  });

  it("fails token verification closed for a revoked/unknown key", async () => {
    const { sql, query } = sqlWith([]);
    await expect(authenticateSagaOutgoingApiSecret(token, sql)).resolves.toBeNull();
    expect(query.mock.calls[0]?.[0]).toContain("key_prefix = $1");
    expect(query.mock.calls[0]?.[0]).toContain("revoked_at is null");
    expect(query.mock.calls[0]?.[0]).toContain("expires_at is null or expires_at > now()");
  });

  it("exports only a fixed safe projection, selection-scoped to the token workspace", async () => {
    const privateBlob = "https://store.blob.vercel-storage.com/private/asset.png?token=not-for-export";
    const contentRow = {
      id: draftId,
      content_type: "article",
      status: "published",
      title: "Bygg säkra system",
      body: `Bildreferens: ${privateBlob}`,
      excerpt: `Se //store.public.blob.vercel-storage.com/private/asset.png?token=not-for-export`,
      publication_channels: ["linkedin"],
      scheduled_at: null,
      published_at: "2026-08-26T08:00:00.000Z",
      updated_at: "2026-08-26T08:00:00.000Z",
    };
    const { sql, query } = sqlWith([contentRow]);
    const page = await readSagaOutgoingContent({
      apiId,
      workspaceId: actor.workspaceId,
      contentTypes: ["article"],
      visibility: "published_only",
      revision: 1,
      secretHash,
    }, { cursor: null, limit: 10, now: new Date("2026-08-26T09:00:00.000Z") }, sql);

    expect(page.items).toHaveLength(1);
    expect(JSON.stringify(page)).not.toContain("blob.vercel-storage.com");
    expect(JSON.stringify(page)).not.toContain("token=not-for-export");
    expect(page.items[0]?.body).toContain("[privat media borttagen]");
    const [statement, params] = query.mock.calls[0] ?? [];
    const selectedColumns = statement.slice(statement.indexOf("select"), statement.indexOf("from studio_drafts"));
    expect(selectedColumns).not.toContain("metadata");
    expect(selectedColumns).not.toContain("source_context");
    expect(selectedColumns).not.toContain("blob_url");
    expect(selectedColumns).not.toContain("blob_pathname");
    expect(statement).toContain("workspace_id = $1::uuid");
    expect(statement).toContain("content_type = any($2::text[])");
    expect(statement).toContain("status = 'published' and published_at is not null");
    expect(statement).toContain("coalesce(metadata ->> 'privateBrief', 'false') <> 'true'");
    expect(statement).toContain("coalesce(metadata ->> 'adAutomationDeliveryLocked', 'false') <> 'true'");
    expect(statement).toContain("status in ('approved', 'scheduled', 'published')");
    expect(statement).toContain("from saga_outgoing_content_apis api");
    expect(statement).toContain("api.revision = $9::integer");
    expect(params).toEqual(expect.arrayContaining([actor.workspaceId, ["article"], apiId, secretHash]));
    expect(page).toMatchObject({ hasMore: false, nextCursor: null });
  });

  it("documents hash-only key storage and the private-draft database guard", () => {
    const migration = readFileSync("db/migrations/202608260020_neon_saga_outgoing_content_apis.sql", "utf8");
    expect(migration).toContain("secret_hash text not null unique");
    expect(migration).toContain("key_prefix text not null unique");
    expect(migration).not.toMatch(/plaintext_secret|raw_secret|token_value/i);
    expect(migration).toContain("visibility in ('published_only', 'publication_ready')");
    expect(migration).toContain("references app_workspace_memberships(workspace_id, user_id)");
  });
});
