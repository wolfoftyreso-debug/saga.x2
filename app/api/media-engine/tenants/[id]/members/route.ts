import { NextRequest } from "next/server";
import { mediaEntityIdSchema, mediaTenantMemberUpsertSchema } from "@/lib/domain/media-engine";
import { listMediaTenantMembers, upsertMediaTenantMember } from "@/lib/services/media-engine";
import { mediaEngineConfigErrorResponse, noStore, readJson, resolveMediaEngineConfigRequestContext } from "@/lib/services/media-engine-config-http";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, context: Context) {
  const id = mediaEntityIdSchema.safeParse((await context.params).id);
  if (!id.success) return noStore({ error: "Arbetsyte-id måste vara en UUID." }, 400);
  const requestContext = await resolveMediaEngineConfigRequestContext();
  if (!requestContext.ok) return requestContext.response;
  try {
    return noStore({ members: await listMediaTenantMembers(requestContext.value.database, requestContext.value.userId, id.data) });
  } catch (error) {
    return mediaEngineConfigErrorResponse(error);
  }
}

export async function PUT(request: NextRequest, context: Context) {
  const id = mediaEntityIdSchema.safeParse((await context.params).id);
  if (!id.success) return noStore({ error: "Arbetsyte-id måste vara en UUID." }, 400);
  const requestContext = await resolveMediaEngineConfigRequestContext();
  if (!requestContext.ok) return requestContext.response;
  const body = await readJson(request);
  const parsed = mediaTenantMemberUpsertSchema.safeParse(body);
  if (!parsed.success) return noStore({ error: parsed.error.issues[0]?.message ?? "Medlemskapet innehåller ett ogiltigt värde." }, 400);
  try {
    const member = await upsertMediaTenantMember(requestContext.value.database, requestContext.value.userId, id.data, parsed.data);
    return noStore({ member });
  } catch (error) {
    return mediaEngineConfigErrorResponse(error);
  }
}
