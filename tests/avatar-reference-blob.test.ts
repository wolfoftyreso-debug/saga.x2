import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  put: vi.fn(),
  del: vi.fn(),
}));

vi.mock("@vercel/blob", () => ({
  put: mocks.put,
  del: mocks.del,
  BlobNotFoundError: class BlobNotFoundError extends Error {},
}));

import {
  assertTrustedAvatarReferenceBlobPath,
  createAvatarReferenceBlobPath,
  deleteAvatarReferenceBlob,
  uploadAvatarReferenceBlob,
} from "@/lib/vercel/avatar-reference-blob";
import { VercelBlobMediaError } from "@/lib/vercel/blob-media";

const workspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const profileId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const scope = { workspaceId, profileId };
const originalToken = process.env.BLOB_READ_WRITE_TOKEN;
const pngBytes = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIW2Nk+M/wHwAF/gL+9dz7jwAAAABJRU5ErkJggg==", "base64"));

beforeEach(() => {
  process.env.BLOB_READ_WRITE_TOKEN = "vercel-blob-secret";
  mocks.put.mockReset();
  mocks.del.mockReset();
  mocks.del.mockResolvedValue(undefined);
  mocks.put.mockImplementation(async (pathname: string) => ({
    url: `https://store.private.blob.vercel-storage.com/${pathname}`,
    pathname,
  }));
});

afterEach(() => {
  if (originalToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
  else process.env.BLOB_READ_WRITE_TOKEN = originalToken;
  vi.restoreAllMocks();
});

describe("private avatar reference Blob storage", () => {
  it("stores a signature-validated image at an opaque, private workspace/profile path", async () => {
    const uploaded = await uploadAvatarReferenceBlob({
      scope,
      bytes: pngBytes,
      fileName: "My identifiable face 2026.png",
      contentType: "image/png",
    });

    expect(uploaded.pathname).toMatch(new RegExp(`^studio/workspaces/${workspaceId}/avatar-profiles/${profileId}/references/[0-9a-f-]{36}\\.png$`));
    expect(uploaded.pathname).not.toContain("identifiable");
    expect(mocks.put).toHaveBeenCalledWith(uploaded.pathname, expect.any(Buffer), expect.objectContaining({
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: false,
      contentType: "image/png",
      token: "vercel-blob-secret",
    }));
  });

  it("rejects a spoofed PNG MIME type before private Blob receives bytes", async () => {
    await expect(uploadAvatarReferenceBlob({
      scope,
      bytes: new TextEncoder().encode("<svg><script>alert(1)</script></svg>"),
      fileName: "not-a-photo.png",
      contentType: "image/png",
    })).rejects.toBeInstanceOf(VercelBlobMediaError);
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it("never accepts cross-profile paths or a Blob URL as a deletion/read path", () => {
    const path = createAvatarReferenceBlobPath(scope, "image/jpeg");
    expect(() => assertTrustedAvatarReferenceBlobPath(
      { ...scope, profileId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
      path,
    )).toThrow(VercelBlobMediaError);
    expect(() => assertTrustedAvatarReferenceBlobPath(
      scope,
      "https://store.private.blob.vercel-storage.com/a-photo.jpg",
    )).toThrow(VercelBlobMediaError);
  });

  it("treats an already-deleted Blob as a successful retry so metadata cleanup can finish", async () => {
    const path = createAvatarReferenceBlobPath(scope, "image/jpeg");
    mocks.del.mockRejectedValueOnce(Object.assign(new Error("gone"), { name: "BlobNotFoundError" }));
    await expect(deleteAvatarReferenceBlob({ scope, pathname: path })).resolves.toBeUndefined();
  });
});
