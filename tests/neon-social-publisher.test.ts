import { describe, expect, it, vi } from "vitest";
import type { ContentDraftView } from "@/lib/domain/content-studio";
import type { AppActor } from "@/lib/neon/auth-repository";
import type { NeonSql } from "@/lib/neon/database";
import type { NeonSocialConnectionSecret } from "@/lib/neon/social-connections-repository";
import {
  publishNeonApprovedSocialDraft,
  type NeonSocialPublisherDependencies,
} from "@/lib/neon/social-publisher";
import { SocialProviderConfigurationError } from "@/lib/services/social-config";
import { SocialPublishError } from "@/lib/services/social-provider-adapter";

const actor: AppActor = {
  userId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  role: "owner",
  email: "owner@example.com",
  displayName: "Owner",
};
const draftId = "33333333-3333-4333-8333-333333333333";
const connectionId = "44444444-4444-4444-8444-444444444444";
const attemptId = "55555555-5555-4555-8555-555555555555";
const now = new Date("2026-08-23T12:00:00.000Z");

function sqlWith(...responses: unknown[]) {
  const query = vi.fn();
  for (const response of responses) query.mockResolvedValueOnce(response);
  return { sql: { query } as unknown as NeonSql, query };
}

function sqlRejecting(error: unknown) {
  const query = vi.fn().mockRejectedValue(error);
  return { sql: { query } as unknown as NeonSql, query };
}

function draft(overrides: Partial<ContentDraftView> = {}): ContentDraftView {
  return {
    id: draftId,
    userId: actor.userId,
    revision: 1,
    contentType: "social_post",
    channels: ["linkedin"],
    title: "Det här gäller",
    headline: "Rakt på sak",
    subject: null,
    body: "Den här texten får aldrig kopieras till audit-kvittot.",
    cta: "Läs mer",
    excerpt: null,
    hashtags: ["#AI"],
    status: "approved",
    generationPrompt: null,
    imagePrompt: null,
    language: "sv",
    timezone: "Europe/Stockholm",
    scheduledAt: null,
    scheduledLocalDate: null,
    scheduledLocalTime: null,
    approvalRequired: true,
    approvedAt: "2026-08-23T11:00:00.000Z",
    publishedAt: null,
    templateId: null,
    automationRuleId: null,
    automationJobId: null,
    newsletterAudienceId: null,
    media: [],
    createdAt: "2026-08-23T10:00:00.000Z",
    updatedAt: "2026-08-23T11:00:00.000Z",
    ...overrides,
  };
}

function connection(overrides: Partial<NeonSocialConnectionSecret> = {}): NeonSocialConnectionSecret {
  return {
    id: connectionId,
    provider: "linkedin",
    providerAccountId: "urn:li:person:abc",
    accountLabel: "Ada Lovelace",
    accountHandle: null,
    state: "active",
    scopes: ["w_member_social"],
    tokenExpiresAt: "2026-09-01T12:00:00.000Z",
    lastVerifiedAt: "2026-08-23T10:00:00.000Z",
    lastError: null,
    createdAt: "2026-08-23T10:00:00.000Z",
    updatedAt: "2026-08-23T10:00:00.000Z",
    workspaceId: actor.workspaceId,
    connectedByUserId: actor.userId,
    tokenCiphertext: "v1.aGVsbG8.ZGF0YQ.dGFn",
    refreshTokenCiphertext: null,
    metadata: { accountType: "member" },
    ...overrides,
  };
}

function dependencies(overrides: Partial<NeonSocialPublisherDependencies> = {}): NeonSocialPublisherDependencies {
  return {
    getDraft: vi.fn().mockResolvedValue(draft()),
    getConnection: vi.fn().mockResolvedValue(connection()),
    markConnectionState: vi.fn().mockResolvedValue(true),
    validateProvider: vi.fn(),
    publish: vi.fn().mockResolvedValue({ externalPostId: "urn:li:share:123", providerResponse: { id: "urn:li:share:123", access_token: "never-store" } }),
    now: () => now,
    ...overrides,
  };
}

function publish(input: Partial<{ provider: "linkedin" | "facebook_page" | "instagram_professional"; draftId: string; connectionId: string; idempotencyKey: string | null }> = {}, options: { sql: NeonSql; dependencies: NeonSocialPublisherDependencies }) {
  return publishNeonApprovedSocialDraft({
    actor,
    draftId: input.draftId ?? draftId,
    connectionId: input.connectionId ?? connectionId,
    provider: input.provider ?? "linkedin",
    idempotencyKey: input.idempotencyKey ?? "manual-test-1",
  }, options);
}

