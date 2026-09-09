import { NextRequest, NextResponse } from "next/server";
import { requireSagaDailyKnowledgeActor, sagaDailyKnowledgeErrorResponse } from "@/lib/services/saga-daily-knowledge-http";
import { listSagaDailyKnowledgeRuns } from "@/lib/neon/saga-daily-knowledge-repository";
import {
  sagaNewsNoStore,
} from "@/lib/services/saga-news-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parsedLimit(value: string | null): number | null {
  if (value === null) return 20;
  if (!/^\d{1,2}$/.test(value)) return null;
  const limit = Number(value);
  return limit >= 1 && limit <= 60 ? limit : null;
}

/** Read-only execution receipts; lease tokens and policy snapshots are never serialized. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const resolved = await requireSagaDailyKnowledgeActor(request, "Logga in för att se SAGA:s kunskapskörningar.");
  if (resolved.response) return resolved.response;
  const limit = parsedLimit(new URL(request.url).searchParams.get("limit"));
  if (limit === null) {
    return sagaNewsNoStore({ error: "Ange limit mellan 1 och 60.", code: "invalid_daily_knowledge_query" }, 422);
  }
  try {
    return sagaNewsNoStore({ data: await listSagaDailyKnowledgeRuns(resolved.actor, { limit }) });
  } catch (error) {
    return sagaDailyKnowledgeErrorResponse(error, "Kunskapskörningarna kunde inte läsas.");
  }
}
