import { NextRequest } from "next/server";
import { getMediaEngineOverview } from "@/lib/services/media-engine-pipeline";
import { mediaEngineErrorResponse, noStore, resolveMediaEngineRequestContext } from "@/lib/services/media-engine-http";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const context = await resolveMediaEngineRequestContext(request.nextUrl.searchParams.get("tenantId"));
  if (!context.ok) return context.response;
  try {
    const overview = await getMediaEngineOverview({ database: context.value.database, userId: context.value.userId, tenantId: context.value.tenant.id });
    return noStore({ runs: overview.runs, configuration: overview.configuration, tenant: overview.tenant });
  } catch (error) {
    return mediaEngineErrorResponse(error);
  }
}
