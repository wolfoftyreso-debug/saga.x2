import { NextRequest } from "next/server";
import { mediaEntityIdSchema } from "@/lib/domain/media-engine";
import { removeMediaTenantMember } from "@/lib/services/media-engine";
import { mediaEngineConfigErrorResponse, noStore, resolveMediaEngineConfigRequestContext } from "@/lib/services/media-engine-config-http";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string; memberUserId: string }> };

export async function DELETE(_request: NextRequest, context: Context) {
  const params = await context.params;
  const tenantId = mediaEntityIdSchema.safeParse(params.id);
  const memberUserId = mediaEntityIdSchema.safeParse(params.memberUserId);
  if (!tenantId.success || !memberUserId.success) return noStore({ error: "Arbetsyte- och medlems-id måste vara UUID." }, 400);
  const requestContext = await resolveMediaEngineConfigRequestContext();
  if (!requestContext.ok) return requestContext.response;
  try {
    const deleted = await removeMediaTenantMember(requestContext.value.database, requestContext.value.userId, tenantId.data, memberUserId.data);
    return deleted ? noStore({ ok: true }) : noStore({ error: "Medlemskapet hittades inte." }, 404);
  } catch (error) {
    return mediaEngineConfigErrorResponse(error);
  }
}
