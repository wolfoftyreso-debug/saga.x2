import { describe, expect, it, vi } from "vitest";
import type { AppActor } from "@/lib/neon/auth-repository";
import type { NeonSql } from "@/lib/neon/database";
import {
  createSagaAvatarProfile,
  createSagaAvatarReferenceMetadata,
  deleteSagaAvatarProfileIfEmpty,
  deleteSagaAvatarReferenceMetadata,
  finalizeSagaAvatarDirectReferenceUpload,
  getSagaAvatarOwnedReference,
  getSagaAvatarProfile,
  getSagaAvatarProfileForPrivateModelUse,
  listSagaAvatarProfiles,
  SagaAvatarAccessError,
  SagaAvatarNotFoundError,
  SagaAvatarValidationError,
  updateSagaAvatarProfile,
} from "@/lib/neon/saga-avatar-repository";

const actor: AppActor = {
  userId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  role: "owner",
  email: "owner@example.com",
  displayName: "Owner",
};
const profileId = "33333333-3333-4333-8333-333333333333";
const referenceId = "44444444-4444-4444-8444-444444444444";

function sqlWith(...responses: unknown[]) {
  const query = vi.fn();
  for (const response of responses) query.mockResolvedValueOnce(response);
  return { sql: { query } as unknown as NeonSql, query };
}

function profileRow(overrides: Record<string, unknown> = {}) {
  return {
    id: profileId,
    label: "Min diskreta avatar",
    output_visibility_policy: "obscured_noir_only",
    full_face_allowed: false,
    provider_processing_enabled: false,
    provider_processing_provider: null,
    provider_processing_consent_version: null,
    provider_processing_consented_at: null,
    created_at: "2026-08-25T08:00:00.000Z",
    updated_at: "2026-08-25T08:00:00.000Z",
    ...overrides,
  };
}

function referenceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: referenceId,
    profile_id: profileId,
    angle: "front",
    position: 1,
    blob_url: "https://private.blob.vercel-storage.com/studio/workspaces/222/avatar-profiles/333/references/file.jpg",
    blob_pathname: "studio/workspaces/222/avatar-profiles/333/references/file.jpg",
    content_type: "image/jpeg",
    byte_size: 22,
    created_at: "2026-08-25T08:00:00.000Z",
    ...overrides,
  };
}

