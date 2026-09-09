import { NextRequest, NextResponse } from "next/server";
import { sagaAvatarProfileIdSchema, updateSagaAvatarProfileSchema } from "@/lib/domain/saga-avatar";
import { neonConfigurationResponse, requireNeonActor } from "@/lib/neon/http";
import {
  deleteSagaAvatarProfileIfEmpty,
  deleteSagaAvatarReferenceMetadata,
  listSagaAvatarOwnedReferencesForDeletion,
  updateSagaAvatarProfile,
} from "@/lib/neon/saga-avatar-repository";
import {
  containsWorkspaceId,
  readSagaAvatarJson,
  sagaAvatarErrorResponse,
  sagaAvatarNoStoreHeaders,
} from "@/lib/services/saga-avatar-http";
import { assertTrustedAvatarReferenceBlobPath, deleteAvatarReferenceBlob } from "@/lib/vercel/avatar-reference-blob";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ profileId: string }> };

export async function PATCH(request: NextRequest, context: Context): Promise<NextResponse> {
  const resolved = await requireAvatarActor("Logga in för att ändra en privat avatarprofil.");
  if (resolved.response) return resolved.response;
  const profileId = sagaAvatarProfileIdSchema.safeParse((await context.params).profileId);
  if (!profileId.success) return NextResponse.json({ error: "Ogiltigt profil-id." }, { status: 400, headers: sagaAvatarNoStoreHeaders });
  const body = await readSagaAvatarJson(request);
  if (body === null || containsWorkspaceId(body)) {
    return NextResponse.json({ error: "Avatarprofilen innehåller ett ogiltigt värde." }, { status: 422, headers: sagaAvatarNoStoreHeaders });
  }
  const payload = updateSagaAvatarProfileSchema.safeParse(body);
  if (!payload.success) {
    return NextResponse.json({ error: "Avatarprofilen innehåller ett ogiltigt värde." }, { status: 422, headers: sagaAvatarNoStoreHeaders });
  }
  try {
    const profile = await updateSagaAvatarProfile(resolved.actor, {
      profileId: profileId.data,
      label: payload.data.label,
      providerProcessingAccepted: payload.data.providerProcessingConsent?.accepted,
    });
    return NextResponse.json({ profile }, { headers: sagaAvatarNoStoreHeaders });
  } catch (error) {
    return sagaAvatarErrorResponse(error, "Kunde inte uppdatera den privata avatarprofilen.");
  }
}

export async function DELETE(_request: NextRequest, context: Context): Promise<NextResponse> {
  const resolved = await requireAvatarActor("Logga in för att ta bort en privat avatarprofil.");
  if (resolved.response) return resolved.response;
  const profileId = sagaAvatarProfileIdSchema.safeParse((await context.params).profileId);
  if (!profileId.success) return NextResponse.json({ error: "Ogiltigt profil-id." }, { status: 400, headers: sagaAvatarNoStoreHeaders });
  try {
    const references = await listSagaAvatarOwnedReferencesForDeletion(resolved.actor, profileId.data);
    if (!references) return NextResponse.json({ error: "Avatarprofilen hittades inte." }, { status: 404, headers: sagaAvatarNoStoreHeaders });
    for (const reference of references) {
      const pathname = assertTrustedAvatarReferenceBlobPath(
        { workspaceId: resolved.actor.workspaceId, profileId: profileId.data },
        reference.blobPathname,
      );
      // Delete the sensitive bytes first. If this fails the metadata remains,
      // so the user can retry without creating an untracked biometric orphan.
      await deleteAvatarReferenceBlob({
        scope: { workspaceId: resolved.actor.workspaceId, profileId: profileId.data },
        pathname,
      });
      await deleteSagaAvatarReferenceMetadata(resolved.actor, profileId.data, reference.id);
    }
    const deleted = await deleteSagaAvatarProfileIfEmpty(resolved.actor, profileId.data);
    if (!deleted) {
      return NextResponse.json(
        { error: "Avatarprofilen ändrades medan den togs bort. Försök igen." },
        { status: 409, headers: sagaAvatarNoStoreHeaders },
      );
    }
    return NextResponse.json(
      { ok: true, cleanup: "complete" },
      { headers: sagaAvatarNoStoreHeaders },
    );
  } catch (error) {
    return sagaAvatarErrorResponse(error, "Kunde inte ta bort den privata avatarprofilen.");
  }
}

async function requireAvatarActor(message: string) {
  const configuration = neonConfigurationResponse("Privata avatarreferenser behöver Neon i Vercel.");
  if (configuration) return { response: configuration };
  return requireNeonActor(message);
}
