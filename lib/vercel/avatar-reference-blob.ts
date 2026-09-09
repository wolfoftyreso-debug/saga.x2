import "server-only";

import { randomUUID } from "node:crypto";
import { BlobNotFoundError, del, put } from "@vercel/blob";
import {
  MissingVercelBlobConfigurationError,
  VercelBlobMediaError,
} from "@/lib/vercel/blob-media";
import { assertAvatarReferenceImageBytes } from "@/lib/vercel/avatar-reference-image-validation";

const AVATAR_BLOB_PREFIX = "studio/workspaces";
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const ONE_YEAR_IN_SECONDS = 60 * 60 * 24 * 365;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const supportedImageTypes = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
} as const;

export type AvatarReferenceBlobContentType = keyof typeof supportedImageTypes;

declare const trustedAvatarReferenceBlobPath: unique symbol;

/** A server-created storage path that cannot be fabricated from a Blob URL. */
export type TrustedAvatarReferenceBlobPath = string & {
  readonly [trustedAvatarReferenceBlobPath]: true;
};

export type AvatarReferenceBlobScope = {
  workspaceId: string;
  profileId: string;
};

export type UploadedAvatarReferenceBlob = {
  /** Server-only private Blob URL. It must never be sent to an API client. */
  url: string;
  pathname: TrustedAvatarReferenceBlobPath;
  contentType: AvatarReferenceBlobContentType;
  size: number;
};

/**
 * Uploads a user-provided avatar reference to a uniquely generated, private
 * Vercel Blob location. Client paths and direct browser Blob uploads are
 * intentionally unsupported.
 */
export async function uploadAvatarReferenceBlob(input: {
  scope: AvatarReferenceBlobScope;
  bytes: Uint8Array;
  fileName: string;
  contentType: string;
}): Promise<UploadedAvatarReferenceBlob> {
  const token = getVercelBlobToken();
  const scope = normalizeScope(input.scope);
  const contentType = validateContentType(input.contentType);
  const size = validateBytes(input.bytes);
  assertAvatarReferenceImageBytes(input.bytes, contentType);
  // `fileName` is deliberately not used in either the object path or the
  // database. Personal filenames can leak identity information in logs.
  void input.fileName;
  const pathname = createAvatarReferenceBlobPath(scope, contentType);

  let uploaded: Awaited<ReturnType<typeof put>>;
  try {
    uploaded = await put(pathname, Buffer.from(input.bytes), {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: false,
      contentType,
      cacheControlMaxAge: ONE_YEAR_IN_SECONDS,
      token,
    });
  } catch {
    throw new VercelBlobMediaError("Kunde inte lagra den privata referensbilden i Vercel Blob.", 502);
  }

  try {
    if (uploaded.pathname !== pathname) {
      throw new VercelBlobMediaError("Vercel Blob returnerade en oväntad filsökväg.", 502);
    }
    return {
      url: assertPrivateAvatarReferenceBlobUrl(uploaded.url, pathname),
      pathname,
      contentType,
      size,
    };
  } catch (error) {
    // This is a path generated in this function, never browser-supplied data.
    await del(pathname, { token }).catch(() => undefined);
    throw error;
  }
}

export function createAvatarReferenceBlobPath(
  scope: AvatarReferenceBlobScope,
  contentType: AvatarReferenceBlobContentType,
): TrustedAvatarReferenceBlobPath {
  const normalizedScope = normalizeScope(scope);
  const extension = supportedImageTypes[contentType];
  const pathname = `${AVATAR_BLOB_PREFIX}/${normalizedScope.workspaceId}/avatar-profiles/${normalizedScope.profileId}/references/${randomUUID()}.${extension}`;
  return assertTrustedAvatarReferenceBlobPath(normalizedScope, pathname);
}

