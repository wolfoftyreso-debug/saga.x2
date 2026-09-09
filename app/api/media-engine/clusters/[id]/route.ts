import { NextRequest } from "next/server";
import { z } from "zod";
import { getMediaEngineOverview, updateMediaClusterState } from "@/lib/services/media-engine-pipeline";
import { mediaEngineErrorResponse, noStore, readJson, resolveMediaEngineRequestContext } from "@/lib/services/media-engine-http";

export const dynamic = "force-dynamic";

const idSchema = z.string().uuid();
const actionSchema = z.object({ tenantId: z.string().uuid().optional(), action: z.enum(["dismiss", "restore"]) });

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!idSchema.safeParse(id).success) return noStore({ error: "Kluster-id måste vara en UUID." }, 400);
  const requestContext = await resolveMediaEngineRequestContext(request.nextUrl.searchParams.get("tenantId"));
  if (!requestContext.ok) return requestContext.response;
  try {
    const overview = await getMediaEngineOverview({
      database: requestContext.value.database,
      userId: requestContext.value.userId,
      tenantId: requestContext.value.tenant.id,
    });
    const cluster = overview.clusters.find((entry) => entry.id === id);
    if (!cluster) return noStore({ error: "Researchklustret finns inte i den här tenanten." }, 404);
    return noStore({
      cluster,
      dossier: overview.dossiers.find((entry) => entry.clusterId === id) ?? null,
      handoff: overview.handoffs.find((entry) => entry.clusterId === id) ?? null,
      noPublication: true,
    });
  } catch (error) {
    return mediaEngineErrorResponse(error);
  }
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!idSchema.safeParse(id).success) return noStore({ error: "Kluster-id måste vara en UUID." }, 400);
  const body = await readJson(request);
  const input = actionSchema.safeParse(body);
  if (!input.success) return noStore({ error: input.error.issues[0]?.message ?? "Skicka en giltig klusteråtgärd." }, 400);
  const requestContext = await resolveMediaEngineRequestContext(input.data.tenantId);
  if (!requestContext.ok) return requestContext.response;
  try {
    const cluster = await updateMediaClusterState({
      database: requestContext.value.database,
      userId: requestContext.value.userId,
      tenantId: requestContext.value.tenant.id,
      clusterId: id,
      action: input.data.action,
    });
    if (!cluster) return noStore({ error: "Researchklustret finns inte i den här tenanten." }, 404);
    return noStore({ cluster });
  } catch (error) {
    return mediaEngineErrorResponse(error);
  }
}
