import "server-only";

import { get } from "@vercel/blob";
import type { AppActor } from "@/lib/neon/auth-repository";
import { getSagaAvatarProfileForPrivateModelUse } from "@/lib/neon/saga-avatar-repository";
import {
  assertSagaAvatarReferenceTransferAuthorized,
  type SagaAvatarGenerationPolicy,
} from "@/lib/services/saga-avatar-privacy";
import { isVercelBlobConfigured } from "@/lib/vercel/blob-media";
import { assertTrustedAvatarReferenceBlobPath } from "@/lib/vercel/avatar-reference-blob";
import { assertAvatarReferenceImageBytes } from "@/lib/vercel/avatar-reference-image-validation";

export type PrivateAvatarReferenceBytes = {
  id: string;
  angle: "front" | "three_quarter_left" | "three_quarter_right" | "left_profile" | "right_profile" | "back" | "other";
  contentType: "image/jpeg" | "image/png" | "image/webp";
  bytes: Uint8Array;
};

export class SagaAvatarReferenceLoaderError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "SagaAvatarReferenceLoaderError";
  }
}

/**
 * The only intended source-image handoff to a future Vercel AI Gateway image
 * worker. It resolves ownership and per-profile consent first, then returns
 * raw bytes only to server code. It does not expose a URL, queue work, or call
 * a model. Callers must pass a trusted actor derived from the durable job.
 */
export async function loadAvatarReferenceBytesForPrivateModel(
  input: { actor: AppActor; profileId: string; policy: SagaAvatarGenerationPolicy },
): Promise<PrivateAvatarReferenceBytes[]> {
  if (!isVercelBlobConfigured()) {
    throw new SagaAvatarReferenceLoaderError("Vercel Blob är inte konfigurerat för privata avatarreferenser.", 503);
  }
  const profile = await getSagaAvatarProfileForPrivateModelUse(input.actor, input.profileId);
  try {
    assertSagaAvatarReferenceTransferAuthorized(
      input.policy,
      profile.id,
      profile.references.map((reference) => reference.id),
    );
  } catch {
    throw new SagaAvatarReferenceLoaderError(
      "Privata avatarreferenser saknar ett uttryckligt samtycke för just denna bildkörning.",
      400,
    );
  }
  const token = process.env.BLOB_READ_WRITE_TOKEN?.trim();
  if (!token) throw new SagaAvatarReferenceLoaderError("Vercel Blob är inte konfigurerat för privata avatarreferenser.", 503);

  const bytes: PrivateAvatarReferenceBytes[] = [];
  for (const reference of profile.references) {
    const pathname = assertTrustedAvatarReferenceBlobPath(
      { workspaceId: input.actor.workspaceId, profileId: profile.id },
      reference.blobPathname,
    );
    let result: Awaited<ReturnType<typeof get>>;
    try {
      result = await get(pathname, { access: "private", token });
    } catch {
      throw new SagaAvatarReferenceLoaderError("Kunde inte läsa en privat avatarreferens från Vercel Blob.", 502);
    }
    if (!result) throw new SagaAvatarReferenceLoaderError("En privat avatarreferens saknas i Vercel Blob.", 404);
    if (
      result.blob.contentType !== reference.contentType
      || result.blob.size !== reference.byteSize
      || result.blob.size <= 0
      || result.blob.size > 20 * 1024 * 1024
    ) {
      throw new SagaAvatarReferenceLoaderError("En privat avatarreferens har oväntad lagringsmetadata.", 502);
    }
    const value = new Uint8Array(await new Response(result.stream).arrayBuffer());
    if (value.byteLength !== reference.byteSize) {
      throw new SagaAvatarReferenceLoaderError("En privat avatarreferens kunde inte läsas korrekt.", 502);
    }
    try {
      assertAvatarReferenceImageBytes(value, reference.contentType);
    } catch {
      throw new SagaAvatarReferenceLoaderError("En privat avatarreferens har inte ett säkert bildformat.", 502);
    }
    bytes.push({
      id: reference.id,
      angle: reference.angle,
      contentType: reference.contentType,
      bytes: value,
    });
  }
  return bytes;
}
