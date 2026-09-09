import { NextRequest } from "next/server";
import { z } from "zod";
import { createDraftFromMediaHandoff } from "@/lib/services/media-engine-pipeline";
import { mediaEngineErrorResponse, noStore, readJson, resolveMediaEngineRequestContext } from "@/lib/services/media-engine-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const idSchema = z.string().uuid();
const inputSchema = z.object({ tenantId: z.string().uuid().optional(), idempotencyKey: z.string().uuid() });

/** Explicit editor action: creates a private Studio draft, never a post. */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!idSchema.safeParse(id).success) return noStore({ error: "Handoff-id måste vara en UUID." }, 400);
  const body = await readJson(request);
  const input = inputSchema.safeParse(body);
  if (!input.success) return noStore({ error: input.error.issues[0]?.message ?? "Skicka en giltig idempotensnyckel." }, 400);
  const requestContext = await resolveMediaEngineRequestContext(input.data.tenantId);
  if (!requestContext.ok) return requestContext.response;
  try {
    const result = await createDraftFromMediaHandoff({
      database: requestContext.value.database,
      userId: requestContext.value.userId,
      tenantId: requestContext.value.tenant.id,
      handoffId: id,
      idempotencyKey: input.data.idempotencyKey,
    });
    return noStore({ ...result, noPublication: true }, 201);
  } catch (error) {
    return mediaEngineErrorResponse(error);
  }
}
