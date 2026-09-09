import { NextRequest, NextResponse } from "next/server";
import { sagaAvatarProfileIdSchema } from "@/lib/domain/saga-avatar";
import { neonConfigurationResponse, requireNeonActor } from "@/lib/neon/http";
import { getSagaAvatarProfile } from "@/lib/neon/saga-avatar-repository";
import {
  sagaAvatarDirectUploadFinalizeSchema,
  verifySagaAvatarDirectUploadGrant,
} from "@/lib/services/saga-avatar-direct-upload";
import { readSagaAvatarJson, sagaAvatarErrorResponse, sagaAvatarNoStoreHeaders } from "@/lib/services/saga-avatar-http";
import { assertTrustedAvatarReferenceBlobPath, deleteAvatarReferenceBlob } from "@/lib/vercel/avatar-reference-blob";
import { isVercelBlobConfigured } from "@/lib/vercel/blob-media";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ profileId: string }> };

/**
 * Best-effort cleanup for a known failed direct upload. It only runs while the
 * profile is still empty, so a stale browser cannot delete a reference that
 * was already finalized and persisted.
 */
export async function POST(request: NextRequest, context: Context): Promise<NextResponse> {
  const resolved = await requireAvatarActor("Logga in för att avbryta privata avatarreferenser.");
  if (resolved.response) return resolved.response;
  if (!isVercelBlobConfigured()) {
    return NextResponse.json(
      { error: "Vercel Blob saknas för privata avatarreferenser.", missing: ["BLOB_READ_WRITE_TOKEN"] },
      { status: 503, headers: sagaAvatarNoStoreHeaders },
    );
  }
  const profileId = sagaAvatarProfileIdSchema.safeParse((await context.params).profileId);
  if (!profileId.success) return NextResponse.json({ error: "Ogiltigt profil-id." }, { status: 400, headers: sagaAvatarNoStoreHeaders });
  const body = await readSagaAvatarJson(request);
  const payload = sagaAvatarDirectUploadFinalizeSchema.safeParse(body);
  if (!payload.success) return NextResponse.json({ error: "Den privata uppladdningsbehörigheten saknas eller är ogiltig." }, { status: 422, headers: sagaAvatarNoStoreHeaders });
  try {
    const grant = verifySagaAvatarDirectUploadGrant(resolved.actor, payload.data.grant, profileId.data);
    const profile = await getSagaAvatarProfile(resolved.actor, profileId.data);
    if (!profile) return NextResponse.json({ error: "Avatarprofilen hittades inte." }, { status: 404, headers: sagaAvatarNoStoreHeaders });
    if (profile.referenceCount > 0) {
      return NextResponse.json(
        { error: "Den privata referensen är redan sparad och kan inte avbrytas via den här uppladdningen." },
        { status: 409, headers: sagaAvatarNoStoreHeaders },
      );
    }
    await Promise.all(grant.files.map(async (file) => {
      const pathname = assertTrustedAvatarReferenceBlobPath(
        { workspaceId: resolved.actor.workspaceId, profileId: profileId.data },
        file.pathname,
      );
      await deleteAvatarReferenceBlob({
        scope: { workspaceId: resolved.actor.workspaceId, profileId: profileId.data },
        pathname,
      });
    }));
    return NextResponse.json({ ok: true, cleanup: "complete" }, { headers: sagaAvatarNoStoreHeaders });
  } catch (error) {
    return sagaAvatarErrorResponse(error, "Kunde inte avbryta de privata referensbilderna.");
  }
}

async function requireAvatarActor(message: string) {
  const configuration = neonConfigurationResponse("Privata avatarreferenser behöver Neon i Vercel.");
  if (configuration) return { response: configuration };
  return requireNeonActor(message);
}
