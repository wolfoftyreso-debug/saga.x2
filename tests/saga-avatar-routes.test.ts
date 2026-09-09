import { describe, expect, it, beforeEach, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  neonConfigurationResponse: vi.fn(),
  requireNeonActor: vi.fn(),
  createProfile: vi.fn(),
  listProfiles: vi.fn(),
  getProfile: vi.fn(),
  createReferences: vi.fn(),
  isBlobConfigured: vi.fn(),
  upload: vi.fn(),
  deleteBlob: vi.fn(),
  getOwnedReference: vi.fn(),
  deleteReferenceMetadata: vi.fn(),
  assertPath: vi.fn(),
}));

vi.mock("@/lib/neon/http", () => ({
  neonConfigurationResponse: mocks.neonConfigurationResponse,
  requireNeonActor: mocks.requireNeonActor,
}));
vi.mock("@/lib/neon/saga-avatar-repository", () => ({
  createSagaAvatarProfile: mocks.createProfile,
  listSagaAvatarProfiles: mocks.listProfiles,
  getSagaAvatarProfile: mocks.getProfile,
  createSagaAvatarReferenceMetadata: mocks.createReferences,
  getSagaAvatarOwnedReference: mocks.getOwnedReference,
  deleteSagaAvatarReferenceMetadata: mocks.deleteReferenceMetadata,
  SagaAvatarValidationError: class SagaAvatarValidationError extends Error {
    constructor(message: string) { super(message); this.name = "SagaAvatarValidationError"; }
  },
  SagaAvatarConflictError: class SagaAvatarConflictError extends Error {},
  SagaAvatarAccessError: class SagaAvatarAccessError extends Error {},
  SagaAvatarNotFoundError: class SagaAvatarNotFoundError extends Error {},
}));
vi.mock("@/lib/vercel/blob-media", () => ({
  isVercelBlobConfigured: mocks.isBlobConfigured,
  VercelBlobMediaError: class VercelBlobMediaError extends Error {
    status: number;
    constructor(message: string, status: number) { super(message); this.name = "VercelBlobMediaError"; this.status = status; }
  },
}));
vi.mock("@/lib/vercel/avatar-reference-blob", () => ({
  uploadAvatarReferenceBlob: mocks.upload,
  deleteAvatarReferenceBlob: mocks.deleteBlob,
  assertTrustedAvatarReferenceBlobPath: mocks.assertPath,
}));

import { GET as listProfiles, POST as createProfile } from "@/app/api/saga/avatar-profiles/route";
import { POST as uploadReferences } from "@/app/api/saga/avatar-profiles/[profileId]/references/route";
import { DELETE as deleteReference } from "@/app/api/saga/avatar-profiles/[profileId]/references/[referenceId]/route";

const actor = {
  userId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  role: "owner" as const,
  email: null,
  displayName: null,
};
const profileId = "33333333-3333-4333-8333-333333333333";
const png = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIW2Nk+M/wHwAF/gL+9dz7jwAAAABJRU5ErkJggg==", "base64"));

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.neonConfigurationResponse.mockReturnValue(null);
  mocks.requireNeonActor.mockResolvedValue({ actor });
  mocks.isBlobConfigured.mockReturnValue(true);
  mocks.getProfile.mockResolvedValue({ id: profileId, referenceCount: 0 });
  mocks.upload.mockResolvedValue({
    url: "https://private.blob.vercel-storage.com/server-only.png",
    pathname: `studio/workspaces/${actor.workspaceId}/avatar-profiles/${profileId}/references/44444444-4444-4444-8444-444444444444.png`,
    contentType: "image/png",
    size: png.byteLength,
  });
  mocks.deleteBlob.mockResolvedValue(undefined);
  mocks.assertPath.mockImplementation((_scope: unknown, pathname: unknown) => pathname);
});

