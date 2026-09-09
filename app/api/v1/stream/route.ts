import { NextRequest, NextResponse } from "next/server";
import { decodeFeedCursor, formatSseEvent, formatSseHeartbeat } from "@/lib/domain/outgoing-feed";
import { getLatestOutgoingFeedCursor, readOutgoingFeed } from "@/lib/services/outgoing-feed";
import {
  authenticateOutgoingFeedRequest,
  outgoingFeedHeaders,
  outgoingFeedOptionsHeaders,
} from "@/lib/services/outgoing-feed-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 55;

const POLL_INTERVAL_MS = 5_000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const STREAM_LIFETIME_MS = 50_000;
const BATCH_SIZE = 100;

/**
 * A short-lived, reconnecting SSE stream. `id` is the opaque delivery cursor,
 * so EventSource's built-in Last-Event-ID reconnection cannot replay a post.
 */
export async function GET(request: NextRequest) {
  const principal = await authenticateOutgoingFeedRequest(request, "feed:sse", true);
  if (!principal) return streamError(request, "Otillåten API-nyckel eller saknad behörighet.", 401);

  const rawCursor = request.headers.get("last-event-id") || request.nextUrl.searchParams.get("cursor");
  const parsedCursor = decodeFeedCursor(rawCursor);
  if (rawCursor && (!parsedCursor || parsedCursor.kind !== "item")) return streamError(request, "cursor är ogiltig.", 400);

  let initialCursor: string | null;
  try {
    // A fresh connection starts at the live edge. Use /feed for current/history;
    // SSE is intentionally only a delivery stream for future posts.
    initialCursor = rawCursor || await getLatestOutgoingFeedCursor({ userId: principal.userId });
  } catch {
    return streamError(request, "Liveflödet kunde inte initieras just nu. Försök igen senare.", 503);
  }

  const stream = createBriefItemStream({
    request,
    userId: principal.userId,
    initialCursor,
  });
  return new Response(stream, {
    headers: outgoingFeedHeaders(request, {
      "Content-Type": "text/event-stream; charset=utf-8",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    }),
  });
}

export function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: outgoingFeedOptionsHeaders(request) });
}

function createBriefItemStream(input: { request: Request; userId: string; initialCursor: string | null }): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let close = () => undefined;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let cursor = input.initialCursor;
      const timers: {
        poll?: ReturnType<typeof setTimeout>;
        heartbeat?: ReturnType<typeof setInterval>;
        expiry?: ReturnType<typeof setTimeout>;
      } = {};

      const send = (value: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(value));
        } catch {
          close();
        }
      };
      close = () => {
        if (closed) return;
        closed = true;
        if (timers.poll) clearTimeout(timers.poll);
        if (timers.heartbeat) clearInterval(timers.heartbeat);
        if (timers.expiry) clearTimeout(timers.expiry);
        input.request.signal.removeEventListener("abort", close);
        try {
          controller.close();
        } catch {
          // The client can close the stream before the server sees its abort.
        }
      };

      const poll = async () => {
        if (closed) return;
        try {
          const page = await readOutgoingFeed({
            userId: input.userId,
            after: decodeFeedCursor(cursor),
            limit: BATCH_SIZE,
            initialWindow: false,
            includeLatestCursor: false,
          });
          for (const item of page.items) {
            if (closed) return;
            cursor = item.cursor;
            send(formatSseEvent("brief_item", item, item.cursor));
          }
          // Drain backlog quickly after a saved cursor; otherwise poll normally.
          timers.poll = setTimeout(poll, page.hasMore ? 25 : POLL_INTERVAL_MS);
        } catch {
          send(formatSseEvent("error", { error: "Liveflödet kunde inte uppdateras. Anslut igen." }));
          close();
        }
      };

      send("retry: 5000\n\n");
      send(formatSseEvent("ready", { version: "v1", cursor }, cursor ?? undefined));
      timers.heartbeat = setInterval(() => send(formatSseHeartbeat()), HEARTBEAT_INTERVAL_MS);
      timers.expiry = setTimeout(close, STREAM_LIFETIME_MS);
      input.request.signal.addEventListener("abort", close, { once: true });
      timers.poll = setTimeout(poll, POLL_INTERVAL_MS);
    },
    cancel() {
      close();
    },
  });
}

function streamError(request: Request, error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: outgoingFeedHeaders(request) });
}
