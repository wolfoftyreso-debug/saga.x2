import "server-only";

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  sagaAvatarProfileIdSchema,
  sagaAvatarReferenceAngleSchema,
  type SagaAvatarReferenceAngle,
} from "@/lib/domain/saga-avatar";
import type { AppActor } from "@/lib/neon/auth-repository";
import {
  createAvatarReferenceBlobPath,
  assertTrustedAvatarReferenceBlobPath,
  type AvatarReferenceBlobContentType,
  type AvatarReferenceBlobScope,
  type TrustedAvatarReferenceBlobPath,
} from "@/lib/vercel/avatar-reference-blob";

/**
 * Vercel Functions only accept a 4.5 MB request body, while a legitimate
 * private reference image may be much larger. The browser therefore uploads
 * directly to a *private* Blob path using a narrowly scoped client token.
 *
 * This grant is not an authorization to read a source image, call a model, or
 * publish anything. It only permits a single write to one server-chosen path.
 */
export const SAGA_AVATAR_DIRECT_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
export const SAGA_AVATAR_DIRECT_UPLOAD_GRANT_TTL_MS = 20 * 60 * 1000;

const grantVersion = "saga-avatar-direct-upload/v1" as const;
const contentTypeSchema = z.enum(["image/jpeg", "image/png", "image/webp"]);

export const sagaAvatarDirectUploadRequestSchema = z.object({
  uploadConsent: z.literal(true),
  files: z.array(z.object({
    angle: sagaAvatarReferenceAngleSchema,
    contentType: contentTypeSchema,
    byteSize: z.number().int().min(12).max(SAGA_AVATAR_DIRECT_UPLOAD_MAX_BYTES),
  }).strict()).min(1).max(6),
}).strict();

export const sagaAvatarDirectUploadFinalizeSchema = z.object({
  grant: z.string().trim().min(32).max(8_192),
}).strict();

export const sagaAvatarDirectUploadClientPayloadSchema = z.object({
  grant: z.string().trim().min(32).max(8_192),
  uploadId: z.string().uuid(),
}).strict();

type DirectUploadFile = {
  id: string;
  angle: SagaAvatarReferenceAngle;
  contentType: AvatarReferenceBlobContentType;
  byteSize: number;
  pathname: TrustedAvatarReferenceBlobPath;
};

export type SagaAvatarDirectUploadGrantPayload = {
  version: typeof grantVersion;
  issuedAt: number;
  expiresAt: number;
  workspaceId: string;
  userId: string;
  profileId: string;
  files: DirectUploadFile[];
};

const directUploadGrantPayloadSchema = z.object({
  version: z.literal(grantVersion),
  issuedAt: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
  workspaceId: z.string().uuid(),
  userId: z.string().uuid(),
  profileId: z.string().uuid(),
  files: z.array(z.object({
    id: z.string().uuid(),
    angle: sagaAvatarReferenceAngleSchema,
    contentType: contentTypeSchema,
    byteSize: z.number().int().min(12).max(SAGA_AVATAR_DIRECT_UPLOAD_MAX_BYTES),
    pathname: z.string().min(1).max(512),
  }).strict()).min(1).max(6),
}).strict();

export type SagaAvatarDirectUploadGrant = {
  /** Opaque, signed and short-lived. Never store it in localStorage. */
  grant: string;
  expiresAt: string;
  uploads: Array<{
    id: string;
    pathname: string;
    angle: SagaAvatarReferenceAngle;
    contentType: AvatarReferenceBlobContentType;
    byteSize: number;
  }>;
};

export class SagaAvatarDirectUploadError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 422 | 503,
  ) {
    super(message);
    this.name = "SagaAvatarDirectUploadError";
  }
}

