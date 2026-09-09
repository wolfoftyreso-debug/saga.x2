import { NextRequest } from "next/server";
import { mediaTenantIdSchema } from "@/lib/domain/media-engine";
import { listMediaResearchClusters } from "@/lib/services/media-engine";
import { mediaEngineConfigErrorResponse, noStore, resolveMediaEngineConfigRequestContext } from "@/lib/services/media-engine-config-http";

export const dynamic = "force-dynamic";

/** Safe, tenant-scoped cluster list.  Use `/clusters/:id` for the evidence chain. */
export async function GET(request: NextRequest) {
  const tenantId = mediaTenantIdSchema.safeParse(request.nextUrl.searchParams.get("tenantId"));
  if (!tenantId.success) return noStore({ error: "tenantId måste vara en UUID." }, 400);
  const context = await resolveMediaEngineConfigRequestContext();
  if (!context.ok) return context.response;
  try {
    return noStore({ clusters: await listMediaResearchClusters(context.value.database, context.value.userId, tenantId.data) });
  } catch (error) {
    return mediaEngineConfigErrorResponse(error);
  }
}
