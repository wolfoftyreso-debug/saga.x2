import { NextRequest } from "next/server";
import { mediaResearchRuleCreateSchema, mediaTenantIdSchema } from "@/lib/domain/media-engine";
import { createMediaResearchRule, listMediaResearchRules } from "@/lib/services/media-engine";
import { mediaEngineConfigErrorResponse, noStore, readJson, resolveMediaEngineConfigRequestContext } from "@/lib/services/media-engine-config-http";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const tenantId = mediaTenantIdSchema.safeParse(request.nextUrl.searchParams.get("tenantId"));
  if (!tenantId.success) return noStore({ error: "tenantId måste vara en UUID." }, 400);
  const context = await resolveMediaEngineConfigRequestContext();
  if (!context.ok) return context.response;
  try {
    return noStore({ rules: await listMediaResearchRules(context.value.database, context.value.userId, tenantId.data) });
  } catch (error) {
    return mediaEngineConfigErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  const context = await resolveMediaEngineConfigRequestContext();
  if (!context.ok) return context.response;
  const body = await readJson(request);
  if (body === null) return noStore({ error: "Skicka giltig JSON." }, 400);
  const parsed = mediaResearchRuleCreateSchema.safeParse(body);
  if (!parsed.success) return noStore({ error: parsed.error.issues[0]?.message ?? "Researchregeln innehåller ett ogiltigt värde." }, 400);
  try {
    const rule = await createMediaResearchRule(context.value.database, context.value.userId, parsed.data);
    return noStore({ rule }, 201);
  } catch (error) {
    return mediaEngineConfigErrorResponse(error);
  }
}
