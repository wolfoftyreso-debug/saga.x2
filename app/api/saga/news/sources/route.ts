import { NextRequest, NextResponse } from "next/server";
import { sagaNewsSourceInputSchema } from "@/lib/domain/saga-news-core";
import { listSagaNewsSources, saveSagaNewsSource } from "@/lib/neon/saga-news-core-repository";
import {
  hasSagaNewsWorkspaceField,
  readSagaNewsJson,
  requireSagaNewsActor,
  sagaNewsErrorResponse,
  sagaNewsNoStore,
} from "@/lib/services/saga-news-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const resolved = await requireSagaNewsActor("Logga in för att se dina SAGA-källor.");
  if (resolved.response) return resolved.response;
  try {
    return sagaNewsNoStore({ data: await listSagaNewsSources(resolved.actor) });
  } catch (error) {
    return sagaNewsErrorResponse(error, "SAGA-källorna kunde inte läsas.");
  }
}

/** Slug-idempotent create/update. A saved source carries no provider secret. */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const resolved = await requireSagaNewsActor("Logga in för att spara en SAGA-källa.");
  if (resolved.response) return resolved.response;
  const body = await readSagaNewsJson(request);
  if (body === null || hasSagaNewsWorkspaceField(body)) {
    return sagaNewsNoStore({ error: "Skicka en giltig källa utan workspaceId.", code: "invalid_source" }, 422);
  }
  const parsed = sagaNewsSourceInputSchema.safeParse(body);
  if (!parsed.success) {
    return sagaNewsNoStore({ error: parsed.error.issues[0]?.message ?? "Källan är inte giltig.", code: "invalid_source" }, 422);
  }
  try {
    return sagaNewsNoStore({ data: await saveSagaNewsSource(resolved.actor, parsed.data) }, 201);
  } catch (error) {
    return sagaNewsErrorResponse(error, "SAGA-källan kunde inte sparas.");
  }
}
