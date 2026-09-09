import { NextRequest, NextResponse } from "next/server";
import { createSagaAvatarProfileSchema } from "@/lib/domain/saga-avatar";
import { neonConfigurationResponse, requireNeonActor } from "@/lib/neon/http";
import { createSagaAvatarProfile, listSagaAvatarProfiles } from "@/lib/neon/saga-avatar-repository";
import {
  containsWorkspaceId,
  readSagaAvatarJson,
  sagaAvatarErrorResponse,
  sagaAvatarNoStoreHeaders,
} from "@/lib/services/saga-avatar-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Lists safe metadata only. Source filenames and private Blob URLs are never returned. */
export async function GET(): Promise<NextResponse> {
  const resolved = await requireAvatarActor("Logga in för att hantera privata avatarreferenser.");
  if (resolved.response) return resolved.response;
  try {
    const profiles = await listSagaAvatarProfiles(resolved.actor);
    return NextResponse.json({ profiles }, { headers: sagaAvatarNoStoreHeaders });
  } catch (error) {
    return sagaAvatarErrorResponse(error, "Kunde inte läsa privata avatarreferenser.");
  }
}

/**
 * Creates only a private profile shell. Provider processing is disabled by
 * default and can only be enabled later through an explicit separate consent.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const resolved = await requireAvatarActor("Logga in för att skapa en privat avatarprofil.");
  if (resolved.response) return resolved.response;
  const body = await readSagaAvatarJson(request);
  if (body === null || containsWorkspaceId(body)) {
    return NextResponse.json({ error: "Avatarprofilen innehåller ett ogiltigt värde." }, { status: 422, headers: sagaAvatarNoStoreHeaders });
  }
  const payload = createSagaAvatarProfileSchema.safeParse(body);
  if (!payload.success) {
    return NextResponse.json({ error: "Bekräfta samtycket och ange ett kort profilnamn." }, { status: 422, headers: sagaAvatarNoStoreHeaders });
  }
  try {
    const profile = await createSagaAvatarProfile(resolved.actor, payload.data);
    return NextResponse.json({ profile }, { status: 201, headers: sagaAvatarNoStoreHeaders });
  } catch (error) {
    return sagaAvatarErrorResponse(error, "Kunde inte skapa den privata avatarprofilen.");
  }
}

async function requireAvatarActor(message: string) {
  const configuration = neonConfigurationResponse("Privata avatarreferenser behöver Neon i Vercel.");
  if (configuration) return { response: configuration };
  return requireNeonActor(message);
}
