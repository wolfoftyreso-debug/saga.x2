import { NextRequest, NextResponse } from "next/server";
import { sagaAvatarProfileIdSchema } from "@/lib/domain/saga-avatar";
import { neonConfigurationResponse, requireNeonActor } from "@/lib/neon/http";
import { getSagaAvatarProfile, SagaAvatarValidationError } from "@/lib/neon/saga-avatar-repository";
import {
  createSagaAvatarDirectUploadGrant,
  sagaAvatarDirectUploadRequestSchema,
} from "@/lib/services/saga-avatar-direct-upload";
import { readSagaAvatarJson, sagaAvatarErrorResponse, sagaAvatarNoStoreHeaders } from "@/lib/services/saga-avatar-http";
import { isVercelBlobConfigured } from "@/lib/vercel/blob-media";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ profileId: string }> };

/**
 * Prepares only signed, short-lived write authority for direct private Blob
 * uploads. The function receives metadata, never the image bytes, so it stays
 * below Vercel's Function request-body ceiling.
 */
export async function POST(request: NextRequest, context: Context): Promise<NextResponse> {
  const resolved = await requireAvatarActor("Logga in för att ladda upp privata avatarreferenser.");
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
  const payload = sagaAvatarDirectUploadRequestSchema.safeParse(body);
  if (!payload.success) {
    return NextResponse.json(
      { error: "Välj mellan en och sex giltiga privata bildfiler och bekräfta samtycket." },
      { status: 422, headers: sagaAvatarNoStoreHeaders },
    );
  }
  try {
    const profile = await getSagaAvatarProfile(resolved.actor, profileId.data);
    if (!profile) return NextResponse.json({ error: "Avatarprofilen hittades inte." }, { status: 404, headers: sagaAvatarNoStoreHeaders });
    assertCapacity(profile.referenceCount, payload.data.files.length);
    const grant = createSagaAvatarDirectUploadGrant(resolved.actor, profileId.data, payload.data);
    return NextResponse.json(grant, { status: 201, headers: sagaAvatarNoStoreHeaders });
  } catch (error) {
    return sagaAvatarErrorResponse(error, "Kunde inte förbereda privata referensbilder.");
  }
}

function assertCapacity(existing: number, incoming: number): void {
  if (existing + incoming > 6) {
    throw new SagaAvatarValidationError("En privat avatarprofil kan innehålla högst sex referensbilder.");
  }
  if (existing === 0 && incoming < 3) {
    throw new SagaAvatarValidationError("Lägg in tre till sex referensbilder första gången.");
  }
  if (existing > 0 && existing < 3 && existing + incoming < 3) {
    throw new SagaAvatarValidationError("Lägg in tillräckligt många referensbilder för att nå minst tre bilder.");
  }
}

async function requireAvatarActor(message: string) {
  const configuration = neonConfigurationResponse("Privata avatarreferenser behöver Neon i Vercel.");
  if (configuration) return { response: configuration };
  return requireNeonActor(message);
}
