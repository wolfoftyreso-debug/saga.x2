import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  put: vi.fn(),
  del: vi.fn(),
}));

vi.mock("@vercel/blob", () => ({
  put: mocks.put,
  del: mocks.del,
}));

import {
  MissingVercelBlobConfigurationError,
  VercelBlobMediaError,
  assertTrustedStudioBlobPath,
  createStudioBlobPath,
  deleteStudioBlob,
  isVercelBlobConfigured,
  missingVercelBlobConfiguration,
  uploadStudioBlob,
} from "@/lib/vercel/blob-media";

const workspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const draftId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const scope = { workspaceId, draftId };
const originalToken = process.env.BLOB_READ_WRITE_TOKEN;

beforeEach(() => {
  mocks.put.mockReset();
  mocks.del.mockReset();
  process.env.BLOB_READ_WRITE_TOKEN = "vercel-blob-secret";
  mocks.put.mockImplementation(async (pathname: string, _body: unknown, options: unknown) => ({
    url: `https://store.public.blob.vercel-storage.com/${pathname}`,
    pathname,
    contentType: "image/png",
    contentDisposition: "inline",
    downloadUrl: `https://store.public.blob.vercel-storage.com/${pathname}?download=1`,
    etag: "etag",
    options,
  }));
  mocks.del.mockResolvedValue(undefined);
});

afterEach(() => {
  if (originalToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
  else process.env.BLOB_READ_WRITE_TOKEN = originalToken;
  vi.restoreAllMocks();
});

describe.sequential("Vercel Blob Studio media", () => {
  it("keeps Blob configuration server-side", () => {
    delete process.env.BLOB_READ_WRITE_TOKEN;
    expect(missingVercelBlobConfiguration()).toEqual(["BLOB_READ_WRITE_TOKEN"]);
    expect(isVercelBlobConfigured()).toBe(false);
    expect(() => createStudioBlobPath(scope, "bild.png", "image/png")).not.toThrow();
  });

  it("creates only private, workspace-and-draft-scoped image objects", async () => {
    const result = await uploadStudioBlob({
      scope,
      bytes: new Uint8Array([1, 2, 3]),
      fileName: "Min fina bild.PNG",
      contentType: "IMAGE/PNG",
    });

    expect(result).toMatchObject({
      url: expect.stringMatching(/^https:\/\//),
      contentType: "image/png",
      size: 3,
    });
    expect(result.pathname).toMatch(new RegExp(`^studio/workspaces/${workspaceId}/drafts/${draftId}/`));
    expect(mocks.put).toHaveBeenCalledWith(
      result.pathname,
      expect.any(Buffer),
      expect.objectContaining({
        access: "private",
        addRandomSuffix: false,
        allowOverwrite: false,
        contentType: "image/png",
        token: "vercel-blob-secret",
      }),
    );
  });

  it("rejects unsafe file metadata before calling Blob", async () => {
    await expect(uploadStudioBlob({
      scope,
      bytes: new Uint8Array([1]),
      fileName: "../other-draft.png",
      contentType: "image/png",
    })).rejects.toBeInstanceOf(VercelBlobMediaError);

    await expect(uploadStudioBlob({
      scope,
      bytes: new Uint8Array([1]),
      fileName: "unsafe.gif",
      contentType: "image/gif",
    })).rejects.toMatchObject({ status: 400 });
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it("requires the server token before uploading", async () => {
    delete process.env.BLOB_READ_WRITE_TOKEN;
    await expect(uploadStudioBlob({
      scope,
      bytes: new Uint8Array([1]),
      fileName: "bild.png",
      contentType: "image/png",
    })).rejects.toBeInstanceOf(MissingVercelBlobConfigurationError);
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it("does not accept URLs or other-workspace paths for deletion", async () => {
    const trusted = createStudioBlobPath(scope, "bild.png", "image/png");
    expect(() => assertTrustedStudioBlobPath(scope, "https://store.public.blob.vercel-storage.com/anything")).toThrow(VercelBlobMediaError);
    expect(() => assertTrustedStudioBlobPath({ ...scope, draftId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }, trusted)).toThrow(VercelBlobMediaError);

    await deleteStudioBlob({ scope, pathname: trusted });
    expect(mocks.del).toHaveBeenCalledWith(trusted, { token: "vercel-blob-secret" });
  });
});
