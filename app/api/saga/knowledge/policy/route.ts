import { NextRequest, NextResponse } from "next/server";
import { sagaDailyKnowledgePolicyInputSchema } from "@/lib/domain/saga-daily-knowledge";
import { requireSagaDailyKnowledgeActor, sagaDailyKnowledgeErrorResponse } from "@/lib/services/saga-daily-knowledge-http";
import {
  getSagaDailyKnowledgePolicy,
  saveSagaDailyKnowledgePolicy,
} from "@/lib/neon/saga-daily-knowledge-repository";
import {
  hasSagaNewsWorkspaceField,
  readSagaNewsJson,
  sagaNewsNoStore,
} from "@/lib/services/saga-news-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Daily Knowledge has one explicit, brand-owned policy inside the workspace. It configures a
 * research receipt only: this route has no draft, channel or publish field.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const resolved = await requireSagaDailyKnowledgeActor(request, "Logga in för att se SAGA:s dagliga kunskapspolicy.");
  if (resolved.response) return resolved.response;
  try {
    return sagaNewsNoStore({ data: await getSagaDailyKnowledgePolicy(resolved.actor) });
  } catch (error) {
    return sagaDailyKnowledgeErrorResponse(error, "Kunskapspolicyn kunde inte läsas.");
  }
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  const resolved = await requireSagaDailyKnowledgeActor(request, "Logga in för att ändra SAGA:s dagliga kunskapspolicy.");
  if (resolved.response) return resolved.response;
  const body = await readSagaNewsJson(request);
  if (body === null || hasSagaNewsWorkspaceField(body)) {
    return sagaNewsNoStore({ error: "Skicka en giltig policy utan workspaceId.", code: "invalid_daily_knowledge_policy" }, 422);
  }
  const parsed = sagaDailyKnowledgePolicyInputSchema.safeParse(body);
  if (!parsed.success) {
    return sagaNewsNoStore({
      error: parsed.error.issues[0]?.message ?? "Kunskapspolicyn är inte giltig.",
      code: "invalid_daily_knowledge_policy",
    }, 422);
  }
  try {
    return sagaNewsNoStore({ data: await saveSagaDailyKnowledgePolicy(resolved.actor, parsed.data) });
  } catch (error) {
    return sagaDailyKnowledgeErrorResponse(error, "Kunskapspolicyn kunde inte sparas.");
  }
}

/** PATCH is a full replacement alias; partial patches cannot silently weaken source controls. */
export async function PATCH(request: NextRequest): Promise<NextResponse> {
  return PUT(request);
}
