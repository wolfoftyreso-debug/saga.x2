import { NextRequest, NextResponse } from "next/server";
import { requireSagaDailyKnowledgeActor, sagaDailyKnowledgeErrorResponse } from "@/lib/services/saga-daily-knowledge-http";
import { listSagaDailyKnowledgeEntries } from "@/lib/neon/saga-daily-knowledge-repository";
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

/** Metadata-only evidence bundles. The endpoint never loads News Core bodies. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const resolved = await requireSagaDailyKnowledgeActor(request, "Logga in för att se dagens SAGA-kunskapsunderlag.");
  if (resolved.response) return resolved.response;
  const url = new URL(request.url);
  const date = url.searchParams.get("date");
  const limit = parsedLimit(url.searchParams.get("limit"));
  if ((date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(date)) || limit === null) {
    return sagaNewsNoStore({ error: "Ange date som YYYY-MM-DD och limit mellan 1 och 60.", code: "invalid_daily_knowledge_query" }, 422);
  }
  try {
    return sagaNewsNoStore({ data: await listSagaDailyKnowledgeEntries(resolved.actor, { date: date ?? undefined, limit }) });
  } catch (error) {
    return sagaDailyKnowledgeErrorResponse(error, "Kunskapsunderlaget kunde inte läsas.");
  }
}
