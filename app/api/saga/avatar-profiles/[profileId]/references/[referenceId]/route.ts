import { NextResponse } from "next/server";
import { sagaAvatarProfileIdSchema, sagaAvatarReferenceIdSchema } from "@/lib/domain/saga-avatar";
import { neonConfigurationResponse, requireNeonActor } from "@/lib/neon/http";
import {
  deleteSagaAvatarReferenceMetadata,
  getSagaAvatarOwnedReference,
} from "@/lib/neon/saga-avatar-repository";
import { sagaAvatarErrorResponse, sagaAvatarNoStoreHeaders } from "@/lib/services/saga-avatar-http";
import { assertTrustedAvatarReferenceBlobPath, deleteAvatarReferenceBlob } from "@/lib/vercel/avatar-reference-blob";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ profileId: string; referenceId: string }> };

/**
 * Private source bytes are deleted before their metadata. A Blob failure leaves
 * the owned metadata in place so the user can retry; it never becomes an
 * inaccessible, untracked biometric orphan.
 */
export async function DELETE(_request: Request, context: Context): Promise<NextResponse> {
  const resolved = await requireAvatarActor("Logga in för att ta bort en privat avatarreferens.");
  if (resolved.response) return resolved.response;
  const params = await context.params;
  const profileId = sagaAvatarProfileIdSchema.safeParse(params.profileId);
  const referenceId = sagaAvatarReferenceIdSchema.safeParse(params.referenceId);
  if (!profileId.success || !referenceId.success) {
    return NextResponse.json({ error: "Ogiltigt profil- eller referens-id." }, { status: 400, headers: sagaAvatarNoStoreHeaders });
  }
  try {
    const reference = await getSagaAvatarOwnedReference(resolved.actor, profileId.data, referenceId.data);
    if (!reference) return NextResponse.json({ error: "Avatarreferensen hittades inte." }, { status: 404, headers: sagaAvatarNoStoreHeaders });
    const pathname = assertTrustedAvatarReferenceBlobPath(
      { workspaceId: resolved.actor.workspaceId, profileId: profileId.data },
      reference.blobPathname,
    );
    await deleteAvatarReferenceBlob({
      scope: { workspaceId: resolved.actor.workspaceId, profileId: profileId.data },
      pathname,
    });
    const deleted = await deleteSagaAvatarReferenceMetadata(resolved.actor, profileId.data, referenceId.data);
    if (!deleted) {
      return NextResponse.json(
        { error: "Avatarreferensen ändrades medan den togs bort. Försök igen." },
        { status: 409, headers: sagaAvatarNoStoreHeaders },
      );
    }
    return NextResponse.json({ ok: true, cleanup: "complete" }, { headers: sagaAvatarNoStoreHeaders });
  } catch (error) {
    return sagaAvatarErrorResponse(error, "Kunde inte ta bort den privata avatarreferensen.");
  }
}

async function requireAvatarActor(message: string) {
  const configuration = neonConfigurationResponse("Privata avatarreferenser behöver Neon i Vercel.");
  if (configuration) return { response: configuration };
  return requireNeonActor(message);
}