/** Validates a DB-resolved path before private Blob deletion or reads. */
export function assertTrustedAvatarReferenceBlobPath(
  scope: AvatarReferenceBlobScope,
  pathname: string,
): TrustedAvatarReferenceBlobPath {
  const normalizedScope = normalizeScope(scope);
  if (typeof pathname !== "string" || pathname.length > 512 || pathname.includes("?") || pathname.includes("#")) {
    throw new VercelBlobMediaError("Referensbildens filsökväg är ogiltig.", 400);
  }
  const expectedPrefix = `${AVATAR_BLOB_PREFIX}/${normalizedScope.workspaceId}/avatar-profiles/${normalizedScope.profileId}/references/`;
  if (!pathname.startsWith(expectedPrefix) || !isSafeLeaf(pathname.slice(expectedPrefix.length))) {
    throw new VercelBlobMediaError("Referensbilden ligger utanför den valda privata profilen.", 400);
  }
  return pathname as TrustedAvatarReferenceBlobPath;
}

/** Deletes only a server-validated private path, never a client-provided URL. */
export async function deleteAvatarReferenceBlob(input: {
  scope: AvatarReferenceBlobScope;
  pathname: TrustedAvatarReferenceBlobPath;
}): Promise<void> {
  const token = getVercelBlobToken();
  const pathname = assertTrustedAvatarReferenceBlobPath(input.scope, input.pathname);
  try {
    await del(pathname, { token });
  } catch (error) {
    // A retry after Blob was deleted but before a database metadata deletion
    // committed is safe: the desired byte state has already been achieved.
    if (error instanceof BlobNotFoundError || (error instanceof Error && error.name === "BlobNotFoundError")) return;
    throw new VercelBlobMediaError("Kunde inte ta bort den privata referensbilden från Vercel Blob.", 502);
  }
}

function getVercelBlobToken(): string {
  const token = process.env.BLOB_READ_WRITE_TOKEN?.trim();
  if (!token) throw new MissingVercelBlobConfigurationError();
  return token;
}

function normalizeScope(scope: AvatarReferenceBlobScope): AvatarReferenceBlobScope {
  if (!scope || typeof scope.workspaceId !== "string" || typeof scope.profileId !== "string") {
    throw new VercelBlobMediaError("Arbetsyta och privat profil måste anges för referensbilden.", 400);
  }
  const workspaceId = scope.workspaceId.trim().toLowerCase();
  const profileId = scope.profileId.trim().toLowerCase();
  if (!uuidPattern.test(workspaceId) || !uuidPattern.test(profileId)) {
    throw new VercelBlobMediaError("Arbetsyta och privat profil måste vara giltiga id:n.", 400);
  }
  return { workspaceId, profileId };
}

function validateContentType(value: string): AvatarReferenceBlobContentType {
  const contentType = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!(contentType in supportedImageTypes)) {
    throw new VercelBlobMediaError("Välj en JPG-, PNG- eller WebP-bild.", 400);
  }
  return contentType as AvatarReferenceBlobContentType;
}

function validateBytes(value: Uint8Array): number {
  if (!(value instanceof Uint8Array) || value.byteLength <= 0 || value.byteLength > MAX_IMAGE_BYTES) {
    throw new VercelBlobMediaError("Referensbilden måste vara större än 0 och högst 20 MB.", 400);
  }
  return value.byteLength;
}

function isSafeLeaf(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|png|webp)$/i.test(value);
}

/** Validates Blob metadata received server-to-server before it reaches Neon. */
export function assertPrivateAvatarReferenceBlobUrl(value: string, expectedPathname: TrustedAvatarReferenceBlobPath): string {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:"
      // A generic `.blob.vercel-storage.com` suffix also matches public
      // stores. Source references may only ever live in a private store.
      || !url.hostname.endsWith(".private.blob.vercel-storage.com")
      || url.username
      || url.password
      || url.search
      || url.hash
      || url.pathname !== `/${expectedPathname}`
    ) {
      throw new Error("invalid Blob URL");
    }
    return url.toString();
  } catch {
    throw new VercelBlobMediaError("Vercel Blob returnerade en ogiltig privat filadress.", 502);
  }
}
