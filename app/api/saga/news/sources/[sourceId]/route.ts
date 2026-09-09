import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { deleteSagaNewsSource, setSagaNewsSourceActive } from "@/lib/neon/saga-news-core-repository";
import { readSagaNewsJson, requireSagaNewsActor, sagaNewsErrorResponse, sagaNewsNoStore } from "@/lib/services/saga-news-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const sourceIdSchema = z.string().uuid();
const activeSchema = z.object({ active: z.boolean() }).strict();

/** Pausing is explicit and clears any active cron lease; source history remains intact. */
export async function PATCH(request: NextRequest, context: { params: Promise<{ sourceId: string }> }): Promise<NextResponse> {
  const resolved = await requireSagaNewsActor("Logga in för att ändra en SAGA-källa.");
  if (resolved.response) return resolved.response;
  const sourceId = sourceIdSchema.safeParse((await context.params).sourceId);
  const body = activeSchema.safeParse(await readSagaNewsJson(request));
  if (!sourceId.success || !body.success) {
    return sagaNewsNoStore({ error: "Skicka ett giltigt käll-id och active-status.", code: "invalid_source" }, 422);
  }
  try {
    return sagaNewsNoStore({ data: await setSagaNewsSourceActive(resolved.actor, sourceId.data, body.data.active) });
  } catch (error) {
    return sagaNewsErrorResponse(error, "SAGA-källan kunde inte ändras.");
  }
}

/** Only brand-new sources can be deleted; sources with provenance must be paused. */
export async function DELETE(_request: NextRequest, context: { params: Promise<{ sourceId: string }> }): Promise<NextResponse> {
  const resolved = await requireSagaNewsActor("Logga in för att ta bort en SAGA-källa.");
  if (resolved.response) return resolved.response;
  const sourceId = sourceIdSchema.safeParse((await context.params).sourceId);
  if (!sourceId.success) return sagaNewsNoStore({ error: "Käll-id:t är ogiltigt.", code: "invalid_source" }, 422);
  try {
    const deleted = await deleteSagaNewsSource(resolved.actor, sourceId.data);
    return sagaNewsNoStore({ deleted });
  } catch (error) {
    return sagaNewsErrorResponse(error, "SAGA-källan kunde inte tas bort.");
  }
}
