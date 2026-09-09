import { NextRequest } from "next/server";
import { z } from "zod";
import { getMediaEngineOverview } from "@/lib/services/media-engine-pipeline";
import { mediaEngineErrorResponse, noStore } from "@/lib/services/media-engine-http";
import { resolveMediaEngineConfigRequestContext } from "@/lib/services/media-engine-config-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The UI's one-shot read model. It contains no credentials or provider tokens. */
export async function GET(request: NextRequest) {
  const tenantId = z.string().uuid().optional().nullable().safeParse(request.nextUrl.searchParams.get("tenantId"));
  if (!tenantId.success) return noStore({ error: "tenantId måste vara en giltig UUID." }, 400);

  // Reading the workspace is deliberately less strict than actions such as
  // checking sources or creating a draft. A signed-in user without a tenant
  // still needs this response so the client can show its first-run action.
  const context = await resolveMediaEngineConfigRequestContext();
  if (!context.ok) return context.response;
  try {
    return noStore(await getMediaEngineOverview({
      database: context.value.database,
      userId: context.value.userId,
      tenantId: tenantId.data,
    }));
  } catch (error) {
    return mediaEngineErrorResponse(error);
  }
}