/** Creates path-bound direct-upload authority after the route authenticated its actor. */
export function createSagaAvatarDirectUploadGrant(
  actor: AppActor,
  profileIdInput: string,
  input: z.input<typeof sagaAvatarDirectUploadRequestSchema>,
  now = Date.now(),
): SagaAvatarDirectUploadGrant {
  const parsed = sagaAvatarDirectUploadRequestSchema.safeParse(input);
  if (!parsed.success) {
    throw new SagaAvatarDirectUploadError("Välj mellan en och sex giltiga privata bildfiler och bekräfta samtycket.", 422);
  }
  const profileId = sagaAvatarProfileIdSchema.safeParse(profileIdInput);
  if (!profileId.success) throw new SagaAvatarDirectUploadError("Ogiltigt profil-id för privata referensbilder.", 400);
  const scope: AvatarReferenceBlobScope = { workspaceId: actor.workspaceId, profileId: profileId.data };
  const payload: SagaAvatarDirectUploadGrantPayload = {
    version: grantVersion,
    issuedAt: now,
    expiresAt: now + SAGA_AVATAR_DIRECT_UPLOAD_GRANT_TTL_MS,
    workspaceId: actor.workspaceId,
    userId: actor.userId,
    profileId: profileId.data,
    files: parsed.data.files.map((file) => ({
      id: randomUUID(),
      angle: file.angle,
      contentType: file.contentType,
      byteSize: file.byteSize,
      pathname: createAvatarReferenceBlobPath(scope, file.contentType),
    })),
  };
  const grant = signPayload(payload);
  return {
    grant,
    expiresAt: new Date(payload.expiresAt).toISOString(),
    uploads: payload.files.map((file) => ({ ...file, pathname: file.pathname })),
  };
}

/** Verifies grant integrity, expiry and the current signed-in actor. */
export function verifySagaAvatarDirectUploadGrant(
  actor: AppActor,
  grant: string,
  profileIdInput?: string,
  now = Date.now(),
): SagaAvatarDirectUploadGrantPayload {
  const [encoded, signature, ...rest] = typeof grant === "string" ? grant.split(".") : [];
  if (!encoded || !signature || rest.length) {
    throw new SagaAvatarDirectUploadError("Den privata uppladdningsbehörigheten är ogiltig. Börja om uppladdningen.", 400);
  }
  const expected = signatureFor(encoded);
  const actualBytes = Buffer.from(signature, "base64url");
  const expectedBytes = Buffer.from(expected, "base64url");
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
    throw new SagaAvatarDirectUploadError("Den privata uppladdningsbehörigheten är ogiltig. Börja om uppladdningen.", 400);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new SagaAvatarDirectUploadError("Den privata uppladdningsbehörigheten är ogiltig. Börja om uppladdningen.", 400);
  }
  const parsed = directUploadGrantPayloadSchema.safeParse(value);
  if (!parsed.success) {
    throw new SagaAvatarDirectUploadError("Den privata uppladdningsbehörigheten är ogiltig. Börja om uppladdningen.", 400);
  }
  const payload = parsed.data;
  if (payload.issuedAt > now || payload.expiresAt <= now || payload.expiresAt - payload.issuedAt > SAGA_AVATAR_DIRECT_UPLOAD_GRANT_TTL_MS) {
    throw new SagaAvatarDirectUploadError("Uppladdningsbehörigheten har gått ut. Välj bilderna igen.", 422);
  }
  if (payload.workspaceId !== actor.workspaceId || payload.userId !== actor.userId) {
    throw new SagaAvatarDirectUploadError("Den privata uppladdningsbehörigheten tillhör inte den här arbetsytan.", 403);
  }
  if (profileIdInput !== undefined && payload.profileId !== profileIdInput) {
    throw new SagaAvatarDirectUploadError("Uppladdningsbehörigheten tillhör inte den här privata referensen.", 403);
  }
  return {
    ...payload,
    files: payload.files.map((file) => ({
      ...file,
      pathname: assertTrustedAvatarReferenceBlobPath(
        { workspaceId: actor.workspaceId, profileId: payload.profileId },
        file.pathname,
      ),
    })),
  };
}

/** Resolves exactly one server-generated direct-upload path for Blob token issuance. */
export function resolveSagaAvatarDirectUploadFile(
  payload: SagaAvatarDirectUploadGrantPayload,
  uploadId: string,
  pathname: string,
): DirectUploadFile {
  const upload = payload.files.find((file) => file.id === uploadId);
  if (!upload || upload.pathname !== pathname) {
    throw new SagaAvatarDirectUploadError("Den privata uppladdningen får bara skriva till den förberedda bildfilen.", 403);
  }
  return upload;
}

function signPayload(payload: SagaAvatarDirectUploadGrantPayload): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encoded}.${signatureFor(encoded)}`;
}

function signatureFor(encoded: string): string {
  const token = process.env.BLOB_READ_WRITE_TOKEN?.trim();
  if (!token) throw new SagaAvatarDirectUploadError("Vercel Blob saknas för privata avatarreferenser.", 503);
  return createHmac("sha256", token).update(encoded).digest("base64url");
}
