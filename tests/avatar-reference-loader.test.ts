import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  getProfile: vi.fn(),
}));

vi.mock("@vercel/blob", () => ({ get: mocks.get }));
vi.mock("@/lib/neon/saga-avatar-repository", () => ({
  getSagaAvatarProfileForPrivateModelUse: mocks.getProfile,
}));

import { loadAvatarReferenceBytesForPrivateModel, SagaAvatarReferenceLoaderError } from "@/lib/vercel/avatar-reference-loader";
import { assertSagaAvatarGenerationCanStart, buildSagaAvatarGenerationPolicy } from "@/lib/services/saga-avatar-privacy";

const actor = {
  userId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  role: "owner" as const,
  email: null,
  displayName: null,
};
const profileId = "33333333-3333-4333-8333-333333333333";
const referenceIds = [
  "44444444-4444-4444-8444-444444444444",
  "55555555-5555-4555-8555-555555555555",
  "66666666-6666-4666-8666-666666666666",
];
const paths = referenceIds.map((_, index) => `studio/workspaces/${actor.workspaceId}/avatar-profiles/${profileId}/references/00000000-0000-4000-8000-00000000000${index + 1}.png`);
const png = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIW2Nk+M/wHwAF/gL+9dz7jwAAAABJRU5ErkJggg==", "base64"));
const originalToken = process.env.BLOB_READ_WRITE_TOKEN;

beforeEach(() => {
  process.env.BLOB_READ_WRITE_TOKEN = "blob-secret";
  mocks.get.mockReset();
  mocks.getProfile.mockReset();
  mocks.getProfile.mockResolvedValue({
    id: profileId,
    workspaceId: actor.workspaceId,
    references: referenceIds.map((id, index) => ({
      id,
      profileId,
      angle: index === 0 ? "front" : index === 1 ? "three_quarter_left" : "back",
      position: index + 1,
      blobUrl: "https://private.blob.vercel-storage.com/never-returned.png",
      blobPathname: paths[index],
      contentType: "image/png",
      byteSize: png.byteLength,
      createdAt: "2026-08-25T08:00:00.000Z",
    })),
  });
});

afterEach(() => {
  if (originalToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
  else process.env.BLOB_READ_WRITE_TOKEN = originalToken;
  vi.restoreAllMocks();
});

describe("private avatar reference model handoff", () => {
  function approvedPolicy() {
    return assertSagaAvatarGenerationCanStart({
      avatarProfileId: profileId,
      referenceImageIds: referenceIds,
      presentation: "noir_shadow",
      requestedVisualDirection: "En lugn, ansiktsdold noirbild.",
      providerTransferConsent: {
        allowReferenceTransferForThisRun: true,
        retentionChoice: "acknowledged_provider_terms",
      },
    });
  }

  it("returns bytes only after server-side model consent resolution, never a Blob URL", async () => {
    mocks.get.mockImplementation(async () => ({
      blob: { contentType: "image/png", size: png.byteLength },
      stream: new Response(png).body,
    }));
    const result = await loadAvatarReferenceBytesForPrivateModel({ actor, profileId, policy: approvedPolicy() });

    expect(mocks.getProfile).toHaveBeenCalledWith(actor, profileId);
    expect(mocks.get).toHaveBeenCalledWith(paths[0], { access: "private", token: "blob-secret" });
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ id: referenceIds[0], angle: "front", contentType: "image/png", bytes: png });
    expect(result[0]).not.toHaveProperty("url");
  });

  it("rejects MIME-spoofed bytes again immediately before model transfer", async () => {
    mocks.get.mockResolvedValue({
      blob: { contentType: "image/png", size: png.byteLength },
      stream: new Response(new Uint8Array(png.byteLength).fill(0x3c)).body,
    });
    await expect(loadAvatarReferenceBytesForPrivateModel({ actor, profileId, policy: approvedPolicy() })).rejects.toBeInstanceOf(SagaAvatarReferenceLoaderError);
  });

  it("rejects a lookalike policy that skipped the explicit per-run authorization assertion", async () => {
    const policy = buildSagaAvatarGenerationPolicy({
      avatarProfileId: profileId,
      referenceImageIds: referenceIds,
      presentation: "noir_shadow",
      requestedVisualDirection: "En lugn, ansiktsdold noirbild.",
      providerTransferConsent: {
        allowReferenceTransferForThisRun: true,
        retentionChoice: "acknowledged_provider_terms",
      },
    });
    await expect(loadAvatarReferenceBytesForPrivateModel({ actor, profileId, policy })).rejects.toMatchObject({ status: 400 });
    expect(mocks.get).not.toHaveBeenCalled();
  });
});