describe("SAGA avatar API contracts", () => {
  it("returns the Vercel/Neon configuration response with no-store before using a session", async () => {
    mocks.neonConfigurationResponse.mockReturnValue(NextResponse.json(
      { error: "configuration" },
      { status: 503, headers: { "cache-control": "no-store" } },
    ));
    const response = await listProfiles();
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.requireNeonActor).not.toHaveBeenCalled();
  });

  it("requires explicit reference-upload consent and rejects a client workspace id", async () => {
    const rejected = await createProfile(new NextRequest("http://localhost/api/saga/avatar-profiles", {
      method: "POST",
      body: JSON.stringify({ label: "Jag", uploadConsent: true, workspaceId: "not-allowed" }),
      headers: { "content-type": "application/json" },
    }));
    expect(rejected.status).toBe(422);
    expect(mocks.createProfile).not.toHaveBeenCalled();

    mocks.createProfile.mockResolvedValue({ id: profileId });
    const accepted = await createProfile(new NextRequest("http://localhost/api/saga/avatar-profiles", {
      method: "POST",
      body: JSON.stringify({ label: "Jag", uploadConsent: true }),
      headers: { "content-type": "application/json" },
    }));
    expect(accepted.status).toBe(201);
    expect(mocks.createProfile).toHaveBeenCalledWith(actor, { label: "Jag", uploadConsent: true });

    const missingConsent = await createProfile(new NextRequest("http://localhost/api/saga/avatar-profiles", {
      method: "POST",
      body: JSON.stringify({ label: "Jag" }),
      headers: { "content-type": "application/json" },
    }));
    expect(missingConsent.status).toBe(422);
  });

  it("accepts only a consented, angle-aligned multipart reference batch and returns a safe profile projection", async () => {
    const form = new FormData();
    form.set("uploadConsent", "true");
    form.set("angles", JSON.stringify(["front", "three_quarter_left", "back"]));
    form.append("files", new File([png], "me.png", { type: "image/png" }));
    form.append("files", new File([png], "me-left.png", { type: "image/png" }));
    form.append("files", new File([png], "me-back.png", { type: "image/png" }));
    mocks.createReferences.mockResolvedValue({ id: profileId, references: [{ id: "safe" }] });

    const response = await uploadReferences(new NextRequest("http://localhost/api/saga/avatar-profiles/x/references", {
      method: "POST",
      body: form,
    }), { params: Promise.resolve({ profileId }) });
    expect(response.status).toBe(201);
    expect(mocks.upload).toHaveBeenCalledTimes(3);
    expect(mocks.createReferences).toHaveBeenCalledWith(actor, expect.objectContaining({
      profileId,
      references: expect.arrayContaining([expect.not.objectContaining({ fileName: expect.anything() })]),
    }));
    expect(await response.json()).not.toHaveProperty("url");
  });

  it("does not start a Blob upload without the per-upload consent field", async () => {
    const form = new FormData();
    form.set("angles", JSON.stringify(["front", "three_quarter_left", "back"]));
    form.append("files", new File([png], "me.png", { type: "image/png" }));
    form.append("files", new File([png], "me-left.png", { type: "image/png" }));
    form.append("files", new File([png], "me-back.png", { type: "image/png" }));
    const response = await uploadReferences(new NextRequest("http://localhost/api/saga/avatar-profiles/x/references", {
      method: "POST",
      body: form,
    }), { params: Promise.resolve({ profileId }) });
    expect(response.status).toBe(422);
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it("rejects a missing angle map and a MIME-spoofed payload before Blob upload", async () => {
    const missingAngles = new FormData();
    missingAngles.set("uploadConsent", "true");
    missingAngles.append("files", new File([png], "me.png", { type: "image/png" }));
    missingAngles.append("files", new File([png], "me-left.png", { type: "image/png" }));
    missingAngles.append("files", new File([png], "me-back.png", { type: "image/png" }));
    const missingAnglesResponse = await uploadReferences(new NextRequest("http://localhost/api/saga/avatar-profiles/x/references", {
      method: "POST",
      body: missingAngles,
    }), { params: Promise.resolve({ profileId }) });
    expect(missingAnglesResponse.status).toBe(422);
    expect(mocks.upload).not.toHaveBeenCalled();

    const spoofed = new FormData();
    spoofed.set("uploadConsent", "true");
    spoofed.set("angles", JSON.stringify(["front", "three_quarter_left", "back"]));
    const html = new TextEncoder().encode("<html>not an image</html>");
    spoofed.append("files", new File([html], "me.png", { type: "image/png" }));
    spoofed.append("files", new File([png], "me-left.png", { type: "image/png" }));
    spoofed.append("files", new File([png], "me-back.png", { type: "image/png" }));
    const spoofedResponse = await uploadReferences(new NextRequest("http://localhost/api/saga/avatar-profiles/x/references", {
      method: "POST",
      body: spoofed,
    }), { params: Promise.resolve({ profileId }) });
    expect(spoofedResponse.status).toBe(400);
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it("deletes only a reference resolved through the authenticated actor and never returns its private storage metadata", async () => {
    const referenceId = "44444444-4444-4444-8444-444444444444";
    const pathname = `studio/workspaces/${actor.workspaceId}/avatar-profiles/${profileId}/references/55555555-5555-4555-8555-555555555555.png`;
    mocks.getOwnedReference.mockResolvedValue({
      id: referenceId,
      profileId,
      angle: "front",
      position: 1,
      blobPathname: pathname,
      blobUrl: "https://private.blob.vercel-storage.com/not-returned.png",
      contentType: "image/png",
      byteSize: png.byteLength,
      createdAt: "2026-08-25T08:00:00.000Z",
    });
    mocks.deleteReferenceMetadata.mockResolvedValue({ id: referenceId });
    const response = await deleteReference(new Request("http://localhost/api/saga/avatar-profiles/x/references/y", { method: "DELETE" }), {
      params: Promise.resolve({ profileId, referenceId }),
    });
    expect(response.status).toBe(200);
    expect(mocks.getOwnedReference).toHaveBeenCalledWith(actor, profileId, referenceId);
    expect(mocks.deleteReferenceMetadata).toHaveBeenCalledWith(actor, profileId, referenceId);
    expect(await response.json()).toEqual({ ok: true, cleanup: "complete" });
  });
});
