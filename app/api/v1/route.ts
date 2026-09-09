import { NextRequest, NextResponse } from "next/server";
import { outgoingFeedHeaders, outgoingFeedOptionsHeaders, outgoingFeedOrigin } from "@/lib/services/outgoing-feed-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * A deliberately small discovery document. It never exposes a user's feed
 * address or API key; those are created and shown once in Settings.
 */
export function GET(request: NextRequest) {
  const origin = outgoingFeedOrigin(request);
  return NextResponse.json({
    version: "v1",
    name: "Personal Daily Brief API",
    authentication: {
      header: "Authorization: Bearer pdb_live_…",
      alternativeHeader: "X-API-Key: pdb_live_…",
      queryToken: "RSS och SSE kan använda ?token=pdb_live_… när klienten inte kan skicka headers.",
      note: "Behandla en RSS- eller SSE-adress med token som ett lösenord.",
    },
    endpoints: {
      feed: {
        href: `${origin}/api/v1/feed`,
        method: "GET",
        scope: "feed:json",
        description: "Materialiserade beslutskort och briefmetadata som JSON.",
        query: { limit: "1–100", cursor: "valfri cursor från föregående svar" },
      },
      briefs: {
        href: `${origin}/api/v1/briefs`,
        method: "GET",
        scope: "briefs:read",
        description: "Hela publicerade briefs som JSON, inklusive valda lägesmoduler.",
        query: { limit: "1–100", cursor: "valfri cursor från föregående svar" },
      },
      stream: {
        href: `${origin}/api/v1/stream`,
        method: "GET",
        scope: "feed:sse",
        description: "Server-Sent Events för nya publicerade poster. Använd Last-Event-ID eller ?cursor=.",
      },
      rss: {
        href: `${origin}/api/v1/rss`,
        method: "GET",
        scope: "feed:rss",
        description: "RSS 2.0 för feedläsare.",
      },
    },
  }, { headers: outgoingFeedHeaders(request) });
}

export function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: outgoingFeedOptionsHeaders(request) });
}
