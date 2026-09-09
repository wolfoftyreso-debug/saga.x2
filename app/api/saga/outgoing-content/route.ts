import { NextRequest, NextResponse } from "next/server";
import {
  decodeSagaOutgoingContentCursor,
  parseSagaOutgoingContentLimit,
} from "@/lib/domain/saga-outgoing-api";
import { neonConfigurationResponse } from "@/lib/neon/http";
import {
  authenticateSagaOutgoingApiSecret,
  readSagaOutgoingContent,
} from "@/lib/neon/saga-outgoing-api-repository";
import {
  extractSagaOutgoingBearerSecret,
  hasOnlySagaOutgoingContentQuery,
  sagaOutgoingApiExternalUnauthorized,
  sagaOutgoingContentExternalResponse,
} from "@/lib/services/saga-outgoing-api-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Publicly reachable but token-gated. It is a read-only API endpoint, not a
 * webhook: no outbound URL, query token, CORS wildcard or write verb exists.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  // The runtime proxy also protects `/api/saga/*`; this direct route guard
  // keeps fail-closed behavior in direct handler calls and tests.
  const configuration = neonConfigurationResponse("Utgående innehålls-API behöver Neon i Vercel.");
  if (configuration) {
    return sagaOutgoingContentExternalResponse({ error: "Tjänsten är inte tillgänglig just nu." }, 503);
  }
  if (!hasOnlySagaOutgoingContentQuery(request)) {
    return sagaOutgoingContentExternalResponse({ error: "Använd bara limit och cursor i URL:en. API-hemligheten måste ligga i Authorization-huvudet." }, 400);
  }
  const secret = extractSagaOutgoingBearerSecret(request);
  if (!secret) return sagaOutgoingApiExternalUnauthorized();
  const principal = await authenticateSagaOutgoingApiSecret(secret);
  if (!principal) return sagaOutgoingApiExternalUnauthorized();

  const limit = parseSagaOutgoingContentLimit(request.nextUrl.searchParams.get("limit"));
  if (!limit) return sagaOutgoingContentExternalResponse({ error: "limit måste vara ett heltal mellan 1 och 10." }, 400);
  const rawCursor = request.nextUrl.searchParams.get("cursor");
  const cursor = decodeSagaOutgoingContentCursor(rawCursor);
  if (rawCursor && !cursor) return sagaOutgoingContentExternalResponse({ error: "cursor är ogiltig." }, 400);

  try {
    return sagaOutgoingContentExternalResponse(await readSagaOutgoingContent(principal, { cursor, limit }));
  } catch {
    // Avoid leaking whether a workspace has content, private media, or a
    // configuration mismatch. The response is no-store in every case.
    return sagaOutgoingContentExternalResponse({ error: "Innehållet kunde inte läsas just nu." }, 503);
  }
}
