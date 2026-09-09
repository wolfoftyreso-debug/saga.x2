import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  neonConfigurationResponse: vi.fn(),
  requireNeonActor: vi.fn(),
  getProfile: vi.fn(),
  finalize: vi.fn(),
  handleUpload: vi.fn(),
  get: vi.fn(),
  isBlobConfigured: vi.fn(),
}));

vi.mock("@vercel/blob/client", () => ({ handleUpload: mocks.handleUpload }));
vi.mock("@vercel/blob", () => ({
  get: mocks.get,
  del: vi.fn(),
  put: vi.fn(),
  BlobNotFoundError: class BlobNotFoundError extends Error {},
}));
vi.mock("@/lib/neon/http", () => ({
  neonConfigurationResponse: mocks.neonConfigurationResponse,
  requireNeonActor: mocks.requireNeonActor,
}));
vi.mock("@/lib/neon/saga-avatar-repository", () => ({
  getSagaAvatarProfile: mocks.getProfile,
  finalizeSagaAvatarDirectReferenceUpload: mocks.finalize,
  SagaAvatarValidationError: class SagaAvatarValidationError extends Error {},
  SagaAvatarAccessError: class SagaAvatarAccessError extends Error {},
  SagaAvatarConflictError: class SagaAvatarConflictError extends Error {},
  SagaAvatarNotFoundError: class SagaAvatarNotFoundError extends Error {},
}));
vi.mock("@/lib/vercel/blob-media", () => ({
  isVercelBlobConfigured: mocks.isBlobConfigured,
  VercelBlobMediaError: class VercelBlobMediaError extends Error {
    constructor(message: string, readonly status: number) { super(message); this.name = "VercelBlobMediaError"; }
  },
}));

import { POST as issueGrant } from "@/app/api/saga/avatar-profiles/[profileId]/upload-grant/route";
import { POST as issueClientToken } from "@/app/api/saga/avatar-upload/route";
import { POST as finalize } from "@/app/api/saga/avatar-profiles/[profileId]/upload-finalize/route";

const actor = {
  userId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  role: "owner" as const,
  email: null,
  displayName: null,
};
const profileId = "33333333-3333-4333-8333-333333333333";
const png = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIW2Nk+M/wHwAF/gL+9dz7jwAAAABJRU5ErkJggg==", "base64"));
const originalBlobToken = process.env.BLOB_READ_WRITE_TOKEN;

function request(path: string, body: unknown) {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  process.env.BLOB_READ_WRITE_TOKEN = "private-blob-test-secret";
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.neonConfigurationResponse.mockReturnValue(null);
  mocks.requireNeonActor.mockResolvedValue({ actor });
  mocks.isBlobConfigured.mockReturnValue(true);
  mocks.getProfile.mockResolvedValue({ id: profileId, referenceCount: 0 });
});

afterEach(() => {
  if (originalBlobToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
  else process.env.BLOB_READ_WRITE_TOKEN = originalBlobToken;
});

async function createGrant() {
  const response = await issueGrant(request(`/api/saga/avatar-profiles/${profileId}/upload-grant`, {
    uploadConsent: true,
    files: [
      { angle: "front", contentType: "image/png", byteSize: png.byteLength },
      { angle: "three_quarter_left", contentType: "image/png", byteSize: png.byteLength },
      { angle: "back", contentType: "image/png", byteSize: png.byteLength },
    ],
  }), { params: Promise.resolve({ profileId }) });
  expect(response.status).toBe(201);
  return await response.json() as { grant: string; uploads: Array<{ id: string; pathname: string }> };
}

describe("SAGA direct-avatar upload API", () => {
  it("pins client-token issuance to the signed actor, one pathname, MIME type and byte limit", async () => {
    const grant = await createGrant();
    const upload = grant.uploads[0]!;
    mocks.handleUpload.mockImplementation(async ({ onBeforeGenerateToken }: {
      onBeforeGenerateToken: (pathname: string, clientPayload: string | null, multipart: boolean) => Promise<unknown>;
    }) => {
      const options = await onBeforeGenerateToken(
        upload.pathname,
        JSON.stringify({ grant: grant.grant, uploadId: upload.id }),
        true,
      );
      expect(options).toMatchObject({
        allowedContentTypes: ["image/png"],
        maximumSizeInBytes: png.byteLength,
        addRandomSuffix: false,
        allowOverwrite: false,
      });
      return { type: "blob.generate-client-token", clientToken: "opaque-client-token" };
    });

    const response = await issueClientToken(request("/api/saga/avatar-upload", { type: "blob.generate-client-token" }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ type: "blob.generate-client-token", clientToken: "opaque-client-token" });
    expect(JSON.stringify(body)).not.toContain("private-blob-test-secret");
  });

  it("finalizes only after server-side private Blob byte validation and returns a safe profile projection", async () => {
    const grant = await createGrant();
    mocks.get.mockImplementation(async (pathname: string) => ({
      statusCode: 200,
      blob: {
        pathname,
        contentType: "image/png",
        size: png.byteLength,
        url: `https://store.private.blob.vercel-storage.com/${pathname}`,
      },
      stream: new ReadableStream({ start(controller) { controller.enqueue(png); controller.close(); } }),
    }));
    mocks.finalize.mockResolvedValue({
      id: profileId,
      outputVisibilityPolicy: "obscured_noir_only",
      fullFaceAllowed: false,
      references: [{ id: "safe", angle: "front", position: 1 }],
    });

    const response = await finalize(request(`/api/saga/avatar-profiles/${profileId}/upload-finalize`, { grant: grant.grant }), {
      params: Promise.resolve({ profileId }),
    });
    expect(response.status).toBe(201);
    expect(mocks.get).toHaveBeenCalledTimes(3);
    expect(mocks.finalize).toHaveBeenCalledWith(actor, expect.objectContaining({
      profileId,
      references: expect.arrayContaining([expect.objectContaining({ contentType: "image/png", byteSize: png.byteLength })]),
    }));
    const body = await response.json();
    expect(JSON.stringify(body)).not.toContain("blob.vercel-storage.com");
  });
});
