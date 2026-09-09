import { NextRequest } from "next/server";
import { mediaEntityIdSchema, mediaResearchRuleUpdateSchema, mediaTenantIdSchema } from "@/lib/domain/media-engine";
import { deleteMediaResearchRule, getMediaResearchRuleForUser, updateMediaResearchRule } from "@/lib/services/media-engine";
import { mediaEngineConfigErrorResponse, noStore, readJson, resolveMediaEngineConfigRequestContext } from "@/lib/services/media-engine-config-http";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

async function ids(request: NextRequest, context: Context) {
  const ruleId = mediaEntityIdSchema.safeParse((await context.params).id);
  const tenantId = mediaTenantIdSchema.safeParse(request.nextUrl.searchParams.get("tenantId"));
  return { ruleId, tenantId };
}

export async function GET(request: NextRequest, context: Context) {
  const { ruleId, tenantId } = await ids(request, context);
  if (!ruleId.success || !tenantId.success) return noStore({ error: "ruleId och tenantId måste vara UUID." }, 400);
  const requestContext = await resolveMediaEngineConfigRequestContext();
  if (!requestContext.ok) return requestContext.response;
  try {
    const rule = await getMediaResearchRuleForUser(requestContext.value.database, requestContext.value.userId, tenantId.data, ruleId.data);
    return rule ? noStore({ rule }) : noStore({ error: "Researchregeln hittades inte." }, 404);
  } catch (error) {
    return mediaEngineConfigErrorResponse(error);
  }
}

export async function PATCH(request: NextRequest, context: Context) {
  const { ruleId, tenantId } = await ids(request, context);
  if (!ruleId.success || !tenantId.success) return noStore({ error: "ruleId och tenantId måste vara UUID." }, 400);
  const requestContext = await resolveMediaEngineConfigRequestContext();
  if (!requestContext.ok) return requestContext.response;
  const body = await readJson(request);
  const parsed = mediaResearchRuleUpdateSchema.safeParse(body);
  if (!parsed.success || Object.keys(parsed.success ? parsed.data : {}).length === 0) {
    return noStore({ error: parsed.success ? "Ange minst en ändring." : parsed.error.issues[0]?.message ?? "Researchregeln innehåller ett ogiltigt värde." }, 400);
  }
  try {
    const rule = await updateMediaResearchRule(requestContext.value.database, requestContext.value.userId, tenantId.data, ruleId.data, parsed.data);
    return rule ? noStore({ rule }) : noStore({ error: "Researchregeln hittades inte." }, 404);
  } catch (error) {
    return mediaEngineConfigErrorResponse(error);
  }
}

export async function DELETE(request: NextRequest, context: Context) {
  const { ruleId, tenantId } = await ids(request, context);
  if (!ruleId.success || !tenantId.success) return noStore({ error: "ruleId och tenantId måste vara UUID." }, 400);
  const requestContext = await resolveMediaEngineConfigRequestContext();
  if (!requestContext.ok) return requestContext.response;
  try {
    const deleted = await deleteMediaResearchRule(requestContext.value.database, requestContext.value.userId, tenantId.data, ruleId.data);
    return deleted ? noStore({ ok: true }) : noStore({ error: "Researchregeln hittades inte." }, 404);
  } catch (error) {
    return mediaEngineConfigErrorResponse(error);
  }
}