describe("Neon social publisher", () => {
  it("writes an idempotent workspace audit receipt before a server-only provider call", async () => {
    const { sql, query } = sqlWith(
      [{ id: attemptId, state: "running", provider_post_id: null, finished_at: null, error_code: null, error_message: null }],
      [{ id: attemptId }],
    );
    const deps = dependencies();

    const result = await publish({}, { sql, dependencies: deps });

    expect(result).toEqual({
      status: "published",
      attemptId,
      externalPostId: "urn:li:share:123",
      publishedAt: now.toISOString(),
    });
    const [insert, insertParams] = query.mock.calls[0] ?? [];
    expect(insert).toContain("insert into social_publish_attempts");
    expect(insert).toContain("on conflict (workspace_id, provider, idempotency_key) do nothing");
    expect(insertParams?.[0]).toBe(actor.workspaceId);
    expect(insertParams?.[1]).toBe(draftId);
    expect(insertParams?.[2]).toBe(connectionId);
    expect(JSON.parse(insertParams?.[7] as string)).toEqual({ title: "Det här gäller", hasLink: false, mediaCount: 0, textLength: expect.any(Number) });
    expect(JSON.stringify(insertParams)).not.toContain("Den här texten får aldrig kopieras till audit-kvittot.");
    expect(JSON.stringify(insertParams)).not.toContain("v1.aGVsbG8.ZGF0YQ.dGFn");
    expect(deps.publish).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[1]?.[0]).toContain("provider_response = $4::jsonb");
    expect(JSON.parse(query.mock.calls[1]?.[1]?.[3] as string)).toEqual({ id: "urn:li:share:123" });
  });

  it("does not create an external post from a non-approved draft", async () => {
    const { sql, query } = sqlWith();
    const deps = dependencies({ getDraft: vi.fn().mockResolvedValue(draft({ status: "in_review", approvedAt: null })) });

    const result = await publish({}, { sql, dependencies: deps });

    expect(result).toMatchObject({ status: "failed", code: "draft_not_approved" });
    expect(deps.publish).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it("never turns a delivery-locked private SAGA brief into a social post", async () => {
    const { sql, query } = sqlWith();
    const deps = dependencies({ getDraft: vi.fn().mockResolvedValue(draft({ deliveryLocked: true, privateBrief: true })) });

    const result = await publish({}, { sql, dependencies: deps });

    expect(result).toMatchObject({ status: "failed", code: "ad_private_brief_locked" });
    expect(deps.publish).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it("honestly blocks private Blob media and Instagram until a secure media delivery step exists", async () => {
    const { sql, query } = sqlWith();
    const mediaDraft = draft({ media: [{
      id: "66666666-6666-4666-8666-666666666666",
      contentDraftId: draftId,
      kind: "image",
      source: "upload",
      storagePath: "workspaces/example/photo.jpg",
      assetUrl: `/api/content/drafts/${draftId}/media/66666666-6666-4666-8666-666666666666/asset`,
      filename: "photo.jpg",
      mimeType: "image/jpeg",
      byteSize: 42,
      altText: null,
      caption: null,
      processingStatus: "ready",
      adaptationPrompt: null,
      variants: {},
      sortOrder: 0,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    }] });
    const deps = dependencies({ getDraft: vi.fn().mockResolvedValue(mediaDraft) });

    const result = await publish({}, { sql, dependencies: deps });

    expect(result).toMatchObject({ status: "unavailable", code: "private_media_delivery_unavailable" });
    expect(deps.publish).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();

    const instagramDeps = dependencies({ getDraft: vi.fn().mockResolvedValue(draft({ channels: ["instagram"] })) });
    const instagram = await publish({ provider: "instagram_professional" }, { sql, dependencies: instagramDeps });
    expect(instagram).toMatchObject({ status: "unavailable", code: "instagram_public_media_required" });
    expect(instagramDeps.publish).not.toHaveBeenCalled();
  });

  it("returns an existing published receipt instead of publishing twice", async () => {
    const { sql, query } = sqlWith(
      [],
      [{ id: attemptId, state: "published", provider_post_id: "urn:li:share:already", finished_at: "2026-08-23T11:30:00.000Z", error_code: null, error_message: null }],
    );
    const deps = dependencies();

    const result = await publish({}, { sql, dependencies: deps });

    expect(result).toEqual({
      status: "published",
      attemptId,
      externalPostId: "urn:li:share:already",
      publishedAt: "2026-08-23T11:30:00.000Z",
    });
    expect(deps.publish).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("records configuration and provider failures without exposing a token or auto-retrying", async () => {
    const { sql, query } = sqlWith(
      [{ id: attemptId, state: "running", provider_post_id: null, finished_at: null, error_code: null, error_message: null }],
      [{ id: attemptId }],
    );
    const deps = dependencies({
      validateProvider: vi.fn(() => { throw new SocialProviderConfigurationError("linkedin", ["LINKEDIN_CLIENT_SECRET"]); }),
    });

    const unavailable = await publish({}, { sql, dependencies: deps });

    expect(unavailable).toMatchObject({ status: "unavailable", code: "provider_configuration_required", attemptId });
    expect(deps.publish).not.toHaveBeenCalled();
    expect(query.mock.calls[1]?.[0]).toContain("set state = 'failed'");

    const { sql: providerSql, query: providerQuery } = sqlWith(
      [{ id: attemptId, state: "running", provider_post_id: null, finished_at: null, error_code: null, error_message: null }],
      [{ id: attemptId }],
    );
    const providerDeps = dependencies({ publish: vi.fn(() => { throw new SocialPublishError("LinkedIn-behörigheten gäller inte längre.", "linkedin_401", true); }) });
    const providerFailure = await publish({}, { sql: providerSql, dependencies: providerDeps });
    expect(providerFailure).toMatchObject({ status: "failed", code: "linkedin_401", attemptId });
    expect(providerDeps.markConnectionState).toHaveBeenCalledWith(actor, connectionId, "needs_reauth", expect.any(String), providerSql);
    expect(providerQuery.mock.calls[1]?.[0]).toContain("set state = 'failed'");
  });

  it("returns an explicit unavailable result when the Neon audit schema is missing", async () => {
    const { sql, query } = sqlRejecting({ code: "42P01", message: "relation social_publish_attempts does not exist" });
    const deps = dependencies();

    const result = await publish({}, { sql, dependencies: deps });

    expect(result).toMatchObject({ status: "unavailable", code: "neon_social_publish_schema_required" });
    expect(deps.publish).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(1);
  });
});
