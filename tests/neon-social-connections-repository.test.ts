import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@/lib/neon/auth-repository";
import type { NeonSql } from "@/lib/neon/database";
import {
  disconnectNeonSocialConnection,
  getNeonSocialConnectionSecret,
  listNeonSocialConnections,
  NeonSocialConnectionAccessError,
  upsertNeonSocialConnections,
} from "@/lib/neon/social-connections-repository";

const actor: AppActor = {
  userId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  role: "owner",
  email: "owner@example.com",
  displayName: "Owner",
};
const connectionId = "33333333-3333-4333-8333-333333333333";
const originalEncryptionKey = process.env.SOCIAL_TOKEN_ENCRYPTION_KEY;

function sqlWith(...responses: unknown[]) {
  const query = vi.fn();
  for (const response of responses) query.mockResolvedValueOnce(response);
  return { sql: { query } as unknown as NeonSql, query };
}

function safeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: connectionId,
    provider: "linkedin",
    provider_account_id: "urn:li:person:abc",
    account_label: "Ada Lovelace",
    account_handle: null,
    state: "active",
    scopes: ["r_liteprofile", "w_member_social"],
    token_expires_at: "2026-09-01T10:00:00.000Z",
    last_verified_at: "2026-08-23T10:00:00.000Z",
    last_error: null,
    created_at: "2026-08-23T10:00:00.000Z",
    updated_at: "2026-08-23T10:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  process.env.SOCIAL_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});

afterEach(() => {
  if (originalEncryptionKey === undefined) delete process.env.SOCIAL_TOKEN_ENCRYPTION_KEY;
  else process.env.SOCIAL_TOKEN_ENCRYPTION_KEY = originalEncryptionKey;
});

describe("Neon social connection repository", () => {
  it("lists only safe workspace-scoped fields", async () => {
    const { sql, query } = sqlWith([safeRow()]);

    const connections = await listNeonSocialConnections(actor, sql);

    expect(connections).toEqual([expect.objectContaining({ id: connectionId, provider: "linkedin", accountLabel: "Ada Lovelace" })]);
    const [statement, params] = query.mock.calls[0] ?? [];
    expect(statement).toContain("where workspace_id = $1::uuid");
    expect(statement).not.toContain("token_ciphertext");
    expect(statement).not.toContain("refresh_token_ciphertext");
    expect(params).toEqual([actor.workspaceId]);
  });

  it("encrypts provider tokens before a workspace-scoped upsert", async () => {
    const secret = "provider-access-token-that-must-never-be-returned";
    const { sql, query } = sqlWith([safeRow()]);

    const saved = await upsertNeonSocialConnections(actor, [{
      provider: "linkedin",
      providerAccountId: "urn:li:person:abc",
      accountLabel: "Ada Lovelace",
      accountHandle: null,
      accessToken: secret,
      refreshToken: "provider-refresh-token",
      tokenExpiresAt: "2026-09-01T10:00:00.000Z",
      scopes: ["r_liteprofile", "w_member_social"],
      metadata: { authorUrn: "urn:li:person:abc", accountType: "member" },
    }], sql);

    expect(saved).toEqual([expect.objectContaining({ id: connectionId, state: "active" })]);
    const [statement, params] = query.mock.calls[0] ?? [];
    expect(statement).toContain("on conflict (workspace_id, provider, provider_account_id)");
    expect(params?.[0]).toBe(actor.workspaceId);
    expect(params?.[1]).toBe(actor.userId);
    expect(params?.[6]).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(params?.[6]).not.toContain(secret);
    expect(params?.[7]).not.toContain("provider-refresh-token");
  });

  it("rejects plaintext credential-shaped metadata before it reaches Neon", async () => {
    const { sql, query } = sqlWith();

    await expect(upsertNeonSocialConnections(actor, [{
      provider: "linkedin",
      providerAccountId: "urn:li:person:abc",
      accountLabel: "Ada Lovelace",
      accountHandle: null,
      accessToken: "provider-access-token",
      refreshToken: null,
      tokenExpiresAt: null,
      scopes: [],
      metadata: { access_token: "this-must-not-be-stored-here" },
    }], sql)).rejects.toThrow("får inte innehålla OAuth-hemligheter");
    expect(query).not.toHaveBeenCalled();
  });

  it("deletes encrypted credentials only in the signed actor workspace", async () => {
    const { sql, query } = sqlWith([{ id: connectionId }]);

    await expect(disconnectNeonSocialConnection({ ...actor, role: "viewer" }, connectionId, sql)).rejects.toBeInstanceOf(NeonSocialConnectionAccessError);
    expect(query).not.toHaveBeenCalled();

    await expect(disconnectNeonSocialConnection(actor, connectionId, sql)).resolves.toBe(true);
    const [statement, params] = query.mock.calls[0] ?? [];
    expect(statement).toContain("delete from social_connections");
    expect(statement).toContain("workspace_id = $1::uuid and id = $2::uuid");
    expect(params).toEqual([actor.workspaceId, connectionId]);
  });

  it("keeps token ciphertext in a server-only projection", async () => {
    const { sql, query } = sqlWith([safeRow({
      workspace_id: actor.workspaceId,
      connected_by_user_id: actor.userId,
      token_ciphertext: "v1.aGVsbG8.ZGF0YQ.dGFn",
      refresh_token_ciphertext: null,
      metadata: { accountType: "member" },
    })]);

    const connection = await getNeonSocialConnectionSecret(actor, connectionId, sql);

    expect(connection).toMatchObject({
      id: connectionId,
      workspaceId: actor.workspaceId,
      tokenCiphertext: "v1.aGVsbG8.ZGF0YQ.dGFn",
    });
    expect(query.mock.calls[0]?.[0]).toContain("token_ciphertext");

    const viewer = { ...actor, role: "viewer" as const };
    await expect(getNeonSocialConnectionSecret(viewer, connectionId, sql)).rejects.toBeInstanceOf(NeonSocialConnectionAccessError);
  });
});
