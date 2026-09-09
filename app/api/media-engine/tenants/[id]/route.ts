import { NextRequest } from "next/server";
import { mediaEntityIdSchema, mediaTenantUpdateSchema } from "@/lib/domain/media-engine";
import { deleteMediaTenant, getMediaTenantForUser, updateMediaTenant } from "@/lib/services/media-engine";
import { mediaEngineConfigErrorResponse, noStore, readJson, resolveMediaEngineConfigRequestContext } from "@/lib/services/media-engine-config-http";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, context: Context) {
  const id = mediaEntityIdSchema.safeParse((await context.params).id);
  if (!id.success) return noStore({ error: "Arbetsyte-id måste vara en UUID." }, 400);
  const requestContext = await resolveMediaEngineConfigRequestContext();
  if (!requestContext.ok) return requestContext.response;
  try {
    const tenant = await getMediaTenantForUser(requestContext.value.database, requestContext.value.userId, id.data);
    return tenant ? noStore({ tenant }) : noStore({ error: "Arbetsytan hittades inte." }, 404);
  } catch (error) {
    return mediaEngineConfigErrorResponse(error);
  }
}

export async function PATCH(request: NextRequest, context: Context) {
  const id = mediaEntityIdSchema.safeParse((await context.params).id);
  if (!id.success) return noStore({ error: "Arbetsyte-id måste vara en UUID." }, 400);
  const requestContext = await resolveMediaEngineConfigRequestContext();
  if (!requestContext.ok) return requestContext.response;
  const body = await readJson(request);
  const parsed = mediaTenantUpdateSchema.safeParse(body);
  if (!parsed.success) return noStore({ error: parsed.error.issues[0]?.message ?? "Arbetsytan innehåller ett ogiltigt värde." }, 400);
  try {
    const tenant = await updateMediaTenant(requestContext.value.database, requestContext.value.userId, id.data, parsed.data);
    return tenant ? noStore({ tenant }) : noStore({ error: "Arbetsytan hittades inte." }, 404);
  } catch (error) {
    return mediaEngineConfigErrorResponse(error);
  }
}

export async function DELETE(_request: NextRequest, context: Context) {
  const id = mediaEntityIdSchema.safeParse((await context.params).id);
  if (!id.success) return noStore({ error: "Arbetsyte-id måste vara en UUID." }, 400);
  const requestContext = await resolveMediaEngineConfigRequestContext();
  if (!requestContext.ok) return requestContext.response;
  try {
    const deleted = await deleteMediaTenant(requestContext.value.database, requestContext.value.userId, id.data);
    return deleted ? noStore({ ok: true }) : noStore({ error: "Arbetsytan hittades inte." }, 404);
  } catch (error) {
    return mediaEngineConfigErrorResponse(error);
  }
}