describe("SAGA private avatar reference repository", () => {
  it("projects strictly metadata-safe reference data, never a Blob URL/path or preview endpoint", async () => {
    const { sql } = sqlWith([profileRow()], [referenceRow()]);
    const [profile] = await listSagaAvatarProfiles(actor, sql);

    expect(profile).toMatchObject({
      id: profileId,
      fullFaceAllowed: false,
      outputVisibilityPolicy: "obscured_noir_only",
      providerProcessing: { enabled: false, readyForPrivateModelUse: false },
      references: [{ id: referenceId, angle: "front", position: 1 }],
    });
    expect(profile?.references[0]).not.toHaveProperty("previewUrl");
    expect(profile?.references[0]).not.toHaveProperty("blobUrl");
    expect(profile?.references[0]).not.toHaveProperty("blobPathname");
  });

  it("records explicit upload consent while creating a profile with provider use disabled", async () => {
    const { sql, query } = sqlWith([profileRow()]);
    const profile = await createSagaAvatarProfile(actor, { label: "Min diskreta avatar" }, sql);

    expect(profile.providerProcessing.enabled).toBe(false);
    const [statement, params] = query.mock.calls[0] ?? [];
    expect(statement).toContain("saga_avatar_consent_records");
    expect(statement).toContain("'reference_upload'");
    expect(statement).toContain("full_face_allowed");
    expect(params).toEqual(expect.arrayContaining([actor.workspaceId, actor.userId, "Min diskreta avatar"]));
  });

  it("requires separate provider consent before source bytes can be used by a model worker", async () => {
    const { sql } = sqlWith([profileRow()]);
    await expect(getSagaAvatarProfileForPrivateModelUse(actor, profileId, sql)).rejects.toBeInstanceOf(SagaAvatarValidationError);
  });

  it("writes provider consent as a separate receipt and only reports ready after 3–6 references", async () => {
    const refs = [1, 2, 3].map((position) => referenceRow({ id: `00000000-0000-4000-8000-00000000000${position}`, position }));
    const { sql, query } = sqlWith([
      profileRow({
        provider_processing_enabled: true,
        provider_processing_provider: "vercel_ai_gateway",
        provider_processing_consent_version: "saga_avatar_vercel_gateway_processing_v1",
        provider_processing_consented_at: "2026-08-25T08:01:00.000Z",
      }),
    ], refs);
    const profile = await updateSagaAvatarProfile(actor, {
      profileId,
      providerProcessingAccepted: true,
    }, sql);

    expect(profile.providerProcessing).toMatchObject({ enabled: true, consented: true, readyForPrivateModelUse: true });
    expect(query.mock.calls[0]?.[0]).toContain("'provider_processing'");
    expect(query.mock.calls[0]?.[1]).toEqual(expect.arrayContaining([actor.workspaceId, profileId, true, actor.userId]));
  });

  it("uses workspace + profile + reference constraints when removing source metadata", async () => {
    const { sql, query } = sqlWith([referenceRow()]);
    await deleteSagaAvatarReferenceMetadata(actor, profileId, referenceId, sql);
    expect(query.mock.calls[0]?.[0]).toContain("workspace_id = $1::uuid");
    expect(query.mock.calls[0]?.[0]).toContain("profile_id = $2::uuid");
    expect(query.mock.calls[0]?.[0]).toContain("profile.created_by_user_id = $4::uuid");
    expect(query.mock.calls[0]?.[1]).toEqual([actor.workspaceId, profileId, referenceId, actor.userId]);
  });

  it("does not expose or mutate one member's private photos for another member of the same workspace", async () => {
    const otherMember: AppActor = {
      ...actor,
      userId: "55555555-5555-4555-8555-555555555555",
      role: "editor",
    };
    const { sql, query } = sqlWith([], [], [], [], [], []);

    await expect(listSagaAvatarProfiles(otherMember, sql)).resolves.toEqual([]);
    await expect(getSagaAvatarProfile(otherMember, profileId, sql)).resolves.toBeNull();
    await expect(updateSagaAvatarProfile(otherMember, { profileId, label: "Inte mitt foto" }, sql)).rejects.toBeInstanceOf(SagaAvatarNotFoundError);
    await expect(getSagaAvatarOwnedReference(otherMember, profileId, referenceId, sql)).resolves.toBeNull();
    await expect(deleteSagaAvatarReferenceMetadata(otherMember, profileId, referenceId, sql)).resolves.toBeNull();
    await expect(deleteSagaAvatarProfileIfEmpty(otherMember, profileId, sql)).resolves.toBe(false);

    for (const [statement, parameters] of query.mock.calls) {
      expect(String(statement)).toContain("created_by_user_id");
      expect(parameters).toContain(otherMember.userId);
    }
  });

  it("fills a deleted reference position instead of exceeding the six-slot limit", async () => {
    const existing = [1, 2, 4, 5, 6].map((position) => referenceRow({
      id: `00000000-0000-4000-8000-00000000000${position}`,
      position,
    }));
    const inserted = referenceRow({ id: "77777777-7777-4777-8777-777777777777", position: 3 });
    const { sql, query } = sqlWith([profileRow()], existing, [inserted]);
    const profile = await createSagaAvatarReferenceMetadata(actor, {
      profileId,
      references: [{
        angle: "three_quarter_right",
        blobUrl: "https://private.blob.vercel-storage.com/server-only.png",
        blobPathname: "studio/workspaces/private/avatar-profiles/private/references/opaque.png" as never,
        contentType: "image/png",
        byteSize: 42,
      }],
    }, sql);
    expect(profile.references.map((reference) => reference.position)).toEqual([1, 2, 3, 4, 5, 6]);
    const insertParams = query.mock.calls[2]?.[1] as unknown[];
    expect(insertParams[4]).toBe(3);
  });

  it("commits a verified direct-Blob batch once and treats an exact retry as a safe idempotent result", async () => {
    const directPaths = [1, 2, 3].map((position) => `studio/workspaces/private/avatar-profiles/private/references/direct-${position}.png`);
    const references = directPaths.map((directPath, index) => ({
      angle: (["front", "three_quarter_right", "back"] as const)[index]!,
      blobUrl: `https://store.private.blob.vercel-storage.com/${directPath}`,
      blobPathname: directPath as never,
      contentType: "image/png" as const,
      byteSize: 42,
    }));
    const inserted = directPaths.map((directPath, index) => referenceRow({
      id: `77777777-7777-4777-8777-77777777777${index}`,
      position: index + 1,
      blob_pathname: directPath,
      blob_url: `https://store.private.blob.vercel-storage.com/${directPath}`,
      content_type: "image/png",
      byte_size: 42,
    }));
    const { sql, query } = sqlWith([profileRow()], [], inserted);
    const first = await finalizeSagaAvatarDirectReferenceUpload(actor, {
      profileId,
      references,
    }, sql);
    expect(first.references).toHaveLength(3);
    expect(query.mock.calls[2]?.[0]).toContain("on conflict (workspace_id, blob_pathname) do nothing");

    const retry = sqlWith([profileRow()], inserted);
    const repeated = await finalizeSagaAvatarDirectReferenceUpload(actor, {
      profileId,
      references,
    }, retry.sql);
    expect(repeated.references).toHaveLength(3);
    expect(retry.query).toHaveBeenCalledTimes(2);
  });

  it("rejects a viewer before a private-reference query is issued", async () => {
    const { sql, query } = sqlWith();
    await expect(createSagaAvatarProfile({ ...actor, role: "viewer" }, { label: "Ska nekas" }, sql)).rejects.toBeInstanceOf(SagaAvatarAccessError);
    expect(query).not.toHaveBeenCalled();
  });
});
