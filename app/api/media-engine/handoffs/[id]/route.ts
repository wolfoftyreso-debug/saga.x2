import { NextRequest } from "next/server";
import { z } from "zod";
import { updateMediaHandoffState } from "@/lib/services/media-engine-pipeline";
import { mediaEngineErrorResponse, noStore, readJson, resolveMediaEngineRequestContext } from "@/lib/services/media-engine-http";

export const dynamic = "force-dynamic";

const idSchema = z.string().uuid();
const actionSchema = z.object({ tenantId: z.string().uuid().optional(), action: z.enum(["reject", "queue_draft"]) });

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!idSchema.safeParse(id).success) return noStore({ error: "Handoff-id måste vara en UUID." }, 400);
  const body = await readJson(request);
  const input = actionSchema.safeParse(body);
  if (!input.success) return noStore({ error: input.error.issues[0]?.message ?? "Skicka en giltig handoff-åtgärd." }, 400);
  const requestContext = await resolveMediaEngineRequestContext(input.data.tenantId);
  if (!requestContext.ok) return requestContext.response;
  try {
    const handoff = await updateMediaHandoffState({
      database: requestContext.value.database,
      userId: requestContext.value.userId,
      tenantId: requestContext.value.tenant.id,
      handoffId: id,
      action: input.data.action,
    });
    if (!handoff) return noStore({ error: "Handoff finns inte i den här tenanten." }, 404);
    return noStore({ handoff, noPublication: true });
  } catch (error) {
    return mediaEngineErrorResponse(error);
  }
}
