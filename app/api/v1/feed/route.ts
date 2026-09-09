import { NextRequest, NextResponse } from "next/server";
import { decodeFeedCursor, parseFeedLimit } from "@/lib/domain/outgoing-feed";
import { readOutgoingFeed } from "@/lib/services/outgoing-feed";
import {
  authenticateOutgoingFeedRequest,
  outgoingFeedHeaders,
  outgoingFeedOptionsHeaders,
} from "@/lib/services/outgoing-feed-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const principal = await authenticateOutgoingFeedRequest(request, "feed:json");
  if (!principal) return apiError(request, "Otillåten API-nyckel eller saknad behörighet.", 401);

  const limit = parseFeedLimit(request.nextUrl.searchParams.get("limit"));
  if (!limit) return apiError(request, "limit måste vara ett heltal mellan 1 och 100.", 400);

  const rawCursor = request.nextUrl.searchParams.get("cursor");
  const cursor = decodeFeedCursor(rawCursor);
  if (rawCursor && (!cursor || cursor.kind !== "item")) return apiError(request, "cursor är ogiltig.", 400);

  try {
    const feed = await readOutgoingFeed({
      userId: principal.userId,
      after: cursor,
      limit,
      initialWindow: !cursor,
    });
    return NextResponse.json(feed, { headers: outgoingFeedHeaders(request) });
  } catch {
    // Never turn a failed database/source-policy read into a misleading quiet feed.
    return apiError(request, "Flödet kunde inte läsas just nu. Försök igen senare.", 503);
  }
}

export function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: outgoingFeedOptionsHeaders(request) });
}

function apiError(request: Request, error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: outgoingFeedHeaders(request) });
}
