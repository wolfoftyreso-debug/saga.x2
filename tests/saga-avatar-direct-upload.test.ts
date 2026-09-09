import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppActor } from "@/lib/neon/auth-repository";
import {
  createSagaAvatarDirectUploadGrant,
  resolveSagaAvatarDirectUploadFile,
  SagaAvatarDirectUploadError,
  verifySagaAvatarDirectUploadGrant,
} from "@/lib/services/saga-avatar-direct-upload";
import { assertPrivateAvatarReferenceBlobUrl } from "@/lib/vercel/avatar-reference-blob";
import { VercelBlobMediaError } from "@/lib/vercel/blob-media";

const actor: AppActor = {
  userId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  role: "owner",
  email: null,
  displayName: null,
};
const profileId = "33333333-3333-4333-8333-333333333333";
const originalToken = process.env.BLOB_READ_WRITE_TOKEN;

beforeEach(() => {
  process.env.BLOB_READ_WRITE_TOKEN = "private-blob-test-secret";
});

afterEach(() => {
  if (originalToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
  else process.env.BLOB_READ_WRITE_TOKEN = originalToken;
});

function createGrant(now = Date.UTC(2026, 7, 26, 10, 0, 0)) {
  return createSagaAvatarDirectUploadGrant(actor, profileId, {
    uploadConsent: true,
    files: [
      { angle: "front", contentType: "image/jpeg", byteSize: 101 },
      { angle: "three_quarter_left", contentType: "image/png", byteSize: 102 },
      { angle: "back", contentType: "image/webp", byteSize: 103 },
    ],
  }, now);
}

describe("SAGA direct private avatar uploads", () => {
  it("issues a short-lived, path-bound grant with no public URL or source filename", () => {
    const issued = createGrant();
    expect(issued.uploads).toHaveLength(3);
    expect(JSON.stringify(issued)).not.toContain("https://");
    expect(JSON.stringify(issued)).not.toContain("filename");
    expect(issued.uploads[0]?.pathname).toMatch(
      new RegExp(`^studio/workspaces/${actor.workspaceId}/avatar-profiles/${profileId}/references/[0-9a-f-]{36}\\.jpg$`),
    );

    const verified = verifySagaAvatarDirectUploadGrant(actor, issued.grant, profileId, Date.UTC(2026, 7, 26, 10, 1, 0));
    const upload = resolveSagaAvatarDirectUploadFile(verified, issued.uploads[0]!.id, issued.uploads[0]!.pathname);
    expect(upload.contentType).toBe("image/jpeg");
  });

  it("rejects a changed grant, another actor and a path outside its single allowed upload", () => {
    const now = Date.UTC(2026, 7, 26, 10, 0, 0);
    const issued = createGrant(now);
    const altered = `${issued.grant.slice(0, -1)}${issued.grant.endsWith("a") ? "b" : "a"}`;
    expect(() => verifySagaAvatarDirectUploadGrant(actor, altered, profileId, now)).toThrow(SagaAvatarDirectUploadError);
    expect(() => verifySagaAvatarDirectUploadGrant({ ...actor, userId: "44444444-4444-4444-8444-444444444444" }, issued.grant, profileId, now)).toThrow(SagaAvatarDirectUploadError);

    const verified = verifySagaAvatarDirectUploadGrant(actor, issued.grant, profileId, now);
    expect(() => resolveSagaAvatarDirectUploadFile(verified, issued.uploads[0]!.id, "studio/workspaces/other/file.png")).toThrow(SagaAvatarDirectUploadError);
  });

  it("expires a grant rather than allowing a later hidden upload", () => {
    const now = Date.UTC(2026, 7, 26, 10, 0, 0);
    const issued = createGrant(now);
    expect(() => verifySagaAvatarDirectUploadGrant(actor, issued.grant, profileId, now + 20 * 60 * 1000)).toThrow(SagaAvatarDirectUploadError);
  });

  it("never accepts a public Blob URL as a private source image", () => {
    const issued = createGrant();
    const pathname = issued.uploads[0]!.pathname as never;
    expect(() => assertPrivateAvatarReferenceBlobUrl(
      `https://store.public.blob.vercel-storage.com/${pathname}`,
      pathname,
    )).toThrow(VercelBlobMediaError);
  });
});
