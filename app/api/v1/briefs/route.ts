import { NextRequest, NextResponse } from "next/server";
import { decodeFeedCursor, parseFeedLimit } from "@/lib/domain/outgoing-feed";
import { readOutgoingBriefs } from "@/lib/services/outgoing-feed";
import {
  authenticateOutgoingFeedRequest,
  outgoingFeedHeaders,
  outgoingFeedOptionsHeaders,
} from "@/lib/services/outgoing-feed-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Full, already-published briefs. This is not a registry/event-search endpoint. */
export async function GET(request: NextRequest) {
  const principal = await authenticateOutgoingFeedRequest(request, "briefs:read");
  if (!principal) return apiError(request, "Otillåten API-nyckel eller saknad behörighet.", 401);

  const limit = parseFeedLimit(request.nextUrl.searchParams.get("limit"));
  if (!limit) return apiError(request, "limit måste vara ett heltal mellan 1 och 100.", 400);

  const rawCursor = request.nextUrl.searchParams.get("cursor");
  const cursor = decodeFeedCursor(rawCursor);
  if (rawCursor && (!cursor || cursor.kind !== "brief")) return apiError(request, "cursor är ogiltig.", 400);

  try {
    const archive = await readOutgoingBriefs({
      userId: principal.userId,
      after: cursor,
      limit,
      initialWindow: !cursor,
    });
    return NextResponse.json(archive, { headers: outgoingFeedHeaders(request) });
  } catch {
    return apiError(request, "Briefarkivet kunde inte läsas just nu. Försök igen senare.", 503);
  }
}

export function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: outgoingFeedOptionsHeaders(request) });
}

function apiError(request: Request, error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: outgoingFeedHeaders(request) });
}
