import { NextResponse } from "next/server";
import { listSagaNewsIngestionRuns, listSagaNewsSignalCandidates, listSagaNewsSourceItems, listSagaNewsSources } from "@/lib/neon/saga-news-core-repository";
import { requireSagaNewsActor, sagaNewsErrorResponse, sagaNewsNoStore } from "@/lib/services/saga-news-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The browser-safe SAGA Research overview. It exposes source policy, short
 * evidence excerpts, receipts and signal status — never bodies, API secrets,
 * lease tokens or workspace identifiers supplied by the caller.
 */
export async function GET(): Promise<NextResponse> {
  const resolved = await requireSagaNewsActor("Logga in för att öppna SAGA Research.");
  if (resolved.response) return resolved.response;
  try {
    const [sources, items, runs, signals] = await Promise.all([
      listSagaNewsSources(resolved.actor),
      listSagaNewsSourceItems(resolved.actor, { limit: 60 }),
      listSagaNewsIngestionRuns(resolved.actor, { limit: 30 }),
      listSagaNewsSignalCandidates(resolved.actor, { limit: 30 }),
    ]);
    return sagaNewsNoStore({ data: { sources, items, runs, signals } });
  } catch (error) {
    return sagaNewsErrorResponse(error, "SAGA Research kunde inte läsas.");
  }
}
