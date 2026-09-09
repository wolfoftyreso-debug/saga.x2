import { NextRequest } from "next/server";
import { mediaEntityIdSchema, mediaSourceConnectionUpdateSchema, mediaTenantIdSchema } from "@/lib/domain/media-engine";
import { deleteMediaSourceConnection, getMediaSourceConnectionForUser, updateMediaSourceConnection } from "@/lib/services/media-engine";
import { mediaEngineConfigErrorResponse, noStore, readJson, resolveMediaEngineConfigRequestContext } from "@/lib/services/media-engine-config-http";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

async function ids(request: NextRequest, context: Context) {
  const sourceId = mediaEntityIdSchema.safeParse((await context.params).id);
  const tenantId = mediaTenantIdSchema.safeParse(request.nextUrl.searchParams.get("tenantId"));
  return { sourceId, tenantId };
}

export async function GET(request: NextRequest, context: Context) {
  const { sourceId, tenantId } = await ids(request, context);
  if (!sourceId.success || !tenantId.success) return noStore({ error: "sourceId och tenantId måste vara UUID." }, 400);
  const requestContext = await resolveMediaEngineConfigRequestContext();
  if (!requestContext.ok) return requestContext.response;
  try {
    const source = await getMediaSourceConnectionForUser(requestContext.value.database, requestContext.value.userId, tenantId.data, sourceId.data);
    return source ? noStore({ source }) : noStore({ error: "Källkopplingen hittades inte." }, 404);
  } catch (error) {
    return mediaEngineConfigErrorResponse(error);
  }
}

export async function PATCH(request: NextRequest, context: Context) {
  const { sourceId, tenantId } = await ids(request, context);
  if (!sourceId.success || !tenantId.success) return noStore({ error: "sourceId och tenantId måste vara UUID." }, 400);
  const requestContext = await resolveMediaEngineConfigRequestContext();
  if (!requestContext.ok) return requestContext.response;
  const body = await readJson(request);
  const parsed = mediaSourceConnectionUpdateSchema.safeParse(body);
  if (!parsed.success) return noStore({ error: parsed.error.issues[0]?.message ?? "Källkopplingen innehåller ett ogiltigt värde." }, 400);
  if (Object.keys(parsed.data).length === 0) return noStore({ error: "Ange minst en ändring." }, 400);
  try {
    const source = await updateMediaSourceConnection(requestContext.value.database, requestContext.value.userId, tenantId.data, sourceId.data, parsed.data);
    return source ? noStore({ source }) : noStore({ error: "Källkopplingen hittades inte." }, 404);
  } catch (error) {
    return mediaEngineConfigErrorResponse(error);
  }
}

export async function DELETE(request: NextRequest, context: Context) {
  const { sourceId, tenantId } = await ids(request, context);
  if (!sourceId.success || !tenantId.success) return noStore({ error: "sourceId och tenantId måste vara UUID." }, 400);
  const requestContext = await resolveMediaEngineConfigRequestContext();
  if (!requestContext.ok) return requestContext.response;
  try {
    const deleted = await deleteMediaSourceConnection(requestContext.value.database, requestContext.value.userId, tenantId.data, sourceId.data);
    return deleted ? noStore({ ok: true }) : noStore({ error: "Källkopplingen hittades inte." }, 404);
  } catch (error) {
    return mediaEngineConfigErrorResponse(error);
  }
}
