import { NextRequest, NextResponse } from "next/server";
import { decodeFeedCursor, parseFeedLimit, serializeRssFeed } from "@/lib/domain/outgoing-feed";
import { readOutgoingFeed } from "@/lib/services/outgoing-feed";
import {
  authenticateOutgoingFeedRequest,
  outgoingFeedHeaders,
  outgoingFeedOptionsHeaders,
  outgoingFeedOrigin,
} from "@/lib/services/outgoing-feed-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * RSS readers cannot normally attach headers. Query-token support is confined
 * to this endpoint (and SSE), with no-store/no-referrer headers on every path.
 */
export async function GET(request: NextRequest) {
  const principal = await authenticateOutgoingFeedRequest(request, "feed:rss", true);
  if (!principal) return rssError(request, "Otillåten API-nyckel eller saknad behörighet.", 401);

  const limit = parseFeedLimit(request.nextUrl.searchParams.get("limit"));
  if (!limit) return rssError(request, "limit måste vara ett heltal mellan 1 och 100.", 400);

  const rawCursor = request.nextUrl.searchParams.get("cursor");
  const cursor = decodeFeedCursor(rawCursor);
  if (rawCursor && (!cursor || cursor.kind !== "item")) return rssError(request, "cursor är ogiltig.", 400);

  try {
    const feed = await readOutgoingFeed({
      userId: principal.userId,
      after: cursor,
      limit,
      initialWindow: !cursor,
    });
    const origin = outgoingFeedOrigin(request);
    const xml = serializeRssFeed({
      items: feed.items,
      channelTitle: "Personal Daily Brief – verifierade signaler",
      channelDescription: "Endast färdigpublicerade beslutssignaler från din personliga brief.",
      channelUrl: origin,
      // Never reflect request.nextUrl here: it can contain the RSS token.
      selfUrl: `${origin}/api/v1/rss`,
      generatedAt: feed.generatedAt,
      itemUrl: (item) => `${origin}/briefs/${item.brief.id}`,
    });
    return new Response(xml, {
      headers: outgoingFeedHeaders(request, { "Content-Type": "application/rss+xml; charset=utf-8" }),
    });
  } catch {
    return rssError(request, "RSS-flödet kunde inte läsas just nu. Försök igen senare.", 503);
  }
}

export function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: outgoingFeedOptionsHeaders(request) });
}

function rssError(request: Request, error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: outgoingFeedHeaders(request) });
}
