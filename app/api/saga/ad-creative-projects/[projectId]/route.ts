import { NextRequest, NextResponse } from "next/server";
import {
  sagaAdCreativeProjectDeleteSchema,
  sagaAdCreativeProjectUpdateSchema,
} from "@/lib/domain/saga-ad-creative";
import {
  deleteSagaAdCreativeProject,
  getSagaAdCreativeProject,
  updateSagaAdCreativeProject,
} from "@/lib/neon/saga-ad-creative-project-repository";
import {
  containsSagaAdCreativeForbiddenSelector,
  readSagaAdCreativeProjectJson,
  requireSagaAdCreativeProjectActor,
  sagaAdCreativeProjectErrorResponse,
  sagaAdCreativeProjectResponse,
} from "@/lib/services/saga-ad-creative-project-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ projectId: string }> };

export async function GET(_request: NextRequest, context: Context): Promise<NextResponse> {
  const resolved = await requireSagaAdCreativeProjectActor("Logga in för att öppna ett annonsprojekt.");
  if (resolved.response) return resolved.response;
  try {
    const project = await getSagaAdCreativeProject(resolved.actor, (await context.params).projectId);
    if (!project) return sagaAdCreativeProjectResponse({ error: "Annonsprojektet hittades inte i den här arbetsytan.", code: "not_found" }, 404);
    return sagaAdCreativeProjectResponse({ project });
  } catch (error) {
    return sagaAdCreativeProjectErrorResponse(error, "Kunde inte läsa annonsprojektet.");
  }
}

/** One revisioned project document protects the master brief and every variant together. */
export async function PATCH(request: NextRequest, context: Context): Promise<NextResponse> {
  const resolved = await requireSagaAdCreativeProjectActor("Logga in för att ändra ett annonsprojekt.");
  if (resolved.response) return resolved.response;
  const body = await readSagaAdCreativeProjectJson(request);
  if (body === null || containsSagaAdCreativeForbiddenSelector(body)) return invalidRequest();
  const payload = sagaAdCreativeProjectUpdateSchema.safeParse(body);
  if (!payload.success) return invalidRequest();
  try {
    return sagaAdCreativeProjectResponse({ project: await updateSagaAdCreativeProject(resolved.actor, (await context.params).projectId, payload.data) });
  } catch (error) {
    return sagaAdCreativeProjectErrorResponse(error, "Kunde inte uppdatera annonsprojektet.");
  }
}

export async function DELETE(request: NextRequest, context: Context): Promise<NextResponse> {
  const resolved = await requireSagaAdCreativeProjectActor("Logga in för att radera ett annonsprojekt.");
  if (resolved.response) return resolved.response;
  const body = await readSagaAdCreativeProjectJson(request);
  if (body === null || containsSagaAdCreativeForbiddenSelector(body)) return invalidDelete();
  const payload = sagaAdCreativeProjectDeleteSchema.safeParse(body);
  if (!payload.success) return invalidDelete();
  try {
    const id = (await context.params).projectId;
    await deleteSagaAdCreativeProject(resolved.actor, id, payload.data);
    return sagaAdCreativeProjectResponse({ deleted: { id } });
  } catch (error) {
    return sagaAdCreativeProjectErrorResponse(error, "Kunde inte radera annonsprojektet.");
  }
}

function invalidRequest(): NextResponse {
  return sagaAdCreativeProjectResponse({ error: "Ändringen behöver aktuell revision och bara giltiga privata projektfält.", code: "invalid_ad_creative_request" }, 422);
}

function invalidDelete(): NextResponse {
  return sagaAdCreativeProjectResponse({ error: "Radering behöver aktuell projektrevision.", code: "invalid_ad_creative_request" }, 422);
}
